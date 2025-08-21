/**
 * Jest Test Setup
 * Global test configuration and utilities
 */

import { Logger } from '../src/utils/Logger';

// Mock console methods to reduce noise during testing
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DISABLE_METRICS = 'true';

// Global test utilities
global.testUtils = {
  // Create a mock logger for testing
  createMockLogger: () => {
    return {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      fatal: jest.fn(),
      child: jest.fn(() => global.testUtils.createMockLogger()),
      setLevel: jest.fn(),
      getLevel: jest.fn(() => 'error'),
      isLevelEnabled: jest.fn(() => false),
      flush: jest.fn(),
      close: jest.fn()
    };
  },

  // Create mock metrics collector
  createMockMetrics: () => {
    return {
      increment: jest.fn(),
      decrement: jest.fn(),
      gauge: jest.fn(),
      histogram: jest.fn(),
      summary: jest.fn(),
      timer: jest.fn(() => ({ end: jest.fn() })),
      getMetrics: jest.fn(() => ({})),
      reset: jest.fn(),
      close: jest.fn()
    };
  },

  // Create mock connection gateway
  createMockGateway: () => {
    return {
      initialize: jest.fn(),
      connect: jest.fn(),
      disconnect: jest.fn(),
      sendRequest: jest.fn(),
      sendMessage: jest.fn(),
      subscribe: jest.fn(),
      unsubscribe: jest.fn(),
      isConnected: jest.fn(() => true),
      getStatus: jest.fn(() => ({ connected: true, lastHeartbeat: Date.now() })),
      close: jest.fn()
    };
  },

  // Wait for async operations
  wait: (ms: number = 10) => new Promise(resolve => setTimeout(resolve, ms)),

  // Create test timeout
  timeout: (ms: number = 5000) => {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Test timeout after ${ms}ms`)), ms);
    });
  }
};

// Global test constants
global.testConstants = {
  TEST_SYMBOL: 'EURUSD',
  TEST_ACCOUNT: '12345678',
  TEST_SERVER: 'TestServer-Demo',
  TEST_LOGIN: 'testuser',
  TEST_PASSWORD: 'testpass',
  MOCK_ENDPOINTS: {
    REQ: 'tcp://localhost:5555',
    SUB: 'tcp://localhost:5556',
    PUSH: 'tcp://localhost:5557'
  }
};

// Increase timeout for integration tests
jest.setTimeout(30000);

// Clean up after each test
afterEach(() => {
  jest.clearAllMocks();
});

// Global error handler for unhandled promises
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Type declarations for global test utilities
declare global {
  namespace NodeJS {
    interface Global {
      testUtils: {
        createMockLogger: () => any;
        createMockMetrics: () => any;
        createMockGateway: () => any;
        wait: (ms?: number) => Promise<void>;
        timeout: (ms?: number) => Promise<never>;
      };
      testConstants: {
        TEST_SYMBOL: string;
        TEST_ACCOUNT: string;
        TEST_SERVER: string;
        TEST_LOGIN: string;
        TEST_PASSWORD: string;
        MOCK_ENDPOINTS: {
          REQ: string;
          SUB: string;
          PUSH: string;
        };
      };
    }
  }
}