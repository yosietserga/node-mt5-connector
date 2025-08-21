# Node.js MT5 Connector SDK

A comprehensive, production-ready Node.js SDK for connecting to MetaTrader 5 (MT5) trading platform. This SDK provides a robust, secure, and high-performance interface for algorithmic trading, market data analysis, and account management.

## 🚀 Features

### Core Functionality
- **Real-time Trading**: Execute market and pending orders with sub-second latency
- **Market Data**: Live quotes, historical data, and market depth information
- **Account Management**: Real-time account information and position monitoring
- **Order Management**: Full order lifecycle management with advanced features

### Advanced Features
- **High Performance**: Optimized for low-latency trading with connection pooling
- **Security**: CURVE25519 encryption, certificate-based authentication, rate limiting
- **Reliability**: Circuit breaker pattern, automatic retry logic, health monitoring
- **Observability**: Comprehensive logging, metrics collection, and performance monitoring
- **Scalability**: Multi-account support, event-driven architecture

### Developer Experience
- **TypeScript Support**: Full type definitions and IntelliSense support
- **Comprehensive Testing**: Unit, integration, and performance test suites
- **Rich Documentation**: API docs, examples, and developer guides
- **Modern Architecture**: Promise-based APIs, event emitters, and async/await support

## 📦 Installation

```bash
npm install node-mt5-connector
```

## 🏃 Quick Start

### Basic Connection and Trading

```typescript
import { MT5Connector } from 'node-mt5-connector';

// Initialize connector
const connector = new MT5Connector({
  host: 'your-mt5-server.com',
  port: 443,
  login: 12345678,
  password: 'your-password',
  server: 'YourBroker-Demo'
});

// Connect and start trading
async function startTrading() {
  try {
    // Connect to MT5
    await connector.connect();
    console.log('Connected to MT5 successfully!');
    
    // Get account information
    const account = await connector.account.getInfo();
    console.log(`Account Balance: ${account.balance} ${account.currency}`);
    
    // Place a market order
    const orderResult = await connector.trade.orderSend({
      action: 1, // TradeAction.DEAL
      symbol: 'EURUSD',
      volume: 0.1,
      type: 0, // OrderType.BUY
      price: 0, // Market price
      deviation: 10,
      sl: 1.1200, // Stop Loss
      tp: 1.1300, // Take Profit
      comment: 'My first order'
    });
    
    if (orderResult.retcode === 10009) {
      console.log('Order placed successfully!', orderResult);
    }
    
    // Subscribe to real-time price updates
    await connector.marketData.subscribeToTicks(['EURUSD'], (tick) => {
      console.log(`${tick.symbol}: ${tick.bid}/${tick.ask}`);
    });
    
  } catch (error) {
    console.error('Trading error:', error);
  }
}

startTrading();
```

### Real-time Market Data

```typescript
// Subscribe to multiple symbols
const symbols = ['EURUSD', 'GBPUSD', 'USDJPY'];

await connector.marketData.subscribeToTicks(symbols, (tick) => {
  console.log(`${tick.symbol}: Bid=${tick.bid}, Ask=${tick.ask}, Time=${new Date(tick.time)}`);
});

// Get historical data
const rates = await connector.marketData.getRates({
  symbol: 'EURUSD',
  timeframe: 'H1',
  from: new Date('2024-01-01'),
  count: 100
});

console.log(`Retrieved ${rates.length} historical bars`);
```

## 📚 Documentation

- **[API Reference](docs/API.md)** - Complete API documentation with examples
- **[Developer Guide](docs/DEVELOPER_GUIDE.md)** - Best practices and advanced usage
- **[Examples](docs/EXAMPLES.md)** - Real-world usage examples and patterns
- **[Testing Guide](tests/README.md)** - Testing framework and guidelines

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                        │
├─────────────────────────────────────────────────────────────┤
│  TradeAPI  │  MarketDataAPI  │  AccountAPI  │  EventAPI     │
├─────────────────────────────────────────────────────────────┤
│                    Core Layer                               │
├─────────────────────────────────────────────────────────────┤
│ ConnectionGateway │ EventProcessor │ SecurityLayer          │
├─────────────────────────────────────────────────────────────┤
│                   Utilities Layer                           │
├─────────────────────────────────────────────────────────────┤
│  Logger  │  Metrics  │  HealthCheck  │  CircuitBreaker     │
└─────────────────────────────────────────────────────────────┘
```

### Key Components

- **ConnectionGateway**: Manages ZeroMQ connections with automatic reconnection
- **SecurityLayer**: Handles encryption, authentication, and rate limiting
- **EventProcessor**: Processes real-time events and market data
- **TradeAPI**: High-level trading operations and order management
- **MarketDataAPI**: Real-time and historical market data access
- **AccountAPI**: Account information and position management

## 🔧 Configuration

### Environment Variables

```bash
# MT5 Connection
MT5_HOST=your-mt5-server.com
MT5_PORT=443
MT5_LOGIN=12345678
MT5_PASSWORD=your-password
MT5_SERVER=YourBroker-Demo

# Security (Optional)
MT5_CLIENT_CERT_PATH=/path/to/client.crt
MT5_CLIENT_KEY_PATH=/path/to/client.key
MT5_CA_CERT_PATH=/path/to/ca.crt

# Logging
LOG_LEVEL=info
LOG_FORMAT=json
LOG_FILE_PATH=/var/log/mt5-connector.log

# Performance
CONNECTION_POOL_SIZE=5
REQUEST_TIMEOUT=30000
MAX_RETRIES=3
```

### Configuration File

```typescript
// config/mt5.config.ts
export const mt5Config = {
  connection: {
    host: process.env.MT5_HOST || 'localhost',
    port: parseInt(process.env.MT5_PORT || '443'),
    login: parseInt(process.env.MT5_LOGIN!),
    password: process.env.MT5_PASSWORD!,
    server: process.env.MT5_SERVER!,
    timeout: 30000,
    retries: 3
  },
  security: {
    encryption: true,
    certificatePath: process.env.MT5_CLIENT_CERT_PATH,
    keyPath: process.env.MT5_CLIENT_KEY_PATH,
    caPath: process.env.MT5_CA_CERT_PATH
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'json',
    filePath: process.env.LOG_FILE_PATH
  },
  metrics: {
    enabled: true,
    port: 9090,
    path: '/metrics'
  }
};
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:unit
npm run test:integration
npm run test:performance

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch

# Debug tests
npm run test:debug
```

## 📊 Performance

### Benchmarks

- **Connection Time**: < 100ms (typical)
- **Order Execution**: < 50ms (market orders)
- **Market Data Latency**: < 10ms (real-time ticks)
- **Throughput**: > 1000 requests/second
- **Memory Usage**: < 50MB (base)

### Optimization Features

- Connection pooling for high-frequency trading
- Intelligent caching for market data
- Batch processing for multiple operations
- Circuit breaker for fault tolerance
- Automatic retry with exponential backoff

## 🔒 Security

### Encryption
- CURVE25519 elliptic curve encryption
- TLS 1.3 support for secure connections
- Certificate-based client authentication

### Authentication
- Multi-factor authentication support
- JWT token-based session management
- API key authentication for REST endpoints

### Rate Limiting
- Configurable rate limits per endpoint
- Sliding window algorithm
- Automatic backoff on rate limit exceeded

## 🚀 Production Deployment

### Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["npm", "start"]
```

### Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: mt5-connector
spec:
  replicas: 3
  selector:
    matchLabels:
      app: mt5-connector
  template:
    metadata:
      labels:
        app: mt5-connector
    spec:
      containers:
      - name: mt5-connector
        image: your-registry/mt5-connector:latest
        ports:
        - containerPort: 3000
        env:
        - name: MT5_HOST
          valueFrom:
            secretKeyRef:
              name: mt5-secrets
              key: host
        - name: MT5_LOGIN
          valueFrom:
            secretKeyRef:
              name: mt5-secrets
              key: login
        - name: MT5_PASSWORD
          valueFrom:
            secretKeyRef:
              name: mt5-secrets
              key: password
```

### Monitoring

```typescript
// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  const metrics = await connector.metrics.getPrometheusMetrics();
  res.set('Content-Type', 'text/plain');
  res.send(metrics);
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const health = await connector.healthCheck.getStatus();
  res.status(health.status === 'healthy' ? 200 : 503).json(health);
});
```

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup

```bash
# Clone the repository
git clone https://github.com/your-org/node-mt5-connector.git
cd node-mt5-connector

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your MT5 credentials

# Run tests
npm test

# Start development server
npm run dev
```

### Code Style

- TypeScript with strict mode enabled
- ESLint + Prettier for code formatting
- Conventional commits for commit messages
- 100% test coverage for new features

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Documentation**: [docs/](docs/)
- **Issues**: [GitHub Issues](https://github.com/your-org/node-mt5-connector/issues)
- **Discussions**: [GitHub Discussions](https://github.com/your-org/node-mt5-connector/discussions)
- **Email**: support@your-org.com

## 🙏 Acknowledgments

- MetaQuotes Software Corp. for the MT5 platform
- ZeroMQ community for the messaging library
- Node.js community for the excellent ecosystem

## 📈 Roadmap

### v2.0.0 (Q2 2024)
- [ ] WebSocket API support
- [ ] GraphQL endpoint
- [ ] Advanced order types
- [ ] Machine learning integration

### v2.1.0 (Q3 2024)
- [ ] Multi-broker support
- [ ] Cloud deployment templates
- [ ] Advanced analytics dashboard
- [ ] Mobile SDK

---

**⚠️ Risk Warning**: Trading financial instruments involves substantial risk of loss and is not suitable for all investors. Please ensure you fully understand the risks involved and seek independent advice if necessary.

**📊 Made with ❤️ for algorithmic traders**
