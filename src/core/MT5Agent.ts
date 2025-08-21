/**
 * MT5Agent - Individual trading agent for executing trades and managing positions
 */

import { EventEmitter } from 'eventemitter3';
import { AgentConfig, TradeRequest, TradeResult, Position, Order, MT5Event } from '../types';
import { ConnectionGateway } from './ConnectionGateway';
import { EventProcessor } from './EventProcessor';
import { SecurityManager } from '../security/SecurityManager';
import { TradeAPI } from '../api/TradeAPI';
import { MarketDataAPI } from '../api/MarketDataAPI';
import { AccountAPI } from '../api/AccountAPI';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { CircuitBreaker } from '../utils/CircuitBreaker';
import { RateLimiter } from '../security/RateLimiter';
import { ValidationError, TradeError, AuthenticationError } from './errors';
import { DEFAULTS } from '../constants';

/**
 * MT5 Agent class for individual trading operations
 */
export class MT5Agent extends EventEmitter {
  private readonly config: AgentConfig;
  private readonly connectionGateway: ConnectionGateway;
  private readonly eventProcessor: EventProcessor;
  private readonly securityManager: SecurityManager;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly rateLimiter: RateLimiter;
  
  // API instances
  private readonly tradeAPI: TradeAPI;
  private readonly marketDataAPI: MarketDataAPI;
  private readonly accountAPI: AccountAPI;
  
  private isActive: boolean = false;
  private isInitialized: boolean = false;
  private lastActivity: Date = new Date();
  private sessionId: string | null = null;

  constructor(
    config: AgentConfig,
    connectionGateway: ConnectionGateway,
    eventProcessor: EventProcessor,
    securityManager: SecurityManager,
    logger: Logger,
    metrics: MetricsCollector
  ) {
    super();

    this.config = this.validateConfig(config);
    this.connectionGateway = connectionGateway;
    this.eventProcessor = eventProcessor;
    this.securityManager = securityManager;
    this.logger = logger.child({ agentId: config.id });
    this.metrics = metrics;
    
    // Initialize circuit breaker
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: config.circuitBreaker?.failureThreshold || DEFAULTS.CIRCUIT_BREAKER.FAILURE_THRESHOLD,
      recoveryTimeout: config.circuitBreaker?.recoveryTimeout || DEFAULTS.CIRCUIT_BREAKER.RECOVERY_TIMEOUT,
      monitoringPeriod: config.circuitBreaker?.monitoringPeriod || DEFAULTS.CIRCUIT_BREAKER.MONITORING_PERIOD
    });
    
    // Initialize rate limiter
    this.rateLimiter = new RateLimiter({
      maxRequests: config.rateLimiting?.maxRequests || DEFAULTS.RATE_LIMITING.MAX_REQUESTS_PER_MINUTE,
      windowMs: config.rateLimiting?.windowMs || DEFAULTS.RATE_LIMITING.WINDOW_MS
    });
    
    // Initialize API instances
    this.tradeAPI = new TradeAPI(
      this.connectionGateway,
      this.securityManager,
      this.logger,
      this.metrics,
      this.circuitBreaker
    );
    
    this.marketDataAPI = new MarketDataAPI(
      this.connectionGateway,
      this.securityManager,
      this.logger,
      this.metrics,
      this.circuitBreaker
    );
    
    this.accountAPI = new AccountAPI(
      this.connectionGateway,
      this.securityManager,
      this.logger,
      this.metrics,
      this.circuitBreaker
    );

    this.setupEventHandlers();
    
    this.logger.info('MT5Agent created', {
      agentId: this.config.id,
      account: this.config.account,
      permissions: this.config.permissions
    });
  }

  /**
   * Initialize the agent
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('Agent is already initialized');
    }

    try {
      this.logger.info('Initializing agent...');
      this.metrics.startTimer('agent_initialization');

      // Authenticate agent
      await this.authenticate();
      
      // Initialize API instances
      await this.tradeAPI.initialize();
      await this.marketDataAPI.initialize();
      await this.accountAPI.initialize();
      
      this.isInitialized = true;
      this.isActive = true;
      this.lastActivity = new Date();
      
      this.metrics.endTimer('agent_initialization');
      this.metrics.recordMetric('agent_status', 1);
      
      this.logger.info('Agent initialized successfully');
      this.emit('initialized');
      
    } catch (error) {
      this.metrics.endTimer('agent_initialization');
      this.logger.error('Failed to initialize agent', { error });
      throw error;
    }
  }

  /**
   * Execute a trade request
   */
  async executeTrade(request: TradeRequest): Promise<TradeResult> {
    this.validateActiveState();
    this.updateActivity();

    // Check rate limiting
    if (!this.rateLimiter.checkLimit()) {
      throw new TradeError('Rate limit exceeded', 'RATE_LIMIT_EXCEEDED');
    }

    // Check permissions
    if (!this.hasPermission('trade')) {
      throw new AuthenticationError('Insufficient permissions for trading');
    }

    try {
      this.logger.info('Executing trade', {
        symbol: request.symbol,
        action: request.action,
        volume: request.volume
      });
      
      this.metrics.startTimer('trade_execution');
      
      const result = await this.circuitBreaker.execute(async () => {
        return await this.tradeAPI.executeTrade(request, this.sessionId!);
      });
      
      this.metrics.endTimer('trade_execution');
      this.metrics.recordMetric('trades_executed', 1);
      
      this.logger.info('Trade executed successfully', {
        orderId: result.orderId,
        executionPrice: result.executionPrice
      });
      
      this.emit('tradeExecuted', { request, result });
      
      return result;
      
    } catch (error) {
      this.metrics.endTimer('trade_execution');
      this.metrics.recordMetric('trade_errors', 1);
      this.logger.error('Trade execution failed', { error, request });
      throw error;
    }
  }

  /**
   * Get current positions
   */
  async getPositions(): Promise<Position[]> {
    this.validateActiveState();
    this.updateActivity();

    if (!this.hasPermission('read')) {
      throw new AuthenticationError('Insufficient permissions for reading positions');
    }

    try {
      this.logger.debug('Fetching positions');
      
      const positions = await this.circuitBreaker.execute(async () => {
        return await this.tradeAPI.getPositions(this.sessionId!);
      });
      
      this.logger.debug('Positions fetched', { count: positions.length });
      
      return positions;
      
    } catch (error) {
      this.logger.error('Failed to fetch positions', { error });
      throw error;
    }
  }

  /**
   * Get pending orders
   */
  async getOrders(): Promise<Order[]> {
    this.validateActiveState();
    this.updateActivity();

    if (!this.hasPermission('read')) {
      throw new AuthenticationError('Insufficient permissions for reading orders');
    }

    try {
      this.logger.debug('Fetching orders');
      
      const orders = await this.circuitBreaker.execute(async () => {
        return await this.tradeAPI.getOrders(this.sessionId!);
      });
      
      this.logger.debug('Orders fetched', { count: orders.length });
      
      return orders;
      
    } catch (error) {
      this.logger.error('Failed to fetch orders', { error });
      throw error;
    }
  }

  /**
   * Close a position
   */
  async closePosition(positionId: string, volume?: number): Promise<TradeResult> {
    this.validateActiveState();
    this.updateActivity();

    if (!this.hasPermission('trade')) {
      throw new AuthenticationError('Insufficient permissions for closing positions');
    }

    try {
      this.logger.info('Closing position', { positionId, volume });
      
      const result = await this.circuitBreaker.execute(async () => {
        return await this.tradeAPI.closePosition(positionId, volume, this.sessionId!);
      });
      
      this.logger.info('Position closed successfully', {
        positionId,
        orderId: result.orderId
      });
      
      this.emit('positionClosed', { positionId, result });
      
      return result;
      
    } catch (error) {
      this.logger.error('Failed to close position', { error, positionId });
      throw error;
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    this.validateActiveState();
    this.updateActivity();

    if (!this.hasPermission('trade')) {
      throw new AuthenticationError('Insufficient permissions for canceling orders');
    }

    try {
      this.logger.info('Canceling order', { orderId });
      
      const result = await this.circuitBreaker.execute(async () => {
        return await this.tradeAPI.cancelOrder(orderId, this.sessionId!);
      });
      
      this.logger.info('Order canceled successfully', { orderId });
      this.emit('orderCanceled', { orderId });
      
      return result;
      
    } catch (error) {
      this.logger.error('Failed to cancel order', { error, orderId });
      throw error;
    }
  }

  /**
   * Subscribe to market data
   */
  async subscribeToMarketData(symbols: string[]): Promise<void> {
    this.validateActiveState();
    this.updateActivity();

    if (!this.hasPermission('marketData')) {
      throw new AuthenticationError('Insufficient permissions for market data');
    }

    try {
      this.logger.info('Subscribing to market data', { symbols });
      
      await this.marketDataAPI.subscribe(symbols, this.sessionId!);
      
      this.logger.info('Market data subscription successful', { symbols });
      this.emit('marketDataSubscribed', { symbols });
      
    } catch (error) {
      this.logger.error('Failed to subscribe to market data', { error, symbols });
      throw error;
    }
  }

  /**
   * Unsubscribe from market data
   */
  async unsubscribeFromMarketData(symbols: string[]): Promise<void> {
    this.validateActiveState();
    this.updateActivity();

    try {
      this.logger.info('Unsubscribing from market data', { symbols });
      
      await this.marketDataAPI.unsubscribe(symbols, this.sessionId!);
      
      this.logger.info('Market data unsubscription successful', { symbols });
      this.emit('marketDataUnsubscribed', { symbols });
      
    } catch (error) {
      this.logger.error('Failed to unsubscribe from market data', { error, symbols });
      throw error;
    }
  }

  /**
   * Get account information
   */
  async getAccountInfo(): Promise<any> {
    this.validateActiveState();
    this.updateActivity();

    if (!this.hasPermission('read')) {
      throw new AuthenticationError('Insufficient permissions for reading account info');
    }

    try {
      this.logger.debug('Fetching account info');
      
      const accountInfo = await this.circuitBreaker.execute(async () => {
        return await this.accountAPI.getAccountInfo(this.sessionId!);
      });
      
      this.logger.debug('Account info fetched');
      
      return accountInfo;
      
    } catch (error) {
      this.logger.error('Failed to fetch account info', { error });
      throw error;
    }
  }

  /**
   * Disconnect the agent
   */
  async disconnect(): Promise<void> {
    try {
      this.logger.info('Disconnecting agent...');
      
      // Unsubscribe from all market data
      await this.marketDataAPI.unsubscribeAll(this.sessionId!);
      
      // Invalidate session
      if (this.sessionId) {
        await this.securityManager.invalidateSession(this.sessionId);
        this.sessionId = null;
      }
      
      this.isActive = false;
      this.metrics.recordMetric('agent_status', 0);
      
      this.logger.info('Agent disconnected successfully');
      this.emit('disconnected');
      
    } catch (error) {
      this.logger.error('Error during agent disconnection', { error });
      throw error;
    }
  }

  /**
   * Check if agent is active
   */
  isAgentActive(): boolean {
    return this.isActive && this.isInitialized;
  }

  /**
   * Get agent configuration
   */
  getConfig(): AgentConfig {
    return { ...this.config };
  }

  /**
   * Get agent metrics
   */
  getMetrics(): any {
    return {
      agentId: this.config.id,
      status: this.isActive ? 'active' : 'inactive',
      lastActivity: this.lastActivity,
      sessionId: this.sessionId,
      circuitBreaker: this.circuitBreaker.getStatus(),
      rateLimiter: this.rateLimiter.getStatus()
    };
  }

  /**
   * Authenticate the agent
   */
  private async authenticate(): Promise<void> {
    try {
      this.logger.info('Authenticating agent...');
      
      const authResult = await this.securityManager.authenticate({
        agentId: this.config.id,
        account: this.config.account,
        credentials: this.config.credentials
      });
      
      this.sessionId = authResult.sessionId;
      
      this.logger.info('Agent authenticated successfully', {
        sessionId: this.sessionId
      });
      
    } catch (error) {
      this.logger.error('Agent authentication failed', { error });
      throw new AuthenticationError(`Authentication failed: ${error.message}`);
    }
  }

  /**
   * Validate agent configuration
   */
  private validateConfig(config: AgentConfig): AgentConfig {
    if (!config.id || !config.account) {
      throw new ValidationError(
        'Agent ID and account are required',
        'config',
        config
      );
    }

    if (!config.permissions || config.permissions.length === 0) {
      throw new ValidationError(
        'Agent permissions are required',
        'permissions',
        config.permissions
      );
    }

    return config;
  }

  /**
   * Check if agent has specific permission
   */
  private hasPermission(permission: string): boolean {
    return this.config.permissions.includes(permission) || 
           this.config.permissions.includes('admin');
  }

  /**
   * Validate that agent is in active state
   */
  private validateActiveState(): void {
    if (!this.isActive || !this.isInitialized) {
      throw new Error('Agent is not active or not initialized');
    }

    if (!this.sessionId) {
      throw new AuthenticationError('Agent session is not valid');
    }
  }

  /**
   * Update last activity timestamp
   */
  private updateActivity(): void {
    this.lastActivity = new Date();
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    // Market data events
    this.marketDataAPI.on('tick', (data) => {
      this.emit('tick', data);
    });

    this.marketDataAPI.on('ohlc', (data) => {
      this.emit('ohlc', data);
    });

    // Trade events
    this.tradeAPI.on('orderUpdate', (data) => {
      this.emit('orderUpdate', data);
    });

    this.tradeAPI.on('positionUpdate', (data) => {
      this.emit('positionUpdate', data);
    });

    // Circuit breaker events
    this.circuitBreaker.on('stateChange', (state) => {
      this.logger.warn('Circuit breaker state changed', { state });
      this.emit('circuitBreakerStateChange', { state });
    });

    // Rate limiter events
    this.rateLimiter.on('limitExceeded', () => {
      this.logger.warn('Rate limit exceeded');
      this.emit('rateLimitExceeded');
    });
  }

  /**
   * Alias for isAgentActive for backward compatibility
   */
  isActive(): boolean {
    return this.isAgentActive();
  }
}