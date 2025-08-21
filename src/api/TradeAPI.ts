/**
 * TradeAPI - Handles trading operations including order execution and position management
 */

import { EventEmitter } from 'eventemitter3';
import {
  TradeRequest,
  TradeResult,
  Position,
  Order,
  TradeAction,
  OrderType,
  ZMQMessage,
  MessageType
} from '../types';
import { ConnectionGateway } from '../core/ConnectionGateway';
import { SecurityManager } from '../security/SecurityManager';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { CircuitBreaker } from '../utils/CircuitBreaker';
import { ValidationError, TradeError, TimeoutError } from '../core/errors';
import { MESSAGE_TYPES, TRADE_ACTIONS, ORDER_TYPES, DEFAULTS } from '../constants';
import { v4 as uuidv4 } from 'uuid';

/**
 * Trade API for executing trades and managing positions
 */
export class TradeAPI extends EventEmitter {
  private readonly connectionGateway: ConnectionGateway;
  private readonly securityManager: SecurityManager;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private readonly circuitBreaker: CircuitBreaker;
  
  private isInitialized: boolean = false;
  private activeOrders: Map<string, Order> = new Map();
  private activePositions: Map<string, Position> = new Map();
  
  // Trade execution settings
  private readonly maxSlippage: number;
  private readonly defaultTimeout: number;
  private readonly retryAttempts: number;

  constructor(
    connectionGateway: ConnectionGateway,
    securityManager: SecurityManager,
    logger: Logger,
    metrics: MetricsCollector,
    circuitBreaker: CircuitBreaker
  ) {
    super();

    this.connectionGateway = connectionGateway;
    this.securityManager = securityManager;
    this.logger = logger.child({ component: 'TradeAPI' });
    this.metrics = metrics;
    this.circuitBreaker = circuitBreaker;
    
    // Trade execution settings
    this.maxSlippage = DEFAULTS.TRADING.MAX_SLIPPAGE;
    this.defaultTimeout = DEFAULTS.TRADING.ORDER_TIMEOUT;
    this.retryAttempts = DEFAULTS.TRADING.RETRY_ATTEMPTS;

    this.logger.info('TradeAPI created');
  }

  /**
   * Initialize the Trade API
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('TradeAPI is already initialized');
    }

    try {
      this.logger.info('Initializing TradeAPI...');
      this.metrics.startTimer('trade_api_initialization');

      // Subscribe to trade-related events
      await this.subscribeToTradeEvents();
      
      // Load existing positions and orders
      await this.loadExistingPositions();
      await this.loadExistingOrders();
      
      this.isInitialized = true;
      this.metrics.endTimer('trade_api_initialization');
      
      this.logger.info('TradeAPI initialized successfully');
      
    } catch (error) {
      this.metrics.endTimer('trade_api_initialization');
      this.logger.error('Failed to initialize TradeAPI', { error });
      throw error;
    }
  }

  /**
   * Execute a trade request
   */
  async executeTrade(request: TradeRequest, sessionId: string): Promise<TradeResult> {
    this.validateInitialized();
    this.validateTradeRequest(request);

    const tradeId = uuidv4();
    
    try {
      this.logger.info('Executing trade', {
        tradeId,
        symbol: request.symbol,
        action: request.action,
        volume: request.volume,
        orderType: request.orderType
      });
      
      this.metrics.startTimer('trade_execution');
      
      const message: ZMQMessage = {
        type: MESSAGE_TYPES.TRADE_REQUEST,
        action: 'execute',
        data: {
          tradeId,
          sessionId,
          request,
          timestamp: Date.now()
        }
      };
      
      const response = await this.connectionGateway.sendRequest(message);
      
      if (response.error) {
        throw new TradeError(response.error, response.errorCode || 'TRADE_EXECUTION_FAILED');
      }
      
      const result: TradeResult = {
        orderId: response.data.orderId,
        ticket: response.data.ticket,
        executionPrice: response.data.executionPrice,
        executionTime: new Date(response.data.executionTime),
        volume: response.data.volume,
        commission: response.data.commission,
        swap: response.data.swap,
        profit: response.data.profit,
        slippage: response.data.slippage,
        comment: response.data.comment,
        success: response.data.success
      };
      
      this.metrics.endTimer('trade_execution');
      this.metrics.recordMetric('trades_executed', 1);
      
      // Update local state if order was created
      if (result.success && result.orderId) {
        await this.updateOrderState(result.orderId);
      }
      
      this.logger.info('Trade executed successfully', {
        tradeId,
        orderId: result.orderId,
        executionPrice: result.executionPrice,
        slippage: result.slippage
      });
      
      this.emit('tradeExecuted', { request, result });
      
      return result;
      
    } catch (error) {
      this.metrics.endTimer('trade_execution');
      this.metrics.recordMetric('trade_errors', 1);
      this.logger.error('Trade execution failed', {
        tradeId,
        error,
        request
      });
      throw error;
    }
  }

  /**
   * Get current positions
   */
  async getPositions(sessionId: string): Promise<Position[]> {
    this.validateInitialized();

    try {
      this.logger.debug('Fetching positions');
      
      const message: ZMQMessage = {
        type: MESSAGE_TYPES.POSITION_REQUEST,
        action: 'getAll',
        data: {
          sessionId,
          timestamp: Date.now()
        }
      };
      
      const response = await this.connectionGateway.sendRequest(message);
      
      if (response.error) {
        throw new Error(response.error);
      }
      
      const positions: Position[] = response.data.positions.map((pos: any) => ({
        id: pos.id,
        ticket: pos.ticket,
        symbol: pos.symbol,
        type: pos.type,
        volume: pos.volume,
        openPrice: pos.openPrice,
        currentPrice: pos.currentPrice,
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit,
        profit: pos.profit,
        commission: pos.commission,
        swap: pos.swap,
        openTime: new Date(pos.openTime),
        comment: pos.comment,
        magic: pos.magic
      }));
      
      // Update local cache
      this.activePositions.clear();
      positions.forEach(pos => this.activePositions.set(pos.id, pos));
      
      this.logger.debug('Positions fetched', { count: positions.length });
      this.metrics.recordMetric('positions_fetched', positions.length);
      
      return positions;
      
    } catch (error) {
      this.logger.error('Failed to fetch positions', { error });
      throw error;
    }
  }

  /**
   * Get pending orders
   */
  async getOrders(sessionId: string): Promise<Order[]> {
    this.validateInitialized();

    try {
      this.logger.debug('Fetching orders');
      
      const message: ZMQMessage = {
        type: MESSAGE_TYPES.ORDER_REQUEST,
        action: 'getAll',
        data: {
          sessionId,
          timestamp: Date.now()
        }
      };
      
      const response = await this.connectionGateway.sendRequest(message);
      
      if (response.error) {
        throw new Error(response.error);
      }
      
      const orders: Order[] = response.data.orders.map((order: any) => ({
        id: order.id,
        ticket: order.ticket,
        symbol: order.symbol,
        type: order.type,
        volume: order.volume,
        openPrice: order.openPrice,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        expiration: order.expiration ? new Date(order.expiration) : undefined,
        comment: order.comment,
        magic: order.magic,
        state: order.state,
        setupTime: new Date(order.setupTime)
      }));
      
      // Update local cache
      this.activeOrders.clear();
      orders.forEach(order => this.activeOrders.set(order.id, order));
      
      this.logger.debug('Orders fetched', { count: orders.length });
      this.metrics.recordMetric('orders_fetched', orders.length);
      
      return orders;
      
    } catch (error) {
      this.logger.error('Failed to fetch orders', { error });
      throw error;
    }
  }

  /**
   * Close a position
   */
  async closePosition(positionId: string, volume?: number, sessionId?: string): Promise<TradeResult> {
    this.validateInitialized();

    const position = this.activePositions.get(positionId);
    if (!position) {
      throw new ValidationError(
        `Position with ID '${positionId}' not found`,
        'positionId',
        positionId
      );
    }

    try {
      this.logger.info('Closing position', {
        positionId,
        symbol: position.symbol,
        volume: volume || position.volume
      });
      
      const message: ZMQMessage = {
        type: MESSAGE_TYPES.POSITION_REQUEST,
        action: 'close',
        data: {
          positionId,
          volume: volume || position.volume,
          sessionId,
          timestamp: Date.now()
        }
      };
      
      const response = await this.connectionGateway.sendRequest(message);
      
      if (response.error) {
        throw new TradeError(response.error, response.errorCode || 'POSITION_CLOSE_FAILED');
      }
      
      const result: TradeResult = {
        orderId: response.data.orderId,
        ticket: response.data.ticket,
        executionPrice: response.data.executionPrice,
        executionTime: new Date(response.data.executionTime),
        volume: response.data.volume,
        commission: response.data.commission,
        swap: response.data.swap,
        profit: response.data.profit,
        slippage: response.data.slippage,
        comment: response.data.comment,
        success: response.data.success
      };
      
      // Update local state
      if (result.success) {
        if (volume && volume < position.volume) {
          // Partial close - update position volume
          position.volume -= volume;
          this.activePositions.set(positionId, position);
        } else {
          // Full close - remove position
          this.activePositions.delete(positionId);
        }
      }
      
      this.logger.info('Position closed successfully', {
        positionId,
        orderId: result.orderId,
        profit: result.profit
      });
      
      this.emit('positionClosed', { positionId, result });
      
      return result;
      
    } catch (error) {
      this.logger.error('Failed to close position', {
        positionId,
        error
      });
      throw error;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string, sessionId?: string): Promise<boolean> {
    this.validateInitialized();

    const order = this.activeOrders.get(orderId);
    if (!order) {
      throw new ValidationError(
        `Order with ID '${orderId}' not found`,
        'orderId',
        orderId
      );
    }

    try {
      this.logger.info('Canceling order', {
        orderId,
        symbol: order.symbol,
        type: order.type
      });
      
      const message: ZMQMessage = {
        type: MESSAGE_TYPES.ORDER_REQUEST,
        action: 'cancel',
        data: {
          orderId,
          sessionId,
          timestamp: Date.now()
        }
      };
      
      const response = await this.connectionGateway.sendRequest(message);
      
      if (response.error) {
        throw new TradeError(response.error, response.errorCode || 'ORDER_CANCEL_FAILED');
      }
      
      const success = response.data.success;
      
      // Update local state
      if (success) {
        this.activeOrders.delete(orderId);
      }
      
      this.logger.info('Order canceled successfully', { orderId });
      this.emit('orderCanceled', { orderId, success });
      
      return success;
      
    } catch (error) {
      this.logger.error('Failed to cancel order', {
        orderId,
        error
      });
      throw error;
    }
  }

  /**
   * Modify an existing order
   */
  async modifyOrder(
    orderId: string,
    modifications: Partial<Pick<Order, 'openPrice' | 'stopLoss' | 'takeProfit' | 'expiration'>>,
    sessionId?: string
  ): Promise<boolean> {
    this.validateInitialized();

    const order = this.activeOrders.get(orderId);
    if (!order) {
      throw new ValidationError(
        `Order with ID '${orderId}' not found`,
        'orderId',
        orderId
      );
    }

    try {
      this.logger.info('Modifying order', {
        orderId,
        modifications
      });
      
      const message: ZMQMessage = {
        type: MESSAGE_TYPES.ORDER_REQUEST,
        action: 'modify',
        data: {
          orderId,
          modifications,
          sessionId,
          timestamp: Date.now()
        }
      };
      
      const response = await this.connectionGateway.sendRequest(message);
      
      if (response.error) {
        throw new TradeError(response.error, response.errorCode || 'ORDER_MODIFY_FAILED');
      }
      
      const success = response.data.success;
      
      // Update local state
      if (success) {
        const updatedOrder = { ...order, ...modifications };
        this.activeOrders.set(orderId, updatedOrder);
      }
      
      this.logger.info('Order modified successfully', { orderId });
      this.emit('orderModified', { orderId, modifications, success });
      
      return success;
      
    } catch (error) {
      this.logger.error('Failed to modify order', {
        orderId,
        error
      });
      throw error;
    }
  }

  /**
   * Get trade history
   */
  async getTradeHistory(
    startDate: Date,
    endDate: Date,
    sessionId: string
  ): Promise<any[]> {
    this.validateInitialized();

    try {
      this.logger.debug('Fetching trade history', {
        startDate,
        endDate
      });
      
      const message: ZMQMessage = {
        type: MESSAGE_TYPES.HISTORY_REQUEST,
        action: 'getTrades',
        data: {
          startDate: startDate.getTime(),
          endDate: endDate.getTime(),
          sessionId,
          timestamp: Date.now()
        }
      };
      
      const response = await this.connectionGateway.sendRequest(message);
      
      if (response.error) {
        throw new Error(response.error);
      }
      
      const history = response.data.trades || [];
      
      this.logger.debug('Trade history fetched', { count: history.length });
      
      return history;
      
    } catch (error) {
      this.logger.error('Failed to fetch trade history', { error });
      throw error;
    }
  }

  /**
   * Get cached positions
   */
  getCachedPositions(): Position[] {
    return Array.from(this.activePositions.values());
  }

  /**
   * Get cached orders
   */
  getCachedOrders(): Order[] {
    return Array.from(this.activeOrders.values());
  }

  /**
   * Get trade statistics
   */
  getStatistics(): any {
    return {
      activePositions: this.activePositions.size,
      activeOrders: this.activeOrders.size,
      isInitialized: this.isInitialized
    };
  }

  /**
   * Validate trade request
   */
  private validateTradeRequest(request: TradeRequest): void {
    if (!request.symbol || request.symbol.trim() === '') {
      throw new ValidationError('Symbol is required', 'symbol', request.symbol);
    }

    if (!Object.values(TradeAction).includes(request.action)) {
      throw new ValidationError('Invalid trade action', 'action', request.action);
    }

    if (!request.volume || request.volume <= 0) {
      throw new ValidationError('Volume must be greater than 0', 'volume', request.volume);
    }

    if (request.orderType && !Object.values(OrderType).includes(request.orderType)) {
      throw new ValidationError('Invalid order type', 'orderType', request.orderType);
    }

    if (request.stopLoss && request.takeProfit) {
      if (request.action === TradeAction.BUY) {
        if (request.stopLoss >= request.takeProfit) {
          throw new ValidationError(
            'Stop loss must be less than take profit for buy orders',
            'stopLoss',
            request.stopLoss
          );
        }
      } else if (request.action === TradeAction.SELL) {
        if (request.stopLoss <= request.takeProfit) {
          throw new ValidationError(
            'Stop loss must be greater than take profit for sell orders',
            'stopLoss',
            request.stopLoss
          );
        }
      }
    }
  }

  /**
   * Subscribe to trade-related events
   */
  private async subscribeToTradeEvents(): Promise<void> {
    try {
      await this.connectionGateway.subscribe([
        'trade',
        'order',
        'position'
      ]);
      
      this.logger.debug('Subscribed to trade events');
      
    } catch (error) {
      this.logger.error('Failed to subscribe to trade events', { error });
      throw error;
    }
  }

  /**
   * Load existing positions from MT5
   */
  private async loadExistingPositions(): Promise<void> {
    try {
      // This will be called during initialization
      // Actual implementation would fetch from MT5 terminal
      this.logger.debug('Loading existing positions...');
      
    } catch (error) {
      this.logger.error('Failed to load existing positions', { error });
    }
  }

  /**
   * Load existing orders from MT5
   */
  private async loadExistingOrders(): Promise<void> {
    try {
      // This will be called during initialization
      // Actual implementation would fetch from MT5 terminal
      this.logger.debug('Loading existing orders...');
      
    } catch (error) {
      this.logger.error('Failed to load existing orders', { error });
    }
  }

  /**
   * Update order state after execution
   */
  private async updateOrderState(orderId: string): Promise<void> {
    try {
      // Refresh order information from MT5
      // This would typically involve fetching updated order details
      this.logger.debug('Updating order state', { orderId });
      
    } catch (error) {
      this.logger.error('Failed to update order state', { orderId, error });
    }
  }

  /**
   * Validate that API is initialized
   */
  private validateInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('TradeAPI is not initialized');
    }
  }
}