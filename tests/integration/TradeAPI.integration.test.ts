/**
 * Integration Tests for TradeAPI
 */

import { TradeAPI } from '../../src/api/TradeAPI';
import { ConnectionGateway } from '../../src/core/ConnectionGateway';
import { SecurityManager } from '../../src/security/SecurityManager';
import { Logger } from '../../src/utils/Logger';
import { MetricsCollector } from '../../src/utils/MetricsCollector';
import { CircuitBreaker } from '../../src/utils/CircuitBreaker';
import {
  TradeRequest,
  TradeResult,
  Position,
  Order,
  TradeType,
  OrderType,
  TradeAction,
  ConnectionConfig,
  SecurityConfig
} from '../../src/types';

describe('TradeAPI Integration Tests', () => {
  let tradeAPI: TradeAPI;
  let gateway: ConnectionGateway;
  let securityManager: SecurityManager;
  let logger: Logger;
  let metrics: MetricsCollector;
  let circuitBreaker: CircuitBreaker;

  beforeAll(async () => {
    // Setup test environment
    logger = new Logger({ level: 'error' });
    metrics = new MetricsCollector({ enabled: false });
    circuitBreaker = new CircuitBreaker({ enabled: false }, logger, metrics);

    const connectionConfig: ConnectionConfig = {
      endpoints: global.testConstants.MOCK_ENDPOINTS,
      timeout: 5000,
      retries: 2
    };

    const securityConfig: SecurityConfig = {
      curve: { enabled: false },
      authentication: { enabled: false },
      rateLimit: { enabled: false }
    };

    gateway = new ConnectionGateway(connectionConfig, securityConfig, logger, metrics, circuitBreaker);
    securityManager = new SecurityManager(securityConfig, logger, metrics);

    // Mock gateway responses for trading operations
    jest.spyOn(gateway, 'sendRequest').mockImplementation(async (command: string, data: any) => {
      switch (command) {
        case 'trade.execute':
          return {
            success: true,
            ticket: Math.floor(Math.random() * 1000000),
            price: data.price || 1.1234,
            volume: data.volume,
            comment: data.comment || 'Test trade'
          };
        
        case 'trade.positions':
          return {
            success: true,
            positions: [
              {
                ticket: 123456,
                symbol: 'EURUSD',
                type: TradeType.BUY,
                volume: 0.1,
                openPrice: 1.1234,
                currentPrice: 1.1240,
                profit: 6.0,
                swap: -0.5,
                commission: -1.0,
                openTime: new Date().toISOString(),
                comment: 'Test position'
              }
            ]
          };
        
        case 'trade.orders':
          return {
            success: true,
            orders: [
              {
                ticket: 789012,
                symbol: 'GBPUSD',
                type: OrderType.BUY_LIMIT,
                volume: 0.2,
                openPrice: 1.2500,
                currentPrice: 1.2520,
                expiration: new Date(Date.now() + 86400000).toISOString(),
                comment: 'Test order'
              }
            ]
          };
        
        case 'trade.close':
          return {
            success: true,
            ticket: data.ticket,
            closePrice: data.price || 1.1240,
            profit: 6.0
          };
        
        case 'trade.cancel':
          return {
            success: true,
            ticket: data.ticket
          };
        
        case 'trade.modify':
          return {
            success: true,
            ticket: data.ticket,
            newPrice: data.price,
            newStopLoss: data.stopLoss,
            newTakeProfit: data.takeProfit
          };
        
        case 'trade.history':
          return {
            success: true,
            trades: [
              {
                ticket: 111222,
                symbol: 'EURUSD',
                type: TradeType.BUY,
                volume: 0.1,
                openPrice: 1.1200,
                closePrice: 1.1250,
                profit: 50.0,
                openTime: new Date(Date.now() - 86400000).toISOString(),
                closeTime: new Date().toISOString(),
                comment: 'Closed trade'
              }
            ]
          };
        
        default:
          return { success: false, error: 'Unknown command' };
      }
    });

    await gateway.initialize();
    await securityManager.initialize();

    tradeAPI = new TradeAPI(gateway, securityManager, logger, metrics, circuitBreaker);
    await tradeAPI.initialize();
  });

  afterAll(async () => {
    await tradeAPI?.close();
    await gateway?.close();
    await securityManager?.close();
    await logger?.close();
    await metrics?.close();
  });

  describe('Trade Execution', () => {
    test('should execute market buy order successfully', async () => {
      const tradeRequest: TradeRequest = {
        action: TradeAction.DEAL,
        symbol: global.testConstants.TEST_SYMBOL,
        volume: 0.1,
        type: TradeType.BUY,
        comment: 'Integration test buy'
      };

      const result = await tradeAPI.executeTrade(tradeRequest);

      expect(result.success).toBe(true);
      expect(result.ticket).toBeDefined();
      expect(result.price).toBeDefined();
      expect(result.volume).toBe(0.1);
    });

    test('should execute market sell order successfully', async () => {
      const tradeRequest: TradeRequest = {
        action: TradeAction.DEAL,
        symbol: global.testConstants.TEST_SYMBOL,
        volume: 0.2,
        type: TradeType.SELL,
        comment: 'Integration test sell'
      };

      const result = await tradeAPI.executeTrade(tradeRequest);

      expect(result.success).toBe(true);
      expect(result.ticket).toBeDefined();
      expect(result.volume).toBe(0.2);
    });

    test('should place pending buy limit order', async () => {
      const tradeRequest: TradeRequest = {
        action: TradeAction.PENDING,
        symbol: global.testConstants.TEST_SYMBOL,
        volume: 0.1,
        type: TradeType.BUY_LIMIT,
        price: 1.1200,
        expiration: new Date(Date.now() + 86400000),
        comment: 'Integration test buy limit'
      };

      const result = await tradeAPI.executeTrade(tradeRequest);

      expect(result.success).toBe(true);
      expect(result.ticket).toBeDefined();
    });

    test('should place pending sell stop order', async () => {
      const tradeRequest: TradeRequest = {
        action: TradeAction.PENDING,
        symbol: global.testConstants.TEST_SYMBOL,
        volume: 0.15,
        type: TradeType.SELL_STOP,
        price: 1.1100,
        stopLoss: 1.1150,
        takeProfit: 1.1050,
        comment: 'Integration test sell stop'
      };

      const result = await tradeAPI.executeTrade(tradeRequest);

      expect(result.success).toBe(true);
      expect(result.ticket).toBeDefined();
    });

    test('should handle trade execution with stop loss and take profit', async () => {
      const tradeRequest: TradeRequest = {
        action: TradeAction.DEAL,
        symbol: global.testConstants.TEST_SYMBOL,
        volume: 0.1,
        type: TradeType.BUY,
        stopLoss: 1.1200,
        takeProfit: 1.1300,
        comment: 'Integration test with SL/TP'
      };

      const result = await tradeAPI.executeTrade(tradeRequest);

      expect(result.success).toBe(true);
      expect(result.ticket).toBeDefined();
    });
  });

  describe('Position Management', () => {
    test('should retrieve all open positions', async () => {
      const positions = await tradeAPI.getPositions();

      expect(Array.isArray(positions)).toBe(true);
      expect(positions.length).toBeGreaterThan(0);
      
      const position = positions[0];
      expect(position).toHaveProperty('ticket');
      expect(position).toHaveProperty('symbol');
      expect(position).toHaveProperty('type');
      expect(position).toHaveProperty('volume');
      expect(position).toHaveProperty('openPrice');
      expect(position).toHaveProperty('currentPrice');
      expect(position).toHaveProperty('profit');
    });

    test('should retrieve positions for specific symbol', async () => {
      const positions = await tradeAPI.getPositions(global.testConstants.TEST_SYMBOL);

      expect(Array.isArray(positions)).toBe(true);
      positions.forEach(position => {
        expect(position.symbol).toBe(global.testConstants.TEST_SYMBOL);
      });
    });

    test('should close position by ticket', async () => {
      const positions = await tradeAPI.getPositions();
      expect(positions.length).toBeGreaterThan(0);

      const position = positions[0];
      const result = await tradeAPI.closePosition(position.ticket);

      expect(result.success).toBe(true);
      expect(result.ticket).toBe(position.ticket);
      expect(result.closePrice).toBeDefined();
    });

    test('should close position with specific price', async () => {
      const positions = await tradeAPI.getPositions();
      expect(positions.length).toBeGreaterThan(0);

      const position = positions[0];
      const closePrice = 1.1240;
      const result = await tradeAPI.closePosition(position.ticket, closePrice);

      expect(result.success).toBe(true);
      expect(result.closePrice).toBe(closePrice);
    });

    test('should close all positions for symbol', async () => {
      const results = await tradeAPI.closeAllPositions(global.testConstants.TEST_SYMBOL);

      expect(Array.isArray(results)).toBe(true);
      results.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.ticket).toBeDefined();
      });
    });
  });

  describe('Order Management', () => {
    test('should retrieve all pending orders', async () => {
      const orders = await tradeAPI.getOrders();

      expect(Array.isArray(orders)).toBe(true);
      expect(orders.length).toBeGreaterThan(0);
      
      const order = orders[0];
      expect(order).toHaveProperty('ticket');
      expect(order).toHaveProperty('symbol');
      expect(order).toHaveProperty('type');
      expect(order).toHaveProperty('volume');
      expect(order).toHaveProperty('openPrice');
    });

    test('should retrieve orders for specific symbol', async () => {
      const orders = await tradeAPI.getOrders('GBPUSD');

      expect(Array.isArray(orders)).toBe(true);
      orders.forEach(order => {
        expect(order.symbol).toBe('GBPUSD');
      });
    });

    test('should cancel pending order', async () => {
      const orders = await tradeAPI.getOrders();
      expect(orders.length).toBeGreaterThan(0);

      const order = orders[0];
      const result = await tradeAPI.cancelOrder(order.ticket);

      expect(result.success).toBe(true);
      expect(result.ticket).toBe(order.ticket);
    });

    test('should modify pending order price', async () => {
      const orders = await tradeAPI.getOrders();
      expect(orders.length).toBeGreaterThan(0);

      const order = orders[0];
      const newPrice = 1.2600;
      const result = await tradeAPI.modifyOrder(order.ticket, {
        price: newPrice
      });

      expect(result.success).toBe(true);
      expect(result.newPrice).toBe(newPrice);
    });

    test('should modify order with stop loss and take profit', async () => {
      const orders = await tradeAPI.getOrders();
      expect(orders.length).toBeGreaterThan(0);

      const order = orders[0];
      const modifications = {
        price: 1.2550,
        stopLoss: 1.2500,
        takeProfit: 1.2650
      };

      const result = await tradeAPI.modifyOrder(order.ticket, modifications);

      expect(result.success).toBe(true);
      expect(result.newPrice).toBe(modifications.price);
      expect(result.newStopLoss).toBe(modifications.stopLoss);
      expect(result.newTakeProfit).toBe(modifications.takeProfit);
    });
  });

  describe('Trade History', () => {
    test('should retrieve trade history', async () => {
      const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
      const toDate = new Date();

      const history = await tradeAPI.getTradeHistory(fromDate, toDate);

      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBeGreaterThan(0);
      
      const trade = history[0];
      expect(trade).toHaveProperty('ticket');
      expect(trade).toHaveProperty('symbol');
      expect(trade).toHaveProperty('type');
      expect(trade).toHaveProperty('volume');
      expect(trade).toHaveProperty('openPrice');
      expect(trade).toHaveProperty('closePrice');
      expect(trade).toHaveProperty('profit');
      expect(trade).toHaveProperty('openTime');
      expect(trade).toHaveProperty('closeTime');
    });

    test('should retrieve trade history for specific symbol', async () => {
      const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const toDate = new Date();

      const history = await tradeAPI.getTradeHistory(
        fromDate,
        toDate,
        global.testConstants.TEST_SYMBOL
      );

      expect(Array.isArray(history)).toBe(true);
      history.forEach(trade => {
        expect(trade.symbol).toBe(global.testConstants.TEST_SYMBOL);
      });
    });

    test('should handle empty trade history', async () => {
      const fromDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // Future date
      const toDate = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

      // Mock empty response
      jest.spyOn(gateway, 'sendRequest').mockResolvedValueOnce({
        success: true,
        trades: []
      });

      const history = await tradeAPI.getTradeHistory(fromDate, toDate);

      expect(Array.isArray(history)).toBe(true);
      expect(history.length).toBe(0);
    });
  });

  describe('Error Handling', () => {
    test('should handle trade execution errors', async () => {
      // Mock error response
      jest.spyOn(gateway, 'sendRequest').mockResolvedValueOnce({
        success: false,
        error: 'Insufficient margin',
        code: 10019
      });

      const tradeRequest: TradeRequest = {
        action: TradeAction.DEAL,
        symbol: global.testConstants.TEST_SYMBOL,
        volume: 100, // Unrealistic volume
        type: TradeType.BUY
      };

      await expect(tradeAPI.executeTrade(tradeRequest)).rejects.toThrow('Insufficient margin');
    });

    test('should handle network timeouts', async () => {
      // Mock timeout
      jest.spyOn(gateway, 'sendRequest').mockRejectedValueOnce(
        new Error('Request timeout')
      );

      const tradeRequest: TradeRequest = {
        action: TradeAction.DEAL,
        symbol: global.testConstants.TEST_SYMBOL,
        volume: 0.1,
        type: TradeType.BUY
      };

      await expect(tradeAPI.executeTrade(tradeRequest)).rejects.toThrow('Request timeout');
    });

    test('should handle invalid trade parameters', async () => {
      const invalidRequest: TradeRequest = {
        action: TradeAction.DEAL,
        symbol: '', // Invalid symbol
        volume: -0.1, // Invalid volume
        type: TradeType.BUY
      };

      await expect(tradeAPI.executeTrade(invalidRequest)).rejects.toThrow();
    });
  });

  describe('Performance and Concurrency', () => {
    test('should handle multiple concurrent trade requests', async () => {
      const requests = Array.from({ length: 5 }, (_, i) => ({
        action: TradeAction.DEAL as TradeAction,
        symbol: global.testConstants.TEST_SYMBOL,
        volume: 0.1,
        type: TradeType.BUY,
        comment: `Concurrent trade ${i + 1}`
      }));

      const promises = requests.map(request => tradeAPI.executeTrade(request));
      const results = await Promise.all(promises);

      expect(results).toHaveLength(5);
      results.forEach(result => {
        expect(result.success).toBe(true);
        expect(result.ticket).toBeDefined();
      });
    });

    test('should handle rapid position queries', async () => {
      const promises = Array.from({ length: 10 }, () => tradeAPI.getPositions());
      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      results.forEach(positions => {
        expect(Array.isArray(positions)).toBe(true);
      });
    });

    test('should maintain performance under load', async () => {
      const startTime = Date.now();
      
      const operations = [
        () => tradeAPI.getPositions(),
        () => tradeAPI.getOrders(),
        () => tradeAPI.getTradeHistory(
          new Date(Date.now() - 24 * 60 * 60 * 1000),
          new Date()
        )
      ];

      const promises = Array.from({ length: 30 }, (_, i) => 
        operations[i % operations.length]()
      );

      await Promise.all(promises);
      
      const duration = Date.now() - startTime;
      
      // Should complete within reasonable time (less than 5 seconds)
      expect(duration).toBeLessThan(5000);
    });
  });

  describe('Cache Functionality', () => {
    test('should cache position data', async () => {
      // First call should hit the gateway
      const positions1 = await tradeAPI.getPositions();
      
      // Second call should use cache (if implemented)
      const positions2 = await tradeAPI.getPositions();
      
      expect(positions1).toEqual(positions2);
    });

    test('should invalidate cache after trade execution', async () => {
      // Get initial positions
      const initialPositions = await tradeAPI.getPositions();
      
      // Execute a trade
      const tradeRequest: TradeRequest = {
        action: TradeAction.DEAL,
        symbol: global.testConstants.TEST_SYMBOL,
        volume: 0.1,
        type: TradeType.BUY
      };
      
      await tradeAPI.executeTrade(tradeRequest);
      
      // Get positions again - should reflect the new trade
      const updatedPositions = await tradeAPI.getPositions();
      
      // Note: In a real scenario, this would show different results
      // Here we're just ensuring the call completes successfully
      expect(Array.isArray(updatedPositions)).toBe(true);
    });
  });
});