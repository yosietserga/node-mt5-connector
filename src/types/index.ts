/**
 * Core type definitions for the MT5 Connector SDK
 */

// Base Types
export interface MT5ConnectorConfig {
  host: string;
  port: number;
  timeout?: number;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  security: SecurityConfig;
  performance?: PerformanceConfig;
  logging?: LoggingConfig;
}

export interface SecurityConfig {
  curveServerPublicKey: string;
  curveServerSecretKey: string;
  curveClientPublicKey: string;
  curveClientSecretKey: string;
  enableEncryption: boolean;
  enableAuthentication: boolean;
  apiKey?: string;
  jwtSecret?: string;
}

export interface PerformanceConfig {
  connectionPoolSize: number;
  messageBatchSize: number;
  messageBatchTimeout: number;
  memoryPoolSize: number;
  cacheTtl: number;
}

export interface LoggingConfig {
  level: 'error' | 'warn' | 'info' | 'debug';
  format: 'json' | 'simple';
  filePath?: string;
  maxSize?: string;
  maxFiles?: number;
}

// Agent Configuration
export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  permissions: AgentPermissions;
  rateLimit?: RateLimitConfig;
}

export interface AgentPermissions {
  canTrade: boolean;
  canViewMarketData: boolean;
  canViewAccountInfo: boolean;
  canModifyOrders: boolean;
  canClosePositions: boolean;
  allowedSymbols?: string[];
  maxLotSize?: number;
}

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  skipSuccessfulRequests?: boolean;
}

// Trading Types
export interface TradeRequest {
  action: TradeAction;
  symbol: string;
  volume: number;
  price?: number;
  stoploss?: number;
  takeprofit?: number;
  deviation?: number;
  type: OrderType;
  comment?: string;
  magic?: number;
  expiration?: Date;
}

export enum TradeAction {
  BUY = 'BUY',
  SELL = 'SELL',
  BUY_LIMIT = 'BUY_LIMIT',
  SELL_LIMIT = 'SELL_LIMIT',
  BUY_STOP = 'BUY_STOP',
  SELL_STOP = 'SELL_STOP'
}

export enum OrderType {
  MARKET = 'MARKET',
  PENDING = 'PENDING',
  LIMIT = 'LIMIT',
  STOP = 'STOP'
}

export interface TradeResult {
  success: boolean;
  orderId?: number;
  ticket?: number;
  price?: number;
  volume?: number;
  error?: string;
  retcode?: number;
  comment?: string;
}

export interface Position {
  ticket: number;
  symbol: string;
  type: PositionType;
  volume: number;
  openPrice: number;
  currentPrice: number;
  profit: number;
  swap: number;
  commission: number;
  openTime: Date;
  comment: string;
  magic: number;
}

export enum PositionType {
  BUY = 'BUY',
  SELL = 'SELL'
}

export interface Order {
  ticket: number;
  symbol: string;
  type: OrderType;
  state: OrderState;
  volume: number;
  price: number;
  stoploss: number;
  takeprofit: number;
  openTime: Date;
  expiration?: Date;
  comment: string;
  magic: number;
}

export enum OrderState {
  STARTED = 'STARTED',
  PLACED = 'PLACED',
  CANCELED = 'CANCELED',
  PARTIAL = 'PARTIAL',
  FILLED = 'FILLED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED'
}

// Market Data Types
export interface SymbolInfo {
  name: string;
  description: string;
  currency: string;
  digits: number;
  point: number;
  spread: number;
  stopsLevel: number;
  lotSize: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
  marginRequired: number;
  tradeMode: TradeMode;
  sessionDeals: number;
  sessionBuyOrders: number;
  sessionSellOrders: number;
}

export enum TradeMode {
  DISABLED = 'DISABLED',
  LONGONLY = 'LONGONLY',
  SHORTONLY = 'SHORTONLY',
  CLOSEONLY = 'CLOSEONLY',
  FULL = 'FULL'
}

export interface Tick {
  symbol: string;
  time: Date;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  flags: TickFlags;
}

export enum TickFlags {
  BID = 'BID',
  ASK = 'ASK',
  LAST = 'LAST',
  VOLUME = 'VOLUME',
  BUY = 'BUY',
  SELL = 'SELL'
}

export interface OHLC {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  spread?: number;
}

export enum Timeframe {
  M1 = 'M1',
  M5 = 'M5',
  M15 = 'M15',
  M30 = 'M30',
  H1 = 'H1',
  H4 = 'H4',
  D1 = 'D1',
  W1 = 'W1',
  MN1 = 'MN1'
}

// Account Types
export interface AccountInfo {
  login: number;
  name: string;
  server: string;
  currency: string;
  company: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number;
  profit: number;
  credit: number;
  leverage: number;
  tradeAllowed: boolean;
  tradeExpert: boolean;
  limitOrders: number;
  marginSoCall: number;
  marginSoSo: number;
}

// Event Types
export interface MT5Event {
  type: EventType;
  timestamp: Date;
  data: any;
  source: string;
}

export enum EventType {
  TICK = 'TICK',
  TRADE = 'TRADE',
  ORDER = 'ORDER',
  POSITION = 'POSITION',
  ACCOUNT = 'ACCOUNT',
  CONNECTION = 'CONNECTION',
  ERROR = 'ERROR',
  HEARTBEAT = 'HEARTBEAT'
}

// Error Types
export interface MT5Error extends Error {
  code: string;
  type: ErrorType;
  details?: any;
  timestamp: Date;
}

export enum ErrorType {
  CONNECTION = 'CONNECTION',
  AUTHENTICATION = 'AUTHENTICATION',
  VALIDATION = 'VALIDATION',
  TRADE = 'TRADE',
  MARKET_DATA = 'MARKET_DATA',
  ACCOUNT = 'ACCOUNT',
  TIMEOUT = 'TIMEOUT',
  RATE_LIMIT = 'RATE_LIMIT',
  INTERNAL = 'INTERNAL'
}

// Monitoring Types
export interface Metric {
  name: string;
  value: number;
  timestamp: number;
  tags: Record<string, string>;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: HealthCheckResult[];
  timestamp: string;
}

export interface HealthCheckResult {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  duration: number;
  timestamp: string;
}

export interface HealthCheck {
  execute(): Promise<{ status: 'healthy' | 'degraded' | 'unhealthy'; message: string }>;
  timeout?: number;
}

// Callback Types
export type EventCallback<T = any> = (event: MT5Event & { data: T }) => void;
export type ErrorCallback = (error: MT5Error) => void;
export type ConnectionCallback = (connected: boolean) => void;

// Utility Types
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

export type RequiredKeys<T, K extends keyof T> = T & Required<Pick<T, K>>;

export type OptionalKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;