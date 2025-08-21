/**
 * Error classes for the MT5 Connector SDK
 */

import { ErrorType } from '../types';
import { ERROR_CODES } from '../constants';

/**
 * Base MT5 Error class
 */
export class MT5Error extends Error {
  public readonly code: string;
  public readonly type: ErrorType;
  public readonly details?: any;
  public readonly timestamp: Date;

  constructor(
    message: string,
    code: string,
    type: ErrorType,
    details?: any
  ) {
    super(message);
    this.name = 'MT5Error';
    this.code = code;
    this.type = type;
    this.details = details;
    this.timestamp = new Date();

    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MT5Error);
    }
  }

  /**
   * Convert error to JSON representation
   */
  toJSON(): object {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      type: this.type,
      details: this.details,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack
    };
  }

  /**
   * Create error from JSON representation
   */
  static fromJSON(json: any): MT5Error {
    const error = new MT5Error(json.message, json.code, json.type, json.details);
    error.stack = json.stack;
    return error;
  }
}

/**
 * Connection-related errors
 */
export class ConnectionError extends MT5Error {
  constructor(message: string, code: string = ERROR_CODES.CONNECTION_FAILED, details?: any) {
    super(message, code, ErrorType.CONNECTION, details);
    this.name = 'ConnectionError';
  }

  static timeout(timeout: number): ConnectionError {
    return new ConnectionError(
      `Connection timeout after ${timeout}ms`,
      ERROR_CODES.CONNECTION_TIMEOUT,
      { timeout }
    );
  }

  static lost(reason?: string): ConnectionError {
    return new ConnectionError(
      `Connection lost${reason ? `: ${reason}` : ''}`,
      ERROR_CODES.CONNECTION_LOST,
      { reason }
    );
  }

  static failed(host: string, port: number, reason?: string): ConnectionError {
    return new ConnectionError(
      `Failed to connect to ${host}:${port}${reason ? `: ${reason}` : ''}`,
      ERROR_CODES.CONNECTION_FAILED,
      { host, port, reason }
    );
  }
}

/**
 * Authentication-related errors
 */
export class AuthenticationError extends MT5Error {
  constructor(message: string, code: string = ERROR_CODES.AUTHENTICATION_FAILED, details?: any) {
    super(message, code, ErrorType.AUTHENTICATION, details);
    this.name = 'AuthenticationError';
  }

  static invalidCredentials(): AuthenticationError {
    return new AuthenticationError(
      'Invalid authentication credentials',
      ERROR_CODES.AUTHENTICATION_FAILED
    );
  }

  static invalidApiKey(): AuthenticationError {
    return new AuthenticationError(
      'Invalid API key provided',
      ERROR_CODES.AUTHENTICATION_FAILED,
      { type: 'api_key' }
    );
  }

  static expiredToken(): AuthenticationError {
    return new AuthenticationError(
      'Authentication token has expired',
      ERROR_CODES.AUTHENTICATION_FAILED,
      { type: 'expired_token' }
    );
  }
}

/**
 * Trading-related errors
 */
export class TradeError extends MT5Error {
  constructor(message: string, code: string, details?: any) {
    super(message, code, ErrorType.TRADE, details);
    this.name = 'TradeError';
  }

  static invalidRequest(field: string, value: any): TradeError {
    return new TradeError(
      `Invalid trade request: ${field} = ${value}`,
      ERROR_CODES.INVALID_TRADE_REQUEST,
      { field, value }
    );
  }

  static insufficientMargin(required: number, available: number): TradeError {
    return new TradeError(
      `Insufficient margin: required ${required}, available ${available}`,
      ERROR_CODES.INSUFFICIENT_MARGIN,
      { required, available }
    );
  }

  static marketClosed(symbol: string): TradeError {
    return new TradeError(
      `Market is closed for symbol ${symbol}`,
      ERROR_CODES.MARKET_CLOSED,
      { symbol }
    );
  }

  static invalidSymbol(symbol: string): TradeError {
    return new TradeError(
      `Invalid or unknown symbol: ${symbol}`,
      ERROR_CODES.INVALID_SYMBOL,
      { symbol }
    );
  }

  static invalidVolume(volume: number, minLot: number, maxLot: number): TradeError {
    return new TradeError(
      `Invalid volume ${volume}: must be between ${minLot} and ${maxLot}`,
      ERROR_CODES.INVALID_VOLUME,
      { volume, minLot, maxLot }
    );
  }

  static invalidPrice(price: number, symbol: string): TradeError {
    return new TradeError(
      `Invalid price ${price} for symbol ${symbol}`,
      ERROR_CODES.INVALID_PRICE,
      { price, symbol }
    );
  }

  static orderNotFound(orderId: number): TradeError {
    return new TradeError(
      `Order not found: ${orderId}`,
      ERROR_CODES.ORDER_NOT_FOUND,
      { orderId }
    );
  }

  static positionNotFound(ticket: number): TradeError {
    return new TradeError(
      `Position not found: ${ticket}`,
      ERROR_CODES.POSITION_NOT_FOUND,
      { ticket }
    );
  }
}

/**
 * Validation-related errors
 */
export class ValidationError extends MT5Error {
  constructor(message: string, field: string, value: any, details?: any) {
    super(message, ERROR_CODES.VALIDATION_ERROR, ErrorType.VALIDATION, {
      field,
      value,
      ...details
    });
    this.name = 'ValidationError';
  }

  static required(field: string): ValidationError {
    return new ValidationError(
      `Field '${field}' is required`,
      field,
      undefined,
      { type: 'required' }
    );
  }

  static invalidType(field: string, expected: string, actual: string): ValidationError {
    return new ValidationError(
      `Field '${field}' must be of type ${expected}, got ${actual}`,
      field,
      actual,
      { type: 'invalid_type', expected }
    );
  }

  static outOfRange(field: string, value: any, min: any, max: any): ValidationError {
    return new ValidationError(
      `Field '${field}' value ${value} is out of range [${min}, ${max}]`,
      field,
      value,
      { type: 'out_of_range', min, max }
    );
  }

  static invalidFormat(field: string, value: any, pattern: string): ValidationError {
    return new ValidationError(
      `Field '${field}' value '${value}' does not match required pattern: ${pattern}`,
      field,
      value,
      { type: 'invalid_format', pattern }
    );
  }
}

/**
 * Rate limiting errors
 */
export class RateLimitError extends MT5Error {
  constructor(
    message: string,
    public readonly limit: number,
    public readonly remaining: number,
    public readonly resetTime: number
  ) {
    super(message, ERROR_CODES.RATE_LIMIT_EXCEEDED, ErrorType.RATE_LIMIT, {
      limit,
      remaining,
      resetTime
    });
    this.name = 'RateLimitError';
  }

  static exceeded(limit: number, resetTime: number): RateLimitError {
    return new RateLimitError(
      `Rate limit exceeded: ${limit} requests per window`,
      limit,
      0,
      resetTime
    );
  }
}

/**
 * Timeout-related errors
 */
export class TimeoutError extends MT5Error {
  constructor(message: string, timeout: number, operation?: string) {
    super(message, ERROR_CODES.TIMEOUT_ERROR, ErrorType.TIMEOUT, {
      timeout,
      operation
    });
    this.name = 'TimeoutError';
  }

  static operation(operation: string, timeout: number): TimeoutError {
    return new TimeoutError(
      `Operation '${operation}' timed out after ${timeout}ms`,
      timeout,
      operation
    );
  }

  static request(timeout: number): TimeoutError {
    return new TimeoutError(
      `Request timed out after ${timeout}ms`,
      timeout,
      'request'
    );
  }
}

/**
 * Market data related errors
 */
export class MarketDataError extends MT5Error {
  constructor(message: string, code: string, details?: any) {
    super(message, code, ErrorType.MARKET_DATA, details);
    this.name = 'MarketDataError';
  }

  static symbolNotFound(symbol: string): MarketDataError {
    return new MarketDataError(
      `Symbol not found: ${symbol}`,
      ERROR_CODES.SYMBOL_NOT_FOUND,
      { symbol }
    );
  }

  static invalidTimeframe(timeframe: string): MarketDataError {
    return new MarketDataError(
      `Invalid timeframe: ${timeframe}`,
      ERROR_CODES.INVALID_TIMEFRAME,
      { timeframe }
    );
  }

  static noDataAvailable(symbol: string, timeframe?: string): MarketDataError {
    return new MarketDataError(
      `No data available for ${symbol}${timeframe ? ` on ${timeframe}` : ''}`,
      ERROR_CODES.NO_DATA_AVAILABLE,
      { symbol, timeframe }
    );
  }

  static invalidDateRange(from: Date, to: Date): MarketDataError {
    return new MarketDataError(
      `Invalid date range: from ${from.toISOString()} to ${to.toISOString()}`,
      ERROR_CODES.INVALID_DATE_RANGE,
      { from: from.toISOString(), to: to.toISOString() }
    );
  }
}

/**
 * Account-related errors
 */
export class AccountError extends MT5Error {
  constructor(message: string, code: string, details?: any) {
    super(message, code, ErrorType.ACCOUNT, details);
    this.name = 'AccountError';
  }

  static disabled(): AccountError {
    return new AccountError(
      'Account is disabled',
      ERROR_CODES.ACCOUNT_DISABLED
    );
  }

  static insufficientRights(operation: string): AccountError {
    return new AccountError(
      `Insufficient rights for operation: ${operation}`,
      ERROR_CODES.INSUFFICIENT_RIGHTS,
      { operation }
    );
  }

  static notFound(login: number): AccountError {
    return new AccountError(
      `Account not found: ${login}`,
      ERROR_CODES.ACCOUNT_NOT_FOUND,
      { login }
    );
  }
}

/**
 * Circuit breaker errors
 */
export class CircuitBreakerError extends MT5Error {
  constructor(message: string, public readonly state: string) {
    super(message, ERROR_CODES.CIRCUIT_BREAKER_OPEN, ErrorType.INTERNAL, { state });
    this.name = 'CircuitBreakerError';
  }

  static open(service: string): CircuitBreakerError {
    return new CircuitBreakerError(
      `Circuit breaker is open for service: ${service}`,
      'OPEN'
    );
  }
}

/**
 * Error factory for creating errors from error codes
 */
export class ErrorFactory {
  static createFromCode(code: string, message?: string, details?: any): MT5Error {
    const defaultMessage = message || 'An error occurred';

    switch (code) {
      case ERROR_CODES.CONNECTION_FAILED:
      case ERROR_CODES.CONNECTION_TIMEOUT:
      case ERROR_CODES.CONNECTION_LOST:
        return new ConnectionError(defaultMessage, code, details);

      case ERROR_CODES.AUTHENTICATION_FAILED:
        return new AuthenticationError(defaultMessage, code, details);

      case ERROR_CODES.INVALID_TRADE_REQUEST:
      case ERROR_CODES.INSUFFICIENT_MARGIN:
      case ERROR_CODES.MARKET_CLOSED:
      case ERROR_CODES.INVALID_SYMBOL:
      case ERROR_CODES.INVALID_VOLUME:
      case ERROR_CODES.INVALID_PRICE:
      case ERROR_CODES.ORDER_NOT_FOUND:
      case ERROR_CODES.POSITION_NOT_FOUND:
        return new TradeError(defaultMessage, code, details);

      case ERROR_CODES.SYMBOL_NOT_FOUND:
      case ERROR_CODES.INVALID_TIMEFRAME:
      case ERROR_CODES.NO_DATA_AVAILABLE:
      case ERROR_CODES.INVALID_DATE_RANGE:
        return new MarketDataError(defaultMessage, code, details);

      case ERROR_CODES.ACCOUNT_DISABLED:
      case ERROR_CODES.INSUFFICIENT_RIGHTS:
      case ERROR_CODES.ACCOUNT_NOT_FOUND:
        return new AccountError(defaultMessage, code, details);

      case ERROR_CODES.RATE_LIMIT_EXCEEDED:
        return new RateLimitError(defaultMessage, 0, 0, 0);

      case ERROR_CODES.TIMEOUT_ERROR:
        return new TimeoutError(defaultMessage, 0);

      case ERROR_CODES.VALIDATION_ERROR:
        return new ValidationError(defaultMessage, 'unknown', undefined, details);

      case ERROR_CODES.CIRCUIT_BREAKER_OPEN:
        return new CircuitBreakerError(defaultMessage, 'OPEN');

      default:
        return new MT5Error(defaultMessage, code, ErrorType.INTERNAL, details);
    }
  }
}