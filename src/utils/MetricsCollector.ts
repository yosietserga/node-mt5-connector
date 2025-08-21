/**
 * MetricsCollector - Performance metrics and monitoring utility
 */

import { EventEmitter } from 'eventemitter3';
import {
  MonitoringConfig,
  Metric,
  MetricType
} from '../types';
import { Logger } from './Logger';
import { MONITORING, DEFAULTS } from '../constants';

interface TimerEntry {
  startTime: number;
  metadata?: any;
}

interface CounterMetric {
  type: 'counter';
  value: number;
  labels?: Record<string, string>;
  timestamp: Date;
}

interface GaugeMetric {
  type: 'gauge';
  value: number;
  labels?: Record<string, string>;
  timestamp: Date;
}

interface HistogramMetric {
  type: 'histogram';
  values: number[];
  buckets: number[];
  labels?: Record<string, string>;
  timestamp: Date;
}

interface SummaryMetric {
  type: 'summary';
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  percentiles: Map<number, number>;
  labels?: Record<string, string>;
  timestamp: Date;
}

type MetricValue = CounterMetric | GaugeMetric | HistogramMetric | SummaryMetric;

interface MetricsSnapshot {
  timestamp: Date;
  metrics: Map<string, MetricValue>;
  systemMetrics: SystemMetrics;
}

interface SystemMetrics {
  memoryUsage: NodeJS.MemoryUsage;
  cpuUsage: NodeJS.CpuUsage;
  uptime: number;
  eventLoopDelay: number;
}

interface MetricsCollectorStats {
  totalMetrics: number;
  metricsPerSecond: number;
  lastCollectionTime?: Date;
  collectionCount: number;
  errorCount: number;
}

/**
 * Metrics Collector
 */
export class MetricsCollector extends EventEmitter {
  private readonly config: MonitoringConfig;
  private readonly logger: Logger;
  
  private isInitialized: boolean = false;
  private metrics: Map<string, MetricValue> = new Map();
  private timers: Map<string, TimerEntry> = new Map();
  
  // Collection and aggregation
  private collectionTimer: NodeJS.Timeout | null = null;
  private aggregationTimer: NodeJS.Timeout | null = null;
  
  // Statistics
  private stats: MetricsCollectorStats;
  
  // System metrics tracking
  private lastCpuUsage: NodeJS.CpuUsage;
  private eventLoopDelayHistogram: any; // Would use perf_hooks.monitorEventLoopDelay in real implementation
  
  // Metric history for trend analysis
  private metricHistory: MetricsSnapshot[] = [];
  private readonly maxHistorySize: number = 1000;

  constructor(
    config: MonitoringConfig,
    logger: Logger
  ) {
    super();

    this.config = config;
    this.logger = logger.child({ component: 'MetricsCollector' });
    
    // Initialize statistics
    this.stats = {
      totalMetrics: 0,
      metricsPerSecond: 0,
      collectionCount: 0,
      errorCount: 0
    };
    
    // Initialize CPU usage baseline
    this.lastCpuUsage = process.cpuUsage();

    this.logger.info('MetricsCollector created', {
      enabled: config.enabled,
      collectInterval: config.collectInterval
    });
  }

  /**
   * Initialize the Metrics Collector
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('MetricsCollector is already initialized');
    }

    if (!this.config.enabled) {
      this.logger.info('Metrics collection is disabled');
      this.isInitialized = true;
      return;
    }

    try {
      this.logger.info('Initializing MetricsCollector...');
      
      // Initialize system metrics monitoring
      this.initializeSystemMetrics();
      
      // Start collection timers
      this.startCollectionTimer();
      this.startAggregationTimer();
      
      // Register default metrics
      this.registerDefaultMetrics();
      
      this.isInitialized = true;
      
      this.logger.info('MetricsCollector initialized successfully');
      
    } catch (error) {
      this.logger.error('Failed to initialize MetricsCollector', { error });
      throw error;
    }
  }

  /**
   * Record a counter metric
   */
  recordCounter(
    name: string,
    value: number = 1,
    labels?: Record<string, string>
  ): void {
    this.validateInitialized();
    
    if (!this.config.enabled) {
      return;
    }

    try {
      const existing = this.metrics.get(name) as CounterMetric;
      
      if (existing && existing.type === 'counter') {
        existing.value += value;
        existing.timestamp = new Date();
        if (labels) {
          existing.labels = { ...existing.labels, ...labels };
        }
      } else {
        this.metrics.set(name, {
          type: 'counter',
          value,
          labels,
          timestamp: new Date()
        });
      }
      
      this.updateStats();
      
      this.logger.debug('Counter metric recorded', {
        name,
        value,
        labels
      });
      
    } catch (error) {
      this.stats.errorCount++;
      this.logger.error('Failed to record counter metric', { error, name, value });
    }
  }

  /**
   * Record a gauge metric
   */
  recordGauge(
    name: string,
    value: number,
    labels?: Record<string, string>
  ): void {
    this.validateInitialized();
    
    if (!this.config.enabled) {
      return;
    }

    try {
      this.metrics.set(name, {
        type: 'gauge',
        value,
        labels,
        timestamp: new Date()
      });
      
      this.updateStats();
      
      this.logger.debug('Gauge metric recorded', {
        name,
        value,
        labels
      });
      
    } catch (error) {
      this.stats.errorCount++;
      this.logger.error('Failed to record gauge metric', { error, name, value });
    }
  }

  /**
   * Record a histogram metric
   */
  recordHistogram(
    name: string,
    value: number,
    buckets?: number[],
    labels?: Record<string, string>
  ): void {
    this.validateInitialized();
    
    if (!this.config.enabled) {
      return;
    }

    try {
      const defaultBuckets = [0.1, 0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000];
      const histogramBuckets = buckets || defaultBuckets;
      
      const existing = this.metrics.get(name) as HistogramMetric;
      
      if (existing && existing.type === 'histogram') {
        existing.values.push(value);
        existing.timestamp = new Date();
        if (labels) {
          existing.labels = { ...existing.labels, ...labels };
        }
      } else {
        this.metrics.set(name, {
          type: 'histogram',
          values: [value],
          buckets: histogramBuckets,
          labels,
          timestamp: new Date()
        });
      }
      
      this.updateStats();
      
      this.logger.debug('Histogram metric recorded', {
        name,
        value,
        labels
      });
      
    } catch (error) {
      this.stats.errorCount++;
      this.logger.error('Failed to record histogram metric', { error, name, value });
    }
  }

  /**
   * Record a summary metric
   */
  recordSummary(
    name: string,
    value: number,
    labels?: Record<string, string>
  ): void {
    this.validateInitialized();
    
    if (!this.config.enabled) {
      return;
    }

    try {
      const existing = this.metrics.get(name) as SummaryMetric;
      
      if (existing && existing.type === 'summary') {
        existing.count++;
        existing.sum += value;
        existing.min = Math.min(existing.min, value);
        existing.max = Math.max(existing.max, value);
        existing.mean = existing.sum / existing.count;
        existing.timestamp = new Date();
        
        if (labels) {
          existing.labels = { ...existing.labels, ...labels };
        }
        
        // Update percentiles (simplified calculation)
        this.updatePercentiles(existing, value);
      } else {
        const summary: SummaryMetric = {
          type: 'summary',
          count: 1,
          sum: value,
          min: value,
          max: value,
          mean: value,
          percentiles: new Map(),
          labels,
          timestamp: new Date()
        };
        
        // Initialize percentiles
        summary.percentiles.set(50, value);
        summary.percentiles.set(90, value);
        summary.percentiles.set(95, value);
        summary.percentiles.set(99, value);
        
        this.metrics.set(name, summary);
      }
      
      this.updateStats();
      
      this.logger.debug('Summary metric recorded', {
        name,
        value,
        labels
      });
      
    } catch (error) {
      this.stats.errorCount++;
      this.logger.error('Failed to record summary metric', { error, name, value });
    }
  }

  /**
   * Record a generic metric
   */
  recordMetric(
    name: string,
    value: number,
    type: MetricType = 'counter',
    labels?: Record<string, string>
  ): void {
    switch (type) {
      case 'counter':
        this.recordCounter(name, value, labels);
        break;
        
      case 'gauge':
        this.recordGauge(name, value, labels);
        break;
        
      case 'histogram':
        this.recordHistogram(name, value, undefined, labels);
        break;
        
      case 'summary':
        this.recordSummary(name, value, labels);
        break;
        
      default:
        this.logger.warn('Unknown metric type', { name, type });
    }
  }

  /**
   * Start a timer
   */
  startTimer(
    name: string,
    metadata?: any
  ): void {
    this.timers.set(name, {
      startTime: Date.now(),
      metadata
    });
    
    this.logger.debug('Timer started', { name, metadata });
  }

  /**
   * End a timer and record the duration
   */
  endTimer(
    name: string,
    labels?: Record<string, string>
  ): number {
    const timer = this.timers.get(name);
    
    if (!timer) {
      this.logger.warn('Timer not found', { name });
      return 0;
    }
    
    const duration = Date.now() - timer.startTime;
    this.timers.delete(name);
    
    // Record as histogram metric
    this.recordHistogram(`${name}_duration_ms`, duration, undefined, labels);
    
    this.logger.debug('Timer ended', {
      name,
      duration,
      labels,
      metadata: timer.metadata
    });
    
    return duration;
  }

  /**
   * Get metric value
   */
  getMetric(name: string): MetricValue | undefined {
    return this.metrics.get(name);
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): Map<string, MetricValue> {
    return new Map(this.metrics);
  }

  /**
   * Get metrics snapshot
   */
  getSnapshot(): MetricsSnapshot {
    return {
      timestamp: new Date(),
      metrics: this.getAllMetrics(),
      systemMetrics: this.collectSystemMetrics()
    };
  }

  /**
   * Get metrics in Prometheus format
   */
  getPrometheusMetrics(): string {
    const lines: string[] = [];
    
    for (const [name, metric] of this.metrics) {
      const sanitizedName = this.sanitizeMetricName(name);
      const labelsStr = this.formatLabels(metric.labels);
      
      switch (metric.type) {
        case 'counter':
          lines.push(`# TYPE ${sanitizedName} counter`);
          lines.push(`${sanitizedName}${labelsStr} ${metric.value}`);
          break;
          
        case 'gauge':
          lines.push(`# TYPE ${sanitizedName} gauge`);
          lines.push(`${sanitizedName}${labelsStr} ${metric.value}`);
          break;
          
        case 'histogram':
          lines.push(`# TYPE ${sanitizedName} histogram`);
          
          // Calculate bucket counts
          const bucketCounts = this.calculateBucketCounts(metric.values, metric.buckets);
          
          for (let i = 0; i < metric.buckets.length; i++) {
            const bucketLabels = this.formatLabels({ ...metric.labels, le: metric.buckets[i].toString() });
            lines.push(`${sanitizedName}_bucket${bucketLabels} ${bucketCounts[i]}`);
          }
          
          lines.push(`${sanitizedName}_count${labelsStr} ${metric.values.length}`);
          lines.push(`${sanitizedName}_sum${labelsStr} ${metric.values.reduce((a, b) => a + b, 0)}`);
          break;
          
        case 'summary':
          lines.push(`# TYPE ${sanitizedName} summary`);
          
          for (const [percentile, value] of metric.percentiles) {
            const quantileLabels = this.formatLabels({ ...metric.labels, quantile: (percentile / 100).toString() });
            lines.push(`${sanitizedName}${quantileLabels} ${value}`);
          }
          
          lines.push(`${sanitizedName}_count${labelsStr} ${metric.count}`);
          lines.push(`${sanitizedName}_sum${labelsStr} ${metric.sum}`);
          break;
      }
    }
    
    return lines.join('\n');
  }

  /**
   * Get collector statistics
   */
  getStats(): MetricsCollectorStats & {
    activeTimers: number;
    historySize: number;
    isInitialized: boolean;
    isEnabled: boolean;
  } {
    return {
      ...this.stats,
      activeTimers: this.timers.size,
      historySize: this.metricHistory.length,
      isInitialized: this.isInitialized,
      isEnabled: this.config.enabled
    };
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics.clear();
    this.timers.clear();
    this.metricHistory = [];
    
    this.stats = {
      totalMetrics: 0,
      metricsPerSecond: 0,
      collectionCount: 0,
      errorCount: 0
    };
    
    this.logger.info('Metrics reset');
    this.emit('metricsReset');
  }

  /**
   * Initialize system metrics monitoring
   */
  private initializeSystemMetrics(): void {
    // In a real implementation, you would use perf_hooks.monitorEventLoopDelay
    // For now, we'll simulate it
    this.logger.debug('System metrics monitoring initialized');
  }

  /**
   * Collect system metrics
   */
  private collectSystemMetrics(): SystemMetrics {
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();
    
    return {
      memoryUsage,
      cpuUsage,
      uptime: process.uptime(),
      eventLoopDelay: 0 // Would be calculated from event loop delay histogram
    };
  }

  /**
   * Register default metrics
   */
  private registerDefaultMetrics(): void {
    // System metrics
    this.recordGauge('nodejs_memory_heap_used_bytes', 0);
    this.recordGauge('nodejs_memory_heap_total_bytes', 0);
    this.recordGauge('nodejs_memory_external_bytes', 0);
    this.recordGauge('nodejs_process_cpu_user_seconds_total', 0);
    this.recordGauge('nodejs_process_cpu_system_seconds_total', 0);
    this.recordGauge('nodejs_process_uptime_seconds', 0);
    
    // Application metrics
    this.recordCounter('mt5_connector_requests_total', 0);
    this.recordCounter('mt5_connector_errors_total', 0);
    this.recordGauge('mt5_connector_active_connections', 0);
    this.recordHistogram('mt5_connector_request_duration_ms', 0);
  }

  /**
   * Start collection timer
   */
  private startCollectionTimer(): void {
    const interval = this.config.collectInterval || DEFAULTS.MONITORING.COLLECT_INTERVAL;
    
    this.collectionTimer = setInterval(() => {
      this.collectMetrics();
    }, interval);
    
    this.logger.debug('Metrics collection timer started', { interval });
  }

  /**
   * Start aggregation timer
   */
  private startAggregationTimer(): void {
    const interval = DEFAULTS.MONITORING.AGGREGATION_INTERVAL;
    
    this.aggregationTimer = setInterval(() => {
      this.aggregateMetrics();
    }, interval);
    
    this.logger.debug('Metrics aggregation timer started', { interval });
  }

  /**
   * Stop collection timer
   */
  private stopCollectionTimer(): void {
    if (this.collectionTimer) {
      clearInterval(this.collectionTimer);
      this.collectionTimer = null;
      this.logger.debug('Metrics collection timer stopped');
    }
  }

  /**
   * Stop aggregation timer
   */
  private stopAggregationTimer(): void {
    if (this.aggregationTimer) {
      clearInterval(this.aggregationTimer);
      this.aggregationTimer = null;
      this.logger.debug('Metrics aggregation timer stopped');
    }
  }

  /**
   * Collect metrics
   */
  private collectMetrics(): void {
    try {
      this.stats.collectionCount++;
      this.stats.lastCollectionTime = new Date();
      
      // Update system metrics
      const systemMetrics = this.collectSystemMetrics();
      
      this.recordGauge('nodejs_memory_heap_used_bytes', systemMetrics.memoryUsage.heapUsed);
      this.recordGauge('nodejs_memory_heap_total_bytes', systemMetrics.memoryUsage.heapTotal);
      this.recordGauge('nodejs_memory_external_bytes', systemMetrics.memoryUsage.external);
      this.recordGauge('nodejs_process_cpu_user_seconds_total', systemMetrics.cpuUsage.user / 1000000);
      this.recordGauge('nodejs_process_cpu_system_seconds_total', systemMetrics.cpuUsage.system / 1000000);
      this.recordGauge('nodejs_process_uptime_seconds', systemMetrics.uptime);
      
      // Create snapshot
      const snapshot = this.getSnapshot();
      this.metricHistory.push(snapshot);
      
      // Limit history size
      if (this.metricHistory.length > this.maxHistorySize) {
        this.metricHistory.shift();
      }
      
      this.emit('metricsCollected', snapshot);
      
    } catch (error) {
      this.stats.errorCount++;
      this.logger.error('Failed to collect metrics', { error });
    }
  }

  /**
   * Aggregate metrics
   */
  private aggregateMetrics(): void {
    try {
      // Calculate metrics per second
      const now = Date.now();
      const oneSecondAgo = now - 1000;
      
      const recentSnapshots = this.metricHistory.filter(
        snapshot => snapshot.timestamp.getTime() > oneSecondAgo
      );
      
      if (recentSnapshots.length > 0) {
        this.stats.metricsPerSecond = recentSnapshots.length;
      }
      
      this.emit('metricsAggregated', {
        metricsPerSecond: this.stats.metricsPerSecond,
        totalMetrics: this.stats.totalMetrics
      });
      
    } catch (error) {
      this.stats.errorCount++;
      this.logger.error('Failed to aggregate metrics', { error });
    }
  }

  /**
   * Update statistics
   */
  private updateStats(): void {
    this.stats.totalMetrics++;
  }

  /**
   * Update percentiles for summary metric
   */
  private updatePercentiles(summary: SummaryMetric, newValue: number): void {
    // Simplified percentile calculation
    // In a real implementation, you would use a more sophisticated algorithm
    
    const values = [newValue]; // In practice, you'd maintain a sliding window of values
    values.sort((a, b) => a - b);
    
    const percentiles = [50, 90, 95, 99];
    
    for (const p of percentiles) {
      const index = Math.ceil((p / 100) * values.length) - 1;
      const value = values[Math.max(0, index)];
      summary.percentiles.set(p, value);
    }
  }

  /**
   * Calculate bucket counts for histogram
   */
  private calculateBucketCounts(values: number[], buckets: number[]): number[] {
    const counts = new Array(buckets.length).fill(0);
    
    for (const value of values) {
      for (let i = 0; i < buckets.length; i++) {
        if (value <= buckets[i]) {
          counts[i]++;
        }
      }
    }
    
    return counts;
  }

  /**
   * Sanitize metric name for Prometheus
   */
  private sanitizeMetricName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, '_');
  }

  /**
   * Format labels for Prometheus
   */
  private formatLabels(labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) {
      return '';
    }
    
    const labelPairs = Object.entries(labels)
      .map(([key, value]) => `${key}="${value}"`)
      .join(',');
    
    return `{${labelPairs}}`;
  }

  /**
   * Validate that MetricsCollector is initialized
   */
  private validateInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('MetricsCollector is not initialized');
    }
  }

  /**
   * Shutdown the Metrics Collector
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down MetricsCollector...');
      
      // Stop timers
      this.stopCollectionTimer();
      this.stopAggregationTimer();
      
      // Final collection
      if (this.config.enabled) {
        this.collectMetrics();
      }
      
      // Clear data
      this.metrics.clear();
      this.timers.clear();
      this.metricHistory = [];
      
      this.isInitialized = false;
      
      this.logger.info('MetricsCollector shutdown completed');
      
    } catch (error) {
      this.logger.error('Error during MetricsCollector shutdown', { error });
      throw error;
    }
  }
}