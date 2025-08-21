/**
 * MarketDataAPI - Handles real-time market data subscriptions and tick data
 */

import { EventEmitter } from 'eventemitter3';
import {
  Tick,
  OHLC,
  SymbolInfo,
  ZMQMessage,
  MessageType,
  Timeframe
} from '../types';
import { ConnectionGateway } from '../core/ConnectionGateway';
import { SecurityManager } from '../security/SecurityManager';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { CircuitBreaker } from '../utils/CircuitBreaker';
import { ValidationError, MarketDataError } from '../core/errors';
import { MESSAGE_TYPES, TIMEFRAMES, DEFAULTS } from '../constants';
import { v4 as uuidv4 } from 'uuid';

interface SymbolSubscription {
  symbol: string;
  subscriptionId: string;
  subscribedAt: Date;
  lastTick?: Tick;
  tickCount: number;
  isActive: boolean;
}

interface MarketDataCache {
  ticks: Map<string, Tick[]>;
  ohlc: Map<string, Map<Timeframe, OHLC[]>>;
  symbols: Map<string, SymbolInfo>;
  maxCacheSize: number;
}

/**
 * Market Data API for handling real-time market data
 */
export class MarketDataAPI extends EventEmitter {
  private readonly connectionGateway: ConnectionGateway;
  private readonly securityManager: SecurityManager;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private readonly circuitBreaker: CircuitBreaker;
  
  private isInitialized: boolean = false;
  private subscriptions: Map<string, SymbolSubscription> = new Map();
  private cache: MarketDataCache;
  
  // Configuration
  private readonly maxSubscriptions: number;
  private readonly tickBufferSize: number;
  private readonly ohlcBufferSize: number;
  private readonly cacheCleanupInterval: number;
  
  // Cleanup timer
  private cacheCleanupTimer: NodeJS.Timeout | null = null;

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
    this.logger = logger.child({ component: 'MarketDataAPI' });
    this.metrics = metrics;
    this.circuitBreaker = circuitBreaker;
    
    // Configuration
    this.maxSubscriptions = DEFAULTS.MARKET_DATA.MAX_SUBSCRIPTIONS;
    this.tickBufferSize = DEFAULTS.MARKET_DATA.TICK_BUFFER_SIZE;
    this.ohlcBufferSize = DEFAULTS.MARKET_DATA.OHLC_BUFFER_SIZE;
    this.cacheCleanupInterval = DEFAULTS.MARKET_DATA.CACHE_CLEANUP_INTERVAL;
    
    // Initialize cache
    this.cache = {
      ticks: new Map(),
      ohlc: new Map(),
      symbols: new Map(),
      maxCacheSize: DEFAULTS.MARKET_DATA.MAX_CACHE_SIZE
    };

    this.logger.info('MarketDataAPI created', {
      maxSubscriptions: this.maxSubscriptions,
      tickBufferSize: this.tickBufferSize,
      ohlcBufferSize: this.ohlcBufferSize
    });
  }

  /**
   * Initialize the Market Data API
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('MarketDataAPI is already initialized');
    }

    try {
      this.logger.info('Initializing MarketDataAPI...');
      this.metrics.startTimer('market_data_api_initialization');

      // Subscribe to market data events
      await this.subscribeToMarketDataEvents();
      
      // Start cache cleanup timer
      this.startCacheCleanup();
      
      this.isInitialized = true;
      this.metrics.endTimer('market_data_api_initialization');
      
      this.logger.info('MarketDataAPI initialized successfully');
      
    } catch (error) {
      this.metrics.endTimer('market_data_api_initialization');
      this.logger.error('Failed to initialize MarketDataAPI', { error });
      throw error;
    }
  }

  /**
   * Subscribe to market data for symbols
   */
  async subscribe(symbols: string[], sessionId: string): Promise<void> {
    this.validateInitialized();
    this.validateSymbols(symbols);

    if (this.subscriptions.size + symbols.length > this.maxSubscriptions) {
      throw new ValidationError(
        `Maximum subscriptions limit (${this.maxSubscriptions}) would be exceeded`,
        'symbols',
        symbols
      );
    }

    try {
      this.logger.info('Subscribing to market data', { symbols });
      
      const subscriptionId = uuidv4();
      
      const message: ZMQMessage = {
        type: MESSAGE_TYPES.MARKET_DATA_REQUEST,
        action: 'subscribe',
        data: {
          subscriptionId,
          symbols,
          sessionId,
          timestamp: Date.now()
        }
      };
      
      const response = await this.connectionGateway.sendRequest(message);
      
      if (response.error) {
        throw new MarketDataError(response.error, response.errorCode || 'SUBSCRIPTION_FAILED');
      }
      
      // Create subscriptions for each symbol
      for (const symbol of symbols) {
        const subscription: SymbolSubscription = {
          symbol,
          subscriptionId: `${subscriptionId}_${symbol}`,
          subscribedAt: new Date(),
          tickCount: 0,
          isActive: true
        };
        
        this.subscriptions.set(symbol, subscription);
        
        // Initialize cache for symbol
        this.cache.ticks.set(symbol, []);
        this.cache.ohlc.set(symbol, new Map());
      }
      
      this.metrics.recordMetric('market_data_subscriptions', this.subscriptions.size);
      
      this.logger.info('Market data subscription successful', {
        symbols,
        totalSubscriptions: this.subscriptions.size
      });
      
      this.emit('subscribed', { symbols, subscriptionId });
      
    } catch (error) {
      this.logger.error('Failed to subscribe to market data', {
        symbols,
        error
      });
      throw error;
    }
  }

  /**
   * Unsubscribe from market data for symbols
   */
  async unsubscribe(symbols: string[], sessionId: string): Promise<void> {
    this.validateInitialized();
    this.validateSymbols(symbols);

    try {
      this.logger.info('Unsubscribing from market data', { symbols });
      
      const message: ZMQMessage = {
        type: MESSAGE_TYPES.MARKET_DATA_REQUEST,
        action: 'unsubscribe',
        data: {
          symbols,
          sessionId,
          timestamp: Date.now()
        }
      };
      
      const response = await this.connectionGateway.sendRequest(message);
      
      if (response.error) {
        throw new MarketDataError(response.error, response.errorCode || 'UNSUBSCRIPTION_FAILED');
      }
      
      // Remove subscriptions
      for (const symbol of symbols) {
        const subscription = this.subscriptions.get(symbol);
        if (subscription) {
          subscription.isActive = false;
          this.subscriptions.delete(symbol);
          
          // Clean up cache
          this.cache.ticks.delete(symbol);
          this.cache.ohlc.delete(symbol);
        }
      }
      
      this.metrics.recordMetric('market_data_subscriptions', this.subscriptions.size);
      
      this.logger.info('Market data unsubscription successful', {
        symbols,
        totalSubscriptions: this.subscriptions.size
      });
      
      this.emit('unsubscribed', { symbols });
      
    } catch (error) {
      this.logger.error('Failed to unsubscribe from market data', {
        symbols,
        error
      });
      throw error;
    }
  }

  /**
   * Unsubscribe from all market data
   */
  async unsubscribeAll(sessionId: string): Promise<void> {
    const symbols = Array.from(this.subscriptions.keys());
    if (symbols.length > 0) {
      await this.unsubscribe(symbols, sessionId);
    }
  }

  /**
   * Get symbol information
   */
  async getSymbolInfo(symbol: string, sessionId: string): Promise<SymbolInfo> {
    this.validateInitialized();
    this.validateSymbol(symbol);

    // Check cache first
    const cachedInfo = this.cache.symbols.get(symbol);
    if (cachedInfo) {
      return cachedInfo;
    }

    try {
      this.logger.debug('Fetching symbol info', { symbol });
      
      const message: ZMQMessage = {
        type: MESSAGE_TYPES.SYMBOL_REQUEST,
        action: 'getInfo',
        data: {
          symbol,
          sessionId,
          timestamp: Date.now()
        }
      };
      
      const response = await this.connectionGateway.sendRequest(message);
      
      if (response.error) {
        throw new MarketDataError(response.error, response.errorCode || 'SYMBOL_INFO_FAILED');
      }
      
      const symbolInfo: SymbolInfo = {
        name: response.data.name,
        description: response.data.description,
        currency: response.data.currency,
        digits: response.data.digits,
        point: response.data.point,
        spread: response.data.spread,
        stopsLevel: response.data.stopsLevel,
        lotSize: response.data.lotSize,
        minLot: response.data.minLot,
        maxLot: response.data.maxLot,
        lotStep: response.data.lotStep,
        marginRequired: response.data.marginRequired,
        swapLong: response.data.swapLong,
        swapShort: response.data.swapShort,
        tradingMode: response.data.tradingMode,
        isActive: response.data.isActive
      };
      
      // Cache the symbol info
      this.cache.symbols.set(symbol, symbolInfo);
      
      this.logger.debug('Symbol info fetched', { symbol });
      
      return symbolInfo;
      
    } catch (error) {
      this.logger.error('Failed to fetch symbol info', { symbol, error });
      throw error;
    }
  }

  /**
   * Get historical OHLC data
   */
  async getOHLC(
    symbol: string,
    timeframe: Timeframe,
    startTime: Date,
    endTime: Date,
    sessionId: string
  ): Promise<OHLC[]> {
    this.validateInitialized();
    this.validateSymbol(symbol);

    try {
      this.logger.debug('Fetching OHLC data', {
        symbol,
        timeframe,
        startTime,
        endTime
      });
      
      const message: ZMQMessage = {
        type: MESSAGE_TYPES.OHLC_REQUEST,
        action: 'getHistory',
        data: {
          symbol,
          timeframe,
          startTime: startTime.getTime(),
          endTime: endTime.getTime(),
          sessionId,
          timestamp: Date.now()
        }
      };
      
      const response = await this.connectionGateway.sendRequest(message);
      
      if (response.error) {
        throw new MarketDataError(response.error, response.errorCode || 'OHLC_FETCH_FAILED');
      }
      
      const ohlcData: OHLC[] = response.data.ohlc.map((bar: any) => ({
        symbol: bar.symbol,
        timeframe: bar.timeframe,
        time: new Date(bar.time),
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
        spread: bar.spread
      }));
      
      // Cache the OHLC data
      this.cacheOHLCData(symbol, timeframe, ohlcData);
      
      this.logger.debug('OHLC data fetched', {
        symbol,
        timeframe,
        count: ohlcData.length
      });
      
      return ohlcData;
      
    } catch (error) {
      this.logger.error('Failed to fetch OHLC data', {
        symbol,
        timeframe,
        error
      });
      throw error;
    }
  }

  /**
   * Get latest tick for a symbol
   */
  getLatestTick(symbol: string): Tick | null {
    const subscription = this.subscriptions.get(symbol);
    return subscription?.lastTick || null;
  }

  /**
   * Get cached ticks for a symbol
   */
  getCachedTicks(symbol: string, limit?: number): Tick[] {
    const ticks = this.cache.ticks.get(symbol) || [];
    return limit ? ticks.slice(-limit) : ticks;
  }

  /**
   * Get cached OHLC data for a symbol
   */
  getCachedOHLC(symbol: string, timeframe: Timeframe, limit?: number): OHLC[] {
    const symbolOHLC = this.cache.ohlc.get(symbol);
    if (!symbolOHLC) {
      return [];
    }
    
    const ohlcData = symbolOHLC.get(timeframe) || [];
    return limit ? ohlcData.slice(-limit) : ohlcData;
  }

  /**
   * Get active subscriptions
   */
  getActiveSubscriptions(): string[] {
    return Array.from(this.subscriptions.keys()).filter(
      symbol => this.subscriptions.get(symbol)?.isActive
    );
  }

  /**
   * Get market data statistics
   */
  getStatistics(): any {
    const totalTicks = Array.from(this.cache.ticks.values())
      .reduce((sum, ticks) => sum + ticks.length, 0);
    
    const totalOHLC = Array.from(this.cache.ohlc.values())
      .reduce((sum, symbolOHLC) => {
        return sum + Array.from(symbolOHLC.values())
          .reduce((innerSum, ohlcArray) => innerSum + ohlcArray.length, 0);
      }, 0);
    
    return {
      activeSubscriptions: this.subscriptions.size,
      cachedSymbols: this.cache.symbols.size,
      totalCachedTicks: totalTicks,
      totalCachedOHLC: totalOHLC,
      isInitialized: this.isInitialized
    };
  }

  /**
   * Handle incoming tick data
   */
  private handleTickData(tickData: any): void {
    try {
      const tick: Tick = {
        symbol: tickData.symbol,
        time: new Date(tickData.time),
        bid: tickData.bid,
        ask: tickData.ask,
        last: tickData.last,
        volume: tickData.volume,
        spread: tickData.spread
      };
      
      // Update subscription
      const subscription = this.subscriptions.get(tick.symbol);
      if (subscription && subscription.isActive) {
        subscription.lastTick = tick;
        subscription.tickCount++;
        
        // Cache the tick
        this.cacheTickData(tick);
        
        this.logger.debug('Tick received', {
          symbol: tick.symbol,
          bid: tick.bid,
          ask: tick.ask
        });
        
        this.emit('tick', tick);
        this.metrics.recordMetric('ticks_received', 1);
      }
      
    } catch (error) {
      this.logger.error('Failed to handle tick data', { error, tickData });
    }
  }

  /**
   * Handle incoming OHLC data
   */
  private handleOHLCData(ohlcData: any): void {
    try {
      const ohlc: OHLC = {
        symbol: ohlcData.symbol,
        timeframe: ohlcData.timeframe,
        time: new Date(ohlcData.time),
        open: ohlcData.open,
        high: ohlcData.high,
        low: ohlcData.low,
        close: ohlcData.close,
        volume: ohlcData.volume,
        spread: ohlcData.spread
      };
      
      // Cache the OHLC data
      this.cacheOHLCData(ohlc.symbol, ohlc.timeframe, [ohlc]);
      
      this.logger.debug('OHLC received', {
        symbol: ohlc.symbol,
        timeframe: ohlc.timeframe,
        close: ohlc.close
      });
      
      this.emit('ohlc', ohlc);
      this.metrics.recordMetric('ohlc_received', 1);
      
    } catch (error) {
      this.logger.error('Failed to handle OHLC data', { error, ohlcData });
    }
  }

  /**
   * Cache tick data
   */
  private cacheTickData(tick: Tick): void {
    const ticks = this.cache.ticks.get(tick.symbol) || [];
    
    ticks.push(tick);
    
    // Maintain buffer size
    if (ticks.length > this.tickBufferSize) {
      ticks.splice(0, ticks.length - this.tickBufferSize);
    }
    
    this.cache.ticks.set(tick.symbol, ticks);
  }

  /**
   * Cache OHLC data
   */
  private cacheOHLCData(symbol: string, timeframe: Timeframe, ohlcData: OHLC[]): void {
    let symbolOHLC = this.cache.ohlc.get(symbol);
    if (!symbolOHLC) {
      symbolOHLC = new Map();
      this.cache.ohlc.set(symbol, symbolOHLC);
    }
    
    let timeframeOHLC = symbolOHLC.get(timeframe) || [];
    
    // Add new data
    timeframeOHLC.push(...ohlcData);
    
    // Sort by time
    timeframeOHLC.sort((a, b) => a.time.getTime() - b.time.getTime());
    
    // Maintain buffer size
    if (timeframeOHLC.length > this.ohlcBufferSize) {
      timeframeOHLC = timeframeOHLC.slice(-this.ohlcBufferSize);
    }
    
    symbolOHLC.set(timeframe, timeframeOHLC);
  }

  /**
   * Subscribe to market data events
   */
  private async subscribeToMarketDataEvents(): Promise<void> {
    try {
      await this.connectionGateway.subscribe([
        'tick',
        'ohlc',
        'symbol'
      ]);
      
      // Setup event handlers
      this.connectionGateway.on('message', (data) => {
        if (data.topic === 'tick') {
          this.handleTickData(data.message.data);
        } else if (data.topic === 'ohlc') {
          this.handleOHLCData(data.message.data);
        }
      });
      
      this.logger.debug('Subscribed to market data events');
      
    } catch (error) {
      this.logger.error('Failed to subscribe to market data events', { error });
      throw error;
    }
  }

  /**
   * Start cache cleanup timer
   */
  private startCacheCleanup(): void {
    this.cacheCleanupTimer = setInterval(() => {
      this.cleanupCache();
    }, this.cacheCleanupInterval);
    
    this.logger.debug('Cache cleanup timer started', {
      interval: this.cacheCleanupInterval
    });
  }

  /**
   * Stop cache cleanup timer
   */
  private stopCacheCleanup(): void {
    if (this.cacheCleanupTimer) {
      clearInterval(this.cacheCleanupTimer);
      this.cacheCleanupTimer = null;
      this.logger.debug('Cache cleanup timer stopped');
    }
  }

  /**
   * Clean up old cache data
   */
  private cleanupCache(): void {
    try {
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours
      
      // Clean up old ticks
      for (const [symbol, ticks] of this.cache.ticks) {
        const filteredTicks = ticks.filter(
          tick => now - tick.time.getTime() < maxAge
        );
        this.cache.ticks.set(symbol, filteredTicks);
      }
      
      // Clean up old OHLC data
      for (const [symbol, symbolOHLC] of this.cache.ohlc) {
        for (const [timeframe, ohlcData] of symbolOHLC) {
          const filteredOHLC = ohlcData.filter(
            ohlc => now - ohlc.time.getTime() < maxAge
          );
          symbolOHLC.set(timeframe, filteredOHLC);
        }
      }
      
      this.logger.debug('Cache cleanup completed');
      
    } catch (error) {
      this.logger.error('Cache cleanup failed', { error });
    }
  }

  /**
   * Validate symbols array
   */
  private validateSymbols(symbols: string[]): void {
    if (!Array.isArray(symbols) || symbols.length === 0) {
      throw new ValidationError('Symbols array cannot be empty', 'symbols', symbols);
    }
    
    for (const symbol of symbols) {
      this.validateSymbol(symbol);
    }
  }

  /**
   * Validate individual symbol
   */
  private validateSymbol(symbol: string): void {
    if (!symbol || typeof symbol !== 'string' || symbol.trim() === '') {
      throw new ValidationError('Symbol must be a non-empty string', 'symbol', symbol);
    }
  }

  /**
   * Validate that API is initialized
   */
  private validateInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('MarketDataAPI is not initialized');
    }
  }

  /**
   * Shutdown the Market Data API
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down MarketDataAPI...');
      
      // Stop cache cleanup
      this.stopCacheCleanup();
      
      // Clear all subscriptions
      this.subscriptions.clear();
      
      // Clear cache
      this.cache.ticks.clear();
      this.cache.ohlc.clear();
      this.cache.symbols.clear();
      
      this.isInitialized = false;
      
      this.logger.info('MarketDataAPI shutdown completed');
      
    } catch (error) {
      this.logger.error('Error during MarketDataAPI shutdown', { error });
      throw error;
    }
  }
}