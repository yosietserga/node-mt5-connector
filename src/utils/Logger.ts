/**
 * Logger - Structured logging utility with multiple levels and outputs
 */

import { EventEmitter } from 'eventemitter3';
import {
  LoggingConfig,
  LogLevel,
  LogOutput
} from '../types';
import { LOGGING, DEFAULTS } from '../constants';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';

interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  message: string;
  component?: string;
  metadata?: any;
  error?: Error;
  requestId?: string;
  sessionId?: string;
  userId?: string;
}

interface LoggerMetrics {
  totalLogs: number;
  logsByLevel: Map<LogLevel, number>;
  errorCount: number;
  warningCount: number;
  lastLogTime?: Date;
}

interface LogRotationConfig {
  maxSize: number; // in bytes
  maxFiles: number;
  compress: boolean;
}

/**
 * Logger Class
 */
export class Logger extends EventEmitter {
  private readonly config: LoggingConfig;
  private readonly component?: string;
  private readonly metadata: any;
  
  private static instances: Map<string, Logger> = new Map();
  private static rootLogger: Logger | null = null;
  
  private logMetrics: LoggerMetrics;
  private fileStreams: Map<string, fs.WriteStream> = new Map();
  private rotationConfig?: LogRotationConfig;
  
  // Log queue for async processing
  private logQueue: LogEntry[] = [];
  private isProcessing: boolean = false;
  private processingTimer: NodeJS.Timeout | null = null;

  constructor(
    config: LoggingConfig,
    component?: string,
    metadata: any = {}
  ) {
    super();

    this.config = config;
    this.component = component;
    this.metadata = metadata;
    
    // Initialize metrics
    this.logMetrics = {
      totalLogs: 0,
      logsByLevel: new Map(),
      errorCount: 0,
      warningCount: 0
    };
    
    // Initialize log levels count
    for (const level of Object.values(LogLevel)) {
      this.logMetrics.logsByLevel.set(level, 0);
    }
    
    // Setup file rotation if configured
    if (config.rotation) {
      this.rotationConfig = {
        maxSize: config.rotation.maxSize || 10 * 1024 * 1024, // 10MB
        maxFiles: config.rotation.maxFiles || 5,
        compress: config.rotation.compress || false
      };
    }
    
    // Start async processing
    this.startAsyncProcessing();
  }

  /**
   * Get or create root logger
   */
  static getLogger(config?: LoggingConfig): Logger {
    if (!Logger.rootLogger) {
      const defaultConfig: LoggingConfig = {
        level: LogLevel.INFO,
        outputs: [LogOutput.CONSOLE],
        format: 'json',
        enabled: true
      };
      
      Logger.rootLogger = new Logger(config || defaultConfig);
    }
    
    return Logger.rootLogger;
  }

  /**
   * Create child logger with component context
   */
  child(context: { component?: string; [key: string]: any }): Logger {
    const childMetadata = { ...this.metadata, ...context };
    const childComponent = context.component || this.component;
    
    const childKey = `${childComponent || 'default'}:${JSON.stringify(childMetadata)}`;
    
    if (!Logger.instances.has(childKey)) {
      const childLogger = new Logger(this.config, childComponent, childMetadata);
      Logger.instances.set(childKey, childLogger);
    }
    
    return Logger.instances.get(childKey)!;
  }

  /**
   * Log debug message
   */
  debug(message: string, metadata?: any): void {
    this.log(LogLevel.DEBUG, message, metadata);
  }

  /**
   * Log info message
   */
  info(message: string, metadata?: any): void {
    this.log(LogLevel.INFO, message, metadata);
  }

  /**
   * Log warning message
   */
  warn(message: string, metadata?: any): void {
    this.log(LogLevel.WARN, message, metadata);
  }

  /**
   * Log error message
   */
  error(message: string, error?: Error | any, metadata?: any): void {
    let errorObj: Error | undefined;
    let metadataObj = metadata;
    
    if (error instanceof Error) {
      errorObj = error;
    } else if (error && typeof error === 'object') {
      metadataObj = { ...error, ...metadata };
    }
    
    this.log(LogLevel.ERROR, message, metadataObj, errorObj);
  }

  /**
   * Log fatal message
   */
  fatal(message: string, error?: Error | any, metadata?: any): void {
    let errorObj: Error | undefined;
    let metadataObj = metadata;
    
    if (error instanceof Error) {
      errorObj = error;
    } else if (error && typeof error === 'object') {
      metadataObj = { ...error, ...metadata };
    }
    
    this.log(LogLevel.FATAL, message, metadataObj, errorObj);
  }

  /**
   * Core logging method
   */
  private log(
    level: LogLevel,
    message: string,
    metadata?: any,
    error?: Error
  ): void {
    if (!this.config.enabled || !this.shouldLog(level)) {
      return;
    }

    const logEntry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      component: this.component,
      metadata: { ...this.metadata, ...metadata },
      error,
      requestId: this.extractFromMetadata('requestId', metadata),
      sessionId: this.extractFromMetadata('sessionId', metadata),
      userId: this.extractFromMetadata('userId', metadata)
    };
    
    // Update metrics
    this.updateMetrics(logEntry);
    
    // Add to queue for async processing
    this.logQueue.push(logEntry);
    
    // Emit log event
    this.emit('log', logEntry);
    
    // For fatal errors, process immediately
    if (level === LogLevel.FATAL) {
      this.processLogQueue();
    }
  }

  /**
   * Check if log level should be logged
   */
  private shouldLog(level: LogLevel): boolean {
    const levelPriority = this.getLevelPriority(level);
    const configPriority = this.getLevelPriority(this.config.level);
    
    return levelPriority >= configPriority;
  }

  /**
   * Get log level priority
   */
  private getLevelPriority(level: LogLevel): number {
    const priorities = {
      [LogLevel.DEBUG]: 0,
      [LogLevel.INFO]: 1,
      [LogLevel.WARN]: 2,
      [LogLevel.ERROR]: 3,
      [LogLevel.FATAL]: 4
    };
    
    return priorities[level] || 0;
  }

  /**
   * Update logging metrics
   */
  private updateMetrics(logEntry: LogEntry): void {
    this.logMetrics.totalLogs++;
    this.logMetrics.lastLogTime = logEntry.timestamp;
    
    const currentCount = this.logMetrics.logsByLevel.get(logEntry.level) || 0;
    this.logMetrics.logsByLevel.set(logEntry.level, currentCount + 1);
    
    if (logEntry.level === LogLevel.ERROR || logEntry.level === LogLevel.FATAL) {
      this.logMetrics.errorCount++;
    }
    
    if (logEntry.level === LogLevel.WARN) {
      this.logMetrics.warningCount++;
    }
  }

  /**
   * Extract value from metadata
   */
  private extractFromMetadata(key: string, metadata?: any): string | undefined {
    if (metadata && typeof metadata === 'object' && metadata[key]) {
      return metadata[key];
    }
    
    if (this.metadata && this.metadata[key]) {
      return this.metadata[key];
    }
    
    return undefined;
  }

  /**
   * Start async log processing
   */
  private startAsyncProcessing(): void {
    this.processingTimer = setInterval(() => {
      if (!this.isProcessing && this.logQueue.length > 0) {
        this.processLogQueue();
      }
    }, DEFAULTS.LOGGING.PROCESSING_INTERVAL);
  }

  /**
   * Stop async log processing
   */
  private stopAsyncProcessing(): void {
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }
  }

  /**
   * Process log queue
   */
  private async processLogQueue(): Promise<void> {
    if (this.isProcessing || this.logQueue.length === 0) {
      return;
    }
    
    this.isProcessing = true;
    
    try {
      const logsToProcess = [...this.logQueue];
      this.logQueue = [];
      
      for (const logEntry of logsToProcess) {
        await this.writeLog(logEntry);
      }
      
    } catch (error) {
      // Fallback to console if logging fails
      console.error('Logger processing failed:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Write log entry to configured outputs
   */
  private async writeLog(logEntry: LogEntry): Promise<void> {
    const formattedLog = this.formatLog(logEntry);
    
    for (const output of this.config.outputs) {
      try {
        switch (output) {
          case LogOutput.CONSOLE:
            this.writeToConsole(logEntry, formattedLog);
            break;
            
          case LogOutput.FILE:
            await this.writeToFile(formattedLog);
            break;
            
          case LogOutput.SYSLOG:
            await this.writeToSyslog(logEntry, formattedLog);
            break;
            
          case LogOutput.HTTP:
            await this.writeToHttp(logEntry, formattedLog);
            break;
        }
      } catch (error) {
        // Fallback to console for failed outputs
        console.error(`Failed to write to ${output}:`, error);
        console.log(formattedLog);
      }
    }
  }

  /**
   * Format log entry
   */
  private formatLog(logEntry: LogEntry): string {
    switch (this.config.format) {
      case 'json':
        return this.formatAsJson(logEntry);
        
      case 'text':
        return this.formatAsText(logEntry);
        
      case 'structured':
        return this.formatAsStructured(logEntry);
        
      default:
        return this.formatAsJson(logEntry);
    }
  }

  /**
   * Format as JSON
   */
  private formatAsJson(logEntry: LogEntry): string {
    const jsonEntry: any = {
      timestamp: logEntry.timestamp.toISOString(),
      level: logEntry.level,
      message: logEntry.message
    };
    
    if (logEntry.component) {
      jsonEntry.component = logEntry.component;
    }
    
    if (logEntry.metadata && Object.keys(logEntry.metadata).length > 0) {
      jsonEntry.metadata = logEntry.metadata;
    }
    
    if (logEntry.error) {
      jsonEntry.error = {
        name: logEntry.error.name,
        message: logEntry.error.message,
        stack: logEntry.error.stack
      };
    }
    
    if (logEntry.requestId) {
      jsonEntry.requestId = logEntry.requestId;
    }
    
    if (logEntry.sessionId) {
      jsonEntry.sessionId = logEntry.sessionId;
    }
    
    if (logEntry.userId) {
      jsonEntry.userId = logEntry.userId;
    }
    
    return JSON.stringify(jsonEntry);
  }

  /**
   * Format as text
   */
  private formatAsText(logEntry: LogEntry): string {
    const timestamp = logEntry.timestamp.toISOString();
    const level = logEntry.level.toUpperCase().padEnd(5);
    const component = logEntry.component ? `[${logEntry.component}]` : '';
    const message = logEntry.message;
    
    let formatted = `${timestamp} ${level} ${component} ${message}`;
    
    if (logEntry.metadata && Object.keys(logEntry.metadata).length > 0) {
      formatted += ` ${util.inspect(logEntry.metadata, { compact: true })}`;
    }
    
    if (logEntry.error) {
      formatted += `\n${logEntry.error.stack || logEntry.error.message}`;
    }
    
    return formatted;
  }

  /**
   * Format as structured
   */
  private formatAsStructured(logEntry: LogEntry): string {
    const parts = [
      `time=${logEntry.timestamp.toISOString()}`,
      `level=${logEntry.level}`,
      `msg="${logEntry.message}"`
    ];
    
    if (logEntry.component) {
      parts.push(`component=${logEntry.component}`);
    }
    
    if (logEntry.requestId) {
      parts.push(`request_id=${logEntry.requestId}`);
    }
    
    if (logEntry.sessionId) {
      parts.push(`session_id=${logEntry.sessionId}`);
    }
    
    if (logEntry.userId) {
      parts.push(`user_id=${logEntry.userId}`);
    }
    
    if (logEntry.metadata) {
      for (const [key, value] of Object.entries(logEntry.metadata)) {
        if (typeof value === 'string') {
          parts.push(`${key}="${value}"`);
        } else {
          parts.push(`${key}=${JSON.stringify(value)}`);
        }
      }
    }
    
    if (logEntry.error) {
      parts.push(`error="${logEntry.error.message}"`);
    }
    
    return parts.join(' ');
  }

  /**
   * Write to console
   */
  private writeToConsole(logEntry: LogEntry, formattedLog: string): void {
    switch (logEntry.level) {
      case LogLevel.DEBUG:
        console.debug(formattedLog);
        break;
        
      case LogLevel.INFO:
        console.info(formattedLog);
        break;
        
      case LogLevel.WARN:
        console.warn(formattedLog);
        break;
        
      case LogLevel.ERROR:
      case LogLevel.FATAL:
        console.error(formattedLog);
        break;
        
      default:
        console.log(formattedLog);
    }
  }

  /**
   * Write to file
   */
  private async writeToFile(formattedLog: string): Promise<void> {
    if (!this.config.file) {
      throw new Error('File output configured but no file path specified');
    }
    
    const filePath = this.config.file.path;
    const fileName = path.basename(filePath);
    
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // Check if rotation is needed
    if (this.rotationConfig && fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.size >= this.rotationConfig.maxSize) {
        await this.rotateLogFile(filePath);
      }
    }
    
    // Get or create file stream
    let stream = this.fileStreams.get(fileName);
    if (!stream) {
      stream = fs.createWriteStream(filePath, { flags: 'a' });
      this.fileStreams.set(fileName, stream);
    }
    
    // Write log
    return new Promise((resolve, reject) => {
      stream!.write(formattedLog + '\n', (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Rotate log file
   */
  private async rotateLogFile(filePath: string): Promise<void> {
    if (!this.rotationConfig) {
      return;
    }
    
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);
    
    // Close existing stream
    const fileName = path.basename(filePath);
    const stream = this.fileStreams.get(fileName);
    if (stream) {
      stream.end();
      this.fileStreams.delete(fileName);
    }
    
    // Rotate existing files
    for (let i = this.rotationConfig.maxFiles - 1; i >= 1; i--) {
      const oldFile = path.join(dir, `${baseName}.${i}${ext}`);
      const newFile = path.join(dir, `${baseName}.${i + 1}${ext}`);
      
      if (fs.existsSync(oldFile)) {
        if (i === this.rotationConfig.maxFiles - 1) {
          // Delete oldest file
          fs.unlinkSync(oldFile);
        } else {
          // Rename file
          fs.renameSync(oldFile, newFile);
        }
      }
    }
    
    // Move current file to .1
    const rotatedFile = path.join(dir, `${baseName}.1${ext}`);
    fs.renameSync(filePath, rotatedFile);
    
    // Compress if configured
    if (this.rotationConfig.compress) {
      // Note: In a real implementation, you would use a compression library
      // For now, we'll just log that compression would happen
      this.info('Log file rotated and would be compressed', {
        originalFile: rotatedFile,
        compressedFile: `${rotatedFile}.gz`
      });
    }
  }

  /**
   * Write to syslog
   */
  private async writeToSyslog(logEntry: LogEntry, formattedLog: string): Promise<void> {
    // Note: In a real implementation, you would use a syslog library
    // For now, we'll just simulate syslog output
    console.log(`SYSLOG: ${formattedLog}`);
  }

  /**
   * Write to HTTP endpoint
   */
  private async writeToHttp(logEntry: LogEntry, formattedLog: string): Promise<void> {
    if (!this.config.http) {
      throw new Error('HTTP output configured but no HTTP config specified');
    }
    
    // Note: In a real implementation, you would use an HTTP client
    // For now, we'll just simulate HTTP output
    console.log(`HTTP[${this.config.http.url}]: ${formattedLog}`);
  }

  /**
   * Get logging metrics
   */
  getMetrics(): LoggerMetrics & {
    queueSize: number;
    isProcessing: boolean;
    component?: string;
  } {
    return {
      ...this.logMetrics,
      queueSize: this.logQueue.length,
      isProcessing: this.isProcessing,
      component: this.component
    };
  }

  /**
   * Flush all pending logs
   */
  async flush(): Promise<void> {
    if (this.logQueue.length > 0) {
      await this.processLogQueue();
    }
    
    // Wait for any ongoing processing to complete
    while (this.isProcessing) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }

  /**
   * Set log level
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
    this.info('Log level changed', { newLevel: level });
  }

  /**
   * Enable/disable logging
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.info('Logging enabled state changed', { enabled });
  }

  /**
   * Shutdown logger
   */
  async shutdown(): Promise<void> {
    try {
      this.info('Shutting down logger...');
      
      // Stop async processing
      this.stopAsyncProcessing();
      
      // Flush remaining logs
      await this.flush();
      
      // Close file streams
      for (const [fileName, stream] of this.fileStreams) {
        stream.end();
        this.fileStreams.delete(fileName);
      }
      
      this.info('Logger shutdown completed');
      
    } catch (error) {
      console.error('Error during logger shutdown:', error);
      throw error;
    }
  }

  /**
   * Shutdown all loggers
   */
  static async shutdownAll(): Promise<void> {
    const shutdownPromises: Promise<void>[] = [];
    
    if (Logger.rootLogger) {
      shutdownPromises.push(Logger.rootLogger.shutdown());
    }
    
    for (const logger of Logger.instances.values()) {
      shutdownPromises.push(logger.shutdown());
    }
    
    await Promise.all(shutdownPromises);
    
    Logger.instances.clear();
    Logger.rootLogger = null;
  }
}