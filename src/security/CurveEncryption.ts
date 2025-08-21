/**
 * CurveEncryption - CURVE25519 encryption implementation for secure communication
 */

import { EventEmitter } from 'eventemitter3';
import {
  CurveConfig,
  EncryptionAlgorithm
} from '../types';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { SecurityError, ValidationError } from '../core/errors';
import { SECURITY } from '../constants';
import * as sodium from 'libsodium-wrappers';
import * as crypto from 'crypto';

interface KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

interface EncryptedMessage {
  nonce: Buffer;
  ciphertext: Buffer;
  publicKey?: Buffer;
}

interface EncryptionMetrics {
  encryptionCount: number;
  decryptionCount: number;
  keyGenerationCount: number;
  errorCount: number;
  averageEncryptionTime: number;
  averageDecryptionTime: number;
}

/**
 * CURVE25519 Encryption Manager
 */
export class CurveEncryption extends EventEmitter {
  private readonly config: CurveConfig;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  
  private isInitialized: boolean = false;
  private keyPair: KeyPair | null = null;
  private encryptionMetrics: EncryptionMetrics;
  
  // Key cache for performance
  private keyCache: Map<string, Buffer> = new Map();
  private readonly maxCacheSize: number = 1000;

  constructor(
    config: CurveConfig,
    logger: Logger,
    metrics: MetricsCollector
  ) {
    super();

    this.config = config;
    this.logger = logger.child({ component: 'CurveEncryption' });
    this.metrics = metrics;
    
    // Initialize metrics
    this.encryptionMetrics = {
      encryptionCount: 0,
      decryptionCount: 0,
      keyGenerationCount: 0,
      errorCount: 0,
      averageEncryptionTime: 0,
      averageDecryptionTime: 0
    };

    this.logger.info('CurveEncryption created', {
      enabled: config.enabled,
      algorithm: config.algorithm
    });
  }

  /**
   * Initialize the CURVE encryption
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('CurveEncryption is already initialized');
    }

    if (!this.config.enabled) {
      this.logger.info('CURVE encryption is disabled');
      this.isInitialized = true;
      return;
    }

    try {
      this.logger.info('Initializing CurveEncryption...');
      this.metrics.startTimer('curve_encryption_initialization');

      // Initialize libsodium
      await sodium.ready;
      
      // Load or generate key pair
      await this.initializeKeyPair();
      
      this.isInitialized = true;
      this.metrics.endTimer('curve_encryption_initialization');
      
      this.logger.info('CurveEncryption initialized successfully', {
        publicKey: this.keyPair?.publicKey.toString('base64').substring(0, 16) + '...'
      });
      
    } catch (error) {
      this.metrics.endTimer('curve_encryption_initialization');
      this.logger.error('Failed to initialize CurveEncryption', { error });
      throw error;
    }
  }

  /**
   * Generate a new key pair
   */
  async generateKeyPair(): Promise<KeyPair> {
    this.validateInitialized();

    try {
      this.logger.debug('Generating new key pair...');
      const startTime = Date.now();
      
      const keyPair = sodium.crypto_box_keypair();
      
      const result: KeyPair = {
        publicKey: Buffer.from(keyPair.publicKey),
        privateKey: Buffer.from(keyPair.privateKey)
      };
      
      const generationTime = Date.now() - startTime;
      this.encryptionMetrics.keyGenerationCount++;
      
      this.logger.debug('Key pair generated', {
        generationTime,
        publicKey: result.publicKey.toString('base64').substring(0, 16) + '...'
      });
      
      this.metrics.recordMetric('key_generation_time', generationTime);
      
      return result;
      
    } catch (error) {
      this.encryptionMetrics.errorCount++;
      this.logger.error('Failed to generate key pair', { error });
      throw new SecurityError('Key pair generation failed', 'KEY_GENERATION_FAILED');
    }
  }

  /**
   * Encrypt data using CURVE25519
   */
  async encrypt(data: Buffer, recipientPublicKey?: Buffer): Promise<Buffer> {
    this.validateInitialized();
    this.validateEnabled();

    if (!data || data.length === 0) {
      throw new ValidationError('Data cannot be empty', 'data', data);
    }

    try {
      const startTime = Date.now();
      
      // Use provided recipient key or our own public key for self-encryption
      const recipientKey = recipientPublicKey || this.keyPair!.publicKey;
      
      // Generate a random nonce
      const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
      
      // Encrypt the data
      const ciphertext = sodium.crypto_box_easy(
        data,
        nonce,
        recipientKey,
        this.keyPair!.privateKey
      );
      
      // Create encrypted message structure
      const encryptedMessage: EncryptedMessage = {
        nonce: Buffer.from(nonce),
        ciphertext: Buffer.from(ciphertext),
        publicKey: this.keyPair!.publicKey
      };
      
      // Serialize the encrypted message
      const serialized = this.serializeEncryptedMessage(encryptedMessage);
      
      const encryptionTime = Date.now() - startTime;
      this.updateEncryptionMetrics(encryptionTime);
      
      this.logger.debug('Data encrypted', {
        originalSize: data.length,
        encryptedSize: serialized.length,
        encryptionTime
      });
      
      return serialized;
      
    } catch (error) {
      this.encryptionMetrics.errorCount++;
      this.logger.error('Encryption failed', { error });
      throw new SecurityError('Encryption failed', 'ENCRYPTION_FAILED');
    }
  }

  /**
   * Decrypt data using CURVE25519
   */
  async decrypt(encryptedData: Buffer, senderPublicKey?: Buffer): Promise<Buffer> {
    this.validateInitialized();
    this.validateEnabled();

    if (!encryptedData || encryptedData.length === 0) {
      throw new ValidationError('Encrypted data cannot be empty', 'encryptedData', encryptedData);
    }

    try {
      const startTime = Date.now();
      
      // Deserialize the encrypted message
      const encryptedMessage = this.deserializeEncryptedMessage(encryptedData);
      
      // Use provided sender key or the key from the message
      const senderKey = senderPublicKey || encryptedMessage.publicKey;
      
      if (!senderKey) {
        throw new SecurityError('Sender public key not available', 'MISSING_SENDER_KEY');
      }
      
      // Decrypt the data
      const decrypted = sodium.crypto_box_open_easy(
        encryptedMessage.ciphertext,
        encryptedMessage.nonce,
        senderKey,
        this.keyPair!.privateKey
      );
      
      const decryptionTime = Date.now() - startTime;
      this.updateDecryptionMetrics(decryptionTime);
      
      this.logger.debug('Data decrypted', {
        encryptedSize: encryptedData.length,
        decryptedSize: decrypted.length,
        decryptionTime
      });
      
      return Buffer.from(decrypted);
      
    } catch (error) {
      this.encryptionMetrics.errorCount++;
      this.logger.error('Decryption failed', { error });
      throw new SecurityError('Decryption failed', 'DECRYPTION_FAILED');
    }
  }

  /**
   * Sign data using the private key
   */
  async sign(data: Buffer): Promise<Buffer> {
    this.validateInitialized();
    this.validateEnabled();

    if (!data || data.length === 0) {
      throw new ValidationError('Data cannot be empty', 'data', data);
    }

    try {
      this.logger.debug('Signing data', { size: data.length });
      
      // Convert box keys to sign keys
      const signPrivateKey = sodium.crypto_sign_seed_keypair(
        this.keyPair!.privateKey.slice(0, sodium.crypto_sign_SEEDBYTES)
      ).privateKey;
      
      const signature = sodium.crypto_sign_detached(data, signPrivateKey);
      
      this.logger.debug('Data signed successfully');
      
      return Buffer.from(signature);
      
    } catch (error) {
      this.encryptionMetrics.errorCount++;
      this.logger.error('Signing failed', { error });
      throw new SecurityError('Signing failed', 'SIGNING_FAILED');
    }
  }

  /**
   * Verify signature
   */
  async verify(data: Buffer, signature: Buffer, senderPublicKey: Buffer): Promise<boolean> {
    this.validateInitialized();
    this.validateEnabled();

    if (!data || data.length === 0) {
      throw new ValidationError('Data cannot be empty', 'data', data);
    }

    if (!signature || signature.length === 0) {
      throw new ValidationError('Signature cannot be empty', 'signature', signature);
    }

    try {
      this.logger.debug('Verifying signature', {
        dataSize: data.length,
        signatureSize: signature.length
      });
      
      // Convert box public key to sign public key
      const signPublicKey = sodium.crypto_sign_seed_keypair(
        senderPublicKey.slice(0, sodium.crypto_sign_SEEDBYTES)
      ).publicKey;
      
      const isValid = sodium.crypto_sign_verify_detached(
        signature,
        data,
        signPublicKey
      );
      
      this.logger.debug('Signature verification result', { isValid });
      
      return isValid;
      
    } catch (error) {
      this.encryptionMetrics.errorCount++;
      this.logger.error('Signature verification failed', { error });
      return false;
    }
  }

  /**
   * Get public key
   */
  getPublicKey(): Buffer | null {
    return this.keyPair?.publicKey || null;
  }

  /**
   * Get private key (use with caution)
   */
  getPrivateKey(): Buffer | null {
    return this.keyPair?.privateKey || null;
  }

  /**
   * Set key pair
   */
  setKeyPair(publicKey: Buffer, privateKey: Buffer): void {
    this.validateInitialized();

    if (!publicKey || publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
      throw new ValidationError('Invalid public key', 'publicKey', publicKey);
    }

    if (!privateKey || privateKey.length !== sodium.crypto_box_SECRETKEYBYTES) {
      throw new ValidationError('Invalid private key', 'privateKey', privateKey);
    }

    this.keyPair = {
      publicKey,
      privateKey
    };

    this.logger.debug('Key pair set', {
      publicKey: publicKey.toString('base64').substring(0, 16) + '...'
    });
  }

  /**
   * Get encryption metrics
   */
  getMetrics(): EncryptionMetrics & {
    keyCacheSize: number;
    isInitialized: boolean;
    isEnabled: boolean;
  } {
    return {
      ...this.encryptionMetrics,
      keyCacheSize: this.keyCache.size,
      isInitialized: this.isInitialized,
      isEnabled: this.config.enabled
    };
  }

  /**
   * Clear key cache
   */
  clearKeyCache(): void {
    this.keyCache.clear();
    this.logger.debug('Key cache cleared');
  }

  /**
   * Initialize key pair
   */
  private async initializeKeyPair(): Promise<void> {
    try {
      // Check if keys are provided in config
      if (this.config.serverPublicKey && this.config.serverPrivateKey) {
        this.logger.debug('Loading key pair from configuration');
        
        const publicKey = Buffer.from(this.config.serverPublicKey, 'base64');
        const privateKey = Buffer.from(this.config.serverPrivateKey, 'base64');
        
        this.setKeyPair(publicKey, privateKey);
        
      } else {
        this.logger.debug('Generating new key pair');
        this.keyPair = await this.generateKeyPair();
      }
      
      this.logger.debug('Key pair initialized');
      
    } catch (error) {
      this.logger.error('Failed to initialize key pair', { error });
      throw error;
    }
  }

  /**
   * Serialize encrypted message
   */
  private serializeEncryptedMessage(message: EncryptedMessage): Buffer {
    try {
      // Format: [nonce_length(4)] [nonce] [publickey_length(4)] [publickey] [ciphertext]
      const nonceLength = Buffer.alloc(4);
      nonceLength.writeUInt32BE(message.nonce.length, 0);
      
      const publicKeyLength = Buffer.alloc(4);
      publicKeyLength.writeUInt32BE(message.publicKey?.length || 0, 0);
      
      const parts = [
        nonceLength,
        message.nonce,
        publicKeyLength
      ];
      
      if (message.publicKey) {
        parts.push(message.publicKey);
      }
      
      parts.push(message.ciphertext);
      
      return Buffer.concat(parts);
      
    } catch (error) {
      this.logger.error('Failed to serialize encrypted message', { error });
      throw new SecurityError('Message serialization failed', 'SERIALIZATION_FAILED');
    }
  }

  /**
   * Deserialize encrypted message
   */
  private deserializeEncryptedMessage(data: Buffer): EncryptedMessage {
    try {
      let offset = 0;
      
      // Read nonce length
      const nonceLength = data.readUInt32BE(offset);
      offset += 4;
      
      // Read nonce
      const nonce = data.slice(offset, offset + nonceLength);
      offset += nonceLength;
      
      // Read public key length
      const publicKeyLength = data.readUInt32BE(offset);
      offset += 4;
      
      // Read public key (if present)
      let publicKey: Buffer | undefined;
      if (publicKeyLength > 0) {
        publicKey = data.slice(offset, offset + publicKeyLength);
        offset += publicKeyLength;
      }
      
      // Read ciphertext
      const ciphertext = data.slice(offset);
      
      return {
        nonce,
        ciphertext,
        publicKey
      };
      
    } catch (error) {
      this.logger.error('Failed to deserialize encrypted message', { error });
      throw new SecurityError('Message deserialization failed', 'DESERIALIZATION_FAILED');
    }
  }

  /**
   * Update encryption metrics
   */
  private updateEncryptionMetrics(encryptionTime: number): void {
    this.encryptionMetrics.encryptionCount++;
    
    if (this.encryptionMetrics.averageEncryptionTime === 0) {
      this.encryptionMetrics.averageEncryptionTime = encryptionTime;
    } else {
      this.encryptionMetrics.averageEncryptionTime = 
        (this.encryptionMetrics.averageEncryptionTime + encryptionTime) / 2;
    }
    
    this.metrics.recordMetric('encryption_count', 1);
    this.metrics.recordMetric('encryption_time', encryptionTime);
  }

  /**
   * Update decryption metrics
   */
  private updateDecryptionMetrics(decryptionTime: number): void {
    this.encryptionMetrics.decryptionCount++;
    
    if (this.encryptionMetrics.averageDecryptionTime === 0) {
      this.encryptionMetrics.averageDecryptionTime = decryptionTime;
    } else {
      this.encryptionMetrics.averageDecryptionTime = 
        (this.encryptionMetrics.averageDecryptionTime + decryptionTime) / 2;
    }
    
    this.metrics.recordMetric('decryption_count', 1);
    this.metrics.recordMetric('decryption_time', decryptionTime);
  }

  /**
   * Validate that encryption is initialized
   */
  private validateInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('CurveEncryption is not initialized');
    }
  }

  /**
   * Validate that encryption is enabled
   */
  private validateEnabled(): void {
    if (!this.config.enabled) {
      throw new SecurityError('CURVE encryption is disabled', 'ENCRYPTION_DISABLED');
    }
    
    if (!this.keyPair) {
      throw new SecurityError('Key pair not available', 'NO_KEY_PAIR');
    }
  }

  /**
   * Shutdown the CURVE encryption
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down CurveEncryption...');
      
      // Clear key cache
      this.clearKeyCache();
      
      // Clear key pair (security measure)
      if (this.keyPair) {
        this.keyPair.privateKey.fill(0);
        this.keyPair = null;
      }
      
      this.isInitialized = false;
      
      this.logger.info('CurveEncryption shutdown completed');
      
    } catch (error) {
      this.logger.error('Error during CurveEncryption shutdown', { error });
      throw error;
    }
  }
}