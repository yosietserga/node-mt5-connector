/**
 * MT5Connector - Main connector class for MetaTrader 5 integration
 */

import { EventEmitter } from 'eventemitter3';
import { MT5ConnectorConfig, AgentConfig, MT5Event, EventType } from '../types';
import { MT5Agent } from './MT5Agent';
import { ConnectionGateway } from './ConnectionGateway';
import { EventProcessor } from './EventProcessor';
import { SecurityManager } from '../security/SecurityManager';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { HealthChecker } from '../utils/HealthChecker';
import { ConfigManager } from '../utils/ConfigManager';
import { ConnectionError, ValidationError } from './errors';
import { DEFAULTS } from '../constants';

/**
 * Main MT5 Connector class that manages connections and agents
 */
export class MT5Connector extends EventEmitter {
  private readonly config: MT5ConnectorConfig;
  private readonly logger: Logger;
  private readonly metrics: MetricsCollector;
  private readonly healthChecker: HealthChecker;
  private readonly configManager: ConfigManager;
  private readonly connectionGateway: ConnectionGateway;
  private readonly eventProcessor: EventProcessor;
  private readonly securityManager: SecurityManager;
  private readonly agents: Map<string, MT5Agent> = new Map();
  private isConnected: boolean = false;
  private isInitialized: boolean = false;

  constructor(config: Partial<MT5ConnectorConfig>) {
    super();

    // Validate and merge configuration
    this.config = this.validateAndMergeConfig(config);
    
    // Initialize core components
    this.logger = new Logger(this.config.logging);
    this.metrics = new MetricsCollector();
    this.healthChecker = new HealthChecker();
    this.configManager = new ConfigManager(this.config);
    
    // Initialize security manager
    this.securityManager = new SecurityManager(this.config.security, this.logger);
    
    // Initialize connection gateway
    this.connectionGateway = new ConnectionGateway(
      this.config,
      this.securityManager,
      this.logger,
      this.metrics
    );
    
    // Initialize event processor
    this.eventProcessor = new EventProcessor(
      this.connectionGateway,
      this.logger,
      this.metrics
    );

    this.setupEventHandlers();
    this.setupHealthChecks();
    
    this.logger.info('MT5Connector initialized', {
      host: this.config.host,
      port: this.config.port,
      security: {
        encryption: this.config.security.enableEncryption,
        authentication: this.config.security.enableAuthentication
      }
    });
  }

  /**
   * Initialize the connector and establish connection
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      throw new Error('Connector is already initialized');
    }

    try {
      this.logger.info('Initializing MT5Connector...');
      this.metrics.startTimer('connector_initialization');

      // Initialize security manager
      await this.securityManager.initialize();
      
      // Initialize connection gateway
      await this.connectionGateway.initialize();
      
      // Initialize event processor
      await this.eventProcessor.initialize();
      
      this.isInitialized = true;
      this.metrics.endTimer('connector_initialization');
      
      this.logger.info('MT5Connector initialized successfully');
      this.emit('initialized');
      
    } catch (error) {
      this.metrics.endTimer('connector_initialization');
      this.logger.error('Failed to initialize MT5Connector', { error });
      throw new ConnectionError(`Initialization failed: ${error.message}`);
    }
  }

  /**
   * Connect to MT5 terminal
   */
  async connect(): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Connector must be initialized before connecting');
    }

    if (this.isConnected) {
      this.logger.warn('Already connected to MT5 terminal');
      return;
    }

    try {
      this.logger.info('Connecting to MT5 terminal...', {
        host: this.config.host,
        port: this.config.port
      });
      
      this.metrics.startTimer('connection_establishment');
      
      await this.connectionGateway.connect();
      
      this.isConnected = true;
      this.metrics.endTimer('connection_establishment');
      this.metrics.recordMetric('connection_status', 1);
      
      this.logger.info('Successfully connected to MT5 terminal');
      this.emit('connected');
      
    } catch (error) {
      this.metrics.endTimer('connection_establishment');
      this.metrics.recordMetric('connection_status', 0);
      this.logger.error('Failed to connect to MT5 terminal', { error });
      throw new ConnectionError(`Connection failed: ${error.message}`);
    }
  }

  /**
   * Disconnect from MT5 terminal
   */
  async disconnect(): Promise<void> {
    if (!this.isConnected) {
      this.logger.warn('Not connected to MT5 terminal');
      return;
    }

    try {
      this.logger.info('Disconnecting from MT5 terminal...');
      
      // Disconnect all agents
      for (const agent of this.agents.values()) {
        await agent.disconnect();
      }
      
      // Disconnect connection gateway
      await this.connectionGateway.disconnect();
      
      this.isConnected = false;
      this.metrics.recordMetric('connection_status', 0);
      
      this.logger.info('Disconnected from MT5 terminal');
      this.emit('disconnected');
      
    } catch (error) {
      this.logger.error('Error during disconnection', { error });
      throw new ConnectionError(`Disconnection failed: ${error.message}`);
    }
  }

  /**
   * Create a new agent with specified configuration
   */
  async createAgent(agentConfig: AgentConfig): Promise<MT5Agent> {
    if (!this.isConnected) {
      throw new ConnectionError('Must be connected before creating agents');
    }

    if (this.agents.has(agentConfig.id)) {
      throw new ValidationError(
        `Agent with ID '${agentConfig.id}' already exists`,
        'id',
        agentConfig.id
      );
    }

    try {
      this.logger.info('Creating new agent', { agentId: agentConfig.id });
      
      const agent = new MT5Agent(
        agentConfig,
        this.connectionGateway,
        this.eventProcessor,
        this.securityManager,
        this.logger,
        this.metrics
      );
      
      await agent.initialize();
      
      this.agents.set(agentConfig.id, agent);
      this.metrics.recordMetric('active_agents', this.agents.size);
      
      this.logger.info('Agent created successfully', { agentId: agentConfig.id });
      this.emit('agentCreated', { agentId: agentConfig.id, agent });
      
      return agent;
      
    } catch (error) {
      this.logger.error('Failed to create agent', {
        agentId: agentConfig.id,
        error
      });
      throw error;
    }
  }

  /**
   * Get an existing agent by ID
   */
  getAgent(agentId: string): MT5Agent | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Get all active agents
   */
  getAgents(): MT5Agent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Remove an agent
   */
  async removeAgent(agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    try {
      this.logger.info('Removing agent', { agentId });
      
      await agent.disconnect();
      this.agents.delete(agentId);
      this.metrics.recordMetric('active_agents', this.agents.size);
      
      this.logger.info('Agent removed successfully', { agentId });
      this.emit('agentRemoved', { agentId });
      
      return true;
      
    } catch (error) {
      this.logger.error('Failed to remove agent', { agentId, error });
      throw error;
    }
  }

  /**
   * Get connection status
   */
  isConnectionActive(): boolean {
    return this.isConnected && this.connectionGateway.isConnected();
  }

  /**
   * Get connector configuration
   */
  getConfig(): MT5ConnectorConfig {
    return { ...this.config };
  }

  /**
   * Get performance metrics
   */
  getMetrics(): any {
    return {
      connection: {
        status: this.isConnected ? 'connected' : 'disconnected',
        uptime: this.connectionGateway.getUptime(),
        reconnectCount: this.connectionGateway.getReconnectCount()
      },
      agents: {
        total: this.agents.size,
        active: Array.from(this.agents.values()).filter(a => a.isActive()).length
      },
      performance: this.metrics.getMetrics(),
      health: this.healthChecker.getLastStatus()
    };
  }

  /**
   * Get health status
   */
  async getHealthStatus(): Promise<any> {
    return await this.healthChecker.runHealthChecks();
  }

  /**
   * Shutdown the connector gracefully
   */
  async shutdown(): Promise<void> {
    try {
      this.logger.info('Shutting down MT5Connector...');
      
      // Remove all agents
      const agentIds = Array.from(this.agents.keys());
      for (const agentId of agentIds) {
        await this.removeAgent(agentId);
      }
      
      // Disconnect if connected
      if (this.isConnected) {
        await this.disconnect();
      }
      
      // Shutdown components
      await this.eventProcessor.shutdown();
      await this.connectionGateway.shutdown();
      
      this.isInitialized = false;
      
      this.logger.info('MT5Connector shutdown completed');
      this.emit('shutdown');
      
    } catch (error) {
      this.logger.error('Error during shutdown', { error });
      throw error;
    }
  }

  /**
   * Validate and merge configuration with defaults
   */
  private validateAndMergeConfig(config: Partial<MT5ConnectorConfig>): MT5ConnectorConfig {
    if (!config.host || !config.port) {
      throw new ValidationError(
        'Host and port are required in configuration',
        'config',
        config
      );
    }

    if (!config.security?.curveServerPublicKey || !config.security?.curveServerSecretKey) {
      throw new ValidationError(
        'CURVE keys are required in security configuration',
        'security',
        config.security
      );
    }

    return {
      ...DEFAULTS.CONFIG,
      ...config,
      security: {
        ...DEFAULTS.CONFIG.security,
        ...config.security
      },
      performance: {
        ...DEFAULTS.CONFIG.performance,
        ...config.performance
      },
      logging: {
        ...DEFAULTS.CONFIG.logging,
        ...config.logging
      }
    } as MT5ConnectorConfig;
  }

  /**
   * Setup event handlers for internal components
   */
  private setupEventHandlers(): void {
    // Connection gateway events
    this.connectionGateway.on('connected', () => {
      this.emit('connected');
    });

    this.connectionGateway.on('disconnected', () => {
      this.isConnected = false;
      this.emit('disconnected');
    });

    this.connectionGateway.on('reconnected', () => {
      this.emit('reconnected');
    });

    this.connectionGateway.on('error', (error) => {
      this.logger.error('Connection gateway error', { error });
      this.emit('error', error);
    });

    // Event processor events
    this.eventProcessor.on('event', (event: MT5Event) => {
      this.emit('event', event);
      this.emit(event.type.toLowerCase(), event);
    });

    this.eventProcessor.on('error', (error) => {
      this.logger.error('Event processor error', { error });
      this.emit('error', error);
    });
  }

  /**
   * Setup health checks for monitoring
   */
  private setupHealthChecks(): void {
    // Connection health check
    this.healthChecker.registerCheck('connection', {
      async execute() {
        const isConnected = this.connectionGateway.isConnected();
        return {
          status: isConnected ? 'healthy' : 'unhealthy',
          message: isConnected ? 'Connection is active' : 'Connection is not active'
        };
      },
      timeout: 5000
    });

    // Security health check
    this.healthChecker.registerCheck('security', {
      async execute() {
        const isSecure = this.securityManager.isSecure();
        return {
          status: isSecure ? 'healthy' : 'degraded',
          message: isSecure ? 'Security is active' : 'Security is not fully active'
        };
      },
      timeout: 3000
    });

    // Agents health check
    this.healthChecker.registerCheck('agents', {
      async execute() {
        const totalAgents = this.agents.size;
        const activeAgents = Array.from(this.agents.values()).filter(a => a.isActive()).length;
        const healthyRatio = totalAgents > 0 ? activeAgents / totalAgents : 1;
        
        return {
          status: healthyRatio >= 0.8 ? 'healthy' : healthyRatio >= 0.5 ? 'degraded' : 'unhealthy',
          message: `${activeAgents}/${totalAgents} agents are active`
        };
      },
      timeout: 2000
    });
  }
}