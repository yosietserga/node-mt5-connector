/**
 * ConnectionGateway - Manages ZeroMQ connections and communication with MT5 terminal
 */

import { EventEmitter } from 'eventemitter3';
import * as zmq from 'zeromq';
import { MT5ConnectorConfig, ZMQMessage, MessageType } from '../types';
import { SecurityManager } from '../security/SecurityManager';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { RetryManager } from '../utils/RetryManager';
import { ConnectionError, TimeoutError } from './errors';
import { DEFAULTS, ZMQ_PATTERNS, MESSAGE_TYPES } from '../constants';
import { v4 as uuidv4 } from 'uuid';

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  timestamp: number;
}

/**
 * Connection Gateway for managing ZeroMQ communication
 */
export class ConnectionGateway extends EventEmitter {
  private readonly config: MT5ConnectorConfig;
  private readonly securityManager: SecurityManager;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private readonly retryManager: RetryManager;
  
  // ZeroMQ sockets
  private reqSocket: zmq.Request | null = null;
  private subSocket: zmq.Subscriber | null = null;
  private pushSocket: zmq.Push | null = null;
  
  // Connection state
  private isConnected: boolean = false;
  private isInitialized: boolean = false;
  private connectionStartTime: Date | null = null;
  private reconnectCount: number = 0;
  
  // Request management
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestTimeout: number;
  
  // Connection pool
  private connectionPool: Map<string, zmq.Socket> = new Map();
  private maxConnections: number;
  
  // Heartbeat
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastHeartbeat: Date | null = null;

  constructor(
    config: MT5ConnectorConfig,
    securityManager: SecurityManager,
    logger: Logger,
    metrics: MetricsCollector
  ) {
    super();

    this.config = config;
    this.securityManager = securityManager;
    this.logger = logger.child({ component: 'ConnectionGateway' });
    this.metrics = metrics;
    
    this.requestTimeout = config.performance?.requestTimeout || DEFAULTS.PERFORMANCE.REQUEST_TIMEOUT;
    this.maxConnections = config.performance?.maxConnections || DEFAULTS.PERFORMANCE.MAX_CONNECTIONS;
    
    this.retryManager = new RetryManager({
      maxRetries: config.performance?.maxRetries || DEFAULTS.RETRY.MAX_RETRIES,
      baseDelay: config.performance?.retryDelay || DEFAULTS.RETRY.BASE_DELAY,
      maxDelay: DEFAULTS.RETRY.MAX_DELAY,
      backoffFactor: DEFAULTS.RETRY.BACKOFF_FACTOR
    });

    this.logger.info('ConnectionGateway created', {
      host: config.host,
      port: config.port,
      requestTimeout: this.requestTimeout,
      maxConnections: this.maxConnections
    });
  }

  /**
   * Initialize the connection gateway
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('ConnectionGateway is already initialized');
    }

    try {
      this.logger.info('Initializing ConnectionGateway...');
      this.metrics.startTimer('gateway_initialization');

      // Initialize ZeroMQ sockets
      await this.initializeSockets();
      
      // Setup socket event handlers
      this.setupSocketEventHandlers();
      
      this.isInitialized = true;
      this.metrics.endTimer('gateway_initialization');
      
      this.logger.info('ConnectionGateway initialized successfully');
      
    } catch (error) {
      this.metrics.endTimer('gateway_initialization');
      this.logger.error('Failed to initialize ConnectionGateway', { error });
      throw new ConnectionError(`Initialization failed: ${error.message}`);
    }
  }

  /**
   * Connect to MT5 terminal
   */
  async connect(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('ConnectionGateway must be initialized before connecting');
    }

    if (this.isConnected) {
      this.logger.warn('Already connected to MT5 terminal');
      return;
    }

    try {
      this.logger.info('Connecting to MT5 terminal...', {
        host: this.config.host,
        port: this.config.port
      });
      
      this.metrics.startTimer('connection_establishment');
      
      await this.retryManager.execute(async () => {
        await this.establishConnections();
      });
      
      // Start heartbeat
      this.startHeartbeat();
      
      this.isConnected = true;
      this.connectionStartTime = new Date();
      this.metrics.endTimer('connection_establishment');
      this.metrics.recordMetric('connection_status', 1);
      
      this.logger.info('Successfully connected to MT5 terminal');
      this.emit('connected');
      
    } catch (error) {
      this.metrics.endTimer('connection_establishment');
      this.metrics.recordMetric('connection_status', 0);
      this.logger.error('Failed to connect to MT5 terminal', { error });
      throw new ConnectionError(`Connection failed: ${error.message}`);
    }
  }

  /**
   * Disconnect from MT5 terminal
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      this.logger.warn('Not connected to MT5 terminal');
      return;
    }

    try {
      this.logger.info('Disconnecting from MT5 terminal...');
      
      // Stop heartbeat
      this.stopHeartbeat();
      
      // Reject all pending requests
      this.rejectPendingRequests(new ConnectionError('Connection closed'));
      
      // Close sockets
      await this.closeSockets();
      
      this.isConnected = false;
      this.connectionStartTime = null;
      this.metrics.recordMetric('connection_status', 0);
      
      this.logger.info('Disconnected from MT5 terminal');
      this.emit('disconnected');
      
    } catch (error) {
      this.logger.error('Error during disconnection', { error });
      throw new ConnectionError(`Disconnection failed: ${error.message}`);
    }
  }

  /**
   * Send a request and wait for response
   */
  async sendRequest(message: ZMQMessage): Promise<any> {
    if (!this.isConnected || !this.reqSocket) {
      throw new ConnectionError('Not connected to MT5 terminal');
    }

    const requestId = uuidv4();
    const requestMessage = {
      ...message,
      id: requestId,
      timestamp: Date.now()
    };

    try {
      this.logger.debug('Sending request', {
        requestId,
        type: message.type,
        action: message.action
      });
      
      this.metrics.startTimer('request_processing');
      
      // Encrypt message if security is enabled
      const encryptedMessage = await this.securityManager.encryptMessage(requestMessage);
      
      // Send request
      await this.reqSocket.send(JSON.stringify(encryptedMessage));
      
      // Wait for response
      const response = await this.waitForResponse(requestId);
      
      this.metrics.endTimer('request_processing');
      this.metrics.recordMetric('requests_sent', 1);
      
      this.logger.debug('Request completed', {
        requestId,
        responseType: response.type
      });
      
      return response;
      
    } catch (error) {
      this.metrics.endTimer('request_processing');
      this.metrics.recordMetric('request_errors', 1);
      this.logger.error('Request failed', {
        requestId,
        error,
        message: message.type
      });
      throw error;
    }
  }

  /**
   * Send a message without waiting for response (fire and forget)
   */
  async sendMessage(message: ZMQMessage): Promise<void> {
    if (!this.isConnected || !this.pushSocket) {
      throw new ConnectionError('Not connected to MT5 terminal');
    }

    try {
      this.logger.debug('Sending message', {
        type: message.type,
        action: message.action
      });
      
      // Encrypt message if security is enabled
      const encryptedMessage = await this.securityManager.encryptMessage(message);
      
      // Send message
      await this.pushSocket.send(JSON.stringify(encryptedMessage));
      
      this.metrics.recordMetric('messages_sent', 1);
      
    } catch (error) {
      this.metrics.recordMetric('message_errors', 1);
      this.logger.error('Failed to send message', { error, message: message.type });
      throw error;
    }
  }

  /**
   * Subscribe to events
   */
  async subscribe(topics: string[]): Promise<void> {
    if (!this.isConnected || !this.subSocket) {
      throw new ConnectionError('Not connected to MT5 terminal');
    }

    try {
      this.logger.info('Subscribing to topics', { topics });
      
      for (const topic of topics) {
        this.subSocket.subscribe(topic);
      }
      
      this.logger.info('Successfully subscribed to topics', { topics });
      
    } catch (error) {
      this.logger.error('Failed to subscribe to topics', { error, topics });
      throw error;
    }
  }

  /**
   * Unsubscribe from events
   */
  async unsubscribe(topics: string[]): Promise<void> {
    if (!this.isConnected || !this.subSocket) {
      throw new ConnectionError('Not connected to MT5 terminal');
    }

    try {
      this.logger.info('Unsubscribing from topics', { topics });
      
      for (const topic of topics) {
        this.subSocket.unsubscribe(topic);
      }
      
      this.logger.info('Successfully unsubscribed from topics', { topics });
      
    } catch (error) {
      this.logger.error('Failed to unsubscribe from topics', { error, topics });
      throw error;
    }
  }

  /**
   * Check if connected
   */
  isConnectionActive(): boolean {
    return this.isConnected;
  }

  /**
   * Get connection uptime in milliseconds
   */
  getUptime(): number {
    if (!this.connectionStartTime) {
      return 0;
    }
    return Date.now() - this.connectionStartTime.getTime();
  }

  /**
   * Get reconnection count
   */
  getReconnectCount(): number {
    return this.reconnectCount;
  }

  /**
   * Get connection metrics
   */
  getMetrics(): any {
    return {
      isConnected: this.isConnected,
      uptime: this.getUptime(),
      reconnectCount: this.reconnectCount,
      pendingRequests: this.pendingRequests.size,
      lastHeartbeat: this.lastHeartbeat,
      connectionPool: this.connectionPool.size
    };
  }

  /**
   * Shutdown the gateway
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down ConnectionGateway...');
      
      if (this.isConnected) {
        await this.disconnect();
      }
      
      // Clear connection pool
      for (const [key, socket] of this.connectionPool) {
        try {
          socket.close();
        } catch (error) {
          this.logger.warn('Error closing pooled socket', { key, error });
        }
      }
      this.connectionPool.clear();
      
      this.isInitialized = false;
      
      this.logger.info('ConnectionGateway shutdown completed');
      
    } catch (error) {
      this.logger.error('Error during gateway shutdown', { error });
      throw error;
    }
  }

  /**
   * Initialize ZeroMQ sockets
   */
  private async initializeSockets(): Promise<void> {
    try {
      // Request-Reply socket for synchronous communication
      this.reqSocket = new zmq.Request({
        linger: 0,
        receiveTimeout: this.requestTimeout,
        sendTimeout: this.requestTimeout
      });
      
      // Subscriber socket for receiving events
      this.subSocket = new zmq.Subscriber({
        linger: 0
      });
      
      // Push socket for sending fire-and-forget messages
      this.pushSocket = new zmq.Push({
        linger: 0,
        sendTimeout: this.requestTimeout
      });
      
      // Configure CURVE security if enabled
      if (this.config.security.enableEncryption) {
        await this.configureCurveSecurity();
      }
      
      this.logger.info('ZeroMQ sockets initialized');
      
    } catch (error) {
      this.logger.error('Failed to initialize sockets', { error });
      throw error;
    }
  }

  /**
   * Configure CURVE security for sockets
   */
  private async configureCurveSecurity(): Promise<void> {
    try {
      const { curveServerPublicKey, curveClientSecretKey, curveClientPublicKey } = this.config.security;
      
      if (!curveServerPublicKey || !curveClientSecretKey || !curveClientPublicKey) {
        throw new Error('CURVE keys are required for encryption');
      }
      
      // Configure REQ socket
      if (this.reqSocket) {
        this.reqSocket.curveServerKey = curveServerPublicKey;
        this.reqSocket.curveSecretKey = curveClientSecretKey;
        this.reqSocket.curvePublicKey = curveClientPublicKey;
      }
      
      // Configure SUB socket
      if (this.subSocket) {
        this.subSocket.curveServerKey = curveServerPublicKey;
        this.subSocket.curveSecretKey = curveClientSecretKey;
        this.subSocket.curvePublicKey = curveClientPublicKey;
      }
      
      // Configure PUSH socket
      if (this.pushSocket) {
        this.pushSocket.curveServerKey = curveServerPublicKey;
        this.pushSocket.curveSecretKey = curveClientSecretKey;
        this.pushSocket.curvePublicKey = curveClientPublicKey;
      }
      
      this.logger.info('CURVE security configured for all sockets');
      
    } catch (error) {
      this.logger.error('Failed to configure CURVE security', { error });
      throw error;
    }
  }

  /**
   * Establish connections to MT5 terminal
   */
  private async establishConnections(): Promise<void> {
    const baseUrl = `tcp://${this.config.host}`;
    
    try {
      // Connect REQ socket
      if (this.reqSocket) {
        await this.reqSocket.connect(`${baseUrl}:${this.config.port}`);
        this.logger.debug('REQ socket connected', { port: this.config.port });
      }
      
      // Connect SUB socket
      if (this.subSocket) {
        const subPort = this.config.port + 1; // Convention: SUB port is REQ port + 1
        await this.subSocket.connect(`${baseUrl}:${subPort}`);
        this.logger.debug('SUB socket connected', { port: subPort });
      }
      
      // Connect PUSH socket
      if (this.pushSocket) {
        const pushPort = this.config.port + 2; // Convention: PUSH port is REQ port + 2
        await this.pushSocket.connect(`${baseUrl}:${pushPort}`);
        this.logger.debug('PUSH socket connected', { port: pushPort });
      }
      
      this.logger.info('All sockets connected successfully');
      
    } catch (error) {
      this.logger.error('Failed to establish connections', { error });
      throw error;
    }
  }

  /**
   * Setup socket event handlers
   */
  private setupSocketEventHandlers(): void {
    // REQ socket events
    if (this.reqSocket) {
      this.reqSocket.events.on('message', async (message) => {
        await this.handleResponse(message);
      });
      
      this.reqSocket.events.on('error', (error) => {
        this.logger.error('REQ socket error', { error });
        this.emit('error', error);
      });
    }
    
    // SUB socket events
    if (this.subSocket) {
      this.subSocket.events.on('message', async (topic, message) => {
        await this.handleSubscriptionMessage(topic, message);
      });
      
      this.subSocket.events.on('error', (error) => {
        this.logger.error('SUB socket error', { error });
        this.emit('error', error);
      });
    }
    
    // PUSH socket events
    if (this.pushSocket) {
      this.pushSocket.events.on('error', (error) => {
        this.logger.error('PUSH socket error', { error });
        this.emit('error', error);
      });
    }
  }

  /**
   * Handle response from REQ socket
   */
  private async handleResponse(message: Buffer): Promise<void> {
    try {
      const responseText = message.toString();
      const encryptedResponse = JSON.parse(responseText);
      
      // Decrypt message if security is enabled
      const response = await this.securityManager.decryptMessage(encryptedResponse);
      
      const requestId = response.id;
      const pendingRequest = this.pendingRequests.get(requestId);
      
      if (pendingRequest) {
        clearTimeout(pendingRequest.timeout);
        this.pendingRequests.delete(requestId);
        
        if (response.error) {
          pendingRequest.reject(new Error(response.error));
        } else {
          pendingRequest.resolve(response);
        }
      } else {
        this.logger.warn('Received response for unknown request', { requestId });
      }
      
    } catch (error) {
      this.logger.error('Failed to handle response', { error });
    }
  }

  /**
   * Handle subscription message from SUB socket
   */
  private async handleSubscriptionMessage(topic: Buffer, message: Buffer): Promise<void> {
    try {
      const topicStr = topic.toString();
      const messageText = message.toString();
      const encryptedMessage = JSON.parse(messageText);
      
      // Decrypt message if security is enabled
      const decryptedMessage = await this.securityManager.decryptMessage(encryptedMessage);
      
      this.logger.debug('Received subscription message', {
        topic: topicStr,
        type: decryptedMessage.type
      });
      
      this.emit('message', {
        topic: topicStr,
        message: decryptedMessage
      });
      
      this.metrics.recordMetric('messages_received', 1);
      
    } catch (error) {
      this.logger.error('Failed to handle subscription message', { error });
    }
  }

  /**
   * Wait for response to a request
   */
  private async waitForResponse(requestId: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new TimeoutError(`Request timeout after ${this.requestTimeout}ms`));
      }, this.requestTimeout);
      
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
        timestamp: Date.now()
      });
    });
  }

  /**
   * Reject all pending requests
   */
  private rejectPendingRequests(error: Error): void {
    for (const [requestId, pendingRequest] of this.pendingRequests) {
      clearTimeout(pendingRequest.timeout);
      pendingRequest.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Close all sockets
   */
  private async closeSockets(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    
    if (this.reqSocket) {
      closePromises.push(this.reqSocket.close());
      this.reqSocket = null;
    }
    
    if (this.subSocket) {
      closePromises.push(this.subSocket.close());
      this.subSocket = null;
    }
    
    if (this.pushSocket) {
      closePromises.push(this.pushSocket.close());
      this.pushSocket = null;
    }
    
    await Promise.all(closePromises);
    this.logger.info('All sockets closed');
  }

  /**
   * Start heartbeat mechanism
   */
  private startHeartbeat(): void {
    const heartbeatInterval = this.config.performance?.heartbeatInterval || DEFAULTS.PERFORMANCE.HEARTBEAT_INTERVAL;
    
    this.heartbeatInterval = setInterval(async () => {
      try {
        await this.sendHeartbeat();
      } catch (error) {
        this.logger.error('Heartbeat failed', { error });
        this.handleConnectionLoss();
      }
    }, heartbeatInterval);
    
    this.logger.debug('Heartbeat started', { interval: heartbeatInterval });
  }

  /**
   * Stop heartbeat mechanism
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      this.logger.debug('Heartbeat stopped');
    }
  }

  /**
   * Send heartbeat message
   */
  private async sendHeartbeat(): Promise<void> {
    const heartbeatMessage: ZMQMessage = {
      type: MESSAGE_TYPES.HEARTBEAT,
      action: 'ping',
      data: { timestamp: Date.now() }
    };
    
    await this.sendRequest(heartbeatMessage);
    this.lastHeartbeat = new Date();
    this.metrics.recordMetric('heartbeats_sent', 1);
  }

  /**
   * Handle connection loss
   */
  private handleConnectionLoss(): void {
    this.logger.warn('Connection loss detected, attempting reconnection...');
    this.isConnected = false;
    this.reconnectCount++;
    
    this.emit('disconnected');
    
    // Attempt reconnection
    this.attemptReconnection();
  }

  /**
   * Attempt to reconnect
   */
  private async attemptReconnection(): Promise<void> {
    try {
      await this.retryManager.execute(async () => {
        await this.establishConnections();
      });
      
      this.isConnected = true;
      this.startHeartbeat();
      
      this.logger.info('Reconnection successful');
      this.emit('reconnected');
      
    } catch (error) {
      this.logger.error('Reconnection failed', { error });
      this.emit('error', new ConnectionError(`Reconnection failed: ${error.message}`));
    }
  }

  /**
   * Alias for isConnectionActive for backward compatibility
   */
  isConnected(): boolean {
    return this.isConnectionActive();
  }
}