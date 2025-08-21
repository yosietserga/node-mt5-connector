/**
 * AccountAPI - Handles account information, balance, equity, and account operations
 */

import { EventEmitter } from 'eventemitter3';
import {
  AccountInfo,
  ZMQMessage,
  MessageType,
  Currency
} from '../types';
import { ConnectionGateway } from '../core/ConnectionGateway';
import { SecurityManager } from '../security/SecurityManager';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { CircuitBreaker } from '../utils/CircuitBreaker';
import { ValidationError, AccountError } from '../core/errors';
import { MESSAGE_TYPES, DEFAULTS } from '../constants';
import { v4 as uuidv4 } from 'uuid';

interface AccountCache {
  accountInfo: AccountInfo | null;
  lastUpdated: Date | null;
  cacheTimeout: number;
}

interface AccountMetrics {
  requestCount: number;
  errorCount: number;
  lastRequestTime: Date | null;
  averageResponseTime: number;
}

/**
 * Account API for handling account information and operations
 */
export class AccountAPI extends EventEmitter {
  private readonly connectionGateway: ConnectionGateway;
  private readonly securityManager: SecurityManager;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private readonly circuitBreaker: CircuitBreaker;
  
  private isInitialized: boolean = false;
  private cache: AccountCache;
  private accountMetrics: AccountMetrics;
  
  // Configuration
  private readonly cacheTimeout: number;
  private readonly refreshInterval: number;
  
  // Auto-refresh timer
  private refreshTimer: NodeJS.Timeout | null = null;

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
    this.logger = logger.child({ component: 'AccountAPI' });
    this.metrics = metrics;
    this.circuitBreaker = circuitBreaker;
    
    // Configuration
    this.cacheTimeout = DEFAULTS.ACCOUNT.CACHE_TIMEOUT;
    this.refreshInterval = DEFAULTS.ACCOUNT.REFRESH_INTERVAL;
    
    // Initialize cache
    this.cache = {
      accountInfo: null,
      lastUpdated: null,
      cacheTimeout: this.cacheTimeout
    };
    
    // Initialize metrics
    this.accountMetrics = {
      requestCount: 0,
      errorCount: 0,
      lastRequestTime: null,
      averageResponseTime: 0
    };

    this.logger.info('AccountAPI created', {
      cacheTimeout: this.cacheTimeout,
      refreshInterval: this.refreshInterval
    });
  }

  /**
   * Initialize the Account API
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('AccountAPI is already initialized');
    }

    try {
      this.logger.info('Initializing AccountAPI...');
      this.metrics.startTimer('account_api_initialization');

      // Subscribe to account events
      await this.subscribeToAccountEvents();
      
      // Start auto-refresh timer
      this.startAutoRefresh();
      
      this.isInitialized = true;
      this.metrics.endTimer('account_api_initialization');
      
      this.logger.info('AccountAPI initialized successfully');
      
    } catch (error) {
      this.metrics.endTimer('account_api_initialization');
      this.logger.error('Failed to initialize AccountAPI', { error });
      throw error;
    }
  }

  /**
   * Get account information
   */
  async getAccountInfo(sessionId: string, forceRefresh: boolean = false): Promise<AccountInfo> {
    this.validateInitialized();

    // Check cache first (unless force refresh)
    if (!forceRefresh && this.isCacheValid()) {
      this.logger.debug('Returning cached account info');
      return this.cache.accountInfo!;
    }

    try {
      this.logger.debug('Fetching account info from MT5');
      const startTime = Date.now();
      
      const message: ZMQMessage = {
        type: MESSAGE_TYPES.ACCOUNT_REQUEST,
        action: 'getInfo',
        data: {
          requestId: uuidv4(),
          sessionId,
          timestamp: Date.now()
        }
      };
      
      const response = await this.connectionGateway.sendRequest(message);
      
      if (response.error) {
        this.accountMetrics.errorCount++;
        throw new AccountError(response.error, response.errorCode || 'ACCOUNT_INFO_FAILED');
      }
      
      const accountInfo: AccountInfo = {
        login: response.data.login,
        name: response.data.name,
        server: response.data.server,
        currency: response.data.currency,
        company: response.data.company,
        balance: response.data.balance,
        equity: response.data.equity,
        margin: response.data.margin,
        freeMargin: response.data.freeMargin,
        marginLevel: response.data.marginLevel,
        profit: response.data.profit,
        credit: response.data.credit,
        leverage: response.data.leverage,
        stopoutLevel: response.data.stopoutLevel,
        stopoutMode: response.data.stopoutMode,
        tradeAllowed: response.data.tradeAllowed,
        tradeExpert: response.data.tradeExpert,
        limitOrders: response.data.limitOrders,
        marginSoMode: response.data.marginSoMode,
        tradingMode: response.data.tradingMode,
        lastUpdateTime: new Date(response.data.lastUpdateTime || Date.now())
      };
      
      // Update cache
      this.updateCache(accountInfo);
      
      // Update metrics
      const responseTime = Date.now() - startTime;
      this.updateMetrics(responseTime);
      
      this.logger.debug('Account info fetched successfully', {
        login: accountInfo.login,
        balance: accountInfo.balance,
        equity: accountInfo.equity
      });
      
      this.emit('accountInfoUpdated', accountInfo);
      
      return accountInfo;
      
    } catch (error) {
      this.accountMetrics.errorCount++;
      this.logger.error('Failed to fetch account info', { error });
      throw error;
    }
  }

  /**
   * Get account balance
   */
  async getBalance(sessionId: string): Promise<number> {
    const accountInfo = await this.getAccountInfo(sessionId);
    return accountInfo.balance;
  }

  /**
   * Get account equity
   */
  async getEquity(sessionId: string): Promise<number> {
    const accountInfo = await this.getAccountInfo(sessionId);
    return accountInfo.equity;
  }

  /**
   * Get account margin information
   */
  async getMarginInfo(sessionId: string): Promise<{
    margin: number;
    freeMargin: number;
    marginLevel: number;
  }> {
    const accountInfo = await this.getAccountInfo(sessionId);
    return {
      margin: accountInfo.margin,
      freeMargin: accountInfo.freeMargin,
      marginLevel: accountInfo.marginLevel
    };
  }

  /**
   * Get account profit/loss
   */
  async getProfit(sessionId: string): Promise<number> {
    const accountInfo = await this.getAccountInfo(sessionId);
    return accountInfo.profit;
  }

  /**
   * Check if trading is allowed
   */
  async isTradingAllowed(sessionId: string): Promise<boolean> {
    const accountInfo = await this.getAccountInfo(sessionId);
    return accountInfo.tradeAllowed;
  }

  /**
   * Get account leverage
   */
  async getLeverage(sessionId: string): Promise<number> {
    const accountInfo = await this.getAccountInfo(sessionId);
    return accountInfo.leverage;
  }

  /**
   * Get account currency
   */
  async getCurrency(sessionId: string): Promise<Currency> {
    const accountInfo = await this.getAccountInfo(sessionId);
    return accountInfo.currency;
  }

  /**
   * Get account summary
   */
  async getAccountSummary(sessionId: string): Promise<{
    login: number;
    name: string;
    server: string;
    currency: Currency;
    balance: number;
    equity: number;
    profit: number;
    marginLevel: number;
    tradeAllowed: boolean;
  }> {
    const accountInfo = await this.getAccountInfo(sessionId);
    return {
      login: accountInfo.login,
      name: accountInfo.name,
      server: accountInfo.server,
      currency: accountInfo.currency,
      balance: accountInfo.balance,
      equity: accountInfo.equity,
      profit: accountInfo.profit,
      marginLevel: accountInfo.marginLevel,
      tradeAllowed: accountInfo.tradeAllowed
    };
  }

  /**
   * Refresh account information
   */
  async refresh(sessionId: string): Promise<AccountInfo> {
    return await this.getAccountInfo(sessionId, true);
  }

  /**
   * Get cached account information (if available)
   */
  getCachedAccountInfo(): AccountInfo | null {
    if (this.isCacheValid()) {
      return this.cache.accountInfo;
    }
    return null;
  }

  /**
   * Get account statistics
   */
  getStatistics(): AccountMetrics & {
    cacheStatus: {
      hasCache: boolean;
      isValid: boolean;
      lastUpdated: Date | null;
      cacheAge: number | null;
    };
    isInitialized: boolean;
  } {
    const cacheAge = this.cache.lastUpdated 
      ? Date.now() - this.cache.lastUpdated.getTime()
      : null;
    
    return {
      ...this.accountMetrics,
      cacheStatus: {
        hasCache: this.cache.accountInfo !== null,
        isValid: this.isCacheValid(),
        lastUpdated: this.cache.lastUpdated,
        cacheAge
      },
      isInitialized: this.isInitialized
    };
  }

  /**
   * Handle incoming account update events
   */
  private handleAccountUpdate(accountData: any): void {
    try {
      const accountInfo: AccountInfo = {
        login: accountData.login,
        name: accountData.name,
        server: accountData.server,
        currency: accountData.currency,
        company: accountData.company,
        balance: accountData.balance,
        equity: accountData.equity,
        margin: accountData.margin,
        freeMargin: accountData.freeMargin,
        marginLevel: accountData.marginLevel,
        profit: accountData.profit,
        credit: accountData.credit,
        leverage: accountData.leverage,
        stopoutLevel: accountData.stopoutLevel,
        stopoutMode: accountData.stopoutMode,
        tradeAllowed: accountData.tradeAllowed,
        tradeExpert: accountData.tradeExpert,
        limitOrders: accountData.limitOrders,
        marginSoMode: accountData.marginSoMode,
        tradingMode: accountData.tradingMode,
        lastUpdateTime: new Date(accountData.lastUpdateTime || Date.now())
      };
      
      // Update cache
      this.updateCache(accountInfo);
      
      this.logger.debug('Account update received', {
        login: accountInfo.login,
        balance: accountInfo.balance,
        equity: accountInfo.equity
      });
      
      this.emit('accountUpdated', accountInfo);
      this.metrics.recordMetric('account_updates_received', 1);
      
    } catch (error) {
      this.logger.error('Failed to handle account update', { error, accountData });
    }
  }

  /**
   * Subscribe to account events
   */
  private async subscribeToAccountEvents(): Promise<void> {
    try {
      await this.connectionGateway.subscribe([
        'account',
        'balance',
        'equity'
      ]);
      
      // Setup event handlers
      this.connectionGateway.on('message', (data) => {
        if (data.topic === 'account' || data.topic === 'balance' || data.topic === 'equity') {
          this.handleAccountUpdate(data.message.data);
        }
      });
      
      this.logger.debug('Subscribed to account events');
      
    } catch (error) {
      this.logger.error('Failed to subscribe to account events', { error });
      throw error;
    }
  }

  /**
   * Start auto-refresh timer
   */
  private startAutoRefresh(): void {
    if (this.refreshInterval > 0) {
      this.refreshTimer = setInterval(() => {
        this.autoRefresh();
      }, this.refreshInterval);
      
      this.logger.debug('Auto-refresh timer started', {
        interval: this.refreshInterval
      });
    }
  }

  /**
   * Stop auto-refresh timer
   */
  private stopAutoRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      this.logger.debug('Auto-refresh timer stopped');
    }
  }

  /**
   * Auto-refresh account information
   */
  private async autoRefresh(): Promise<void> {
    try {
      // Only refresh if cache is getting stale
      if (!this.isCacheValid()) {
        this.logger.debug('Auto-refreshing account info');
        // Note: We need a session ID for this, but in auto-refresh context
        // we might not have one. This is a design consideration.
        // For now, we'll skip auto-refresh if no session is available.
        this.logger.debug('Skipping auto-refresh - no session context');
      }
    } catch (error) {
      this.logger.error('Auto-refresh failed', { error });
    }
  }

  /**
   * Update cache with new account info
   */
  private updateCache(accountInfo: AccountInfo): void {
    this.cache.accountInfo = accountInfo;
    this.cache.lastUpdated = new Date();
    
    this.logger.debug('Account cache updated', {
      login: accountInfo.login,
      lastUpdated: this.cache.lastUpdated
    });
  }

  /**
   * Check if cache is valid
   */
  private isCacheValid(): boolean {
    if (!this.cache.accountInfo || !this.cache.lastUpdated) {
      return false;
    }
    
    const cacheAge = Date.now() - this.cache.lastUpdated.getTime();
    return cacheAge < this.cache.cacheTimeout;
  }

  /**
   * Update metrics
   */
  private updateMetrics(responseTime: number): void {
    this.accountMetrics.requestCount++;
    this.accountMetrics.lastRequestTime = new Date();
    
    // Calculate average response time
    if (this.accountMetrics.averageResponseTime === 0) {
      this.accountMetrics.averageResponseTime = responseTime;
    } else {
      this.accountMetrics.averageResponseTime = 
        (this.accountMetrics.averageResponseTime + responseTime) / 2;
    }
    
    this.metrics.recordMetric('account_request_count', 1);
    this.metrics.recordMetric('account_response_time', responseTime);
  }

  /**
   * Validate that API is initialized
   */
  private validateInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('AccountAPI is not initialized');
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.accountInfo = null;
    this.cache.lastUpdated = null;
    this.logger.debug('Account cache cleared');
  }

  /**
   * Shutdown the Account API
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down AccountAPI...');
      
      // Stop auto-refresh
      this.stopAutoRefresh();
      
      // Clear cache
      this.clearCache();
      
      this.isInitialized = false;
      
      this.logger.info('AccountAPI shutdown completed');
      
    } catch (error) {
      this.logger.error('Error during AccountAPI shutdown', { error });
      throw error;
    }
  }
}