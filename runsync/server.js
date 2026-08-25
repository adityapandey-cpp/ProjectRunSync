require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
require('./config/redis'); // initializes main + publisher clients on import
require('./services/pubsub/subscriber'); // initializes dedicated subscriber client on import

const authRoutes = require('./routes/auth');
const runRoutes = require('./routes/runs');
const aiRoutes = require('./routes/ai');

const { generalLimiter } = require('./middleware/rateLimiter');
const { errorHandler, notFound } = require('./middleware/errorHandler');
const initMultiplayer = require('./sockets/multiplayer');

const REQUIRED_ENV_VARS = ['MONGO_URI', 'JWT_SECRET', 'REDIS_URL'];
const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(`[Startup] Missing required environment variables: ${missingEnvVars.join(', ')}`);
  console.error('[Startup] Copy .env.example to .env and fill in the values before starting.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*', credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({ success: true, status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/runs', runRoutes);
app.use('/api/ai', aiRoutes);

// Apply a general rate limit to anything else under /api not already covered
app.use('/api', generalLimiter);

app.use(notFound);
app.use(errorHandler);

// ---------------------------------------------------------------------------
// Real-time multiplayer engine
// ---------------------------------------------------------------------------
initMultiplayer(io);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 5000;

(async () => {
  await connectDB();

  server.listen(PORT, () => {
    console.log(`[Server] RunSync backend listening on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
})();

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  console.log(`[Server] Received ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log('[Server] HTTP server closed.');
    process.exit(0);
  });

  // Force-exit if shutdown hangs
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled Rejection:', reason);
});

module.exports = { app, server, io };
