const { verifyToken } = require('../utils/jwt');
const { publisherClient, redisClient } = require('../config/redis');
const { subscribeToChannel, unsubscribeHandler } = require('../services/pubsub/subscriber');

/**
 * REAL-TIME MULTIPLAYER ENGINE
 * -------------------------------------------------------------------------
 * Rooms represent a live shared run ("group run"). Members broadcast
 * periodic progress updates (distance/pace/location) and the server
 * fans out a live leaderboard to everyone in the room.
 *
 * Redis is used for two things:
 *  1. Shared room membership/state (`room:{roomId}:members` hash) so any
 *     server instance can compute a leaderboard, not just the instance that
 *     happens to hold the socket.
 *  2. Pub/Sub (`room:{roomId}` channel) so an event published by ANY server
 *     instance reaches sockets connected to every OTHER instance too. This
 *     is what makes the app horizontally scalable beyond a single process.
 *
 * Client -> Server events:
 *   - "room:join"     { roomId }
 *   - "room:leave"    { roomId }
 *   - "run:progress"  { roomId, distanceKm, paceSecPerKm, elapsedSeconds, lat?, lng? }
 *   - "run:finish"    { roomId, distanceKm, totalTimeSeconds }
 *   - "chat:cheer"    { roomId, message }
 *
 * Server -> Client events:
 *   - "room:joined"       { roomId, members }
 *   - "room:user_joined"  { userId, name }
 *   - "room:user_left"    { userId, name }
 *   - "room:leaderboard"  { roomId, leaderboard: [{ userId, name, distanceKm, paceSecPerKm, elapsedSeconds }] }
 *   - "run:user_finished" { roomId, userId, name, distanceKm, totalTimeSeconds }
 *   - "chat:cheer"        { roomId, userId, name, message, ts }
 *   - "error"             { message }
 */

const ROOM_MEMBER_TTL_SECONDS = 6 * 60 * 60; // auto-expire stale room state after 6h
const roomChannel = (roomId) => `room:${roomId}`;
const roomMembersKey = (roomId) => `room:${roomId}:members`;

function initMultiplayer(io) {
  // ---------------------------------------------------------------------
  // AUTH MIDDLEWARE — every socket connection must present a valid JWT
  // ---------------------------------------------------------------------
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error('AUTH_ERROR: No token provided.'));
      }

      const decoded = verifyToken(token);
      socket.user = decoded; // { id, email, name }
      return next();
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return next(new Error('AUTH_ERROR: Token expired.'));
      }
      return next(new Error('AUTH_ERROR: Invalid token.'));
    }
  });

  // Tracks which redis-subscription handlers this process owns per room,
  // so we can unsubscribe cleanly once the last local socket leaves.
  const roomHandlers = new Map(); // roomId -> handler function

  io.on('connection', (socket) => {
    console.log(`[Socket.IO] Connected: ${socket.id} (user: ${socket.user?.id})`);

    // Track rooms this socket is in locally so disconnect cleanup works.
    const joinedRooms = new Set();

    // -----------------------------------------------------------------
    // room:join
    // -----------------------------------------------------------------
    socket.on('room:join', async ({ roomId } = {}) => {
      try {
        if (!roomId || typeof roomId !== 'string') {
          return socket.emit('error', { message: 'roomId is required to join a room.' });
        }

        socket.join(roomId);
        joinedRooms.add(roomId);

        const memberState = {
          userId: socket.user.id,
          name: socket.user.name || 'Runner',
          distanceKm: 0,
          paceSecPerKm: 0,
          elapsedSeconds: 0,
          joinedAt: Date.now(),
        };

        // Persist membership in shared Redis state (visible to all instances)
        await redisClient.hset(roomMembersKey(roomId), socket.user.id, JSON.stringify(memberState));
        await redisClient.expire(roomMembersKey(roomId), ROOM_MEMBER_TTL_SECONDS);

        // Subscribe this process to the room's pub/sub channel exactly once.
        if (!roomHandlers.has(roomId)) {
          const handler = (payload) => {
            // Fan out to every socket on THIS instance that's in the room.
            io.to(roomId).emit(payload.event, payload.data);
          };
          roomHandlers.set(roomId, handler);
          await subscribeToChannel(roomChannel(roomId), handler);
        }

        const rawMembers = await redisClient.hgetall(roomMembersKey(roomId));
        const members = Object.values(rawMembers).map((m) => JSON.parse(m));

        socket.emit('room:joined', { roomId, members });

        await publisherClient.publish(
          roomChannel(roomId),
          JSON.stringify({
            event: 'room:user_joined',
            data: { userId: socket.user.id, name: socket.user.name || 'Runner' },
          }),
        );
      } catch (err) {
        console.error('[Socket.IO] room:join error:', err.message);
        socket.emit('error', { message: 'Failed to join room.' });
      }
    });

    // -----------------------------------------------------------------
    // room:leave
    // -----------------------------------------------------------------
    socket.on('room:leave', async ({ roomId } = {}) => {
      await leaveRoom(roomId);
    });

    // -----------------------------------------------------------------
    // run:progress — periodic live updates while running
    // -----------------------------------------------------------------
    socket.on('run:progress', async (payload = {}) => {
      try {
        const { roomId, distanceKm, paceSecPerKm, elapsedSeconds, lat, lng } = payload;

        if (!roomId) {
          return socket.emit('error', { message: 'roomId is required.' });
        }
        if (!joinedRooms.has(roomId)) {
          return socket.emit('error', { message: 'You must join the room before sending progress updates.' });
        }
        if (typeof distanceKm !== 'number' || typeof elapsedSeconds !== 'number') {
          return socket.emit('error', { message: 'distanceKm and elapsedSeconds must be numbers.' });
        }

        const memberState = {
          userId: socket.user.id,
          name: socket.user.name || 'Runner',
          distanceKm,
          paceSecPerKm: typeof paceSecPerKm === 'number' ? paceSecPerKm : 0,
          elapsedSeconds,
          lat: typeof lat === 'number' ? lat : undefined,
          lng: typeof lng === 'number' ? lng : undefined,
          updatedAt: Date.now(),
        };

        await redisClient.hset(roomMembersKey(roomId), socket.user.id, JSON.stringify(memberState));
        await redisClient.expire(roomMembersKey(roomId), ROOM_MEMBER_TTL_SECONDS);

        const rawMembers = await redisClient.hgetall(roomMembersKey(roomId));
        const leaderboard = Object.values(rawMembers)
          .map((m) => JSON.parse(m))
          .sort((a, b) => b.distanceKm - a.distanceKm);

        await publisherClient.publish(
          roomChannel(roomId),
          JSON.stringify({
            event: 'room:leaderboard',
            data: { roomId, leaderboard },
          }),
        );
      } catch (err) {
        console.error('[Socket.IO] run:progress error:', err.message);
        socket.emit('error', { message: 'Failed to broadcast progress.' });
      }
    });

    // -----------------------------------------------------------------
    // run:finish
    // -----------------------------------------------------------------
    socket.on('run:finish', async (payload = {}) => {
      try {
        const { roomId, distanceKm, totalTimeSeconds } = payload;

        if (!roomId || !joinedRooms.has(roomId)) {
          return socket.emit('error', { message: 'You must be in the room to finish a run.' });
        }

        await publisherClient.publish(
          roomChannel(roomId),
          JSON.stringify({
            event: 'run:user_finished',
            data: {
              roomId,
              userId: socket.user.id,
              name: socket.user.name || 'Runner',
              distanceKm,
              totalTimeSeconds,
            },
          }),
        );
      } catch (err) {
        console.error('[Socket.IO] run:finish error:', err.message);
        socket.emit('error', { message: 'Failed to broadcast run completion.' });
      }
    });

    // -----------------------------------------------------------------
    // chat:cheer — lightweight encouragement messages within a room
    // -----------------------------------------------------------------
    socket.on('chat:cheer', async (payload = {}) => {
      try {
        const { roomId, message } = payload;

        if (!roomId || !joinedRooms.has(roomId)) {
          return socket.emit('error', { message: 'You must be in the room to send a message.' });
        }
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
          return socket.emit('error', { message: 'message must be a non-empty string.' });
        }
        if (message.length > 280) {
          return socket.emit('error', { message: 'message must be 280 characters or fewer.' });
        }

        await publisherClient.publish(
          roomChannel(roomId),
          JSON.stringify({
            event: 'chat:cheer',
            data: {
              roomId,
              userId: socket.user.id,
              name: socket.user.name || 'Runner',
              message: message.trim(),
              ts: Date.now(),
            },
          }),
        );
      } catch (err) {
        console.error('[Socket.IO] chat:cheer error:', err.message);
        socket.emit('error', { message: 'Failed to send message.' });
      }
    });

    // -----------------------------------------------------------------
    // disconnect cleanup
    // -----------------------------------------------------------------
    socket.on('disconnect', async () => {
      console.log(`[Socket.IO] Disconnected: ${socket.id} (user: ${socket.user?.id})`);
      for (const roomId of Array.from(joinedRooms)) {
        await leaveRoom(roomId);
      }
    });

    async function leaveRoom(roomId) {
      if (!roomId || !joinedRooms.has(roomId)) return;

      try {
        socket.leave(roomId);
        joinedRooms.delete(roomId);

        await redisClient.hdel(roomMembersKey(roomId), socket.user.id);

        await publisherClient.publish(
          roomChannel(roomId),
          JSON.stringify({
            event: 'room:user_left',
            data: { userId: socket.user.id, name: socket.user.name || 'Runner' },
          }),
        );

        // If no local sockets remain in this room on this instance, drop
        // our subscription to avoid an ever-growing handler map.
        const localRoom = io.sockets.adapter.rooms.get(roomId);
        if (!localRoom || localRoom.size === 0) {
          const handler = roomHandlers.get(roomId);
          if (handler) {
            await unsubscribeHandler(roomChannel(roomId), handler);
            roomHandlers.delete(roomId);
          }
        }
      } catch (err) {
        console.error('[Socket.IO] leaveRoom error:', err.message);
      }
    }
  });
}

module.exports = initMultiplayer;
