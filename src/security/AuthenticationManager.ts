/**
 * AuthenticationManager - Handles JWT authentication and user management
 */

import { EventEmitter } from 'eventemitter3';
import {
  AuthenticationConfig,
  AuthenticationMethod
} from '../types';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { SecurityError, ValidationError } from '../core/errors';
import { SECURITY, DEFAULTS } from '../constants';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

interface User {
  id: string;
  username: string;
  email?: string;
  passwordHash: string;
  permissions: string[];
  isActive: boolean;
  createdAt: Date;
  lastLoginAt?: Date;
  failedLoginAttempts: number;
  lockedUntil?: Date;
  metadata?: any;
}

interface AuthenticationResult {
  success: boolean;
  userId?: string;
  permissions?: string[];
  error?: string;
  requiresPasswordChange?: boolean;
}

interface TokenPayload {
  sessionId: string;
  userId: string;
  permissions: string[];
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
}

interface AuthenticationMetrics {
  totalAttempts: number;
  successfulAttempts: number;
  failedAttempts: number;
  lockedAccounts: number;
  activeTokens: number;
  tokenGenerations: number;
  tokenValidations: number;
}

/**
 * Authentication Manager
 */
export class AuthenticationManager extends EventEmitter {
  private readonly config: AuthenticationConfig;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  
  private isInitialized: boolean = false;
  private users: Map<string, User> = new Map();
  private activeTokens: Set<string> = new Set();
  private authMetrics: AuthenticationMetrics;
  
  // JWT configuration
  private jwtSecret: string;
  private jwtOptions: jwt.SignOptions;
  
  // Rate limiting for authentication attempts
  private attemptCounts: Map<string, { count: number; resetTime: number }> = new Map();
  
  // Cleanup timer
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    config: AuthenticationConfig,
    logger: Logger,
    metrics: MetricsCollector
  ) {
    super();

    this.config = config;
    this.logger = logger.child({ component: 'AuthenticationManager' });
    this.metrics = metrics;
    
    // Initialize JWT configuration
    this.jwtSecret = config.jwtSecret || this.generateSecret();
    this.jwtOptions = {
      issuer: config.issuer || 'mt5-connector',
      audience: config.audience || 'mt5-client',
      expiresIn: config.tokenExpiration || '1h',
      algorithm: 'HS256'
    };
    
    // Initialize metrics
    this.authMetrics = {
      totalAttempts: 0,
      successfulAttempts: 0,
      failedAttempts: 0,
      lockedAccounts: 0,
      activeTokens: 0,
      tokenGenerations: 0,
      tokenValidations: 0
    };

    this.logger.info('AuthenticationManager created', {
      enabled: config.enabled,
      method: config.method,
      tokenExpiration: config.tokenExpiration
    });
  }

  /**
   * Initialize the Authentication Manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('AuthenticationManager is already initialized');
    }

    if (!this.config.enabled) {
      this.logger.info('Authentication is disabled');
      this.isInitialized = true;
      return;
    }

    try {
      this.logger.info('Initializing AuthenticationManager...');
      this.metrics.startTimer('auth_manager_initialization');

      // Load users from configuration or database
      await this.loadUsers();
      
      // Start cleanup timer
      this.startCleanupTimer();
      
      this.isInitialized = true;
      this.metrics.endTimer('auth_manager_initialization');
      
      this.logger.info('AuthenticationManager initialized successfully', {
        userCount: this.users.size
      });
      
    } catch (error) {
      this.metrics.endTimer('auth_manager_initialization');
      this.logger.error('Failed to initialize AuthenticationManager', { error });
      throw error;
    }
  }

  /**
   * Authenticate user with credentials
   */
  async authenticate(credentials: {
    username?: string;
    email?: string;
    password?: string;
    apiKey?: string;
    token?: string;
  }): Promise<AuthenticationResult> {
    this.validateInitialized();
    this.validateEnabled();

    try {
      this.authMetrics.totalAttempts++;
      
      const identifier = credentials.username || credentials.email;
      if (!identifier) {
        throw new ValidationError('Username or email is required', 'credentials', credentials);
      }
      
      // Check rate limiting
      if (!this.checkRateLimit(identifier)) {
        this.authMetrics.failedAttempts++;
        this.logger.warn('Authentication rate limited', { identifier });
        return {
          success: false,
          error: 'Too many authentication attempts. Please try again later.'
        };
      }
      
      // Find user
      const user = this.findUser(identifier);
      if (!user) {
        this.authMetrics.failedAttempts++;
        this.recordFailedAttempt(identifier);
        this.logger.warn('User not found', { identifier });
        return {
          success: false,
          error: 'Invalid credentials'
        };
      }
      
      // Check if account is locked
      if (this.isAccountLocked(user)) {
        this.authMetrics.failedAttempts++;
        this.logger.warn('Account is locked', {
          userId: user.id,
          lockedUntil: user.lockedUntil
        });
        return {
          success: false,
          error: 'Account is temporarily locked due to too many failed attempts'
        };
      }
      
      // Check if account is active
      if (!user.isActive) {
        this.authMetrics.failedAttempts++;
        this.logger.warn('Account is inactive', { userId: user.id });
        return {
          success: false,
          error: 'Account is inactive'
        };
      }
      
      // Authenticate based on method
      let authSuccess = false;
      
      switch (this.config.method) {
        case 'password':
          if (!credentials.password) {
            throw new ValidationError('Password is required', 'password', credentials.password);
          }
          authSuccess = await this.verifyPassword(credentials.password, user.passwordHash);
          break;
          
        case 'api_key':
          if (!credentials.apiKey) {
            throw new ValidationError('API key is required', 'apiKey', credentials.apiKey);
          }
          authSuccess = await this.verifyApiKey(credentials.apiKey, user);
          break;
          
        case 'token':
          if (!credentials.token) {
            throw new ValidationError('Token is required', 'token', credentials.token);
          }
          authSuccess = await this.verifyToken(credentials.token);
          break;
          
        default:
          throw new SecurityError(`Unsupported authentication method: ${this.config.method}`, 'UNSUPPORTED_AUTH_METHOD');
      }
      
      if (!authSuccess) {
        this.authMetrics.failedAttempts++;
        this.recordFailedAttempt(identifier);
        this.incrementFailedLoginAttempts(user);
        
        this.logger.warn('Authentication failed', {
          userId: user.id,
          method: this.config.method
        });
        
        return {
          success: false,
          error: 'Invalid credentials'
        };
      }
      
      // Authentication successful
      this.authMetrics.successfulAttempts++;
      this.resetFailedLoginAttempts(user);
      this.clearRateLimit(identifier);
      
      // Update last login
      user.lastLoginAt = new Date();
      
      this.logger.info('Authentication successful', {
        userId: user.id,
        method: this.config.method
      });
      
      this.emit('userAuthenticated', {
        userId: user.id,
        username: user.username,
        permissions: user.permissions
      });
      
      return {
        success: true,
        userId: user.id,
        permissions: user.permissions
      };
      
    } catch (error) {
      this.authMetrics.failedAttempts++;
      this.logger.error('Authentication error', { error });
      throw error;
    }
  }

  /**
   * Generate JWT token
   */
  async generateToken(payload: {
    sessionId: string;
    userId: string;
    permissions: string[];
  }): Promise<string> {
    this.validateInitialized();
    this.validateEnabled();

    try {
      const tokenPayload: TokenPayload = {
        sessionId: payload.sessionId,
        userId: payload.userId,
        permissions: payload.permissions
      };
      
      const token = jwt.sign(tokenPayload, this.jwtSecret, this.jwtOptions);
      
      this.activeTokens.add(token);
      this.authMetrics.tokenGenerations++;
      this.authMetrics.activeTokens = this.activeTokens.size;
      
      this.logger.debug('JWT token generated', {
        userId: payload.userId,
        sessionId: payload.sessionId
      });
      
      this.metrics.recordMetric('jwt_tokens_generated', 1);
      
      return token;
      
    } catch (error) {
      this.logger.error('Failed to generate JWT token', { error });
      throw new SecurityError('Token generation failed', 'TOKEN_GENERATION_FAILED');
    }
  }

  /**
   * Validate JWT token
   */
  async validateToken(token: string): Promise<TokenPayload> {
    this.validateInitialized();
    this.validateEnabled();

    if (!token) {
      throw new ValidationError('Token is required', 'token', token);
    }

    try {
      this.authMetrics.tokenValidations++;
      
      // Check if token is in active tokens set
      if (!this.activeTokens.has(token)) {
        throw new SecurityError('Token is not active', 'TOKEN_NOT_ACTIVE');
      }
      
      const decoded = jwt.verify(token, this.jwtSecret, {
        issuer: this.jwtOptions.issuer,
        audience: this.jwtOptions.audience
      }) as TokenPayload;
      
      this.logger.debug('JWT token validated', {
        userId: decoded.userId,
        sessionId: decoded.sessionId
      });
      
      this.metrics.recordMetric('jwt_tokens_validated', 1);
      
      return decoded;
      
    } catch (error) {
      this.logger.error('JWT token validation failed', { error });
      
      if (error instanceof jwt.JsonWebTokenError) {
        throw new SecurityError('Invalid token', 'INVALID_TOKEN');
      } else if (error instanceof jwt.TokenExpiredError) {
        // Remove expired token from active set
        this.activeTokens.delete(token);
        this.authMetrics.activeTokens = this.activeTokens.size;
        throw new SecurityError('Token expired', 'TOKEN_EXPIRED');
      } else {
        throw error;
      }
    }
  }

  /**
   * Revoke JWT token
   */
  revokeToken(token: string): void {
    this.activeTokens.delete(token);
    this.authMetrics.activeTokens = this.activeTokens.size;
    
    this.logger.debug('JWT token revoked');
    this.metrics.recordMetric('jwt_tokens_revoked', 1);
  }

  /**
   * Create a new user
   */
  async createUser(userData: {
    username: string;
    email?: string;
    password?: string;
    permissions?: string[];
    metadata?: any;
  }): Promise<User> {
    this.validateInitialized();

    if (this.findUser(userData.username) || (userData.email && this.findUser(userData.email))) {
      throw new ValidationError('User already exists', 'username', userData.username);
    }

    try {
      const user: User = {
        id: uuidv4(),
        username: userData.username,
        email: userData.email,
        passwordHash: userData.password ? await this.hashPassword(userData.password) : '',
        permissions: userData.permissions || [],
        isActive: true,
        createdAt: new Date(),
        failedLoginAttempts: 0,
        metadata: userData.metadata
      };
      
      this.users.set(user.id, user);
      
      this.logger.info('User created', {
        userId: user.id,
        username: user.username
      });
      
      this.emit('userCreated', {
        userId: user.id,
        username: user.username
      });
      
      return user;
      
    } catch (error) {
      this.logger.error('Failed to create user', { error });
      throw error;
    }
  }

  /**
   * Update user
   */
  async updateUser(userId: string, updates: Partial<User>): Promise<User> {
    this.validateInitialized();

    const user = this.users.get(userId);
    if (!user) {
      throw new ValidationError('User not found', 'userId', userId);
    }

    try {
      // Hash password if provided
      if (updates.passwordHash && updates.passwordHash !== user.passwordHash) {
        updates.passwordHash = await this.hashPassword(updates.passwordHash);
      }
      
      // Update user
      Object.assign(user, updates);
      
      this.logger.info('User updated', {
        userId: user.id,
        username: user.username
      });
      
      this.emit('userUpdated', {
        userId: user.id,
        username: user.username
      });
      
      return user;
      
    } catch (error) {
      this.logger.error('Failed to update user', { error });
      throw error;
    }
  }

  /**
   * Delete user
   */
  deleteUser(userId: string): void {
    const user = this.users.get(userId);
    if (user) {
      this.users.delete(userId);
      
      this.logger.info('User deleted', {
        userId: user.id,
        username: user.username
      });
      
      this.emit('userDeleted', {
        userId: user.id,
        username: user.username
      });
    }
  }

  /**
   * Get user by ID
   */
  getUser(userId: string): User | undefined {
    return this.users.get(userId);
  }

  /**
   * Get all users
   */
  getUsers(): User[] {
    return Array.from(this.users.values());
  }

  /**
   * Get authentication metrics
   */
  getMetrics(): AuthenticationMetrics & {
    userCount: number;
    isInitialized: boolean;
    isEnabled: boolean;
  } {
    return {
      ...this.authMetrics,
      userCount: this.users.size,
      isInitialized: this.isInitialized,
      isEnabled: this.config.enabled
    };
  }

  /**
   * Hash password
   */
  private async hashPassword(password: string): Promise<string> {
    const saltRounds = this.config.bcryptRounds || 12;
    return await bcrypt.hash(password, saltRounds);
  }

  /**
   * Verify password
   */
  private async verifyPassword(password: string, hash: string): Promise<boolean> {
    return await bcrypt.compare(password, hash);
  }

  /**
   * Verify API key
   */
  private async verifyApiKey(apiKey: string, user: User): Promise<boolean> {
    // In a real implementation, this would check against stored API keys
    // For now, we'll use a simple hash comparison
    const expectedApiKey = crypto.createHash('sha256')
      .update(user.id + user.username)
      .digest('hex');
    
    return apiKey === expectedApiKey;
  }

  /**
   * Verify token (for token-based auth)
   */
  private async verifyToken(token: string): Promise<boolean> {
    try {
      await this.validateToken(token);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find user by username or email
   */
  private findUser(identifier: string): User | undefined {
    for (const user of this.users.values()) {
      if (user.username === identifier || user.email === identifier) {
        return user;
      }
    }
    return undefined;
  }

  /**
   * Check if account is locked
   */
  private isAccountLocked(user: User): boolean {
    if (!user.lockedUntil) {
      return false;
    }
    
    if (user.lockedUntil > new Date()) {
      return true;
    }
    
    // Unlock account if lock period has expired
    user.lockedUntil = undefined;
    user.failedLoginAttempts = 0;
    this.authMetrics.lockedAccounts--;
    
    return false;
  }

  /**
   * Increment failed login attempts
   */
  private incrementFailedLoginAttempts(user: User): void {
    user.failedLoginAttempts++;
    
    const maxAttempts = this.config.maxLoginAttempts || 5;
    const lockDuration = this.config.accountLockDuration || 15 * 60 * 1000; // 15 minutes
    
    if (user.failedLoginAttempts >= maxAttempts) {
      user.lockedUntil = new Date(Date.now() + lockDuration);
      this.authMetrics.lockedAccounts++;
      
      this.logger.warn('Account locked due to too many failed attempts', {
        userId: user.id,
        failedAttempts: user.failedLoginAttempts,
        lockedUntil: user.lockedUntil
      });
      
      this.emit('accountLocked', {
        userId: user.id,
        username: user.username,
        lockedUntil: user.lockedUntil
      });
    }
  }

  /**
   * Reset failed login attempts
   */
  private resetFailedLoginAttempts(user: User): void {
    if (user.failedLoginAttempts > 0) {
      user.failedLoginAttempts = 0;
      user.lockedUntil = undefined;
    }
  }

  /**
   * Check rate limiting
   */
  private checkRateLimit(identifier: string): boolean {
    const now = Date.now();
    const windowSize = 15 * 60 * 1000; // 15 minutes
    const maxAttempts = 10;
    
    const attempts = this.attemptCounts.get(identifier);
    
    if (!attempts) {
      return true;
    }
    
    if (now > attempts.resetTime) {
      this.attemptCounts.delete(identifier);
      return true;
    }
    
    return attempts.count < maxAttempts;
  }

  /**
   * Record failed attempt
   */
  private recordFailedAttempt(identifier: string): void {
    const now = Date.now();
    const windowSize = 15 * 60 * 1000; // 15 minutes
    
    const attempts = this.attemptCounts.get(identifier);
    
    if (!attempts || now > attempts.resetTime) {
      this.attemptCounts.set(identifier, {
        count: 1,
        resetTime: now + windowSize
      });
    } else {
      attempts.count++;
    }
  }

  /**
   * Clear rate limit
   */
  private clearRateLimit(identifier: string): void {
    this.attemptCounts.delete(identifier);
  }

  /**
   * Load users from configuration
   */
  private async loadUsers(): Promise<void> {
    try {
      // Load default users from configuration
      if (this.config.defaultUsers) {
        for (const userData of this.config.defaultUsers) {
          await this.createUser(userData);
        }
      }
      
      // Create default admin user if no users exist
      if (this.users.size === 0) {
        await this.createUser({
          username: 'admin',
          password: 'admin123',
          permissions: ['*'],
          metadata: { isDefault: true }
        });
        
        this.logger.warn('Created default admin user with password "admin123". Please change this password!');
      }
      
    } catch (error) {
      this.logger.error('Failed to load users', { error });
      throw error;
    }
  }

  /**
   * Generate secret for JWT
   */
  private generateSecret(): string {
    return crypto.randomBytes(64).toString('hex');
  }

  /**
   * Start cleanup timer
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, DEFAULTS.SECURITY.AUTH_CLEANUP_INTERVAL);
    
    this.logger.debug('Authentication cleanup timer started');
  }

  /**
   * Stop cleanup timer
   */
  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      this.logger.debug('Authentication cleanup timer stopped');
    }
  }

  /**
   * Cleanup expired data
   */
  private cleanup(): void {
    const now = Date.now();
    
    // Clean up rate limit attempts
    for (const [identifier, attempts] of this.attemptCounts) {
      if (now > attempts.resetTime) {
        this.attemptCounts.delete(identifier);
      }
    }
    
    // Clean up expired account locks
    for (const user of this.users.values()) {
      if (user.lockedUntil && user.lockedUntil < new Date()) {
        user.lockedUntil = undefined;
        user.failedLoginAttempts = 0;
        this.authMetrics.lockedAccounts--;
      }
    }
  }

  /**
   * Validate that AuthenticationManager is initialized
   */
  private validateInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('AuthenticationManager is not initialized');
    }
  }

  /**
   * Validate that authentication is enabled
   */
  private validateEnabled(): void {
    if (!this.config.enabled) {
      throw new SecurityError('Authentication is disabled', 'AUTHENTICATION_DISABLED');
    }
  }

  /**
   * Shutdown the Authentication Manager
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down AuthenticationManager...');
      
      // Stop cleanup timer
      this.stopCleanupTimer();
      
      // Clear active tokens
      this.activeTokens.clear();
      
      // Clear attempt counts
      this.attemptCounts.clear();
      
      // Clear users (in production, this might persist to database)
      this.users.clear();
      
      this.isInitialized = false;
      
      this.logger.info('AuthenticationManager shutdown completed');
      
    } catch (error) {
      this.logger.error('Error during AuthenticationManager shutdown', { error });
      throw error;
    }
  }
}