# RunSync Backend

Real-time multiplayer running app backend with AI coaching (Node.js, Express, MongoDB, Redis, Socket.IO, Gemini).

## Setup

```bash
npm install
cp .env.example .env   # fill in MONGO_URI, JWT_SECRET, REDIS_URL, GEMINI_API_KEY
npm start               # or: npm run dev (nodemon)
```

## Project Structure

```
config/
  db.js              MongoDB (Mongoose) connection
  redis.js            Main command client + publisher client + cache helpers
services/
  gemini.js            Gemini REST API wrapper (AI training plans)
  pubsub/
    subscriber.js       Dedicated, isolated ioredis SUBSCRIBE-only client
models/
  User.js               bcrypt password hashing + comparePassword
  Run.js                 auto-computed avgPace
middleware/
  auth.js                HTTP Bearer JWT guard
  rateLimiter.js          express-rate-limit backed by Redis
  errorHandler.js          centralized error normalization
routes/
  auth.js    POST /api/auth/register, /login
  runs.js    POST/GET/DELETE /api/runs  (cache + invalidation)
  ai.js      GET /api/ai/plan, POST /api/ai/plan/refresh
sockets/
  multiplayer.js   Socket.IO auth + live group-run rooms via Redis pub/sub
server.js            wires it all together
```

## Key Architectural Points

- **Redis client isolation**: `config/redis.js` exports a command client
  (GET/SET/DEL/HSET etc.) and a separate PUBLISH-only client. The
  subscriber lives entirely in `services/pubsub/subscriber.js` as its own
  ioredis instance, since a connection that issues SUBSCRIBE can never
  issue normal commands again until it unsubscribes.
- **Cache policy**: `runs:{userId}` (1h TTL) and `ai:plan:{userId}` (24h TTL)
  are both deleted the instant `POST /api/runs` succeeds.
- **Auth everywhere**: HTTP routes use `middleware/auth.js` (Bearer JWT).
  Socket.IO uses `io.use()` verifying `socket.handshake.auth.token` before
  any event handler runs.
- **Multiplayer scaling**: room state (`room:{roomId}:members`) lives in
  Redis, not process memory, and every room event is PUBLISHed to a Redis
  channel and re-broadcast locally by the subscriber — so this works
  correctly across multiple Node processes/instances, not just one.
