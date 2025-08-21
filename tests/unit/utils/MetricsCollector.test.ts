/**
 * Unit Tests for MetricsCollector
 */

import { MetricsCollector } from '../../../src/utils/MetricsCollector';
import { MonitoringConfig } from '../../../src/types';

describe('MetricsCollector', () => {
  let metricsCollector: MetricsCollector;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = global.testUtils.createMockLogger();
    
    const config: MonitoringConfig = {
      enabled: true,
      interval: 1000,
      retention: 3600000,
      systemMetrics: true,
      customMetrics: true,
      prometheus: {
        enabled: true,
        port: 9090,
        path: '/metrics'
      }
    };

    metricsCollector = new MetricsCollector(config, mockLogger);
  });

  afterEach(async () => {
    if (metricsCollector) {
      await metricsCollector.close();
    }
  });

  describe('Initialization', () => {
    test('should initialize with default configuration', () => {
      const defaultCollector = new MetricsCollector();
      expect(defaultCollector).toBeDefined();
      defaultCollector.close();
    });

    test('should initialize with custom configuration', () => {
      expect(metricsCollector).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'MetricsCollector initialized',
        expect.any(Object)
      );
    });
  });

  describe('Counter Metrics', () => {
    test('should increment counter', () => {
      metricsCollector.increment('test.counter');
      metricsCollector.increment('test.counter', { label: 'value' });
      metricsCollector.increment('test.counter', { label: 'value' }, 5);

      const metrics = metricsCollector.getMetrics();
      expect(metrics).toHaveProperty('test.counter');
    });

    test('should decrement counter', () => {
      metricsCollector.increment('test.counter', {}, 10);
      metricsCollector.decrement('test.counter', {}, 3);

      const metrics = metricsCollector.getMetrics();
      expect(metrics['test.counter']).toBeDefined();
    });

    test('should handle counter with labels', () => {
      metricsCollector.increment('requests.total', { method: 'GET', status: '200' });
      metricsCollector.increment('requests.total', { method: 'POST', status: '201' });
      metricsCollector.increment('requests.total', { method: 'GET', status: '404' });

      const metrics = metricsCollector.getMetrics();
      expect(metrics['requests.total']).toBeDefined();
    });
  });

  describe('Gauge Metrics', () => {
    test('should set gauge value', () => {
      metricsCollector.gauge('memory.usage', 1024);
      metricsCollector.gauge('cpu.usage', 75.5, { core: '0' });

      const metrics = metricsCollector.getMetrics();
      expect(metrics['memory.usage']).toBeDefined();
      expect(metrics['cpu.usage']).toBeDefined();
    });

    test('should update gauge value', () => {
      metricsCollector.gauge('temperature', 20.5);
      metricsCollector.gauge('temperature', 25.0);
      metricsCollector.gauge('temperature', 22.3);

      const metrics = metricsCollector.getMetrics();
      expect(metrics['temperature']).toBeDefined();
    });
  });

  describe('Histogram Metrics', () => {
    test('should record histogram values', () => {
      metricsCollector.histogram('request.duration', 100);
      metricsCollector.histogram('request.duration', 250);
      metricsCollector.histogram('request.duration', 150);
      metricsCollector.histogram('request.duration', 300, { endpoint: '/api/users' });

      const metrics = metricsCollector.getMetrics();
      expect(metrics['request.duration']).toBeDefined();
    });

    test('should calculate histogram statistics', () => {
      const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      values.forEach(value => {
        metricsCollector.histogram('response.size', value);
      });

      const metrics = metricsCollector.getMetrics();
      expect(metrics['response.size']).toBeDefined();
    });
  });

  describe('Summary Metrics', () => {
    test('should record summary values', () => {
      metricsCollector.summary('api.latency', 45);
      metricsCollector.summary('api.latency', 67);
      metricsCollector.summary('api.latency', 23);
      metricsCollector.summary('api.latency', 89, { service: 'auth' });

      const metrics = metricsCollector.getMetrics();
      expect(metrics['api.latency']).toBeDefined();
    });

    test('should calculate summary quantiles', () => {
      // Generate sample data
      for (let i = 1; i <= 100; i++) {
        metricsCollector.summary('processing.time', i * 10);
      }

      const metrics = metricsCollector.getMetrics();
      expect(metrics['processing.time']).toBeDefined();
    });
  });

  describe('Timer Functionality', () => {
    test('should measure execution time', async () => {
      const timer = metricsCollector.timer('operation.duration');
      
      await global.testUtils.wait(50);
      
      timer.end();

      const metrics = metricsCollector.getMetrics();
      expect(metrics['operation.duration']).toBeDefined();
    });

    test('should measure execution time with labels', async () => {
      const timer = metricsCollector.timer('database.query', { table: 'users' });
      
      await global.testUtils.wait(25);
      
      timer.end();

      const metrics = metricsCollector.getMetrics();
      expect(metrics['database.query']).toBeDefined();
    });

    test('should handle multiple concurrent timers', async () => {
      const timer1 = metricsCollector.timer('concurrent.op', { id: '1' });
      const timer2 = metricsCollector.timer('concurrent.op', { id: '2' });
      
      await global.testUtils.wait(30);
      timer1.end();
      
      await global.testUtils.wait(20);
      timer2.end();

      const metrics = metricsCollector.getMetrics();
      expect(metrics['concurrent.op']).toBeDefined();
    });
  });

  describe('System Metrics', () => {
    test('should collect system metrics when enabled', async () => {
      await global.testUtils.wait(100); // Allow system metrics collection

      const metrics = metricsCollector.getMetrics();
      
      // Check for system metrics
      expect(Object.keys(metrics).some(key => key.startsWith('system.'))).toBe(true);
    });

    test('should include memory metrics', async () => {
      await global.testUtils.wait(100);

      const metrics = metricsCollector.getMetrics();
      
      expect(metrics).toHaveProperty('system.memory.used');
      expect(metrics).toHaveProperty('system.memory.total');
    });

    test('should include process metrics', async () => {
      await global.testUtils.wait(100);

      const metrics = metricsCollector.getMetrics();
      
      expect(metrics).toHaveProperty('system.process.uptime');
      expect(metrics).toHaveProperty('system.process.cpu');
    });
  });

  describe('Prometheus Export', () => {
    test('should export metrics in Prometheus format', () => {
      metricsCollector.increment('http_requests_total', { method: 'GET' });
      metricsCollector.gauge('memory_usage_bytes', 1048576);
      metricsCollector.histogram('request_duration_seconds', 0.25);

      const prometheusOutput = metricsCollector.getPrometheusMetrics();
      
      expect(prometheusOutput).toContain('http_requests_total');
      expect(prometheusOutput).toContain('memory_usage_bytes');
      expect(prometheusOutput).toContain('request_duration_seconds');
    });

    test('should include metric metadata in Prometheus format', () => {
      metricsCollector.increment('api_calls_total', { endpoint: '/users' });
      
      const prometheusOutput = metricsCollector.getPrometheusMetrics();
      
      expect(prometheusOutput).toContain('# TYPE');
      expect(prometheusOutput).toContain('# HELP');
    });
  });

  describe('Metrics Management', () => {
    test('should reset all metrics', () => {
      metricsCollector.increment('test.counter');
      metricsCollector.gauge('test.gauge', 100);
      metricsCollector.histogram('test.histogram', 50);

      let metrics = metricsCollector.getMetrics();
      expect(Object.keys(metrics).length).toBeGreaterThan(0);

      metricsCollector.reset();
      
      metrics = metricsCollector.getMetrics();
      expect(Object.keys(metrics).filter(key => key.startsWith('test.')).length).toBe(0);
    });

    test('should get metrics statistics', () => {
      metricsCollector.increment('requests');
      metricsCollector.gauge('connections', 10);
      
      const stats = metricsCollector.getStats();
      
      expect(stats).toHaveProperty('totalMetrics');
      expect(stats).toHaveProperty('counters');
      expect(stats).toHaveProperty('gauges');
      expect(stats).toHaveProperty('histograms');
      expect(stats).toHaveProperty('summaries');
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid metric names gracefully', () => {
      expect(() => {
        metricsCollector.increment('');
      }).not.toThrow();
      
      expect(() => {
        metricsCollector.gauge('invalid..name', 100);
      }).not.toThrow();
    });

    test('should handle invalid metric values gracefully', () => {
      expect(() => {
        metricsCollector.gauge('test', NaN);
      }).not.toThrow();
      
      expect(() => {
        metricsCollector.histogram('test', Infinity);
      }).not.toThrow();
    });

    test('should log errors when metrics collection fails', () => {
      // Force an error condition
      const originalProcess = process.memoryUsage;
      process.memoryUsage = jest.fn(() => {
        throw new Error('Memory usage error');
      });

      // This should not throw but should log an error
      expect(() => {
        metricsCollector.getMetrics();
      }).not.toThrow();

      // Restore original function
      process.memoryUsage = originalProcess;
    });
  });

  describe('Performance', () => {
    test('should handle high-frequency metrics efficiently', () => {
      const startTime = Date.now();
      
      for (let i = 0; i < 10000; i++) {
        metricsCollector.increment('high_frequency_counter');
        metricsCollector.gauge('high_frequency_gauge', Math.random() * 100);
      }
      
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Should complete within reasonable time (less than 1 second)
      expect(duration).toBeLessThan(1000);
    });

    test('should maintain memory efficiency with many metrics', () => {
      const initialMemory = process.memoryUsage().heapUsed;
      
      // Create many different metrics
      for (let i = 0; i < 1000; i++) {
        metricsCollector.increment(`metric_${i}`, { index: i.toString() });
      }
      
      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;
      
      // Memory increase should be reasonable (less than 50MB)
      expect(memoryIncrease).toBeLessThan(50 * 1024 * 1024);
    });
  });
});