/**
 * EventProcessor - Handles event processing, filtering, and routing
 */

import { EventEmitter } from 'eventemitter3';
import { MT5Event, EventType, EventFilter, EventHandler } from '../types';
import { ConnectionGateway } from './ConnectionGateway';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { CircuitBreaker } from '../utils/CircuitBreaker';
import { ValidationError } from './errors';
import { DEFAULTS, EVENT_TYPES, MESSAGE_TYPES } from '../constants';
import { v4 as uuidv4 } from 'uuid';

interface EventSubscription {
  id: string;
  filter: EventFilter;
  handler: EventHandler;
  priority: number;
  isActive: boolean;
  createdAt: Date;
  lastTriggered?: Date;
  triggerCount: number;
}

interface EventQueue {
  events: MT5Event[];
  processing: boolean;
  maxSize: number;
}

/**
 * Event Processor for handling MT5 events
 */
export class EventProcessor extends EventEmitter {
  private readonly connectionGateway: ConnectionGateway;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private readonly circuitBreaker: CircuitBreaker;
  
  // Event management
  private subscriptions: Map<string, EventSubscription> = new Map();
  private eventQueue: EventQueue;
  private isProcessing: boolean = false;
  private isInitialized: boolean = false;
  
  // Event filtering and routing
  private eventFilters: Map<EventType, EventFilter[]> = new Map();
  private globalFilters: EventFilter[] = [];
  
  // Performance settings
  private readonly maxConcurrentEvents: number;
  private readonly eventBatchSize: number;
  private readonly processingInterval: number;
  
  // Processing statistics
  private processedEvents: number = 0;
  private droppedEvents: number = 0;
  private errorCount: number = 0;
  
  // Processing timer
  private processingTimer: NodeJS.Timeout | null = null;

  constructor(
    connectionGateway: ConnectionGateway,
    logger: Logger,
    metrics: MetricsCollector
  ) {
    super();

    this.connectionGateway = connectionGateway;
    this.logger = logger.child({ component: 'EventProcessor' });
    this.metrics = metrics;
    
    // Initialize circuit breaker for event processing
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: DEFAULTS.CIRCUIT_BREAKER.FAILURE_THRESHOLD,
      recoveryTimeout: DEFAULTS.CIRCUIT_BREAKER.RECOVERY_TIMEOUT,
      monitoringPeriod: DEFAULTS.CIRCUIT_BREAKER.MONITORING_PERIOD
    });
    
    // Performance settings
    this.maxConcurrentEvents = DEFAULTS.PERFORMANCE.MAX_CONCURRENT_EVENTS;
    this.eventBatchSize = DEFAULTS.PERFORMANCE.EVENT_BATCH_SIZE;
    this.processingInterval = DEFAULTS.PERFORMANCE.EVENT_PROCESSING_INTERVAL;
    
    // Initialize event queue
    this.eventQueue = {
      events: [],
      processing: false,
      maxSize: DEFAULTS.PERFORMANCE.MAX_EVENT_QUEUE_SIZE
    };

    this.setupConnectionEventHandlers();
    
    this.logger.info('EventProcessor created', {
      maxConcurrentEvents: this.maxConcurrentEvents,
      eventBatchSize: this.eventBatchSize,
      processingInterval: this.processingInterval
    });
  }

  /**
   * Initialize the event processor
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('EventProcessor is already initialized');
    }

    try {
      this.logger.info('Initializing EventProcessor...');
      this.metrics.startTimer('event_processor_initialization');

      // Start event processing loop
      this.startEventProcessing();
      
      // Setup default event filters
      this.setupDefaultFilters();
      
      this.isInitialized = true;
      this.metrics.endTimer('event_processor_initialization');
      
      this.logger.info('EventProcessor initialized successfully');
      
    } catch (error) {
      this.metrics.endTimer('event_processor_initialization');
      this.logger.error('Failed to initialize EventProcessor', { error });
      throw error;
    }
  }

  /**
   * Subscribe to events with filter and handler
   */
  subscribe(filter: EventFilter, handler: EventHandler, priority: number = 0): string {
    if (!this.isInitialized) {
      throw new Error('EventProcessor must be initialized before subscribing');
    }

    const subscriptionId = uuidv4();
    
    const subscription: EventSubscription = {
      id: subscriptionId,
      filter,
      handler,
      priority,
      isActive: true,
      createdAt: new Date(),
      triggerCount: 0
    };
    
    this.subscriptions.set(subscriptionId, subscription);
    
    // Add to event type filters if specific type is specified
    if (filter.eventType) {
      if (!this.eventFilters.has(filter.eventType)) {
        this.eventFilters.set(filter.eventType, []);
      }
      this.eventFilters.get(filter.eventType)!.push(filter);
    } else {
      // Add to global filters if no specific type
      this.globalFilters.push(filter);
    }
    
    this.logger.debug('Event subscription created', {
      subscriptionId,
      eventType: filter.eventType,
      priority
    });
    
    this.metrics.recordMetric('event_subscriptions', this.subscriptions.size);
    
    return subscriptionId;
  }

  /**
   * Unsubscribe from events
   */
  unsubscribe(subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return false;
    }
    
    // Remove from event type filters
    if (subscription.filter.eventType) {
      const filters = this.eventFilters.get(subscription.filter.eventType);
      if (filters) {
        const index = filters.indexOf(subscription.filter);
        if (index > -1) {
          filters.splice(index, 1);
        }
      }
    } else {
      // Remove from global filters
      const index = this.globalFilters.indexOf(subscription.filter);
      if (index > -1) {
        this.globalFilters.splice(index, 1);
      }
    }
    
    this.subscriptions.delete(subscriptionId);
    
    this.logger.debug('Event subscription removed', { subscriptionId });
    this.metrics.recordMetric('event_subscriptions', this.subscriptions.size);
    
    return true;
  }

  /**
   * Process an incoming event
   */
  async processEvent(event: MT5Event): Promise<void> {
    if (!this.isInitialized) {
      this.logger.warn('EventProcessor not initialized, dropping event', {
        eventType: event.type
      });
      return;
    }

    try {
      // Check queue capacity
      if (this.eventQueue.events.length >= this.eventQueue.maxSize) {
        this.droppedEvents++;
        this.metrics.recordMetric('events_dropped', 1);
        this.logger.warn('Event queue full, dropping event', {
          eventType: event.type,
          queueSize: this.eventQueue.events.length
        });
        return;
      }
      
      // Add event to queue
      this.eventQueue.events.push(event);
      
      this.logger.debug('Event queued for processing', {
        eventType: event.type,
        eventId: event.id,
        queueSize: this.eventQueue.events.length
      });
      
      this.metrics.recordMetric('events_queued', 1);
      
    } catch (error) {
      this.logger.error('Failed to queue event', { error, event });
      this.metrics.recordMetric('event_processing_errors', 1);
    }
  }

  /**
   * Add a global event filter
   */
  addGlobalFilter(filter: EventFilter): void {
    this.globalFilters.push(filter);
    this.logger.debug('Global event filter added');
  }

  /**
   * Remove a global event filter
   */
  removeGlobalFilter(filter: EventFilter): boolean {
    const index = this.globalFilters.indexOf(filter);
    if (index > -1) {
      this.globalFilters.splice(index, 1);
      this.logger.debug('Global event filter removed');
      return true;
    }
    return false;
  }

  /**
   * Get event processing statistics
   */
  getStatistics(): any {
    return {
      subscriptions: this.subscriptions.size,
      queueSize: this.eventQueue.events.length,
      processedEvents: this.processedEvents,
      droppedEvents: this.droppedEvents,
      errorCount: this.errorCount,
      isProcessing: this.isProcessing,
      circuitBreakerStatus: this.circuitBreaker.getStatus()
    };
  }

  /**
   * Get active subscriptions
   */
  getSubscriptions(): EventSubscription[] {
    return Array.from(this.subscriptions.values()).filter(sub => sub.isActive);
  }

  /**
   * Pause event processing
   */
  pauseProcessing(): void {
    this.isProcessing = false;
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }
    this.logger.info('Event processing paused');
  }

  /**
   * Resume event processing
   */
  resumeProcessing(): void {
    if (!this.isProcessing) {
      this.startEventProcessing();
      this.logger.info('Event processing resumed');
    }
  }

  /**
   * Clear event queue
   */
  clearQueue(): void {
    const queueSize = this.eventQueue.events.length;
    this.eventQueue.events = [];
    this.logger.info('Event queue cleared', { clearedEvents: queueSize });
  }

  /**
   * Shutdown the event processor
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down EventProcessor...');
      
      // Stop processing
      this.pauseProcessing();
      
      // Process remaining events
      if (this.eventQueue.events.length > 0) {
        this.logger.info('Processing remaining events before shutdown', {
          remainingEvents: this.eventQueue.events.length
        });
        await this.processEventBatch();
      }
      
      // Clear subscriptions
      this.subscriptions.clear();
      this.eventFilters.clear();
      this.globalFilters.length = 0;
      
      this.isInitialized = false;
      
      this.logger.info('EventProcessor shutdown completed');
      
    } catch (error) {
      this.logger.error('Error during EventProcessor shutdown', { error });
      throw error;
    }
  }

  /**
   * Setup connection event handlers
   */
  private setupConnectionEventHandlers(): void {
    this.connectionGateway.on('message', async (data) => {
      try {
        const event = this.parseMessageToEvent(data);
        if (event) {
          await this.processEvent(event);
        }
      } catch (error) {
        this.logger.error('Failed to process connection message', { error, data });
      }
    });
    
    this.connectionGateway.on('connected', () => {
      this.emit('connected');
    });
    
    this.connectionGateway.on('disconnected', () => {
      this.emit('disconnected');
    });
    
    this.connectionGateway.on('error', (error) => {
      this.emit('error', error);
    });
  }

  /**
   * Parse connection message to MT5Event
   */
  private parseMessageToEvent(data: any): MT5Event | null {
    try {
      const { topic, message } = data;
      
      // Map topic to event type
      const eventType = this.mapTopicToEventType(topic);
      if (!eventType) {
        return null;
      }
      
      const event: MT5Event = {
        id: uuidv4(),
        type: eventType,
        timestamp: new Date(),
        source: 'MT5Terminal',
        data: message.data || message,
        metadata: {
          topic,
          messageType: message.type,
          originalMessage: message
        }
      };
      
      return event;
      
    } catch (error) {
      this.logger.error('Failed to parse message to event', { error, data });
      return null;
    }
  }

  /**
   * Map topic to event type
   */
  private mapTopicToEventType(topic: string): EventType | null {
    const topicMappings: Record<string, EventType> = {
      'tick': EventType.TICK_UPDATE,
      'ohlc': EventType.OHLC_UPDATE,
      'trade': EventType.TRADE_UPDATE,
      'order': EventType.ORDER_UPDATE,
      'position': EventType.POSITION_UPDATE,
      'account': EventType.ACCOUNT_UPDATE,
      'symbol': EventType.SYMBOL_UPDATE,
      'connection': EventType.CONNECTION_STATUS,
      'error': EventType.ERROR
    };
    
    return topicMappings[topic] || null;
  }

  /**
   * Start event processing loop
   */
  private startEventProcessing(): void {
    this.isProcessing = true;
    
    this.processingTimer = setInterval(async () => {
      if (this.eventQueue.events.length > 0 && !this.eventQueue.processing) {
        await this.processEventBatch();
      }
    }, this.processingInterval);
    
    this.logger.debug('Event processing started', {
      interval: this.processingInterval
    });
  }

  /**
   * Process a batch of events
   */
  private async processEventBatch(): Promise<void> {
    if (this.eventQueue.processing) {
      return;
    }
    
    this.eventQueue.processing = true;
    
    try {
      const batchSize = Math.min(this.eventBatchSize, this.eventQueue.events.length);
      const batch = this.eventQueue.events.splice(0, batchSize);
      
      this.logger.debug('Processing event batch', {
        batchSize,
        remainingInQueue: this.eventQueue.events.length
      });
      
      await this.circuitBreaker.execute(async () => {
        await Promise.all(batch.map(event => this.processEventInternal(event)));
      });
      
      this.processedEvents += batch.length;
      this.metrics.recordMetric('events_processed', batch.length);
      
    } catch (error) {
      this.errorCount++;
      this.logger.error('Error processing event batch', { error });
      this.metrics.recordMetric('event_processing_errors', 1);
    } finally {
      this.eventQueue.processing = false;
    }
  }

  /**
   * Process individual event
   */
  private async processEventInternal(event: MT5Event): Promise<void> {
    try {
      // Apply global filters first
      if (!this.applyFilters(event, this.globalFilters)) {
        return;
      }
      
      // Apply event type specific filters
      const typeFilters = this.eventFilters.get(event.type) || [];
      if (!this.applyFilters(event, typeFilters)) {
        return;
      }
      
      // Find matching subscriptions
      const matchingSubscriptions = this.findMatchingSubscriptions(event);
      
      if (matchingSubscriptions.length === 0) {
        return;
      }
      
      // Sort by priority (higher priority first)
      matchingSubscriptions.sort((a, b) => b.priority - a.priority);
      
      // Execute handlers
      for (const subscription of matchingSubscriptions) {
        try {
          await subscription.handler(event);
          subscription.triggerCount++;
          subscription.lastTriggered = new Date();
        } catch (error) {
          this.logger.error('Event handler error', {
            error,
            subscriptionId: subscription.id,
            eventType: event.type
          });
        }
      }
      
      // Emit event for general listeners
      this.emit('event', event);
      
    } catch (error) {
      this.logger.error('Error processing event', { error, event });
      throw error;
    }
  }

  /**
   * Apply filters to an event
   */
  private applyFilters(event: MT5Event, filters: EventFilter[]): boolean {
    for (const filter of filters) {
      if (!this.matchesFilter(event, filter)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if event matches filter
   */
  private matchesFilter(event: MT5Event, filter: EventFilter): boolean {
    // Check event type
    if (filter.eventType && filter.eventType !== event.type) {
      return false;
    }
    
    // Check source
    if (filter.source && filter.source !== event.source) {
      return false;
    }
    
    // Check custom filter function
    if (filter.customFilter && !filter.customFilter(event)) {
      return false;
    }
    
    // Check data filters
    if (filter.dataFilters) {
      for (const [key, value] of Object.entries(filter.dataFilters)) {
        if (event.data[key] !== value) {
          return false;
        }
      }
    }
    
    return true;
  }

  /**
   * Find subscriptions that match the event
   */
  private findMatchingSubscriptions(event: MT5Event): EventSubscription[] {
    const matching: EventSubscription[] = [];
    
    for (const subscription of this.subscriptions.values()) {
      if (subscription.isActive && this.matchesFilter(event, subscription.filter)) {
        matching.push(subscription);
      }
    }
    
    return matching;
  }

  /**
   * Setup default event filters
   */
  private setupDefaultFilters(): void {
    // Filter out heartbeat events from general processing
    this.addGlobalFilter({
      customFilter: (event: MT5Event) => {
        return event.type !== EventType.HEARTBEAT;
      }
    });
    
    // Filter out events older than 5 minutes
    this.addGlobalFilter({
      customFilter: (event: MT5Event) => {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        return event.timestamp > fiveMinutesAgo;
      }
    });
    
    this.logger.debug('Default event filters setup completed');
  }
}