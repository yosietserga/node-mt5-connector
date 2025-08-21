/**
 * ConfigManager - Configuration management and validation utility
 */

import { EventEmitter } from 'eventemitter3';
import * as fs from 'fs';
import * as path from 'path';
import {
  MT5Config,
  ConnectionConfig,
  SecurityConfig,
  MonitoringConfig,
  RateLimitConfig,
  LoggingConfig
} from '../types';
import { Logger } from './Logger';
import { DEFAULTS, ENV_VARS } from '../constants';
import { ValidationError } from '../core/errors';

interface ConfigSource {
  type: 'file' | 'env' | 'object' | 'default';
  path?: string;
  data: any;
  priority: number;
  timestamp: Date;
}

interface ConfigValidationRule {
  path: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  min?: number;
  max?: number;
  pattern?: RegExp;
  enum?: any[];
  validator?: (value: any) => boolean | string;
}

interface ConfigChangeEvent {
  path: string;
  oldValue: any;
  newValue: any;
  source: string;
  timestamp: Date;
}

interface ConfigStats {
  totalConfigs: number;
  validConfigs: number;
  invalidConfigs: number;
  lastValidation?: Date;
  lastUpdate?: Date;
  sources: ConfigSource[];
}

/**
 * Configuration Manager
 */
export class ConfigManager extends EventEmitter {
  private config: MT5Config;
  private sources: Map<string, ConfigSource> = new Map();
  private validationRules: ConfigValidationRule[] = [];
  private logger: Logger;
  
  private isInitialized: boolean = false;
  private watchedFiles: Map<string, fs.FSWatcher> = new Map();
  
  // Configuration state
  private configHistory: Array<{ config: MT5Config; timestamp: Date; source: string }> = [];
  private readonly maxHistorySize: number = 50;
  
  // Statistics
  private stats: ConfigStats;

  constructor(logger?: Logger) {
    super();

    this.logger = logger || new Logger({
      level: 'info',
      format: 'json',
      outputs: [{ type: 'console' }]
    });
    
    this.logger = this.logger.child({ component: 'ConfigManager' });
    
    // Initialize with default configuration
    this.config = this.createDefaultConfig();
    
    // Initialize statistics
    this.stats = {
      totalConfigs: 0,
      validConfigs: 0,
      invalidConfigs: 0,
      sources: []
    };
    
    // Setup validation rules
    this.setupValidationRules();

    this.logger.info('ConfigManager created');
  }

  /**
   * Initialize the Configuration Manager
   */
  async initialize(options?: {
    configFile?: string;
    envPrefix?: string;
    watchFiles?: boolean;
    validateOnLoad?: boolean;
  }): Promise<void> {
    if (this.isInitialized) {
      throw new Error('ConfigManager is already initialized');
    }

    try {
      this.logger.info('Initializing ConfigManager...', options);
      
      // Load configuration from various sources
      await this.loadConfiguration(options);
      
      // Validate configuration
      if (options?.validateOnLoad !== false) {
        this.validateConfiguration();
      }
      
      // Setup file watching
      if (options?.watchFiles !== false) {
        this.setupFileWatching();
      }
      
      this.isInitialized = true;
      
      this.logger.info('ConfigManager initialized successfully', {
        sources: this.sources.size,
        watchedFiles: this.watchedFiles.size
      });
      
    } catch (error) {
      this.logger.error('Failed to initialize ConfigManager', { error });
      throw error;
    }
  }

  /**
   * Get the current configuration
   */
  getConfig(): MT5Config {
    return { ...this.config };
  }

  /**
   * Get a specific configuration value
   */
  get<T = any>(path: string, defaultValue?: T): T {
    const keys = path.split('.');
    let value: any = this.config;
    
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return defaultValue as T;
      }
    }
    
    return value as T;
  }

  /**
   * Set a configuration value
   */
  set(path: string, value: any, source: string = 'runtime'): void {
    const keys = path.split('.');
    const oldValue = this.get(path);
    
    let current: any = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }
    
    const lastKey = keys[keys.length - 1];
    current[lastKey] = value;
    
    // Record change
    const changeEvent: ConfigChangeEvent = {
      path,
      oldValue,
      newValue: value,
      source,
      timestamp: new Date()
    };
    
    // Add to history
    this.configHistory.push({
      config: { ...this.config },
      timestamp: new Date(),
      source
    });
    
    if (this.configHistory.length > this.maxHistorySize) {
      this.configHistory.shift();
    }
    
    // Update statistics
    this.stats.lastUpdate = new Date();
    
    // Emit events
    this.emit('configChanged', changeEvent);
    this.emit(`configChanged:${path}`, changeEvent);
    
    this.logger.debug('Configuration value updated', {
      path,
      oldValue,
      newValue: value,
      source
    });
  }

  /**
   * Update configuration from object
   */
  updateConfig(updates: Partial<MT5Config>, source: string = 'runtime'): void {
    const oldConfig = { ...this.config };
    
    // Deep merge configuration
    this.config = this.deepMerge(this.config, updates);
    
    // Record change
    this.configHistory.push({
      config: { ...this.config },
      timestamp: new Date(),
      source
    });
    
    if (this.configHistory.length > this.maxHistorySize) {
      this.configHistory.shift();
    }
    
    // Update statistics
    this.stats.lastUpdate = new Date();
    
    // Emit event
    this.emit('configUpdated', {
      oldConfig,
      newConfig: { ...this.config },
      updates,
      source,
      timestamp: new Date()
    });
    
    this.logger.info('Configuration updated', {
      source,
      updateKeys: Object.keys(updates)
    });
  }

  /**
   * Load configuration from file
   */
  async loadFromFile(filePath: string, priority: number = 1): Promise<void> {
    try {
      const absolutePath = path.resolve(filePath);
      
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Configuration file not found: ${absolutePath}`);
      }
      
      const content = fs.readFileSync(absolutePath, 'utf8');
      let data: any;
      
      const ext = path.extname(absolutePath).toLowerCase();
      switch (ext) {
        case '.json':
          data = JSON.parse(content);
          break;
        case '.js':
        case '.ts':
          // For JS/TS files, require them
          delete require.cache[absolutePath];
          data = require(absolutePath);
          if (data.default) {
            data = data.default;
          }
          break;
        default:
          throw new Error(`Unsupported configuration file format: ${ext}`);
      }
      
      const source: ConfigSource = {
        type: 'file',
        path: absolutePath,
        data,
        priority,
        timestamp: new Date()
      };
      
      this.sources.set(absolutePath, source);
      
      // Merge configuration
      this.mergeConfiguration(data, `file:${filePath}`);
      
      this.logger.info('Configuration loaded from file', {
        filePath: absolutePath,
        priority
      });
      
    } catch (error) {
      this.logger.error('Failed to load configuration from file', {
        filePath,
        error
      });
      throw error;
    }
  }

  /**
   * Load configuration from environment variables
   */
  loadFromEnvironment(prefix: string = 'MT5_'): void {
    try {
      const envConfig: any = {};
      
      // Map environment variables to configuration
      const envMappings = {
        [`${prefix}HOST`]: 'connection.host',
        [`${prefix}PORT`]: 'connection.port',
        [`${prefix}TIMEOUT`]: 'connection.timeout',
        [`${prefix}RETRY_ATTEMPTS`]: 'connection.retryAttempts',
        [`${prefix}RETRY_DELAY`]: 'connection.retryDelay',
        [`${prefix}HEARTBEAT_INTERVAL`]: 'connection.heartbeatInterval',
        [`${prefix}RECONNECT_INTERVAL`]: 'connection.reconnectInterval',
        [`${prefix}MAX_RECONNECT_ATTEMPTS`]: 'connection.maxReconnectAttempts',
        
        [`${prefix}SECURITY_ENABLED`]: 'security.enabled',
        [`${prefix}CURVE_SERVER_KEY`]: 'security.curveServerKey',
        [`${prefix}CURVE_CLIENT_KEY`]: 'security.curveClientKey',
        [`${prefix}JWT_SECRET`]: 'security.jwtSecret',
        [`${prefix}JWT_EXPIRES_IN`]: 'security.jwtExpiresIn',
        [`${prefix}SESSION_TIMEOUT`]: 'security.sessionTimeout',
        
        [`${prefix}RATE_LIMIT_ENABLED`]: 'rateLimiting.enabled',
        [`${prefix}RATE_LIMIT_REQUESTS`]: 'rateLimiting.requests',
        [`${prefix}RATE_LIMIT_WINDOW`]: 'rateLimiting.windowMs',
        
        [`${prefix}LOG_LEVEL`]: 'logging.level',
        [`${prefix}LOG_FORMAT`]: 'logging.format',
        
        [`${prefix}MONITORING_ENABLED`]: 'monitoring.enabled',
        [`${prefix}METRICS_ENABLED`]: 'monitoring.metricsEnabled',
        [`${prefix}HEALTH_CHECK_INTERVAL`]: 'monitoring.healthCheckInterval'
      };
      
      for (const [envVar, configPath] of Object.entries(envMappings)) {
        const value = process.env[envVar];
        if (value !== undefined) {
          this.setNestedValue(envConfig, configPath, this.parseEnvValue(value));
        }
      }
      
      if (Object.keys(envConfig).length > 0) {
        const source: ConfigSource = {
          type: 'env',
          data: envConfig,
          priority: 2,
          timestamp: new Date()
        };
        
        this.sources.set('environment', source);
        
        // Merge configuration
        this.mergeConfiguration(envConfig, 'environment');
        
        this.logger.info('Configuration loaded from environment', {
          prefix,
          variableCount: Object.keys(envConfig).length
        });
      }
      
    } catch (error) {
      this.logger.error('Failed to load configuration from environment', {
        prefix,
        error
      });
      throw error;
    }
  }

  /**
   * Validate configuration
   */
  validateConfiguration(): void {
    try {
      const errors: string[] = [];
      
      for (const rule of this.validationRules) {
        const value = this.get(rule.path);
        const error = this.validateValue(value, rule);
        if (error) {
          errors.push(`${rule.path}: ${error}`);
        }
      }
      
      if (errors.length > 0) {
        this.stats.invalidConfigs++;
        throw new ValidationError(`Configuration validation failed: ${errors.join(', ')}`);
      }
      
      this.stats.validConfigs++;
      this.stats.lastValidation = new Date();
      
      this.logger.info('Configuration validation passed');
      
    } catch (error) {
      this.logger.error('Configuration validation failed', { error });
      throw error;
    }
  }

  /**
   * Get configuration statistics
   */
  getStats(): ConfigStats & {
    isInitialized: boolean;
    historySize: number;
    watchedFiles: number;
  } {
    return {
      ...this.stats,
      sources: Array.from(this.sources.values()),
      isInitialized: this.isInitialized,
      historySize: this.configHistory.length,
      watchedFiles: this.watchedFiles.size
    };
  }

  /**
   * Get configuration history
   */
  getHistory(): Array<{ config: MT5Config; timestamp: Date; source: string }> {
    return [...this.configHistory];
  }

  /**
   * Export configuration to file
   */
  async exportToFile(filePath: string, format: 'json' | 'js' = 'json'): Promise<void> {
    try {
      const absolutePath = path.resolve(filePath);
      
      // Ensure directory exists
      const dir = path.dirname(absolutePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      let content: string;
      
      switch (format) {
        case 'json':
          content = JSON.stringify(this.config, null, 2);
          break;
        case 'js':
          content = `module.exports = ${JSON.stringify(this.config, null, 2)};`;
          break;
        default:
          throw new Error(`Unsupported export format: ${format}`);
      }
      
      fs.writeFileSync(absolutePath, content, 'utf8');
      
      this.logger.info('Configuration exported to file', {
        filePath: absolutePath,
        format
      });
      
    } catch (error) {
      this.logger.error('Failed to export configuration to file', {
        filePath,
        format,
        error
      });
      throw error;
    }
  }

  /**
   * Create default configuration
   */
  private createDefaultConfig(): MT5Config {
    return {
      connection: {
        host: DEFAULTS.CONNECTION.HOST,
        port: DEFAULTS.CONNECTION.PORT,
        timeout: DEFAULTS.CONNECTION.TIMEOUT,
        retryAttempts: DEFAULTS.CONNECTION.RETRY_ATTEMPTS,
        retryDelay: DEFAULTS.CONNECTION.RETRY_DELAY,
        heartbeatInterval: DEFAULTS.CONNECTION.HEARTBEAT_INTERVAL,
        reconnectInterval: DEFAULTS.CONNECTION.RECONNECT_INTERVAL,
        maxReconnectAttempts: DEFAULTS.CONNECTION.MAX_RECONNECT_ATTEMPTS,
        enableCompression: DEFAULTS.CONNECTION.ENABLE_COMPRESSION,
        maxMessageSize: DEFAULTS.CONNECTION.MAX_MESSAGE_SIZE
      },
      security: {
        enabled: DEFAULTS.SECURITY.ENABLED,
        curveServerKey: '',
        curveClientKey: '',
        jwtSecret: '',
        jwtExpiresIn: DEFAULTS.SECURITY.JWT_EXPIRES_IN,
        sessionTimeout: DEFAULTS.SECURITY.SESSION_TIMEOUT,
        maxLoginAttempts: DEFAULTS.SECURITY.MAX_LOGIN_ATTEMPTS,
        lockoutDuration: DEFAULTS.SECURITY.LOCKOUT_DURATION,
        encryptionAlgorithm: DEFAULTS.SECURITY.ENCRYPTION_ALGORITHM
      },
      rateLimiting: {
        enabled: DEFAULTS.RATE_LIMITING.ENABLED,
        requests: DEFAULTS.RATE_LIMITING.REQUESTS,
        windowMs: DEFAULTS.RATE_LIMITING.WINDOW_MS,
        algorithm: DEFAULTS.RATE_LIMITING.ALGORITHM,
        skipSuccessfulRequests: DEFAULTS.RATE_LIMITING.SKIP_SUCCESSFUL_REQUESTS,
        skipFailedRequests: DEFAULTS.RATE_LIMITING.SKIP_FAILED_REQUESTS
      },
      monitoring: {
        enabled: DEFAULTS.MONITORING.ENABLED,
        metricsEnabled: DEFAULTS.MONITORING.METRICS_ENABLED,
        healthCheckEnabled: DEFAULTS.MONITORING.HEALTH_CHECK_ENABLED,
        healthCheckInterval: DEFAULTS.MONITORING.HEALTH_CHECK_INTERVAL,
        metricsInterval: DEFAULTS.MONITORING.METRICS_INTERVAL,
        retentionPeriod: DEFAULTS.MONITORING.RETENTION_PERIOD
      },
      logging: {
        level: DEFAULTS.LOGGING.LEVEL,
        format: DEFAULTS.LOGGING.FORMAT,
        outputs: [{ type: 'console' }],
        enableFileRotation: DEFAULTS.LOGGING.ENABLE_FILE_ROTATION,
        maxFileSize: DEFAULTS.LOGGING.MAX_FILE_SIZE,
        maxFiles: DEFAULTS.LOGGING.MAX_FILES
      }
    };
  }

  /**
   * Setup validation rules
   */
  private setupValidationRules(): void {
    this.validationRules = [
      // Connection validation
      {
        path: 'connection.host',
        type: 'string',
        required: true,
        pattern: /^[a-zA-Z0-9.-]+$/
      },
      {
        path: 'connection.port',
        type: 'number',
        required: true,
        min: 1,
        max: 65535
      },
      {
        path: 'connection.timeout',
        type: 'number',
        required: true,
        min: 1000
      },
      {
        path: 'connection.retryAttempts',
        type: 'number',
        required: true,
        min: 0,
        max: 10
      },
      
      // Security validation
      {
        path: 'security.enabled',
        type: 'boolean',
        required: true
      },
      {
        path: 'security.jwtExpiresIn',
        type: 'string',
        required: true,
        pattern: /^\d+[smhd]$/
      },
      {
        path: 'security.sessionTimeout',
        type: 'number',
        required: true,
        min: 60000 // 1 minute minimum
      },
      
      // Rate limiting validation
      {
        path: 'rateLimiting.enabled',
        type: 'boolean',
        required: true
      },
      {
        path: 'rateLimiting.requests',
        type: 'number',
        required: true,
        min: 1
      },
      {
        path: 'rateLimiting.windowMs',
        type: 'number',
        required: true,
        min: 1000
      },
      
      // Logging validation
      {
        path: 'logging.level',
        type: 'string',
        required: true,
        enum: ['debug', 'info', 'warn', 'error', 'fatal']
      },
      {
        path: 'logging.format',
        type: 'string',
        required: true,
        enum: ['json', 'text', 'structured']
      }
    ];
  }

  /**
   * Load configuration from various sources
   */
  private async loadConfiguration(options?: {
    configFile?: string;
    envPrefix?: string;
  }): Promise<void> {
    // Load from default configuration (already done in constructor)
    
    // Load from configuration file
    if (options?.configFile) {
      try {
        await this.loadFromFile(options.configFile, 1);
      } catch (error) {
        this.logger.warn('Failed to load configuration file, using defaults', {
          configFile: options.configFile,
          error: error.message
        });
      }
    }
    
    // Load from environment variables
    this.loadFromEnvironment(options?.envPrefix);
  }

  /**
   * Merge configuration
   */
  private mergeConfiguration(newConfig: any, source: string): void {
    const oldConfig = { ...this.config };
    this.config = this.deepMerge(this.config, newConfig);
    
    // Add to history
    this.configHistory.push({
      config: { ...this.config },
      timestamp: new Date(),
      source
    });
    
    if (this.configHistory.length > this.maxHistorySize) {
      this.configHistory.shift();
    }
    
    // Update statistics
    this.stats.totalConfigs++;
    this.stats.lastUpdate = new Date();
    
    // Emit event
    this.emit('configMerged', {
      oldConfig,
      newConfig: { ...this.config },
      source,
      timestamp: new Date()
    });
  }

  /**
   * Deep merge objects
   */
  private deepMerge(target: any, source: any): any {
    const result = { ...target };
    
    for (const key in source) {
      if (source.hasOwnProperty(key)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
          result[key] = this.deepMerge(result[key] || {}, source[key]);
        } else {
          result[key] = source[key];
        }
      }
    }
    
    return result;
  }

  /**
   * Set nested value in object
   */
  private setNestedValue(obj: any, path: string, value: any): void {
    const keys = path.split('.');
    let current = obj;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }
    
    current[keys[keys.length - 1]] = value;
  }

  /**
   * Parse environment variable value
   */
  private parseEnvValue(value: string): any {
    // Try to parse as JSON first
    try {
      return JSON.parse(value);
    } catch {
      // If not JSON, try other types
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
      if (/^\d+$/.test(value)) return parseInt(value, 10);
      if (/^\d*\.\d+$/.test(value)) return parseFloat(value);
      return value;
    }
  }

  /**
   * Validate a value against a rule
   */
  private validateValue(value: any, rule: ConfigValidationRule): string | null {
    // Check if required
    if (rule.required && (value === undefined || value === null)) {
      return 'is required';
    }
    
    // Skip validation if value is undefined/null and not required
    if (value === undefined || value === null) {
      return null;
    }
    
    // Type validation
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== rule.type) {
      return `expected ${rule.type}, got ${actualType}`;
    }
    
    // Number validations
    if (rule.type === 'number') {
      if (rule.min !== undefined && value < rule.min) {
        return `must be >= ${rule.min}`;
      }
      if (rule.max !== undefined && value > rule.max) {
        return `must be <= ${rule.max}`;
      }
    }
    
    // String validations
    if (rule.type === 'string') {
      if (rule.pattern && !rule.pattern.test(value)) {
        return `does not match pattern ${rule.pattern}`;
      }
      if (rule.min !== undefined && value.length < rule.min) {
        return `length must be >= ${rule.min}`;
      }
      if (rule.max !== undefined && value.length > rule.max) {
        return `length must be <= ${rule.max}`;
      }
    }
    
    // Enum validation
    if (rule.enum && !rule.enum.includes(value)) {
      return `must be one of: ${rule.enum.join(', ')}`;
    }
    
    // Custom validator
    if (rule.validator) {
      const result = rule.validator(value);
      if (result !== true) {
        return typeof result === 'string' ? result : 'validation failed';
      }
    }
    
    return null;
  }

  /**
   * Setup file watching
   */
  private setupFileWatching(): void {
    for (const [path, source] of this.sources) {
      if (source.type === 'file' && source.path) {
        this.watchFile(source.path);
      }
    }
  }

  /**
   * Watch a configuration file
   */
  private watchFile(filePath: string): void {
    try {
      if (this.watchedFiles.has(filePath)) {
        return; // Already watching
      }
      
      const watcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'change') {
          this.logger.info('Configuration file changed, reloading...', {
            filePath
          });
          
          // Debounce file changes
          setTimeout(async () => {
            try {
              await this.loadFromFile(filePath);
              this.emit('configFileChanged', {
                filePath,
                timestamp: new Date()
              });
            } catch (error) {
              this.logger.error('Failed to reload configuration file', {
                filePath,
                error
              });
            }
          }, 100);
        }
      });
      
      this.watchedFiles.set(filePath, watcher);
      
      this.logger.debug('Started watching configuration file', {
        filePath
      });
      
    } catch (error) {
      this.logger.error('Failed to watch configuration file', {
        filePath,
        error
      });
    }
  }

  /**
   * Stop watching files
   */
  private stopFileWatching(): void {
    for (const [filePath, watcher] of this.watchedFiles) {
      try {
        watcher.close();
        this.logger.debug('Stopped watching configuration file', {
          filePath
        });
      } catch (error) {
        this.logger.error('Error stopping file watcher', {
          filePath,
          error
        });
      }
    }
    
    this.watchedFiles.clear();
  }

  /**
   * Shutdown the Configuration Manager
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down ConfigManager...');
      
      // Stop file watching
      this.stopFileWatching();
      
      // Clear data
      this.sources.clear();
      this.configHistory = [];
      
      this.isInitialized = false;
      
      this.logger.info('ConfigManager shutdown completed');
      
    } catch (error) {
      this.logger.error('Error during ConfigManager shutdown', { error });
      throw error;
    }
  }
}