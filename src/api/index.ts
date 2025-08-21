/**
 * API Module Exports
 * 
 * This file exports all API modules for the MT5 Connector SDK
 */

export { TradeAPI } from './TradeAPI';
export { MarketDataAPI } from './MarketDataAPI';
export { AccountAPI } from './AccountAPI';

// Re-export types that are commonly used with APIs
export type {
  TradeRequest,
  TradeResult,
  Position,
  Order,
  Tick,
  OHLC,
  SymbolInfo,
  AccountInfo,
  OrderType,
  TradeAction,
  OrderState,
  PositionType,
  Timeframe,
  Currency
} from '../types';