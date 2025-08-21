/**
 * Unit Tests for Logger
 */

import { Logger } from '../../../src/utils/Logger';
import { LogLevel, LogFormat, LogOutput } from '../../../src/types';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('Logger', () => {
  let logger: Logger;
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (logger) {
      logger.close();
    }
    consoleSpy.mockRestore();
  });

  describe('Basic Logging', () => {
    beforeEach(() => {
      logger = new Logger({
        level: LogLevel.DEBUG,
        format: LogFormat.JSON,
        outputs: [LogOutput.CONSOLE]
      });
    });

    test('should create logger with default configuration', () => {
      const defaultLogger = new Logger();
      expect(defaultLogger.getLevel()).toBe(LogLevel.INFO);
      defaultLogger.close();
    });

    test('should log messages at different levels', () => {
      logger.debug('Debug message');
      logger.info('Info message');
      logger.warn('Warning message');
      logger.error('Error message');
      logger.fatal('Fatal message');

      expect(consoleSpy).toHaveBeenCalledTimes(5);
    });

    test('should respect log level filtering', () => {
      logger.setLevel(LogLevel.WARN);
      
      logger.debug('Debug message');
      logger.info('Info message');
      logger.warn('Warning message');
      logger.error('Error message');

      expect(consoleSpy).toHaveBeenCalledTimes(2); // Only warn and error
    });

    test('should check if level is enabled', () => {
      logger.setLevel(LogLevel.INFO);
      
      expect(logger.isLevelEnabled(LogLevel.DEBUG)).toBe(false);
      expect(logger.isLevelEnabled(LogLevel.INFO)).toBe(true);
      expect(logger.isLevelEnabled(LogLevel.WARN)).toBe(true);
      expect(logger.isLevelEnabled(LogLevel.ERROR)).toBe(true);
    });
  });

  describe('Log Formatting', () => {
    test('should format logs as JSON', () => {
      logger = new Logger({
        level: LogLevel.INFO,
        format: LogFormat.JSON,
        outputs: [LogOutput.CONSOLE]
      });

      logger.info('Test message', { key: 'value' });
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"message":"Test message"')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"key":"value"')
      );
    });

    test('should format logs as text', () => {
      logger = new Logger({
        level: LogLevel.INFO,
        format: LogFormat.TEXT,
        outputs: [LogOutput.CONSOLE]
      });

      logger.info('Test message');
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('INFO')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test message')
      );
    });

    test('should format logs as structured', () => {
      logger = new Logger({
        level: LogLevel.INFO,
        format: LogFormat.STRUCTURED,
        outputs: [LogOutput.CONSOLE]
      });

      logger.info('Test message', { requestId: '123' });
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('requestId=123')
      );
    });
  });

  describe('Child Loggers', () => {
    beforeEach(() => {
      logger = new Logger({
        level: LogLevel.INFO,
        format: LogFormat.JSON,
        outputs: [LogOutput.CONSOLE]
      });
    });

    test('should create child logger with additional context', () => {
      const childLogger = logger.child({ component: 'TestComponent' });
      
      childLogger.info('Child message');
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"component":"TestComponent"')
      );
    });

    test('should inherit parent logger configuration', () => {
      const childLogger = logger.child({ module: 'test' });
      
      expect(childLogger.getLevel()).toBe(logger.getLevel());
    });
  });

  describe('File Output', () => {
    beforeEach(() => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.mkdirSync.mockImplementation();
      mockFs.appendFileSync.mockImplementation();
      mockFs.statSync.mockReturnValue({ size: 1000 } as any);
    });

    test('should write logs to file', () => {
      logger = new Logger({
        level: LogLevel.INFO,
        format: LogFormat.JSON,
        outputs: [LogOutput.FILE],
        file: {
          path: '/tmp/test.log',
          maxSize: 10485760,
          maxFiles: 5
        }
      });

      logger.info('File log message');
      
      expect(mockFs.appendFileSync).toHaveBeenCalled();
    });

    test('should create log directory if it does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      
      logger = new Logger({
        level: LogLevel.INFO,
        outputs: [LogOutput.FILE],
        file: {
          path: '/tmp/logs/test.log',
          maxSize: 10485760,
          maxFiles: 5
        }
      });

      logger.info('Test message');
      
      expect(mockFs.mkdirSync).toHaveBeenCalledWith(
        '/tmp/logs',
        { recursive: true }
      );
    });
  });

  describe('Error Handling', () => {
    beforeEach(() => {
      logger = new Logger({
        level: LogLevel.INFO,
        format: LogFormat.JSON,
        outputs: [LogOutput.CONSOLE]
      });
    });

    test('should handle logging errors gracefully', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();
      consoleSpy.mockImplementation(() => {
        throw new Error('Console error');
      });

      expect(() => {
        logger.info('Test message');
      }).not.toThrow();

      errorSpy.mockRestore();
    });

    test('should log Error objects properly', () => {
      const error = new Error('Test error');
      error.stack = 'Error stack trace';
      
      logger.error('Error occurred', { error });
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test error')
      );
    });
  });

  describe('Metrics Integration', () => {
    test('should collect logging metrics', () => {
      const mockMetrics = global.testUtils.createMockMetrics();
      
      logger = new Logger({
        level: LogLevel.INFO,
        format: LogFormat.JSON,
        outputs: [LogOutput.CONSOLE],
        metrics: mockMetrics
      });

      logger.info('Test message');
      logger.error('Error message');
      
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'logger.messages.total',
        expect.objectContaining({ level: 'info' })
      );
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'logger.messages.total',
        expect.objectContaining({ level: 'error' })
      );
    });
  });

  describe('Async Operations', () => {
    test('should handle async logging', async () => {
      logger = new Logger({
        level: LogLevel.INFO,
        format: LogFormat.JSON,
        outputs: [LogOutput.CONSOLE],
        async: true
      });

      logger.info('Async message 1');
      logger.info('Async message 2');
      
      await logger.flush();
      
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });

    test('should flush pending logs on close', async () => {
      logger = new Logger({
        level: LogLevel.INFO,
        format: LogFormat.JSON,
        outputs: [LogOutput.CONSOLE],
        async: true
      });

      logger.info('Message before close');
      
      await logger.close();
      
      expect(consoleSpy).toHaveBeenCalled();
    });
  });
});