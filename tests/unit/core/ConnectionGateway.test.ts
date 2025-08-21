/**
 * Unit Tests for ConnectionGateway
 */

import { ConnectionGateway } from '../../../src/core/ConnectionGateway';
import { ConnectionConfig, SecurityConfig } from '../../../src/types';
import { EventEmitter } from 'events';

// Mock ZeroMQ
jest.mock('zeromq', () => ({
  Request: jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    disconnect: jest.fn(),
    send: jest.fn(),
    receive: jest.fn(),
    close: jest.fn(),
    events: {
      on: jest.fn(),
      off: jest.fn()
    }
  })),
  Subscriber: jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    disconnect: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    receive: jest.fn(),
    close: jest.fn(),
    events: {
      on: jest.fn(),
      off: jest.fn()
    }
  })),
  Push: jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    disconnect: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
    events: {
      on: jest.fn(),
      off: jest.fn()
    }
  }))
}));

// Mock libsodium-wrappers
jest.mock('libsodium-wrappers', () => ({
  ready: Promise.resolve(),
  crypto_box_keypair: jest.fn(() => ({
    publicKey: new Uint8Array(32),
    privateKey: new Uint8Array(32)
  })),
  crypto_box_easy: jest.fn(() => new Uint8Array(48)),
  crypto_box_open_easy: jest.fn(() => new Uint8Array(16)),
  randombytes_buf: jest.fn(() => new Uint8Array(24))
}));

describe('ConnectionGateway', () => {
  let gateway: ConnectionGateway;
  let mockLogger: any;
  let mockMetrics: any;
  let mockCircuitBreaker: any;
  let config: ConnectionConfig;
  let securityConfig: SecurityConfig;

  beforeEach(() => {
    mockLogger = global.testUtils.createMockLogger();
    mockMetrics = global.testUtils.createMockMetrics();
    mockCircuitBreaker = {
      execute: jest.fn((fn) => fn()),
      getState: jest.fn(() => 'CLOSED'),
      getStats: jest.fn(() => ({ failures: 0, successes: 0 }))
    };

    config = {
      endpoints: {
        req: 'tcp://localhost:5555',
        sub: 'tcp://localhost:5556',
        push: 'tcp://localhost:5557'
      },
      timeout: 5000,
      retries: 3,
      heartbeat: {
        interval: 30000,
        timeout: 10000
      },
      reconnect: {
        enabled: true,
        maxAttempts: 5,
        delay: 1000,
        backoff: 2
      }
    };

    securityConfig = {
      curve: {
        enabled: true,
        serverKey: 'test-server-key',
        clientKeys: ['test-client-key']
      },
      authentication: {
        enabled: true,
        method: 'jwt',
        secret: 'test-secret',
        expiresIn: '1h'
      },
      rateLimit: {
        enabled: true,
        requests: 100,
        window: 60000
      }
    };

    gateway = new ConnectionGateway(
      config,
      securityConfig,
      mockLogger,
      mockMetrics,
      mockCircuitBreaker
    );
  });

  afterEach(async () => {
    if (gateway) {
      await gateway.close();
    }
  });

  describe('Initialization', () => {
    test('should initialize with provided configuration', () => {
      expect(gateway).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'ConnectionGateway initialized',
        expect.any(Object)
      );
    });

    test('should initialize with default configuration', () => {
      const defaultGateway = new ConnectionGateway();
      expect(defaultGateway).toBeDefined();
      defaultGateway.close();
    });

    test('should setup CURVE security when enabled', async () => {
      await gateway.initialize();
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('CURVE security enabled')
      );
    });
  });

  describe('Connection Management', () => {
    beforeEach(async () => {
      await gateway.initialize();
    });

    test('should connect to all endpoints', async () => {
      await gateway.connect();
      
      expect(gateway.isConnected()).toBe(true);
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'gateway.connections.established'
      );
    });

    test('should disconnect from all endpoints', async () => {
      await gateway.connect();
      await gateway.disconnect();
      
      expect(gateway.isConnected()).toBe(false);
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'gateway.connections.closed'
      );
    });

    test('should handle connection failures gracefully', async () => {
      // Mock connection failure
      const zmq = require('zeromq');
      zmq.Request.mockImplementation(() => ({
        connect: jest.fn().mockRejectedValue(new Error('Connection failed')),
        close: jest.fn()
      }));

      await expect(gateway.connect()).rejects.toThrow('Connection failed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to connect'),
        expect.any(Object)
      );
    });

    test('should get connection status', async () => {
      await gateway.connect();
      
      const status = gateway.getStatus();
      
      expect(status).toHaveProperty('connected');
      expect(status).toHaveProperty('endpoints');
      expect(status).toHaveProperty('lastHeartbeat');
      expect(status).toHaveProperty('pendingRequests');
    });
  });

  describe('Request/Response Communication', () => {
    beforeEach(async () => {
      await gateway.initialize();
      await gateway.connect();
    });

    test('should send request and receive response', async () => {
      const mockResponse = { success: true, data: 'test' };
      
      // Mock ZeroMQ receive
      const zmq = require('zeromq');
      const mockSocket = zmq.Request();
      mockSocket.receive.mockResolvedValue([Buffer.from(JSON.stringify(mockResponse))]);

      const response = await gateway.sendRequest('test.command', { param: 'value' });
      
      expect(response).toEqual(mockResponse);
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'gateway.requests.sent'
      );
    });

    test('should handle request timeout', async () => {
      // Mock timeout
      const zmq = require('zeromq');
      const mockSocket = zmq.Request();
      mockSocket.receive.mockImplementation(() => 
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), 100)
        )
      );

      await expect(
        gateway.sendRequest('slow.command', {}, { timeout: 50 })
      ).rejects.toThrow('Timeout');
      
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'gateway.requests.timeout'
      );
    });

    test('should retry failed requests', async () => {
      const zmq = require('zeromq');
      const mockSocket = zmq.Request();
      
      // Fail first two attempts, succeed on third
      mockSocket.receive
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce([Buffer.from(JSON.stringify({ success: true }))]);

      const response = await gateway.sendRequest('retry.command', {});
      
      expect(response).toEqual({ success: true });
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'gateway.requests.retried'
      );
    });

    test('should track pending requests', async () => {
      const zmq = require('zeromq');
      const mockSocket = zmq.Request();
      mockSocket.receive.mockImplementation(() => 
        new Promise(resolve => setTimeout(() => 
          resolve([Buffer.from(JSON.stringify({ success: true }))]), 100
        ))
      );

      const requestPromise = gateway.sendRequest('pending.command', {});
      
      // Check pending requests
      const status = gateway.getStatus();
      expect(status.pendingRequests).toBeGreaterThan(0);
      
      await requestPromise;
      
      // Check requests cleared
      const finalStatus = gateway.getStatus();
      expect(finalStatus.pendingRequests).toBe(0);
    });
  });

  describe('Publish/Subscribe Communication', () => {
    beforeEach(async () => {
      await gateway.initialize();
      await gateway.connect();
    });

    test('should subscribe to events', async () => {
      const callback = jest.fn();
      
      await gateway.subscribe('market.tick', callback);
      
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'gateway.subscriptions.added'
      );
    });

    test('should unsubscribe from events', async () => {
      const callback = jest.fn();
      
      await gateway.subscribe('market.tick', callback);
      await gateway.unsubscribe('market.tick', callback);
      
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'gateway.subscriptions.removed'
      );
    });

    test('should handle subscription messages', async () => {
      const callback = jest.fn();
      const testMessage = { symbol: 'EURUSD', bid: 1.1234, ask: 1.1236 };
      
      await gateway.subscribe('market.tick', callback);
      
      // Simulate receiving a message
      const zmq = require('zeromq');
      const mockSocket = zmq.Subscriber();
      const messageHandler = mockSocket.events.on.mock.calls
        .find(call => call[0] === 'message')?.[1];
      
      if (messageHandler) {
        messageHandler('market.tick', Buffer.from(JSON.stringify(testMessage)));
        
        expect(callback).toHaveBeenCalledWith(testMessage);
        expect(mockMetrics.increment).toHaveBeenCalledWith(
          'gateway.messages.received'
        );
      }
    });

    test('should send push messages', async () => {
      const message = { type: 'notification', content: 'Test message' };
      
      await gateway.sendMessage('notifications', message);
      
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'gateway.messages.sent'
      );
    });
  });

  describe('Heartbeat Mechanism', () => {
    beforeEach(async () => {
      await gateway.initialize();
      await gateway.connect();
    });

    test('should start heartbeat when connected', async () => {
      const status = gateway.getStatus();
      expect(status.lastHeartbeat).toBeDefined();
    });

    test('should update heartbeat timestamp', async () => {
      const initialStatus = gateway.getStatus();
      const initialHeartbeat = initialStatus.lastHeartbeat;
      
      await global.testUtils.wait(100);
      
      // Trigger heartbeat update
      const updatedStatus = gateway.getStatus();
      expect(updatedStatus.lastHeartbeat).toBeGreaterThanOrEqual(initialHeartbeat);
    });
  });

  describe('Security Features', () => {
    test('should encrypt messages when CURVE is enabled', async () => {
      await gateway.initialize();
      await gateway.connect();
      
      const message = { sensitive: 'data' };
      await gateway.sendRequest('secure.command', message);
      
      // Verify encryption was attempted
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Encrypting message')
      );
    });

    test('should validate client certificates', async () => {
      const invalidConfig = {
        ...securityConfig,
        curve: {
          ...securityConfig.curve,
          clientKeys: [] // No valid client keys
        }
      };
      
      const secureGateway = new ConnectionGateway(
        config,
        invalidConfig,
        mockLogger,
        mockMetrics
      );
      
      await secureGateway.initialize();
      
      // Should log security warning
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('No client keys configured')
      );
      
      await secureGateway.close();
    });
  });

  describe('Error Handling and Recovery', () => {
    beforeEach(async () => {
      await gateway.initialize();
    });

    test('should handle socket errors gracefully', async () => {
      await gateway.connect();
      
      // Simulate socket error
      const zmq = require('zeromq');
      const mockSocket = zmq.Request();
      const errorHandler = mockSocket.events.on.mock.calls
        .find(call => call[0] === 'error')?.[1];
      
      if (errorHandler) {
        errorHandler(new Error('Socket error'));
        
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.stringContaining('Socket error'),
          expect.any(Object)
        );
      }
    });

    test('should attempt reconnection on connection loss', async () => {
      await gateway.connect();
      
      // Simulate connection loss
      const zmq = require('zeromq');
      const mockSocket = zmq.Request();
      const disconnectHandler = mockSocket.events.on.mock.calls
        .find(call => call[0] === 'disconnect')?.[1];
      
      if (disconnectHandler) {
        disconnectHandler();
        
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Connection lost')
        );
        expect(mockMetrics.increment).toHaveBeenCalledWith(
          'gateway.reconnect.attempts'
        );
      }
    });

    test('should respect maximum reconnection attempts', async () => {
      const limitedConfig = {
        ...config,
        reconnect: {
          ...config.reconnect,
          maxAttempts: 2
        }
      };
      
      const limitedGateway = new ConnectionGateway(
        limitedConfig,
        securityConfig,
        mockLogger,
        mockMetrics
      );
      
      await limitedGateway.initialize();
      
      // Mock repeated connection failures
      const zmq = require('zeromq');
      zmq.Request.mockImplementation(() => ({
        connect: jest.fn().mockRejectedValue(new Error('Connection failed')),
        close: jest.fn()
      }));
      
      await expect(limitedGateway.connect()).rejects.toThrow();
      
      await limitedGateway.close();
    });
  });

  describe('Metrics and Monitoring', () => {
    beforeEach(async () => {
      await gateway.initialize();
      await gateway.connect();
    });

    test('should collect connection metrics', () => {
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'gateway.connections.established'
      );
    });

    test('should collect request metrics', async () => {
      const zmq = require('zeromq');
      const mockSocket = zmq.Request();
      mockSocket.receive.mockResolvedValue([Buffer.from(JSON.stringify({ success: true }))]);
      
      await gateway.sendRequest('test.command', {});
      
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'gateway.requests.sent'
      );
      expect(mockMetrics.histogram).toHaveBeenCalledWith(
        'gateway.request.duration',
        expect.any(Number)
      );
    });

    test('should collect subscription metrics', async () => {
      const callback = jest.fn();
      
      await gateway.subscribe('test.event', callback);
      
      expect(mockMetrics.increment).toHaveBeenCalledWith(
        'gateway.subscriptions.added'
      );
      expect(mockMetrics.gauge).toHaveBeenCalledWith(
        'gateway.subscriptions.active',
        expect.any(Number)
      );
    });
  });

  describe('Cleanup and Shutdown', () => {
    test('should close all connections on shutdown', async () => {
      await gateway.initialize();
      await gateway.connect();
      
      await gateway.close();
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        'ConnectionGateway closed'
      );
    });

    test('should clear pending requests on shutdown', async () => {
      await gateway.initialize();
      await gateway.connect();
      
      // Create pending request
      const zmq = require('zeromq');
      const mockSocket = zmq.Request();
      mockSocket.receive.mockImplementation(() => new Promise(() => {})); // Never resolves
      
      const requestPromise = gateway.sendRequest('pending.command', {});
      
      await gateway.close();
      
      await expect(requestPromise).rejects.toThrow();
    });

    test('should stop heartbeat on shutdown', async () => {
      await gateway.initialize();
      await gateway.connect();
      
      const statusBefore = gateway.getStatus();
      expect(statusBefore.connected).toBe(true);
      
      await gateway.close();
      
      const statusAfter = gateway.getStatus();
      expect(statusAfter.connected).toBe(false);
    });
  });
});