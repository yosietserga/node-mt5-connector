/**
 * CircuitBreaker - Circuit breaker pattern implementation for fault tolerance
 */

import { EventEmitter } from 'eventemitter3';
import { Logger } from './Logger';
import { MetricsCollector } from './MetricsCollector';
import { CIRCUIT_BREAKER, DEFAULTS } from '../constants';
import { CircuitBreakerError } from '../core/errors';

export enum CircuitBreakerState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open'
}

interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeout: number;
  monitoringPeriod: number;
  halfOpenMaxCalls: number;
  volumeThreshold: number;
  errorThresholdPercentage: number;
  enabled: boolean;
}

interface CircuitBreakerCall {
  id: string;
  timestamp: Date;
  duration: number;
  success: boolean;
  error?: Error;
}

interface CircuitBreakerStats {
  state: CircuitBreakerState;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  rejectedCalls: number;
  lastFailureTime?: Date;
  lastSuccessTime?: Date;
  failureRate: number;
  averageResponseTime: number;
  stateChanges: number;
  uptime: number;
}

interface StateChangeEvent {
  from: CircuitBreakerState;
  to: CircuitBreakerState;
  timestamp: Date;
  reason: string;
  stats: CircuitBreakerStats;
}

interface CallResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  duration: number;
  timestamp: Date;
}

/**
 * Circuit Breaker
 */
export class CircuitBreaker extends EventEmitter {
  private readonly name: string;
  private readonly config: CircuitBreakerConfig;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  
  private state: CircuitBreakerState = CircuitBreakerState.CLOSED;
  private lastFailureTime?: Date;
  private lastSuccessTime?: Date;
  private stateChangeTime: Date = new Date();
  
  // Call tracking
  private calls: CircuitBreakerCall[] = [];
  private readonly maxCallHistory: number = 1000;
  
  // Statistics
  private totalCalls: number = 0;
  private successfulCalls: number = 0;
  private failedCalls: number = 0;
  private rejectedCalls: number = 0;
  private stateChanges: number = 0;
  
  // Half-open state tracking
  private halfOpenCalls: number = 0;
  
  // Timers
  private recoveryTimer?: NodeJS.Timeout;
  private monitoringTimer?: NodeJS.Timeout;
  
  // Moving averages
  private averageResponseTime: number = 0;
  private readonly responseTimeAlpha: number = 0.1; // EMA factor

  constructor(
    name: string,
    config: Partial<CircuitBreakerConfig>,
    logger: Logger,
    metrics: MetricsCollector
  ) {
    super();

    this.name = name;
    this.config = {
      failureThreshold: config.failureThreshold || DEFAULTS.CIRCUIT_BREAKER.FAILURE_THRESHOLD,
      recoveryTimeout: config.recoveryTimeout || DEFAULTS.CIRCUIT_BREAKER.RECOVERY_TIMEOUT,
      monitoringPeriod: config.monitoringPeriod || DEFAULTS.CIRCUIT_BREAKER.MONITORING_PERIOD,
      halfOpenMaxCalls: config.halfOpenMaxCalls || DEFAULTS.CIRCUIT_BREAKER.HALF_OPEN_MAX_CALLS,
      volumeThreshold: config.volumeThreshold || DEFAULTS.CIRCUIT_BREAKER.VOLUME_THRESHOLD,
      errorThresholdPercentage: config.errorThresholdPercentage || DEFAULTS.CIRCUIT_BREAKER.ERROR_THRESHOLD_PERCENTAGE,
      enabled: config.enabled !== false
    };
    
    this.logger = logger.child({ component: 'CircuitBreaker', name });
    this.metrics = metrics;
    
    // Start monitoring
    this.startMonitoring();

    this.logger.info('CircuitBreaker created', {
      name,
      config: this.config
    });
  }

  /**
   * Execute a function with circuit breaker protection
   */
  async execute<T>(fn: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    if (!this.config.enabled) {
      return await fn();
    }
    
    const callId = this.generateCallId();
    const startTime = Date.now();
    
    try {
      // Check if circuit breaker allows the call
      this.checkState();
      
      // Execute the function
      const result = await fn();
      
      // Record successful call
      const duration = Date.now() - startTime;
      this.recordCall(callId, duration, true);
      
      return result;
      
    } catch (error) {
      // Record failed call
      const duration = Date.now() - startTime;
      this.recordCall(callId, duration, false, error);
      
      // Try fallback if available
      if (fallback) {
        try {
          this.logger.debug('Executing fallback function', {
            name: this.name,
            callId,
            error: error.message
          });
          
          return await fallback();
        } catch (fallbackError) {
          this.logger.error('Fallback function failed', {
            name: this.name,
            callId,
            originalError: error.message,
            fallbackError: fallbackError.message
          });
          
          throw fallbackError;
        }
      }
      
      throw error;
    }
  }

  /**
   * Execute a function and return result with metadata
   */
  async call<T>(fn: () => Promise<T>): Promise<CallResult<T>> {
    const callId = this.generateCallId();
    const startTime = Date.now();
    const timestamp = new Date();
    
    try {
      if (!this.config.enabled) {
        const result = await fn();
        return {
          success: true,
          result,
          duration: Date.now() - startTime,
          timestamp
        };
      }
      
      // Check if circuit breaker allows the call
      this.checkState();
      
      // Execute the function
      const result = await fn();
      
      // Record successful call
      const duration = Date.now() - startTime;
      this.recordCall(callId, duration, true);
      
      return {
        success: true,
        result,
        duration,
        timestamp
      };
      
    } catch (error) {
      // Record failed call
      const duration = Date.now() - startTime;
      this.recordCall(callId, duration, false, error);
      
      return {
        success: false,
        error,
        duration,
        timestamp
      };
    }
  }

  /**
   * Get current circuit breaker state
   */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * Get circuit breaker statistics
   */
  getStats(): CircuitBreakerStats {
    const now = Date.now();
    const uptime = now - this.stateChangeTime.getTime();
    
    return {
      state: this.state,
      totalCalls: this.totalCalls,
      successfulCalls: this.successfulCalls,
      failedCalls: this.failedCalls,
      rejectedCalls: this.rejectedCalls,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
      failureRate: this.calculateFailureRate(),
      averageResponseTime: this.averageResponseTime,
      stateChanges: this.stateChanges,
      uptime
    };
  }

  /**
   * Get recent calls
   */
  getRecentCalls(limit: number = 100): CircuitBreakerCall[] {
    return this.calls.slice(-limit);
  }

  /**
   * Check if circuit breaker is open
   */
  isOpen(): boolean {
    return this.state === CircuitBreakerState.OPEN;
  }

  /**
   * Check if circuit breaker is closed
   */
  isClosed(): boolean {
    return this.state === CircuitBreakerState.CLOSED;
  }

  /**
   * Check if circuit breaker is half-open
   */
  isHalfOpen(): boolean {
    return this.state === CircuitBreakerState.HALF_OPEN;
  }

  /**
   * Manually open the circuit breaker
   */
  open(reason: string = 'manual'): void {
    this.changeState(CircuitBreakerState.OPEN, reason);
  }

  /**
   * Manually close the circuit breaker
   */
  close(reason: string = 'manual'): void {
    this.changeState(CircuitBreakerState.CLOSED, reason);
  }

  /**
   * Manually set circuit breaker to half-open
   */
  halfOpen(reason: string = 'manual'): void {
    this.changeState(CircuitBreakerState.HALF_OPEN, reason);
  }

  /**
   * Reset circuit breaker statistics
   */
  reset(): void {
    this.totalCalls = 0;
    this.successfulCalls = 0;
    this.failedCalls = 0;
    this.rejectedCalls = 0;
    this.stateChanges = 0;
    this.halfOpenCalls = 0;
    this.averageResponseTime = 0;
    this.calls = [];
    this.lastFailureTime = undefined;
    this.lastSuccessTime = undefined;
    
    this.changeState(CircuitBreakerState.CLOSED, 'reset');
    
    this.logger.info('CircuitBreaker reset', { name: this.name });
  }

  /**
   * Enable/disable circuit breaker
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    
    this.logger.info('CircuitBreaker enabled state changed', {
      name: this.name,
      enabled
    });
    
    if (enabled) {
      this.startMonitoring();
    } else {
      this.stopMonitoring();
    }
  }

  /**
   * Check circuit breaker state and determine if call should be allowed
   */
  private checkState(): void {
    switch (this.state) {
      case CircuitBreakerState.CLOSED:
        // Allow all calls in closed state
        break;
        
      case CircuitBreakerState.OPEN:
        // Check if recovery timeout has passed
        if (this.shouldAttemptRecovery()) {
          this.changeState(CircuitBreakerState.HALF_OPEN, 'recovery_timeout');
        } else {
          this.rejectedCalls++;
          this.recordMetrics('rejected');
          throw new CircuitBreakerError(
            `Circuit breaker is OPEN for ${this.name}`,
            this.name,
            this.state
          );
        }
        break;
        
      case CircuitBreakerState.HALF_OPEN:
        // Allow limited calls in half-open state
        if (this.halfOpenCalls >= this.config.halfOpenMaxCalls) {
          this.rejectedCalls++;
          this.recordMetrics('rejected');
          throw new CircuitBreakerError(
            `Circuit breaker is HALF_OPEN and max calls exceeded for ${this.name}`,
            this.name,
            this.state
          );
        }
        this.halfOpenCalls++;
        break;
    }
  }

  /**
   * Record a function call
   */
  private recordCall(id: string, duration: number, success: boolean, error?: Error): void {
    const call: CircuitBreakerCall = {
      id,
      timestamp: new Date(),
      duration,
      success,
      error
    };
    
    // Add to call history
    this.calls.push(call);
    if (this.calls.length > this.maxCallHistory) {
      this.calls.shift();
    }
    
    // Update statistics
    this.totalCalls++;
    
    if (success) {
      this.successfulCalls++;
      this.lastSuccessTime = call.timestamp;
      
      // Handle half-open state success
      if (this.state === CircuitBreakerState.HALF_OPEN) {
        // If we've had enough successful calls, close the circuit
        const recentSuccesses = this.getRecentSuccessCount();
        if (recentSuccesses >= this.config.halfOpenMaxCalls) {
          this.changeState(CircuitBreakerState.CLOSED, 'recovery_success');
        }
      }
    } else {
      this.failedCalls++;
      this.lastFailureTime = call.timestamp;
      
      // Handle half-open state failure
      if (this.state === CircuitBreakerState.HALF_OPEN) {
        this.changeState(CircuitBreakerState.OPEN, 'half_open_failure');
      }
    }
    
    // Update average response time
    this.updateAverageResponseTime(duration);
    
    // Record metrics
    this.recordMetrics(success ? 'success' : 'failure', duration);
    
    // Check if circuit should open
    if (this.state === CircuitBreakerState.CLOSED && this.shouldOpenCircuit()) {
      this.changeState(CircuitBreakerState.OPEN, 'failure_threshold_exceeded');
    }
    
    this.logger.debug('Call recorded', {
      name: this.name,
      callId: id,
      success,
      duration,
      state: this.state,
      error: error?.message
    });
  }

  /**
   * Change circuit breaker state
   */
  private changeState(newState: CircuitBreakerState, reason: string): void {
    if (newState === this.state) {
      return;
    }
    
    const oldState = this.state;
    this.state = newState;
    this.stateChangeTime = new Date();
    this.stateChanges++;
    
    // Reset half-open call counter when leaving half-open state
    if (oldState === CircuitBreakerState.HALF_OPEN) {
      this.halfOpenCalls = 0;
    }
    
    // Setup recovery timer for open state
    if (newState === CircuitBreakerState.OPEN) {
      this.setupRecoveryTimer();
    } else {
      this.clearRecoveryTimer();
    }
    
    const event: StateChangeEvent = {
      from: oldState,
      to: newState,
      timestamp: this.stateChangeTime,
      reason,
      stats: this.getStats()
    };
    
    // Record metrics
    this.metrics.recordCounter(
      'circuit_breaker_state_changes_total',
      1,
      {
        name: this.name,
        from_state: oldState,
        to_state: newState,
        reason
      }
    );
    
    this.metrics.recordGauge(
      'circuit_breaker_state',
      this.getStateValue(newState),
      { name: this.name }
    );
    
    // Emit events
    this.emit('stateChanged', event);
    this.emit(`state:${newState}`, event);
    
    this.logger.info('CircuitBreaker state changed', {
      name: this.name,
      from: oldState,
      to: newState,
      reason
    });
  }

  /**
   * Check if circuit should open
   */
  private shouldOpenCircuit(): boolean {
    const recentCalls = this.getRecentCalls(this.config.volumeThreshold);
    
    // Need minimum volume of calls
    if (recentCalls.length < this.config.volumeThreshold) {
      return false;
    }
    
    // Check failure rate
    const failureRate = this.calculateFailureRate(recentCalls);
    return failureRate >= this.config.errorThresholdPercentage;
  }

  /**
   * Check if should attempt recovery
   */
  private shouldAttemptRecovery(): boolean {
    if (!this.lastFailureTime) {
      return true;
    }
    
    const timeSinceLastFailure = Date.now() - this.lastFailureTime.getTime();
    return timeSinceLastFailure >= this.config.recoveryTimeout;
  }

  /**
   * Calculate failure rate
   */
  private calculateFailureRate(calls?: CircuitBreakerCall[]): number {
    const callsToAnalyze = calls || this.getRecentCalls();
    
    if (callsToAnalyze.length === 0) {
      return 0;
    }
    
    const failures = callsToAnalyze.filter(call => !call.success).length;
    return (failures / callsToAnalyze.length) * 100;
  }

  /**
   * Get recent success count
   */
  private getRecentSuccessCount(): number {
    const recentCalls = this.getRecentCalls(this.config.halfOpenMaxCalls);
    return recentCalls.filter(call => call.success).length;
  }

  /**
   * Update average response time
   */
  private updateAverageResponseTime(duration: number): void {
    if (this.averageResponseTime === 0) {
      this.averageResponseTime = duration;
    } else {
      this.averageResponseTime = 
        this.averageResponseTime * (1 - this.responseTimeAlpha) + 
        duration * this.responseTimeAlpha;
    }
  }

  /**
   * Setup recovery timer
   */
  private setupRecoveryTimer(): void {
    this.clearRecoveryTimer();
    
    this.recoveryTimer = setTimeout(() => {
      if (this.state === CircuitBreakerState.OPEN) {
        this.changeState(CircuitBreakerState.HALF_OPEN, 'recovery_timer');
      }
    }, this.config.recoveryTimeout);
  }

  /**
   * Clear recovery timer
   */
  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
  }

  /**
   * Start monitoring
   */
  private startMonitoring(): void {
    this.stopMonitoring();
    
    this.monitoringTimer = setInterval(() => {
      this.performMonitoring();
    }, this.config.monitoringPeriod);
  }

  /**
   * Stop monitoring
   */
  private stopMonitoring(): void {
    if (this.monitoringTimer) {
      clearInterval(this.monitoringTimer);
      this.monitoringTimer = undefined;
    }
  }

  /**
   * Perform monitoring tasks
   */
  private performMonitoring(): void {
    try {
      // Clean old calls
      this.cleanOldCalls();
      
      // Record current metrics
      this.recordCurrentMetrics();
      
      // Check for state changes
      this.checkStateConditions();
      
    } catch (error) {
      this.logger.error('Error during monitoring', {
        name: this.name,
        error
      });
    }
  }

  /**
   * Clean old calls from history
   */
  private cleanOldCalls(): void {
    const cutoffTime = Date.now() - (this.config.monitoringPeriod * 10); // Keep 10 periods
    this.calls = this.calls.filter(call => call.timestamp.getTime() > cutoffTime);
  }

  /**
   * Record current metrics
   */
  private recordCurrentMetrics(): void {
    const stats = this.getStats();
    
    this.metrics.recordGauge(
      'circuit_breaker_state',
      this.getStateValue(this.state),
      { name: this.name }
    );
    
    this.metrics.recordGauge(
      'circuit_breaker_failure_rate',
      stats.failureRate,
      { name: this.name }
    );
    
    this.metrics.recordGauge(
      'circuit_breaker_total_calls',
      stats.totalCalls,
      { name: this.name }
    );
    
    this.metrics.recordGauge(
      'circuit_breaker_average_response_time',
      stats.averageResponseTime,
      { name: this.name }
    );
  }

  /**
   * Check state conditions
   */
  private checkStateConditions(): void {
    // Additional state checking logic can be added here
    // For example, automatic state transitions based on time or conditions
  }

  /**
   * Record metrics for a call
   */
  private recordMetrics(type: 'success' | 'failure' | 'rejected', duration?: number): void {
    this.metrics.recordCounter(
      'circuit_breaker_calls_total',
      1,
      {
        name: this.name,
        type,
        state: this.state
      }
    );
    
    if (duration !== undefined) {
      this.metrics.recordHistogram(
        'circuit_breaker_call_duration_ms',
        duration,
        undefined,
        {
          name: this.name,
          type,
          state: this.state
        }
      );
    }
  }

  /**
   * Get numeric value for state (for metrics)
   */
  private getStateValue(state: CircuitBreakerState): number {
    switch (state) {
      case CircuitBreakerState.CLOSED:
        return 0;
      case CircuitBreakerState.HALF_OPEN:
        return 1;
      case CircuitBreakerState.OPEN:
        return 2;
      default:
        return -1;
    }
  }

  /**
   * Generate unique call ID
   */
  private generateCallId(): string {
    return `${this.name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Shutdown the circuit breaker
   */
  shutdown(): void {
    this.logger.info('Shutting down CircuitBreaker', { name: this.name });
    
    this.stopMonitoring();
    this.clearRecoveryTimer();
    
    // Clear data
    this.calls = [];
    
    this.logger.info('CircuitBreaker shutdown completed', { name: this.name });
  }
}