/**
 * HealthChecker - System health monitoring and health check utility
 */

import { EventEmitter } from 'eventemitter3';
import {
  MonitoringConfig,
  HealthStatus,
  HealthCheckResult,
  HealthCheck
} from '../types';
import { Logger } from './Logger';
import { MetricsCollector } from './MetricsCollector';
import { MONITORING, DEFAULTS } from '../constants';

interface HealthCheckDefinition {
  id: string;
  name: string;
  description: string;
  check: () => Promise<HealthCheckResult>;
  interval: number; // in milliseconds
  timeout: number; // in milliseconds
  critical: boolean; // if true, failure affects overall health
  enabled: boolean;
  tags: string[];
  lastRun?: Date;
  lastResult?: HealthCheckResult;
  consecutiveFailures: number;
  totalRuns: number;
  totalFailures: number;
}

interface SystemHealthMetrics {
  memoryUsage: {
    used: number;
    total: number;
    percentage: number;
  };
  cpuUsage: {
    user: number;
    system: number;
    percentage: number;
  };
  diskUsage: {
    used: number;
    total: number;
    percentage: number;
  };
  networkConnections: {
    active: number;
    listening: number;
  };
  eventLoopLag: number;
  uptime: number;
}

interface HealthSummary {
  status: HealthStatus;
  timestamp: Date;
  uptime: number;
  version: string;
  checks: HealthCheckResult[];
  systemMetrics: SystemHealthMetrics;
  overallScore: number; // 0-100
}

interface HealthCheckerStats {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  criticalFailures: number;
  averageResponseTime: number;
  lastCheckTime?: Date;
}

/**
 * Health Checker
 */
export class HealthChecker extends EventEmitter {
  private readonly config: MonitoringConfig;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  
  private isInitialized: boolean = false;
  private healthChecks: Map<string, HealthCheckDefinition> = new Map();
  private checkTimers: Map<string, NodeJS.Timeout> = new Map();
  
  // Health state
  private currentStatus: HealthStatus = HealthStatus.UNKNOWN;
  private lastHealthSummary?: HealthSummary;
  
  // Statistics
  private stats: HealthCheckerStats;
  
  // System monitoring
  private systemMonitorTimer: NodeJS.Timeout | null = null;
  private systemMetrics: SystemHealthMetrics;
  
  // Health history
  private healthHistory: HealthSummary[] = [];
  private readonly maxHistorySize: number = 100;

  constructor(
    config: MonitoringConfig,
    logger: Logger,
    metrics: MetricsCollector
  ) {
    super();

    this.config = config;
    this.logger = logger.child({ component: 'HealthChecker' });
    this.metrics = metrics;
    
    // Initialize statistics
    this.stats = {
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      criticalFailures: 0,
      averageResponseTime: 0
    };
    
    // Initialize system metrics
    this.systemMetrics = {
      memoryUsage: { used: 0, total: 0, percentage: 0 },
      cpuUsage: { user: 0, system: 0, percentage: 0 },
      diskUsage: { used: 0, total: 0, percentage: 0 },
      networkConnections: { active: 0, listening: 0 },
      eventLoopLag: 0,
      uptime: 0
    };

    this.logger.info('HealthChecker created', {
      enabled: config.enabled,
      healthCheckInterval: config.healthCheckInterval
    });
  }

  /**
   * Initialize the Health Checker
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('HealthChecker is already initialized');
    }

    if (!this.config.enabled) {
      this.logger.info('Health checking is disabled');
      this.isInitialized = true;
      return;
    }

    try {
      this.logger.info('Initializing HealthChecker...');
      
      // Register default health checks
      this.registerDefaultHealthChecks();
      
      // Start system monitoring
      this.startSystemMonitoring();
      
      // Start health checks
      this.startHealthChecks();
      
      // Perform initial health check
      await this.performHealthCheck();
      
      this.isInitialized = true;
      
      this.logger.info('HealthChecker initialized successfully', {
        checkCount: this.healthChecks.size,
        status: this.currentStatus
      });
      
    } catch (error) {
      this.logger.error('Failed to initialize HealthChecker', { error });
      throw error;
    }
  }

  /**
   * Register a health check
   */
  registerHealthCheck(healthCheck: {
    id: string;
    name: string;
    description: string;
    check: () => Promise<HealthCheckResult>;
    interval?: number;
    timeout?: number;
    critical?: boolean;
    enabled?: boolean;
    tags?: string[];
  }): void {
    const checkDef: HealthCheckDefinition = {
      id: healthCheck.id,
      name: healthCheck.name,
      description: healthCheck.description,
      check: healthCheck.check,
      interval: healthCheck.interval || DEFAULTS.MONITORING.HEALTH_CHECK_INTERVAL,
      timeout: healthCheck.timeout || DEFAULTS.MONITORING.HEALTH_CHECK_TIMEOUT,
      critical: healthCheck.critical !== false,
      enabled: healthCheck.enabled !== false,
      tags: healthCheck.tags || [],
      consecutiveFailures: 0,
      totalRuns: 0,
      totalFailures: 0
    };
    
    this.healthChecks.set(checkDef.id, checkDef);
    
    // Start timer if initialized
    if (this.isInitialized && checkDef.enabled) {
      this.startHealthCheckTimer(checkDef);
    }
    
    this.logger.info('Health check registered', {
      id: checkDef.id,
      name: checkDef.name,
      interval: checkDef.interval,
      critical: checkDef.critical
    });
  }

  /**
   * Unregister a health check
   */
  unregisterHealthCheck(id: string): void {
    const checkDef = this.healthChecks.get(id);
    if (checkDef) {
      // Stop timer
      this.stopHealthCheckTimer(id);
      
      // Remove check
      this.healthChecks.delete(id);
      
      this.logger.info('Health check unregistered', {
        id,
        name: checkDef.name
      });
    }
  }

  /**
   * Enable/disable a health check
   */
  setHealthCheckEnabled(id: string, enabled: boolean): void {
    const checkDef = this.healthChecks.get(id);
    if (checkDef) {
      checkDef.enabled = enabled;
      
      if (enabled && this.isInitialized) {
        this.startHealthCheckTimer(checkDef);
      } else {
        this.stopHealthCheckTimer(id);
      }
      
      this.logger.info('Health check enabled state changed', {
        id,
        name: checkDef.name,
        enabled
      });
    }
  }

  /**
   * Run a specific health check
   */
  async runHealthCheck(id: string): Promise<HealthCheckResult> {
    const checkDef = this.healthChecks.get(id);
    if (!checkDef) {
      throw new Error(`Health check not found: ${id}`);
    }
    
    return await this.executeHealthCheck(checkDef);
  }

  /**
   * Run all health checks
   */
  async runAllHealthChecks(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];
    
    for (const checkDef of this.healthChecks.values()) {
      if (checkDef.enabled) {
        try {
          const result = await this.executeHealthCheck(checkDef);
          results.push(result);
        } catch (error) {
          this.logger.error('Health check execution failed', {
            id: checkDef.id,
            error
          });
          
          results.push({
            id: checkDef.id,
            name: checkDef.name,
            status: HealthStatus.UNHEALTHY,
            message: `Execution failed: ${error.message}`,
            timestamp: new Date(),
            duration: 0,
            metadata: { error: error.message }
          });
        }
      }
    }
    
    return results;
  }

  /**
   * Get current health status
   */
  getHealthStatus(): HealthStatus {
    return this.currentStatus;
  }

  /**
   * Get health summary
   */
  async getHealthSummary(): Promise<HealthSummary> {
    const checkResults = await this.runAllHealthChecks();
    const systemMetrics = await this.collectSystemMetrics();
    
    const summary: HealthSummary = {
      status: this.calculateOverallStatus(checkResults),
      timestamp: new Date(),
      uptime: process.uptime(),
      version: process.version,
      checks: checkResults,
      systemMetrics,
      overallScore: this.calculateHealthScore(checkResults, systemMetrics)
    };
    
    this.lastHealthSummary = summary;
    this.currentStatus = summary.status;
    
    // Add to history
    this.healthHistory.push(summary);
    if (this.healthHistory.length > this.maxHistorySize) {
      this.healthHistory.shift();
    }
    
    return summary;
  }

  /**
   * Get health check definitions
   */
  getHealthChecks(): HealthCheckDefinition[] {
    return Array.from(this.healthChecks.values());
  }

  /**
   * Get health checker statistics
   */
  getStats(): HealthCheckerStats & {
    checkCount: number;
    enabledChecks: number;
    currentStatus: HealthStatus;
    isInitialized: boolean;
    isEnabled: boolean;
  } {
    const enabledChecks = Array.from(this.healthChecks.values())
      .filter(check => check.enabled).length;
    
    return {
      ...this.stats,
      checkCount: this.healthChecks.size,
      enabledChecks,
      currentStatus: this.currentStatus,
      isInitialized: this.isInitialized,
      isEnabled: this.config.enabled
    };
  }

  /**
   * Get health history
   */
  getHealthHistory(): HealthSummary[] {
    return [...this.healthHistory];
  }

  /**
   * Register default health checks
   */
  private registerDefaultHealthChecks(): void {
    // Memory usage check
    this.registerHealthCheck({
      id: 'memory_usage',
      name: 'Memory Usage',
      description: 'Check system memory usage',
      check: async () => {
        const memUsage = process.memoryUsage();
        const usedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const totalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
        const percentage = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100);
        
        const status = percentage > 90 ? HealthStatus.UNHEALTHY :
                      percentage > 75 ? HealthStatus.DEGRADED :
                      HealthStatus.HEALTHY;
        
        return {
          id: 'memory_usage',
          name: 'Memory Usage',
          status,
          message: `Memory usage: ${usedMB}MB / ${totalMB}MB (${percentage}%)`,
          timestamp: new Date(),
          duration: 0,
          metadata: {
            usedMB,
            totalMB,
            percentage,
            heapUsed: memUsage.heapUsed,
            heapTotal: memUsage.heapTotal,
            external: memUsage.external
          }
        };
      },
      interval: 30000, // 30 seconds
      critical: true,
      tags: ['system', 'memory']
    });
    
    // Event loop lag check
    this.registerHealthCheck({
      id: 'event_loop_lag',
      name: 'Event Loop Lag',
      description: 'Check Node.js event loop lag',
      check: async () => {
        const start = process.hrtime.bigint();
        
        return new Promise((resolve) => {
          setImmediate(() => {
            const lag = Number(process.hrtime.bigint() - start) / 1000000; // Convert to ms
            
            const status = lag > 100 ? HealthStatus.UNHEALTHY :
                          lag > 50 ? HealthStatus.DEGRADED :
                          HealthStatus.HEALTHY;
            
            resolve({
              id: 'event_loop_lag',
              name: 'Event Loop Lag',
              status,
              message: `Event loop lag: ${lag.toFixed(2)}ms`,
              timestamp: new Date(),
              duration: lag,
              metadata: {
                lagMs: lag,
                threshold: {
                  degraded: 50,
                  unhealthy: 100
                }
              }
            });
          });
        });
      },
      interval: 15000, // 15 seconds
      critical: true,
      tags: ['system', 'performance']
    });
    
    // Process uptime check
    this.registerHealthCheck({
      id: 'process_uptime',
      name: 'Process Uptime',
      description: 'Check process uptime',
      check: async () => {
        const uptime = process.uptime();
        const uptimeHours = Math.floor(uptime / 3600);
        const uptimeMinutes = Math.floor((uptime % 3600) / 60);
        
        return {
          id: 'process_uptime',
          name: 'Process Uptime',
          status: HealthStatus.HEALTHY,
          message: `Process uptime: ${uptimeHours}h ${uptimeMinutes}m`,
          timestamp: new Date(),
          duration: 0,
          metadata: {
            uptimeSeconds: uptime,
            uptimeHours,
            uptimeMinutes
          }
        };
      },
      interval: 60000, // 1 minute
      critical: false,
      tags: ['system', 'uptime']
    });
  }

  /**
   * Start health check timers
   */
  private startHealthChecks(): void {
    for (const checkDef of this.healthChecks.values()) {
      if (checkDef.enabled) {
        this.startHealthCheckTimer(checkDef);
      }
    }
  }

  /**
   * Start health check timer
   */
  private startHealthCheckTimer(checkDef: HealthCheckDefinition): void {
    // Stop existing timer
    this.stopHealthCheckTimer(checkDef.id);
    
    // Start new timer
    const timer = setInterval(async () => {
      try {
        await this.executeHealthCheck(checkDef);
      } catch (error) {
        this.logger.error('Health check timer execution failed', {
          id: checkDef.id,
          error
        });
      }
    }, checkDef.interval);
    
    this.checkTimers.set(checkDef.id, timer);
    
    this.logger.debug('Health check timer started', {
      id: checkDef.id,
      interval: checkDef.interval
    });
  }

  /**
   * Stop health check timer
   */
  private stopHealthCheckTimer(id: string): void {
    const timer = this.checkTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this.checkTimers.delete(id);
      
      this.logger.debug('Health check timer stopped', { id });
    }
  }

  /**
   * Execute a health check
   */
  private async executeHealthCheck(checkDef: HealthCheckDefinition): Promise<HealthCheckResult> {
    const startTime = Date.now();
    
    try {
      this.stats.totalChecks++;
      checkDef.totalRuns++;
      checkDef.lastRun = new Date();
      
      // Execute check with timeout
      const result = await this.executeWithTimeout(
        checkDef.check(),
        checkDef.timeout
      );
      
      const duration = Date.now() - startTime;
      result.duration = duration;
      
      // Update statistics
      this.updateStats(result, duration);
      
      // Update check definition
      checkDef.lastResult = result;
      
      if (result.status === HealthStatus.HEALTHY) {
        checkDef.consecutiveFailures = 0;
        this.stats.passedChecks++;
      } else {
        checkDef.consecutiveFailures++;
        checkDef.totalFailures++;
        this.stats.failedChecks++;
        
        if (checkDef.critical) {
          this.stats.criticalFailures++;
        }
      }
      
      // Record metrics
      this.metrics.recordHistogram(
        'health_check_duration_ms',
        duration,
        undefined,
        {
          check_id: checkDef.id,
          status: result.status
        }
      );
      
      this.metrics.recordCounter(
        'health_checks_total',
        1,
        {
          check_id: checkDef.id,
          status: result.status
        }
      );
      
      // Emit events
      this.emit('healthCheckCompleted', {
        checkId: checkDef.id,
        result
      });
      
      if (result.status !== HealthStatus.HEALTHY) {
        this.emit('healthCheckFailed', {
          checkId: checkDef.id,
          result,
          consecutiveFailures: checkDef.consecutiveFailures
        });
      }
      
      this.logger.debug('Health check completed', {
        id: checkDef.id,
        status: result.status,
        duration,
        message: result.message
      });
      
      return result;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      checkDef.consecutiveFailures++;
      checkDef.totalFailures++;
      this.stats.failedChecks++;
      
      if (checkDef.critical) {
        this.stats.criticalFailures++;
      }
      
      const result: HealthCheckResult = {
        id: checkDef.id,
        name: checkDef.name,
        status: HealthStatus.UNHEALTHY,
        message: `Health check failed: ${error.message}`,
        timestamp: new Date(),
        duration,
        metadata: {
          error: error.message,
          stack: error.stack
        }
      };
      
      checkDef.lastResult = result;
      
      this.logger.error('Health check execution failed', {
        id: checkDef.id,
        error,
        duration
      });
      
      return result;
    }
  }

  /**
   * Execute with timeout
   */
  private async executeWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Health check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      
      promise
        .then(resolve)
        .catch(reject)
        .finally(() => clearTimeout(timer));
    });
  }

  /**
   * Calculate overall health status
   */
  private calculateOverallStatus(results: HealthCheckResult[]): HealthStatus {
    if (results.length === 0) {
      return HealthStatus.UNKNOWN;
    }
    
    const criticalChecks = Array.from(this.healthChecks.values())
      .filter(check => check.critical && check.enabled);
    
    // Check critical health checks
    for (const check of criticalChecks) {
      const result = results.find(r => r.id === check.id);
      if (result && result.status === HealthStatus.UNHEALTHY) {
        return HealthStatus.UNHEALTHY;
      }
    }
    
    // Check for any degraded status
    const hasDegraded = results.some(r => r.status === HealthStatus.DEGRADED);
    if (hasDegraded) {
      return HealthStatus.DEGRADED;
    }
    
    // Check for any unhealthy non-critical checks
    const hasUnhealthy = results.some(r => r.status === HealthStatus.UNHEALTHY);
    if (hasUnhealthy) {
      return HealthStatus.DEGRADED;
    }
    
    return HealthStatus.HEALTHY;
  }

  /**
   * Calculate health score
   */
  private calculateHealthScore(results: HealthCheckResult[], systemMetrics: SystemHealthMetrics): number {
    if (results.length === 0) {
      return 0;
    }
    
    let score = 0;
    let totalWeight = 0;
    
    // Health check scores
    for (const result of results) {
      const check = this.healthChecks.get(result.id);
      const weight = check?.critical ? 2 : 1;
      
      let checkScore = 0;
      switch (result.status) {
        case HealthStatus.HEALTHY:
          checkScore = 100;
          break;
        case HealthStatus.DEGRADED:
          checkScore = 50;
          break;
        case HealthStatus.UNHEALTHY:
          checkScore = 0;
          break;
        default:
          checkScore = 25;
      }
      
      score += checkScore * weight;
      totalWeight += weight;
    }
    
    // System metrics impact
    const memoryScore = Math.max(0, 100 - systemMetrics.memoryUsage.percentage);
    const cpuScore = Math.max(0, 100 - systemMetrics.cpuUsage.percentage);
    
    score += (memoryScore + cpuScore) / 2;
    totalWeight += 1;
    
    return Math.round(score / totalWeight);
  }

  /**
   * Update statistics
   */
  private updateStats(result: HealthCheckResult, duration: number): void {
    this.stats.lastCheckTime = new Date();
    
    // Update average response time
    const alpha = 0.1; // Exponential moving average factor
    this.stats.averageResponseTime = 
      this.stats.averageResponseTime * (1 - alpha) + duration * alpha;
  }

  /**
   * Start system monitoring
   */
  private startSystemMonitoring(): void {
    this.systemMonitorTimer = setInterval(() => {
      this.updateSystemMetrics();
    }, DEFAULTS.MONITORING.SYSTEM_METRICS_INTERVAL);
    
    this.logger.debug('System monitoring started');
  }

  /**
   * Stop system monitoring
   */
  private stopSystemMonitoring(): void {
    if (this.systemMonitorTimer) {
      clearInterval(this.systemMonitorTimer);
      this.systemMonitorTimer = null;
      this.logger.debug('System monitoring stopped');
    }
  }

  /**
   * Update system metrics
   */
  private updateSystemMetrics(): void {
    try {
      const memUsage = process.memoryUsage();
      const cpuUsage = process.cpuUsage();
      
      this.systemMetrics = {
        memoryUsage: {
          used: memUsage.heapUsed,
          total: memUsage.heapTotal,
          percentage: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100)
        },
        cpuUsage: {
          user: cpuUsage.user,
          system: cpuUsage.system,
          percentage: 0 // Would calculate from previous measurement
        },
        diskUsage: {
          used: 0, // Would implement disk usage check
          total: 0,
          percentage: 0
        },
        networkConnections: {
          active: 0, // Would implement network connection check
          listening: 0
        },
        eventLoopLag: 0, // Would implement event loop lag measurement
        uptime: process.uptime()
      };
      
    } catch (error) {
      this.logger.error('Failed to update system metrics', { error });
    }
  }

  /**
   * Collect system metrics
   */
  private async collectSystemMetrics(): Promise<SystemHealthMetrics> {
    this.updateSystemMetrics();
    return { ...this.systemMetrics };
  }

  /**
   * Perform health check
   */
  private async performHealthCheck(): Promise<void> {
    try {
      const summary = await this.getHealthSummary();
      
      this.emit('healthStatusChanged', {
        previousStatus: this.currentStatus,
        currentStatus: summary.status,
        summary
      });
      
      this.logger.info('Health check performed', {
        status: summary.status,
        score: summary.overallScore,
        checkCount: summary.checks.length
      });
      
    } catch (error) {
      this.logger.error('Health check failed', { error });
    }
  }

  /**
   * Validate that HealthChecker is initialized
   */
  private validateInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('HealthChecker is not initialized');
    }
  }

  /**
   * Shutdown the Health Checker
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down HealthChecker...');
      
      // Stop all timers
      for (const [id, timer] of this.checkTimers) {
        clearInterval(timer);
        this.checkTimers.delete(id);
      }
      
      // Stop system monitoring
      this.stopSystemMonitoring();
      
      // Final health check
      if (this.config.enabled) {
        await this.performHealthCheck();
      }
      
      // Clear data
      this.healthChecks.clear();
      this.healthHistory = [];
      
      this.isInitialized = false;
      this.currentStatus = HealthStatus.UNKNOWN;
      
      this.logger.info('HealthChecker shutdown completed');
      
    } catch (error) {
      this.logger.error('Error during HealthChecker shutdown', { error });
      throw error;
    }
  }
}