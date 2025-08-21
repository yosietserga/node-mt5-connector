/**
 * SecurityManager - Central security management for the MT5 Connector
 */

import { EventEmitter } from 'eventemitter3';
import {
  SecurityConfig,
  SecurityLevel,
  EncryptionAlgorithm
} from '../types';
import { CurveEncryption } from './CurveEncryption';
import { AuthenticationManager } from './AuthenticationManager';
import { RateLimiter } from './RateLimiter';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { SecurityError, ValidationError } from '../core/errors';
import { SECURITY, DEFAULTS } from '../constants';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';

interface SecuritySession {
  sessionId: string;
  userId: string;
  createdAt: Date;
  lastActivity: Date;
  ipAddress?: string;
  userAgent?: string;
  permissions: string[];
  isActive: boolean;
  expiresAt: Date;
}

interface SecurityAuditLog {
  id: string;
  timestamp: Date;
  event: string;
  userId?: string;
  sessionId?: string;
  ipAddress?: string;
  success: boolean;
  details: any;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

interface SecurityMetrics {
  totalSessions: number;
  activeSessions: number;
  failedAuthentications: number;
  successfulAuthentications: number;
  encryptionOperations: number;
  rateLimitViolations: number;
  securityViolations: number;
}

/**
 * Central Security Manager
 */
export class SecurityManager extends EventEmitter {
  private readonly config: SecurityConfig;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  
  private readonly curveEncryption: CurveEncryption;
  private readonly authManager: AuthenticationManager;
  private readonly rateLimiter: RateLimiter;
  
  private isInitialized: boolean = false;
  private sessions: Map<string, SecuritySession> = new Map();
  private auditLogs: SecurityAuditLog[] = [];
  private securityMetrics: SecurityMetrics;
  
  // Security keys and certificates
  private serverKeys: { publicKey: Buffer; privateKey: Buffer } | null = null;
  private trustedClients: Set<string> = new Set();
  
  // Cleanup timers
  private sessionCleanupTimer: NodeJS.Timeout | null = null;
  private auditCleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    config: SecurityConfig,
    logger: Logger,
    metrics: MetricsCollector
  ) {
    super();

    this.config = config;
    this.logger = logger.child({ component: 'SecurityManager' });
    this.metrics = metrics;
    
    // Initialize security components
    this.curveEncryption = new CurveEncryption(config.curve, logger, metrics);
    this.authManager = new AuthenticationManager(config.authentication, logger, metrics);
    this.rateLimiter = new RateLimiter(config.rateLimiting, logger, metrics);
    
    // Initialize metrics
    this.securityMetrics = {
      totalSessions: 0,
      activeSessions: 0,
      failedAuthentications: 0,
      successfulAuthentications: 0,
      encryptionOperations: 0,
      rateLimitViolations: 0,
      securityViolations: 0
    };

    this.logger.info('SecurityManager created', {
      securityLevel: config.level,
      encryptionEnabled: config.curve.enabled,
      authenticationEnabled: config.authentication.enabled,
      rateLimitingEnabled: config.rateLimiting.enabled
    });
  }

  /**
   * Initialize the Security Manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('SecurityManager is already initialized');
    }

    try {
      this.logger.info('Initializing SecurityManager...');
      this.metrics.startTimer('security_manager_initialization');

      // Initialize security components
      await this.curveEncryption.initialize();
      await this.authManager.initialize();
      await this.rateLimiter.initialize();
      
      // Generate server keys if encryption is enabled
      if (this.config.curve.enabled) {
        await this.generateServerKeys();
      }
      
      // Load trusted clients
      await this.loadTrustedClients();
      
      // Start cleanup timers
      this.startCleanupTimers();
      
      this.isInitialized = true;
      this.metrics.endTimer('security_manager_initialization');
      
      this.logger.info('SecurityManager initialized successfully');
      
    } catch (error) {
      this.metrics.endTimer('security_manager_initialization');
      this.logger.error('Failed to initialize SecurityManager', { error });
      throw error;
    }
  }

  /**
   * Authenticate a user and create a session
   */
  async authenticate(
    credentials: any,
    clientInfo?: {
      ipAddress?: string;
      userAgent?: string;
    }
  ): Promise<{
    sessionId: string;
    token: string;
    expiresAt: Date;
    permissions: string[];
  }> {
    this.validateInitialized();

    try {
      this.logger.debug('Authenticating user', {
        ipAddress: clientInfo?.ipAddress
      });
      
      // Check rate limiting
      const rateLimitKey = `auth:${clientInfo?.ipAddress || 'unknown'}`;
      if (!await this.rateLimiter.checkLimit(rateLimitKey)) {
        this.securityMetrics.rateLimitViolations++;
        this.auditLog('authentication_rate_limited', undefined, undefined, clientInfo?.ipAddress, false, {
          rateLimitKey
        }, 'medium');
        throw new SecurityError('Authentication rate limit exceeded', 'RATE_LIMIT_EXCEEDED');
      }
      
      // Authenticate with AuthenticationManager
      const authResult = await this.authManager.authenticate(credentials);
      
      if (!authResult.success) {
        this.securityMetrics.failedAuthentications++;
        this.auditLog('authentication_failed', authResult.userId, undefined, clientInfo?.ipAddress, false, {
          reason: authResult.error
        }, 'high');
        throw new SecurityError(authResult.error || 'Authentication failed', 'AUTHENTICATION_FAILED');
      }
      
      // Create session
      const sessionId = uuidv4();
      const expiresAt = new Date(Date.now() + this.config.authentication.sessionTimeout);
      
      const session: SecuritySession = {
        sessionId,
        userId: authResult.userId!,
        createdAt: new Date(),
        lastActivity: new Date(),
        ipAddress: clientInfo?.ipAddress,
        userAgent: clientInfo?.userAgent,
        permissions: authResult.permissions || [],
        isActive: true,
        expiresAt
      };
      
      this.sessions.set(sessionId, session);
      
      // Generate JWT token
      const token = await this.authManager.generateToken({
        sessionId,
        userId: authResult.userId!,
        permissions: authResult.permissions || []
      });
      
      this.securityMetrics.successfulAuthentications++;
      this.securityMetrics.totalSessions++;
      this.securityMetrics.activeSessions++;
      
      this.auditLog('authentication_success', authResult.userId, sessionId, clientInfo?.ipAddress, true, {
        permissions: authResult.permissions
      }, 'low');
      
      this.logger.info('User authenticated successfully', {
        userId: authResult.userId,
        sessionId,
        permissions: authResult.permissions
      });
      
      this.emit('userAuthenticated', {
        userId: authResult.userId,
        sessionId,
        permissions: authResult.permissions
      });
      
      return {
        sessionId,
        token,
        expiresAt,
        permissions: authResult.permissions || []
      };
      
    } catch (error) {
      this.logger.error('Authentication failed', { error });
      throw error;
    }
  }

  /**
   * Validate a session
   */
  async validateSession(sessionId: string, token?: string): Promise<SecuritySession> {
    this.validateInitialized();

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SecurityError('Session not found', 'SESSION_NOT_FOUND');
    }

    if (!session.isActive) {
      throw new SecurityError('Session is inactive', 'SESSION_INACTIVE');
    }

    if (session.expiresAt < new Date()) {
      this.invalidateSession(sessionId);
      throw new SecurityError('Session expired', 'SESSION_EXPIRED');
    }

    // Validate token if provided
    if (token) {
      try {
        const tokenPayload = await this.authManager.validateToken(token);
        if (tokenPayload.sessionId !== sessionId) {
          throw new SecurityError('Token session mismatch', 'TOKEN_SESSION_MISMATCH');
        }
      } catch (error) {
        this.auditLog('token_validation_failed', session.userId, sessionId, session.ipAddress, false, {
          error: error.message
        }, 'high');
        throw new SecurityError('Invalid token', 'INVALID_TOKEN');
      }
    }

    // Update last activity
    session.lastActivity = new Date();
    
    return session;
  }

  /**
   * Check if user has permission
   */
  async checkPermission(sessionId: string, permission: string): Promise<boolean> {
    const session = await this.validateSession(sessionId);
    return session.permissions.includes(permission) || session.permissions.includes('*');
  }

  /**
   * Invalidate a session
   */
  invalidateSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.isActive = false;
      this.sessions.delete(sessionId);
      this.securityMetrics.activeSessions--;
      
      this.auditLog('session_invalidated', session.userId, sessionId, session.ipAddress, true, {}, 'low');
      
      this.logger.debug('Session invalidated', {
        sessionId,
        userId: session.userId
      });
      
      this.emit('sessionInvalidated', { sessionId, userId: session.userId });
    }
  }

  /**
   * Encrypt data
   */
  async encrypt(data: Buffer, recipientPublicKey?: Buffer): Promise<Buffer> {
    this.validateInitialized();
    
    if (!this.config.curve.enabled) {
      return data; // Return unencrypted if encryption is disabled
    }
    
    try {
      const encrypted = await this.curveEncryption.encrypt(data, recipientPublicKey);
      this.securityMetrics.encryptionOperations++;
      return encrypted;
    } catch (error) {
      this.logger.error('Encryption failed', { error });
      throw new SecurityError('Encryption failed', 'ENCRYPTION_FAILED');
    }
  }

  /**
   * Decrypt data
   */
  async decrypt(encryptedData: Buffer, senderPublicKey?: Buffer): Promise<Buffer> {
    this.validateInitialized();
    
    if (!this.config.curve.enabled) {
      return encryptedData; // Return as-is if encryption is disabled
    }
    
    try {
      const decrypted = await this.curveEncryption.decrypt(encryptedData, senderPublicKey);
      this.securityMetrics.encryptionOperations++;
      return decrypted;
    } catch (error) {
      this.logger.error('Decryption failed', { error });
      throw new SecurityError('Decryption failed', 'DECRYPTION_FAILED');
    }
  }

  /**
   * Get server public key
   */
  getServerPublicKey(): Buffer | null {
    return this.serverKeys?.publicKey || null;
  }

  /**
   * Add trusted client
   */
  addTrustedClient(clientPublicKey: string): void {
    this.trustedClients.add(clientPublicKey);
    this.logger.debug('Trusted client added', { clientPublicKey });
  }

  /**
   * Remove trusted client
   */
  removeTrustedClient(clientPublicKey: string): void {
    this.trustedClients.delete(clientPublicKey);
    this.logger.debug('Trusted client removed', { clientPublicKey });
  }

  /**
   * Check if client is trusted
   */
  isTrustedClient(clientPublicKey: string): boolean {
    return this.trustedClients.has(clientPublicKey);
  }

  /**
   * Get security metrics
   */
  getSecurityMetrics(): SecurityMetrics & {
    auditLogCount: number;
    trustedClientsCount: number;
    isInitialized: boolean;
  } {
    return {
      ...this.securityMetrics,
      auditLogCount: this.auditLogs.length,
      trustedClientsCount: this.trustedClients.size,
      isInitialized: this.isInitialized
    };
  }

  /**
   * Get audit logs
   */
  getAuditLogs(limit?: number, filter?: {
    userId?: string;
    sessionId?: string;
    event?: string;
    riskLevel?: string;
    startDate?: Date;
    endDate?: Date;
  }): SecurityAuditLog[] {
    let logs = [...this.auditLogs];
    
    // Apply filters
    if (filter) {
      if (filter.userId) {
        logs = logs.filter(log => log.userId === filter.userId);
      }
      if (filter.sessionId) {
        logs = logs.filter(log => log.sessionId === filter.sessionId);
      }
      if (filter.event) {
        logs = logs.filter(log => log.event === filter.event);
      }
      if (filter.riskLevel) {
        logs = logs.filter(log => log.riskLevel === filter.riskLevel);
      }
      if (filter.startDate) {
        logs = logs.filter(log => log.timestamp >= filter.startDate!);
      }
      if (filter.endDate) {
        logs = logs.filter(log => log.timestamp <= filter.endDate!);
      }
    }
    
    // Sort by timestamp (newest first)
    logs.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    
    // Apply limit
    if (limit) {
      logs = logs.slice(0, limit);
    }
    
    return logs;
  }

  /**
   * Get active sessions
   */
  getActiveSessions(): SecuritySession[] {
    return Array.from(this.sessions.values()).filter(session => session.isActive);
  }

  /**
   * Generate server keys
   */
  private async generateServerKeys(): Promise<void> {
    try {
      this.logger.debug('Generating server keys...');
      
      // Check if keys are provided in config
      if (this.config.curve.serverPublicKey && this.config.curve.serverPrivateKey) {
        this.serverKeys = {
          publicKey: Buffer.from(this.config.curve.serverPublicKey, 'base64'),
          privateKey: Buffer.from(this.config.curve.serverPrivateKey, 'base64')
        };
        this.logger.debug('Server keys loaded from configuration');
      } else {
        // Generate new keys
        this.serverKeys = await this.curveEncryption.generateKeyPair();
        this.logger.info('New server keys generated', {
          publicKey: this.serverKeys.publicKey.toString('base64')
        });
      }
      
    } catch (error) {
      this.logger.error('Failed to generate server keys', { error });
      throw error;
    }
  }

  /**
   * Load trusted clients
   */
  private async loadTrustedClients(): Promise<void> {
    try {
      if (this.config.curve.trustedClients) {
        for (const clientKey of this.config.curve.trustedClients) {
          this.trustedClients.add(clientKey);
        }
        this.logger.debug('Trusted clients loaded', {
          count: this.trustedClients.size
        });
      }
    } catch (error) {
      this.logger.error('Failed to load trusted clients', { error });
      throw error;
    }
  }

  /**
   * Start cleanup timers
   */
  private startCleanupTimers(): void {
    // Session cleanup timer
    this.sessionCleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, DEFAULTS.SECURITY.SESSION_CLEANUP_INTERVAL);
    
    // Audit log cleanup timer
    this.auditCleanupTimer = setInterval(() => {
      this.cleanupOldAuditLogs();
    }, DEFAULTS.SECURITY.AUDIT_CLEANUP_INTERVAL);
    
    this.logger.debug('Cleanup timers started');
  }

  /**
   * Stop cleanup timers
   */
  private stopCleanupTimers(): void {
    if (this.sessionCleanupTimer) {
      clearInterval(this.sessionCleanupTimer);
      this.sessionCleanupTimer = null;
    }
    
    if (this.auditCleanupTimer) {
      clearInterval(this.auditCleanupTimer);
      this.auditCleanupTimer = null;
    }
    
    this.logger.debug('Cleanup timers stopped');
  }

  /**
   * Clean up expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = new Date();
    let cleanedCount = 0;
    
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt < now || !session.isActive) {
        this.sessions.delete(sessionId);
        this.securityMetrics.activeSessions--;
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      this.logger.debug('Expired sessions cleaned up', { count: cleanedCount });
    }
  }

  /**
   * Clean up old audit logs
   */
  private cleanupOldAuditLogs(): void {
    const maxAge = DEFAULTS.SECURITY.AUDIT_LOG_RETENTION;
    const cutoffDate = new Date(Date.now() - maxAge);
    
    const initialCount = this.auditLogs.length;
    this.auditLogs = this.auditLogs.filter(log => log.timestamp > cutoffDate);
    
    const cleanedCount = initialCount - this.auditLogs.length;
    if (cleanedCount > 0) {
      this.logger.debug('Old audit logs cleaned up', { count: cleanedCount });
    }
  }

  /**
   * Add audit log entry
   */
  private auditLog(
    event: string,
    userId?: string,
    sessionId?: string,
    ipAddress?: string,
    success: boolean = true,
    details: any = {},
    riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'low'
  ): void {
    const logEntry: SecurityAuditLog = {
      id: uuidv4(),
      timestamp: new Date(),
      event,
      userId,
      sessionId,
      ipAddress,
      success,
      details,
      riskLevel
    };
    
    this.auditLogs.push(logEntry);
    
    // Emit security event
    this.emit('securityEvent', logEntry);
    
    // Log high-risk events
    if (riskLevel === 'high' || riskLevel === 'critical') {
      this.logger.warn('High-risk security event', logEntry);
      this.securityMetrics.securityViolations++;
    }
  }

  /**
   * Validate that SecurityManager is initialized
   */
  private validateInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('SecurityManager is not initialized');
    }
  }

  /**
   * Shutdown the Security Manager
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down SecurityManager...');
      
      // Stop cleanup timers
      this.stopCleanupTimers();
      
      // Shutdown security components
      await this.curveEncryption.shutdown();
      await this.authManager.shutdown();
      await this.rateLimiter.shutdown();
      
      // Clear sessions
      this.sessions.clear();
      
      // Clear trusted clients
      this.trustedClients.clear();
      
      this.isInitialized = false;
      
      this.logger.info('SecurityManager shutdown completed');
      
    } catch (error) {
      this.logger.error('Error during SecurityManager shutdown', { error });
      throw error;
    }
  }
}