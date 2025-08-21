/**
 * MT5 Connector SDK - Enterprise-Grade MetaTrader 5 Connector for Node.js
 * 
 * This package provides a comprehensive, secure, and high-performance interface
 * for connecting Node.js applications to MetaTrader 5 terminals using ZeroMQ.
 * 
 * @author MT5 Connector Team
 * @version 1.0.0
 * @license MIT
 */

// Core Components
export { MT5Connector } from './core/MT5Connector';
export { MT5Agent } from './core/MT5Agent';
export { ConnectionGateway } from './core/ConnectionGateway';
export { EventProcessor } from './core/EventProcessor';

// API Modules
export { TradeAPI } from './api/TradeAPI';
export { MarketDataAPI } from './api/MarketDataAPI';
export { AccountAPI } from './api/AccountAPI';

// Security Components
export { SecurityManager } from './security/SecurityManager';
export { CurveEncryption } from './security/CurveEncryption';
export { AuthenticationManager } from './security/AuthenticationManager';
export { RateLimiter } from './security/RateLimiter';

// Utility Components
export { Logger } from './utils/Logger';
export { MetricsCollector } from './utils/MetricsCollector';
export { HealthChecker } from './utils/HealthChecker';
export { ConfigManager } from './utils/ConfigManager';
export { CircuitBreaker } from './utils/CircuitBreaker';
export { RetryManager } from './utils/RetryManager';

// Type Definitions
export * from './types';

// Error Classes
export {
  MT5Error,
  ConnectionError,
  TradeError,
  ValidationError,
  AuthenticationError,
  RateLimitError,
  TimeoutError
} from './core/errors';

// Constants
export { MT5_CONSTANTS } from './constants';

// Version
export const VERSION = '1.0.0';

// Default export for convenience
export default MT5Connector;