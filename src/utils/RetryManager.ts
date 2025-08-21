/**
 * RetryManager - Retry logic with exponential backoff and various strategies
 */

import { EventEmitter } from 'eventemitter3';
import { Logger } from './Logger';
import { MetricsCollector } from './MetricsCollector';
import { RETRY, DEFAULTS } from '../constants';
import { TimeoutError, RetryError } from '../core/errors';

export enum RetryStrategy {
  FIXED_DELAY = 'fixed_delay',
  EXPONENTIAL_BACKOFF = 'exponential_backoff',
  LINEAR_BACKOFF = 'linear_backoff',
  FIBONACCI_BACKOFF = 'fibonacci_backoff',
  CUSTOM = 'custom'
}

export enum RetryCondition {
  ALWAYS = 'always',
  ON_ERROR = 'on_error',
  ON_TIMEOUT = 'on_timeout',
  ON_NETWORK_ERROR = 'on_network_error',
  CUSTOM = 'custom'
}

interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  strategy: RetryStrategy;
  condition: RetryCondition;
  jitter: boolean;
  jitterFactor: number;
  backoffMultiplier: number;
  timeout?: number;
  enabled: boolean;
  customDelayFn?: (attempt: number, baseDelay: number) => number;
  customConditionFn?: (error: Error, attempt: number) => boolean;
}

interface RetryAttempt {
  attempt: number;
  timestamp: Date;
  delay: number;
  error?: Error;
  success: boolean;
  duration: number;
}

interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: Error;
  attempts: RetryAttempt[];
  totalDuration: number;
  finalAttempt: number;
}

interface RetryStats {
  totalRetries: number;
  successfulRetries: number;
  failedRetries: number;
  averageAttempts: number;
  averageDuration: number;
  lastRetryTime?: Date;
}

interface RetryEvent<T> {
  operationId: string;
  attempt: number;
  maxAttempts: number;
  delay: number;
  error?: Error;
  result?: T;
  timestamp: Date;
}

/**
 * Retry Manager
 */
export class RetryManager extends EventEmitter {
  private readonly config: RetryConfig;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  
  // Statistics
  private stats: RetryStats;
  
  // Active operations
  private activeOperations: Map<string, {
    startTime: Date;
    attempts: RetryAttempt[];
    abortController?: AbortController;
  }> = new Map();
  
  // Fibonacci sequence cache
  private fibonacciCache: number[] = [1, 1];

  constructor(
    config: Partial<RetryConfig>,
    logger: Logger,
    metrics: MetricsCollector
  ) {
    super();

    this.config = {
      maxAttempts: config.maxAttempts || DEFAULTS.RETRY.MAX_ATTEMPTS,
      baseDelay: config.baseDelay || DEFAULTS.RETRY.BASE_DELAY,
      maxDelay: config.maxDelay || DEFAULTS.RETRY.MAX_DELAY,
      strategy: config.strategy || RetryStrategy.EXPONENTIAL_BACKOFF,
      condition: config.condition || RetryCondition.ON_ERROR,
      jitter: config.jitter !== false,
      jitterFactor: config.jitterFactor || DEFAULTS.RETRY.JITTER_FACTOR,
      backoffMultiplier: config.backoffMultiplier || DEFAULTS.RETRY.BACKOFF_MULTIPLIER,
      timeout: config.timeout,
      enabled: config.enabled !== false,
      customDelayFn: config.customDelayFn,
      customConditionFn: config.customConditionFn
    };
    
    this.logger = logger.child({ component: 'RetryManager' });
    this.metrics = metrics;
    
    // Initialize statistics
    this.stats = {
      totalRetries: 0,
      successfulRetries: 0,
      failedRetries: 0,
      averageAttempts: 0,
      averageDuration: 0
    };

    this.logger.info('RetryManager created', {
      config: this.config
    });
  }

  /**
   * Execute a function with retry logic
   */
  async execute<T>(
    fn: () => Promise<T>,
    options?: Partial<RetryConfig>
  ): Promise<T> {
    const operationId = this.generateOperationId();
    const config = { ...this.config, ...options };
    
    if (!config.enabled) {
      return await fn();
    }
    
    const result = await this.executeWithRetry(operationId, fn, config);
    
    if (!result.success) {
      throw result.error || new RetryError(
        `Operation failed after ${result.finalAttempt} attempts`,
        result.attempts
      );
    }
    
    return result.result!;
  }

  /**
   * Execute a function with retry logic and return detailed result
   */
  async executeWithResult<T>(
    fn: () => Promise<T>,
    options?: Partial<RetryConfig>
  ): Promise<RetryResult<T>> {
    const operationId = this.generateOperationId();
    const config = { ...this.config, ...options };
    
    if (!config.enabled) {
      const startTime = Date.now();
      try {
        const result = await fn();
        const duration = Date.now() - startTime;
        
        return {
          success: true,
          result,
          attempts: [{
            attempt: 1,
            timestamp: new Date(),
            delay: 0,
            success: true,
            duration
          }],
          totalDuration: duration,
          finalAttempt: 1
        };
      } catch (error) {
        const duration = Date.now() - startTime;
        
        return {
          success: false,
          error,
          attempts: [{
            attempt: 1,
            timestamp: new Date(),
            delay: 0,
            success: false,
            duration,
            error
          }],
          totalDuration: duration,
          finalAttempt: 1
        };
      }
    }
    
    return await this.executeWithRetry(operationId, fn, config);
  }

  /**
   * Execute a function with timeout
   */
  async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeout: number,
    options?: Partial<RetryConfig>
  ): Promise<T> {
    const config = { ...this.config, ...options, timeout };
    return await this.execute(fn, config);
  }

  /**
   * Create an abortable retry operation
   */
  async executeAbortable<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    options?: Partial<RetryConfig>
  ): Promise<{ result: T; abort: () => void }> {
    const operationId = this.generateOperationId();
    const config = { ...this.config, ...options };
    const abortController = new AbortController();
    
    // Store abort controller
    const operation = this.activeOperations.get(operationId);
    if (operation) {
      operation.abortController = abortController;
    }
    
    const wrappedFn = () => fn(abortController.signal);
    
    try {
      const result = await this.execute(wrappedFn, config);
      return {
        result,
        abort: () => abortController.abort()
      };
    } finally {
      // Clean up
      const op = this.activeOperations.get(operationId);
      if (op) {
        op.abortController = undefined;
      }
    }
  }

  /**
   * Get retry statistics
   */
  getStats(): RetryStats & {
    activeOperations: number;
    isEnabled: boolean;
  } {
    return {
      ...this.stats,
      activeOperations: this.activeOperations.size,
      isEnabled: this.config.enabled
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalRetries: 0,
      successfulRetries: 0,
      failedRetries: 0,
      averageAttempts: 0,
      averageDuration: 0
    };
    
    this.logger.info('RetryManager statistics reset');
  }

  /**
   * Enable/disable retry manager
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    
    this.logger.info('RetryManager enabled state changed', {
      enabled
    });
  }

  /**
   * Update retry configuration
   */
  updateConfig(updates: Partial<RetryConfig>): void {
    Object.assign(this.config, updates);
    
    this.logger.info('RetryManager configuration updated', {
      updates
    });
  }

  /**
   * Abort all active operations
   */
  abortAll(): void {
    for (const [operationId, operation] of this.activeOperations) {
      if (operation.abortController) {
        operation.abortController.abort();
        this.logger.debug('Aborted operation', { operationId });
      }
    }
    
    this.activeOperations.clear();
    
    this.logger.info('All active retry operations aborted');
  }

  /**
   * Execute function with retry logic
   */
  private async executeWithRetry<T>(
    operationId: string,
    fn: () => Promise<T>,
    config: RetryConfig
  ): Promise<RetryResult<T>> {
    const startTime = Date.now();
    const attempts: RetryAttempt[] = [];
    
    // Track operation
    this.activeOperations.set(operationId, {
      startTime: new Date(),
      attempts
    });
    
    try {
      for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
        const attemptStartTime = Date.now();
        
        try {
          // Apply timeout if configured
          let result: T;
          if (config.timeout) {
            result = await this.executeWithTimeoutInternal(fn, config.timeout);
          } else {
            result = await fn();
          }
          
          const duration = Date.now() - attemptStartTime;
          
          // Record successful attempt
          const attemptRecord: RetryAttempt = {
            attempt,
            timestamp: new Date(),
            delay: 0,
            success: true,
            duration
          };
          
          attempts.push(attemptRecord);
          
          // Update statistics
          this.updateStats(true, attempts.length, Date.now() - startTime);
          
          // Emit success event
          this.emit('success', {
            operationId,
            attempt,
            maxAttempts: config.maxAttempts,
            delay: 0,
            result,
            timestamp: new Date()
          } as RetryEvent<T>);
          
          this.logger.debug('Operation succeeded', {
            operationId,
            attempt,
            duration
          });
          
          return {
            success: true,
            result,
            attempts,
            totalDuration: Date.now() - startTime,
            finalAttempt: attempt
          };
          
        } catch (error) {
          const duration = Date.now() - attemptStartTime;
          
          // Record failed attempt
          const attemptRecord: RetryAttempt = {
            attempt,
            timestamp: new Date(),
            delay: 0,
            success: false,
            duration,
            error
          };
          
          attempts.push(attemptRecord);
          
          // Check if we should retry
          const shouldRetry = attempt < config.maxAttempts && 
                             this.shouldRetry(error, attempt, config);
          
          if (!shouldRetry) {
            // Update statistics
            this.updateStats(false, attempts.length, Date.now() - startTime);
            
            // Emit failure event
            this.emit('failure', {
              operationId,
              attempt,
              maxAttempts: config.maxAttempts,
              delay: 0,
              error,
              timestamp: new Date()
            } as RetryEvent<T>);
            
            this.logger.debug('Operation failed, no more retries', {
              operationId,
              attempt,
              maxAttempts: config.maxAttempts,
              error: error.message
            });
            
            return {
              success: false,
              error,
              attempts,
              totalDuration: Date.now() - startTime,
              finalAttempt: attempt
            };
          }
          
          // Calculate delay for next attempt
          const delay = this.calculateDelay(attempt, config);
          attemptRecord.delay = delay;
          
          // Emit retry event
          this.emit('retry', {
            operationId,
            attempt,
            maxAttempts: config.maxAttempts,
            delay,
            error,
            timestamp: new Date()
          } as RetryEvent<T>);
          
          this.logger.debug('Operation failed, retrying', {
            operationId,
            attempt,
            nextAttempt: attempt + 1,
            delay,
            error: error.message
          });
          
          // Wait before next attempt
          if (delay > 0) {
            await this.sleep(delay);
          }
        }
      }
      
      // This should never be reached, but just in case
      const lastError = attempts[attempts.length - 1]?.error;
      return {
        success: false,
        error: lastError || new Error('Maximum attempts reached'),
        attempts,
        totalDuration: Date.now() - startTime,
        finalAttempt: config.maxAttempts
      };
      
    } finally {
      // Clean up
      this.activeOperations.delete(operationId);
      
      // Record metrics
      this.recordMetrics(attempts, Date.now() - startTime);
    }
  }

  /**
   * Execute function with timeout
   */
  private async executeWithTimeoutInternal<T>(
    fn: () => Promise<T>,
    timeout: number
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TimeoutError(`Operation timed out after ${timeout}ms`));
      }, timeout);
      
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => clearTimeout(timer));
    });
  }

  /**
   * Check if operation should be retried
   */
  private shouldRetry(error: Error, attempt: number, config: RetryConfig): boolean {
    switch (config.condition) {
      case RetryCondition.ALWAYS:
        return true;
        
      case RetryCondition.ON_ERROR:
        return true;
        
      case RetryCondition.ON_TIMEOUT:
        return error instanceof TimeoutError;
        
      case RetryCondition.ON_NETWORK_ERROR:
        return this.isNetworkError(error);
        
      case RetryCondition.CUSTOM:
        return config.customConditionFn ? 
               config.customConditionFn(error, attempt) : 
               true;
        
      default:
        return true;
    }
  }

  /**
   * Check if error is a network error
   */
  private isNetworkError(error: Error): boolean {
    const networkErrorCodes = [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ENETUNREACH',
      'EHOSTUNREACH'
    ];
    
    return networkErrorCodes.some(code => 
      error.message.includes(code) || 
      (error as any).code === code
    );
  }

  /**
   * Calculate delay for next attempt
   */
  private calculateDelay(attempt: number, config: RetryConfig): number {
    let delay: number;
    
    switch (config.strategy) {
      case RetryStrategy.FIXED_DELAY:
        delay = config.baseDelay;
        break;
        
      case RetryStrategy.EXPONENTIAL_BACKOFF:
        delay = config.baseDelay * Math.pow(config.backoffMultiplier, attempt - 1);
        break;
        
      case RetryStrategy.LINEAR_BACKOFF:
        delay = config.baseDelay * attempt;
        break;
        
      case RetryStrategy.FIBONACCI_BACKOFF:
        delay = config.baseDelay * this.getFibonacci(attempt);
        break;
        
      case RetryStrategy.CUSTOM:
        delay = config.customDelayFn ? 
                config.customDelayFn(attempt, config.baseDelay) : 
                config.baseDelay;
        break;
        
      default:
        delay = config.baseDelay;
    }
    
    // Apply maximum delay limit
    delay = Math.min(delay, config.maxDelay);
    
    // Apply jitter if enabled
    if (config.jitter) {
      const jitterAmount = delay * config.jitterFactor * Math.random();
      delay += jitterAmount;
    }
    
    return Math.round(delay);
  }

  /**
   * Get Fibonacci number (cached)
   */
  private getFibonacci(n: number): number {
    if (n <= 0) return 1;
    if (n <= 2) return 1;
    
    // Extend cache if needed
    while (this.fibonacciCache.length < n) {
      const len = this.fibonacciCache.length;
      this.fibonacciCache.push(
        this.fibonacciCache[len - 1] + this.fibonacciCache[len - 2]
      );
    }
    
    return this.fibonacciCache[n - 1];
  }

  /**
   * Sleep for specified duration
   */
  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Update statistics
   */
  private updateStats(success: boolean, attempts: number, duration: number): void {
    this.stats.totalRetries++;
    
    if (success) {
      this.stats.successfulRetries++;
    } else {
      this.stats.failedRetries++;
    }
    
    // Update averages using exponential moving average
    const alpha = 0.1;
    
    if (this.stats.averageAttempts === 0) {
      this.stats.averageAttempts = attempts;
    } else {
      this.stats.averageAttempts = 
        this.stats.averageAttempts * (1 - alpha) + attempts * alpha;
    }
    
    if (this.stats.averageDuration === 0) {
      this.stats.averageDuration = duration;
    } else {
      this.stats.averageDuration = 
        this.stats.averageDuration * (1 - alpha) + duration * alpha;
    }
    
    this.stats.lastRetryTime = new Date();
  }

  /**
   * Record metrics
   */
  private recordMetrics(attempts: RetryAttempt[], totalDuration: number): void {
    const finalAttempt = attempts[attempts.length - 1];
    const success = finalAttempt?.success || false;
    
    this.metrics.recordCounter(
      'retry_operations_total',
      1,
      {
        success: success.toString(),
        strategy: this.config.strategy
      }
    );
    
    this.metrics.recordHistogram(
      'retry_attempts_count',
      attempts.length,
      undefined,
      {
        success: success.toString(),
        strategy: this.config.strategy
      }
    );
    
    this.metrics.recordHistogram(
      'retry_operation_duration_ms',
      totalDuration,
      undefined,
      {
        success: success.toString(),
        strategy: this.config.strategy
      }
    );
    
    // Record individual attempt metrics
    for (const attempt of attempts) {
      this.metrics.recordHistogram(
        'retry_attempt_duration_ms',
        attempt.duration,
        undefined,
        {
          attempt: attempt.attempt.toString(),
          success: attempt.success.toString(),
          strategy: this.config.strategy
        }
      );
    }
  }

  /**
   * Generate unique operation ID
   */
  private generateOperationId(): string {
    return `retry-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Shutdown the retry manager
   */
  shutdown(): void {
    this.logger.info('Shutting down RetryManager...');
    
    // Abort all active operations
    this.abortAll();
    
    // Clear data
    this.fibonacciCache = [1, 1];
    
    this.logger.info('RetryManager shutdown completed');
  }
}