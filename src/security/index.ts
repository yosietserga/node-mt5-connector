/**
 * Security Module Exports
 * 
 * This module provides comprehensive security components for the MT5 Connector SDK,
 * including encryption, authentication, rate limiting, and security management.
 */

// Core Security Manager
export { SecurityManager } from './SecurityManager';

// Encryption
export { CurveEncryption } from './CurveEncryption';

// Authentication
export { AuthenticationManager } from './AuthenticationManager';

// Rate Limiting
export { RateLimiter } from './RateLimiter';

// Re-export security-related types
export {
  SecurityConfig,
  AuthenticationConfig,
  AuthenticationMethod,
  RateLimitConfig,
  RateLimitAlgorithm,
  EncryptionConfig
} from '../types';

// Re-export security-related errors
export {
  SecurityError,
  AuthenticationError,
  RateLimitError
} from '../core/errors';

// Re-export security constants
export {
  SECURITY,
  RATE_LIMITING
} from '../constants';