/**
 * Constants used throughout the MT5 Connector SDK
 */

export const MT5_CONSTANTS = {
  // Connection Settings
  CONNECTION: {
    DEFAULT_HOST: 'localhost',
    DEFAULT_PORT: 5555,
    DEFAULT_TIMEOUT: 30000,
    DEFAULT_RECONNECT_INTERVAL: 5000,
    MAX_RECONNECT_ATTEMPTS: 10,
    HEARTBEAT_INTERVAL: 10000,
    CONNECTION_POOL_SIZE: 10
  },

  // ZeroMQ Settings
  ZMQ: {
    SOCKET_TYPES: {
      REQ: 'req',
      REP: 'rep',
      PUB: 'pub',
      SUB: 'sub',
      PUSH: 'push',
      PULL: 'pull',
      DEALER: 'dealer',
      ROUTER: 'router'
    },
    DEFAULT_PORTS: {
      REQ: 5555,
      PUB: 5556,
      PUSH: 5557,
      PULL: 5558,
      DEALER: 5559,
      ROUTER: 5560
    },
    HIGH_WATER_MARK: 1000,
    LINGER: 0
  },

  // Security Settings
  SECURITY: {
    CURVE_KEY_LENGTH: 32,
    NONCE_LENGTH: 24,
    SIGNATURE_LENGTH: 64,
    DEFAULT_ENCRYPTION: true,
    DEFAULT_AUTHENTICATION: true,
    JWT_EXPIRATION: '1h',
    API_KEY_LENGTH: 32
  },

  // Rate Limiting
  RATE_LIMIT: {
    DEFAULT_MAX_REQUESTS: 100,
    DEFAULT_WINDOW_MS: 60000,
    DEFAULT_SKIP_SUCCESSFUL: false
  },

  // Performance Settings
  PERFORMANCE: {
    DEFAULT_BATCH_SIZE: 100,
    DEFAULT_BATCH_TIMEOUT: 1000,
    DEFAULT_MEMORY_POOL_SIZE: 1000,
    DEFAULT_CACHE_TTL: 300000,
    MAX_CONCURRENT_REQUESTS: 50
  },

  // Circuit Breaker Settings
  CIRCUIT_BREAKER: {
    DEFAULT_FAILURE_THRESHOLD: 5,
    DEFAULT_RESET_TIMEOUT: 60000,
    DEFAULT_MONITOR_TIMEOUT: 30000,
    STATES: {
      CLOSED: 'CLOSED',
      OPEN: 'OPEN',
      HALF_OPEN: 'HALF_OPEN'
    }
  },

  // Retry Settings
  RETRY: {
    DEFAULT_MAX_ATTEMPTS: 3,
    DEFAULT_INITIAL_DELAY: 1000,
    DEFAULT_MAX_DELAY: 10000,
    DEFAULT_BACKOFF_FACTOR: 2,
    RETRYABLE_ERRORS: [
      'ECONNRESET',
      'ENOTFOUND',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'TIMEOUT'
    ]
  },

  // Logging Settings
  LOGGING: {
    LEVELS: {
      ERROR: 'error',
      WARN: 'warn',
      INFO: 'info',
      DEBUG: 'debug'
    },
    FORMATS: {
      JSON: 'json',
      SIMPLE: 'simple'
    },
    DEFAULT_LEVEL: 'info',
    DEFAULT_FORMAT: 'json'
  },

  // Monitoring Settings
  MONITORING: {
    DEFAULT_METRICS_PORT: 9090,
    DEFAULT_HEALTH_PORT: 8080,
    METRICS_PATH: '/metrics',
    HEALTH_PATH: '/health',
    DEFAULT_COLLECTION_INTERVAL: 5000
  },

  // Trading Constants
  TRADING: {
    MIN_LOT_SIZE: 0.01,
    MAX_LOT_SIZE: 100.0,
    DEFAULT_DEVIATION: 10,
    DEFAULT_MAGIC: 0,
    MAX_COMMENT_LENGTH: 31,
    ORDER_EXPIRATION_HOURS: 24
  },

  // Market Data Constants
  MARKET_DATA: {
    MAX_BARS_REQUEST: 5000,
    DEFAULT_BARS_COUNT: 1000,
    TICK_BUFFER_SIZE: 1000,
    SYMBOL_CACHE_TTL: 3600000, // 1 hour
    PRICE_PRECISION: 5
  },

  // Error Codes
  ERROR_CODES: {
    // Connection Errors
    CONNECTION_FAILED: 'E001',
    CONNECTION_TIMEOUT: 'E002',
    CONNECTION_LOST: 'E003',
    AUTHENTICATION_FAILED: 'E004',
    
    // Trading Errors
    INVALID_TRADE_REQUEST: 'E101',
    INSUFFICIENT_MARGIN: 'E102',
    MARKET_CLOSED: 'E103',
    INVALID_SYMBOL: 'E104',
    INVALID_VOLUME: 'E105',
    INVALID_PRICE: 'E106',
    ORDER_NOT_FOUND: 'E107',
    POSITION_NOT_FOUND: 'E108',
    
    // Market Data Errors
    SYMBOL_NOT_FOUND: 'E201',
    INVALID_TIMEFRAME: 'E202',
    NO_DATA_AVAILABLE: 'E203',
    INVALID_DATE_RANGE: 'E204',
    
    // Account Errors
    ACCOUNT_DISABLED: 'E301',
    INSUFFICIENT_RIGHTS: 'E302',
    ACCOUNT_NOT_FOUND: 'E303',
    
    // System Errors
    INTERNAL_ERROR: 'E901',
    RATE_LIMIT_EXCEEDED: 'E902',
    VALIDATION_ERROR: 'E903',
    TIMEOUT_ERROR: 'E904',
    CIRCUIT_BREAKER_OPEN: 'E905'
  },

  // Message Types
  MESSAGE_TYPES: {
    // Request Types
    TRADE_REQUEST: 'TRADE_REQUEST',
    MARKET_DATA_REQUEST: 'MARKET_DATA_REQUEST',
    ACCOUNT_INFO_REQUEST: 'ACCOUNT_INFO_REQUEST',
    SYMBOL_INFO_REQUEST: 'SYMBOL_INFO_REQUEST',
    HISTORY_REQUEST: 'HISTORY_REQUEST',
    
    // Response Types
    TRADE_RESPONSE: 'TRADE_RESPONSE',
    MARKET_DATA_RESPONSE: 'MARKET_DATA_RESPONSE',
    ACCOUNT_INFO_RESPONSE: 'ACCOUNT_INFO_RESPONSE',
    SYMBOL_INFO_RESPONSE: 'SYMBOL_INFO_RESPONSE',
    HISTORY_RESPONSE: 'HISTORY_RESPONSE',
    
    // Event Types
    TICK_EVENT: 'TICK_EVENT',
    TRADE_EVENT: 'TRADE_EVENT',
    ORDER_EVENT: 'ORDER_EVENT',
    POSITION_EVENT: 'POSITION_EVENT',
    ACCOUNT_EVENT: 'ACCOUNT_EVENT',
    CONNECTION_EVENT: 'CONNECTION_EVENT',
    ERROR_EVENT: 'ERROR_EVENT',
    HEARTBEAT_EVENT: 'HEARTBEAT_EVENT'
  },

  // Validation Rules
  VALIDATION: {
    SYMBOL: {
      MIN_LENGTH: 1,
      MAX_LENGTH: 12,
      PATTERN: /^[A-Z0-9._]+$/
    },
    VOLUME: {
      MIN: 0.01,
      MAX: 1000.0,
      STEP: 0.01
    },
    PRICE: {
      MIN: 0.00001,
      MAX: 999999.99999
    },
    MAGIC: {
      MIN: 0,
      MAX: 2147483647
    },
    COMMENT: {
      MAX_LENGTH: 31
    }
  },

  // Environment Variables
  ENV_VARS: {
    NODE_ENV: 'NODE_ENV',
    MT5_HOST: 'MT5_HOST',
    MT5_PORT: 'MT5_PORT',
    LOG_LEVEL: 'LOG_LEVEL',
    CURVE_SERVER_PUBLIC_KEY: 'CURVE_SERVER_PUBLIC_KEY',
    CURVE_SERVER_SECRET_KEY: 'CURVE_SERVER_SECRET_KEY',
    CURVE_CLIENT_PUBLIC_KEY: 'CURVE_CLIENT_PUBLIC_KEY',
    CURVE_CLIENT_SECRET_KEY: 'CURVE_CLIENT_SECRET_KEY',
    API_KEY: 'API_KEY',
    JWT_SECRET: 'JWT_SECRET'
  },

  // Default Configurations
  DEFAULTS: {
    CONFIG: {
      host: 'localhost',
      port: 5555,
      timeout: 30000,
      reconnectInterval: 5000,
      maxReconnectAttempts: 10,
      security: {
        enableEncryption: true,
        enableAuthentication: true
      },
      performance: {
        connectionPoolSize: 10,
        messageBatchSize: 100,
        messageBatchTimeout: 1000,
        memoryPoolSize: 1000,
        cacheTtl: 300000
      },
      logging: {
        level: 'info',
        format: 'json'
      }
    },
    AGENT_PERMISSIONS: {
      canTrade: false,
      canViewMarketData: true,
      canViewAccountInfo: false,
      canModifyOrders: false,
      canClosePositions: false
    }
  }
} as const;

// Export individual constant groups for convenience
export const { CONNECTION, ZMQ, SECURITY, RATE_LIMIT, PERFORMANCE, CIRCUIT_BREAKER, RETRY, LOGGING, MONITORING, TRADING, MARKET_DATA, ERROR_CODES, MESSAGE_TYPES, VALIDATION, ENV_VARS, DEFAULTS } = MT5_CONSTANTS;