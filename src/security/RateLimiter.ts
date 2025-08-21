/**
 * RateLimiter - Implements rate limiting using token bucket and sliding window algorithms
 */

import { EventEmitter } from 'eventemitter3';
import {
  RateLimitConfig,
  RateLimitAlgorithm
} from '../types';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { RateLimitError } from '../core/errors';
import { RATE_LIMITING, DEFAULTS } from '../constants';

interface RateLimitRule {
  id: string;
  name: string;
  algorithm: RateLimitAlgorithm;
  windowSize: number; // in milliseconds
  maxRequests: number;
  burstSize?: number; // for token bucket
  refillRate?: number; // tokens per second for token bucket
  enabled: boolean;
  priority: number; // higher number = higher priority
}

interface TokenBucketState {
  tokens: number;
  lastRefill: number;
}

interface SlidingWindowState {
  requests: number[];
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
  rule?: RateLimitRule;
}

interface RateLimitMetrics {
  totalRequests: number;
  allowedRequests: number;
  blockedRequests: number;
  ruleViolations: Map<string, number>;
  averageResponseTime: number;
}

/**
 * Rate Limiter
 */
export class RateLimiter extends EventEmitter {
  private readonly config: RateLimitConfig;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  
  private isInitialized: boolean = false;
  private rules: Map<string, RateLimitRule> = new Map();
  
  // State storage for different algorithms
  private tokenBuckets: Map<string, TokenBucketState> = new Map();
  private slidingWindows: Map<string, SlidingWindowState> = new Map();
  
  // Client-specific state
  private clientStates: Map<string, Map<string, any>> = new Map();
  
  // Metrics
  private rateLimitMetrics: RateLimitMetrics;
  
  // Cleanup timer
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    config: RateLimitConfig,
    logger: Logger,
    metrics: MetricsCollector
  ) {
    super();

    this.config = config;
    this.logger = logger.child({ component: 'RateLimiter' });
    this.metrics = metrics;
    
    // Initialize metrics
    this.rateLimitMetrics = {
      totalRequests: 0,
      allowedRequests: 0,
      blockedRequests: 0,
      ruleViolations: new Map(),
      averageResponseTime: 0
    };

    this.logger.info('RateLimiter created', {
      enabled: config.enabled,
      defaultAlgorithm: config.defaultAlgorithm
    });
  }

  /**
   * Initialize the Rate Limiter
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('RateLimiter is already initialized');
    }

    if (!this.config.enabled) {
      this.logger.info('Rate limiting is disabled');
      this.isInitialized = true;
      return;
    }

    try {
      this.logger.info('Initializing RateLimiter...');
      this.metrics.startTimer('rate_limiter_initialization');

      // Load default rules
      this.loadDefaultRules();
      
      // Load custom rules from configuration
      if (this.config.rules) {
        for (const rule of this.config.rules) {
          this.addRule(rule);
        }
      }
      
      // Start cleanup timer
      this.startCleanupTimer();
      
      this.isInitialized = true;
      this.metrics.endTimer('rate_limiter_initialization');
      
      this.logger.info('RateLimiter initialized successfully', {
        ruleCount: this.rules.size
      });
      
    } catch (error) {
      this.metrics.endTimer('rate_limiter_initialization');
      this.logger.error('Failed to initialize RateLimiter', { error });
      throw error;
    }
  }

  /**
   * Check if request is allowed
   */
  async checkLimit(
    clientId: string,
    resource: string = 'default',
    weight: number = 1
  ): Promise<RateLimitResult> {
    this.validateInitialized();
    
    if (!this.config.enabled) {
      return {
        allowed: true,
        remaining: Infinity,
        resetTime: 0
      };
    }

    const startTime = Date.now();
    
    try {
      this.rateLimitMetrics.totalRequests++;
      
      // Find applicable rules for this resource
      const applicableRules = this.getApplicableRules(resource);
      
      if (applicableRules.length === 0) {
        this.rateLimitMetrics.allowedRequests++;
        return {
          allowed: true,
          remaining: Infinity,
          resetTime: 0
        };
      }
      
      // Check each rule (sorted by priority)
      for (const rule of applicableRules) {
        const result = await this.checkRule(clientId, rule, weight);
        
        if (!result.allowed) {
          this.rateLimitMetrics.blockedRequests++;
          this.recordRuleViolation(rule.id);
          
          this.logger.warn('Rate limit exceeded', {
            clientId,
            resource,
            rule: rule.name,
            remaining: result.remaining,
            resetTime: result.resetTime
          });
          
          this.emit('rateLimitExceeded', {
            clientId,
            resource,
            rule: rule.name,
            remaining: result.remaining,
            resetTime: result.resetTime
          });
          
          return {
            ...result,
            rule
          };
        }
      }
      
      // All rules passed
      this.rateLimitMetrics.allowedRequests++;
      
      // Update metrics
      const responseTime = Date.now() - startTime;
      this.updateAverageResponseTime(responseTime);
      
      this.logger.debug('Rate limit check passed', {
        clientId,
        resource,
        weight,
        responseTime
      });
      
      return {
        allowed: true,
        remaining: this.getRemainingRequests(clientId, applicableRules[0]),
        resetTime: this.getResetTime(clientId, applicableRules[0])
      };
      
    } catch (error) {
      this.logger.error('Rate limit check failed', { error, clientId, resource });
      throw error;
    }
  }

  /**
   * Add a new rate limit rule
   */
  addRule(ruleConfig: {
    id?: string;
    name: string;
    algorithm?: RateLimitAlgorithm;
    windowSize: number;
    maxRequests: number;
    burstSize?: number;
    refillRate?: number;
    enabled?: boolean;
    priority?: number;
  }): void {
    const rule: RateLimitRule = {
      id: ruleConfig.id || this.generateRuleId(),
      name: ruleConfig.name,
      algorithm: ruleConfig.algorithm || this.config.defaultAlgorithm || 'sliding_window',
      windowSize: ruleConfig.windowSize,
      maxRequests: ruleConfig.maxRequests,
      burstSize: ruleConfig.burstSize,
      refillRate: ruleConfig.refillRate,
      enabled: ruleConfig.enabled !== false,
      priority: ruleConfig.priority || 0
    };
    
    this.rules.set(rule.id, rule);
    
    this.logger.info('Rate limit rule added', {
      id: rule.id,
      name: rule.name,
      algorithm: rule.algorithm,
      maxRequests: rule.maxRequests,
      windowSize: rule.windowSize
    });
  }

  /**
   * Remove a rate limit rule
   */
  removeRule(ruleId: string): void {
    const rule = this.rules.get(ruleId);
    if (rule) {
      this.rules.delete(ruleId);
      
      // Clean up associated state
      this.cleanupRuleState(ruleId);
      
      this.logger.info('Rate limit rule removed', {
        id: ruleId,
        name: rule.name
      });
    }
  }

  /**
   * Update a rate limit rule
   */
  updateRule(ruleId: string, updates: Partial<RateLimitRule>): void {
    const rule = this.rules.get(ruleId);
    if (!rule) {
      throw new Error(`Rate limit rule not found: ${ruleId}`);
    }
    
    Object.assign(rule, updates);
    
    this.logger.info('Rate limit rule updated', {
      id: ruleId,
      name: rule.name,
      updates
    });
  }

  /**
   * Get rate limit rule
   */
  getRule(ruleId: string): RateLimitRule | undefined {
    return this.rules.get(ruleId);
  }

  /**
   * Get all rate limit rules
   */
  getRules(): RateLimitRule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Reset rate limit for a client
   */
  resetClient(clientId: string): void {
    this.clientStates.delete(clientId);
    
    this.logger.info('Rate limit reset for client', { clientId });
    
    this.emit('clientReset', { clientId });
  }

  /**
   * Get rate limit status for a client
   */
  getClientStatus(clientId: string): {
    rules: Array<{
      id: string;
      name: string;
      remaining: number;
      resetTime: number;
      algorithm: RateLimitAlgorithm;
    }>;
  } {
    const rules = Array.from(this.rules.values())
      .filter(rule => rule.enabled)
      .map(rule => ({
        id: rule.id,
        name: rule.name,
        remaining: this.getRemainingRequests(clientId, rule),
        resetTime: this.getResetTime(clientId, rule),
        algorithm: rule.algorithm
      }));
    
    return { rules };
  }

  /**
   * Get rate limiting metrics
   */
  getMetrics(): RateLimitMetrics & {
    ruleCount: number;
    clientCount: number;
    isInitialized: boolean;
    isEnabled: boolean;
  } {
    return {
      ...this.rateLimitMetrics,
      ruleCount: this.rules.size,
      clientCount: this.clientStates.size,
      isInitialized: this.isInitialized,
      isEnabled: this.config.enabled
    };
  }

  /**
   * Check a specific rule
   */
  private async checkRule(
    clientId: string,
    rule: RateLimitRule,
    weight: number
  ): Promise<RateLimitResult> {
    if (!rule.enabled) {
      return {
        allowed: true,
        remaining: rule.maxRequests,
        resetTime: 0
      };
    }
    
    switch (rule.algorithm) {
      case 'token_bucket':
        return this.checkTokenBucket(clientId, rule, weight);
        
      case 'sliding_window':
        return this.checkSlidingWindow(clientId, rule, weight);
        
      case 'fixed_window':
        return this.checkFixedWindow(clientId, rule, weight);
        
      default:
        throw new Error(`Unsupported rate limit algorithm: ${rule.algorithm}`);
    }
  }

  /**
   * Check token bucket algorithm
   */
  private checkTokenBucket(
    clientId: string,
    rule: RateLimitRule,
    weight: number
  ): RateLimitResult {
    const bucketKey = `${clientId}:${rule.id}`;
    const now = Date.now();
    
    let bucket = this.tokenBuckets.get(bucketKey);
    
    if (!bucket) {
      bucket = {
        tokens: rule.burstSize || rule.maxRequests,
        lastRefill: now
      };
      this.tokenBuckets.set(bucketKey, bucket);
    }
    
    // Refill tokens
    const refillRate = rule.refillRate || (rule.maxRequests / (rule.windowSize / 1000));
    const timePassed = (now - bucket.lastRefill) / 1000;
    const tokensToAdd = Math.floor(timePassed * refillRate);
    
    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(
        rule.burstSize || rule.maxRequests,
        bucket.tokens + tokensToAdd
      );
      bucket.lastRefill = now;
    }
    
    // Check if enough tokens available
    if (bucket.tokens >= weight) {
      bucket.tokens -= weight;
      
      return {
        allowed: true,
        remaining: bucket.tokens,
        resetTime: now + ((rule.burstSize || rule.maxRequests) - bucket.tokens) / refillRate * 1000
      };
    } else {
      const retryAfter = (weight - bucket.tokens) / refillRate * 1000;
      
      return {
        allowed: false,
        remaining: bucket.tokens,
        resetTime: now + retryAfter,
        retryAfter
      };
    }
  }

  /**
   * Check sliding window algorithm
   */
  private checkSlidingWindow(
    clientId: string,
    rule: RateLimitRule,
    weight: number
  ): RateLimitResult {
    const windowKey = `${clientId}:${rule.id}`;
    const now = Date.now();
    const windowStart = now - rule.windowSize;
    
    let window = this.slidingWindows.get(windowKey);
    
    if (!window) {
      window = { requests: [] };
      this.slidingWindows.set(windowKey, window);
    }
    
    // Remove old requests
    window.requests = window.requests.filter(timestamp => timestamp > windowStart);
    
    // Count current requests
    const currentRequests = window.requests.reduce((sum, timestamp) => {
      // Assuming each request has weight 1, in real implementation
      // you might store weight with timestamp
      return sum + 1;
    }, 0);
    
    if (currentRequests + weight <= rule.maxRequests) {
      // Add current request timestamps (weight times)
      for (let i = 0; i < weight; i++) {
        window.requests.push(now);
      }
      
      return {
        allowed: true,
        remaining: rule.maxRequests - currentRequests - weight,
        resetTime: window.requests[0] + rule.windowSize
      };
    } else {
      const oldestRequest = window.requests[0] || now;
      const retryAfter = oldestRequest + rule.windowSize - now;
      
      return {
        allowed: false,
        remaining: rule.maxRequests - currentRequests,
        resetTime: oldestRequest + rule.windowSize,
        retryAfter: Math.max(0, retryAfter)
      };
    }
  }

  /**
   * Check fixed window algorithm
   */
  private checkFixedWindow(
    clientId: string,
    rule: RateLimitRule,
    weight: number
  ): RateLimitResult {
    const windowKey = `${clientId}:${rule.id}`;
    const now = Date.now();
    const windowStart = Math.floor(now / rule.windowSize) * rule.windowSize;
    const windowEnd = windowStart + rule.windowSize;
    
    let clientState = this.clientStates.get(clientId);
    if (!clientState) {
      clientState = new Map();
      this.clientStates.set(clientId, clientState);
    }
    
    let windowData = clientState.get(windowKey);
    if (!windowData || windowData.windowStart !== windowStart) {
      windowData = {
        windowStart,
        requests: 0
      };
      clientState.set(windowKey, windowData);
    }
    
    if (windowData.requests + weight <= rule.maxRequests) {
      windowData.requests += weight;
      
      return {
        allowed: true,
        remaining: rule.maxRequests - windowData.requests,
        resetTime: windowEnd
      };
    } else {
      return {
        allowed: false,
        remaining: rule.maxRequests - windowData.requests,
        resetTime: windowEnd,
        retryAfter: windowEnd - now
      };
    }
  }

  /**
   * Get applicable rules for a resource
   */
  private getApplicableRules(resource: string): RateLimitRule[] {
    return Array.from(this.rules.values())
      .filter(rule => rule.enabled)
      .sort((a, b) => b.priority - a.priority); // Higher priority first
  }

  /**
   * Get remaining requests for a client and rule
   */
  private getRemainingRequests(clientId: string, rule: RateLimitRule): number {
    switch (rule.algorithm) {
      case 'token_bucket': {
        const bucketKey = `${clientId}:${rule.id}`;
        const bucket = this.tokenBuckets.get(bucketKey);
        return bucket ? bucket.tokens : rule.maxRequests;
      }
      
      case 'sliding_window': {
        const windowKey = `${clientId}:${rule.id}`;
        const window = this.slidingWindows.get(windowKey);
        if (!window) return rule.maxRequests;
        
        const now = Date.now();
        const windowStart = now - rule.windowSize;
        const currentRequests = window.requests.filter(timestamp => timestamp > windowStart).length;
        
        return Math.max(0, rule.maxRequests - currentRequests);
      }
      
      case 'fixed_window': {
        const windowKey = `${clientId}:${rule.id}`;
        const clientState = this.clientStates.get(clientId);
        if (!clientState) return rule.maxRequests;
        
        const windowData = clientState.get(windowKey);
        if (!windowData) return rule.maxRequests;
        
        const now = Date.now();
        const windowStart = Math.floor(now / rule.windowSize) * rule.windowSize;
        
        if (windowData.windowStart !== windowStart) {
          return rule.maxRequests;
        }
        
        return Math.max(0, rule.maxRequests - windowData.requests);
      }
      
      default:
        return rule.maxRequests;
    }
  }

  /**
   * Get reset time for a client and rule
   */
  private getResetTime(clientId: string, rule: RateLimitRule): number {
    const now = Date.now();
    
    switch (rule.algorithm) {
      case 'token_bucket': {
        const bucketKey = `${clientId}:${rule.id}`;
        const bucket = this.tokenBuckets.get(bucketKey);
        if (!bucket) return now;
        
        const refillRate = rule.refillRate || (rule.maxRequests / (rule.windowSize / 1000));
        const tokensNeeded = (rule.burstSize || rule.maxRequests) - bucket.tokens;
        
        return now + (tokensNeeded / refillRate * 1000);
      }
      
      case 'sliding_window': {
        const windowKey = `${clientId}:${rule.id}`;
        const window = this.slidingWindows.get(windowKey);
        if (!window || window.requests.length === 0) return now;
        
        return window.requests[0] + rule.windowSize;
      }
      
      case 'fixed_window': {
        const windowStart = Math.floor(now / rule.windowSize) * rule.windowSize;
        return windowStart + rule.windowSize;
      }
      
      default:
        return now;
    }
  }

  /**
   * Record rule violation
   */
  private recordRuleViolation(ruleId: string): void {
    const current = this.rateLimitMetrics.ruleViolations.get(ruleId) || 0;
    this.rateLimitMetrics.ruleViolations.set(ruleId, current + 1);
  }

  /**
   * Update average response time
   */
  private updateAverageResponseTime(responseTime: number): void {
    const alpha = 0.1; // Exponential moving average factor
    this.rateLimitMetrics.averageResponseTime = 
      this.rateLimitMetrics.averageResponseTime * (1 - alpha) + responseTime * alpha;
  }

  /**
   * Load default rules
   */
  private loadDefaultRules(): void {
    // Default API rate limit
    this.addRule({
      name: 'default_api',
      algorithm: 'sliding_window',
      windowSize: 60 * 1000, // 1 minute
      maxRequests: 100,
      priority: 1
    });
    
    // Default trade rate limit
    this.addRule({
      name: 'default_trade',
      algorithm: 'token_bucket',
      windowSize: 60 * 1000, // 1 minute
      maxRequests: 10,
      burstSize: 5,
      refillRate: 0.167, // ~10 per minute
      priority: 10
    });
    
    // Default market data rate limit
    this.addRule({
      name: 'default_market_data',
      algorithm: 'sliding_window',
      windowSize: 1000, // 1 second
      maxRequests: 50,
      priority: 5
    });
  }

  /**
   * Generate rule ID
   */
  private generateRuleId(): string {
    return `rule_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clean up rule state
   */
  private cleanupRuleState(ruleId: string): void {
    // Clean up token buckets
    for (const [key, _] of this.tokenBuckets) {
      if (key.endsWith(`:${ruleId}`)) {
        this.tokenBuckets.delete(key);
      }
    }
    
    // Clean up sliding windows
    for (const [key, _] of this.slidingWindows) {
      if (key.endsWith(`:${ruleId}`)) {
        this.slidingWindows.delete(key);
      }
    }
    
    // Clean up client states
    for (const [clientId, clientState] of this.clientStates) {
      for (const [key, _] of clientState) {
        if (key.endsWith(`:${ruleId}`)) {
          clientState.delete(key);
        }
      }
      
      if (clientState.size === 0) {
        this.clientStates.delete(clientId);
      }
    }
  }

  /**
   * Start cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, DEFAULTS.RATE_LIMITING.CLEANUP_INTERVAL);
    
    this.logger.debug('Rate limiter cleanup timer started');
  }

  /**
   * Stop cleanup timer
   */
  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      this.logger.debug('Rate limiter cleanup timer stopped');
    }
  }

  /**
   * Cleanup expired data
   */
  private cleanup(): void {
    const now = Date.now();
    
    // Clean up old sliding window data
    for (const [key, window] of this.slidingWindows) {
      const rule = this.findRuleByKey(key);
      if (rule) {
        const windowStart = now - rule.windowSize;
        window.requests = window.requests.filter(timestamp => timestamp > windowStart);
        
        if (window.requests.length === 0) {
          this.slidingWindows.delete(key);
        }
      }
    }
    
    // Clean up old fixed window data
    for (const [clientId, clientState] of this.clientStates) {
      for (const [key, windowData] of clientState) {
        const rule = this.findRuleByKey(key);
        if (rule && rule.algorithm === 'fixed_window') {
          const currentWindowStart = Math.floor(now / rule.windowSize) * rule.windowSize;
          
          if (windowData.windowStart < currentWindowStart) {
            clientState.delete(key);
          }
        }
      }
      
      if (clientState.size === 0) {
        this.clientStates.delete(clientId);
      }
    }
  }

  /**
   * Find rule by key
   */
  private findRuleByKey(key: string): RateLimitRule | undefined {
    const ruleId = key.split(':').pop();
    return ruleId ? this.rules.get(ruleId) : undefined;
  }

  /**
   * Validate that RateLimiter is initialized
   */
  private validateInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('RateLimiter is not initialized');
    }
  }

  /**
   * Shutdown the Rate Limiter
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down RateLimiter...');
      
      // Stop cleanup timer
      this.stopCleanupTimer();
      
      // Clear all state
      this.rules.clear();
      this.tokenBuckets.clear();
      this.slidingWindows.clear();
      this.clientStates.clear();
      
      this.isInitialized = false;
      
      this.logger.info('RateLimiter shutdown completed');
      
    } catch (error) {
      this.logger.error('Error during RateLimiter shutdown', { error });
      throw error;
    }
  }
}