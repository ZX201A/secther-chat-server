const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

// ─── Persistent User Registry ─────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, 'users_registry.json');
const INACTIVITY_HOURS = 48; // Delete user after 48 hours of inactivity

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      const map = new Map();
      for (const [username, info] of Object.entries(parsed)) {
        map.set(username, info);
      }
      console.log(`[Registry] Loaded ${map.size} users - index.js:20`);
      return map;
    }
  } catch (e) {
    console.error('[Registry] Failed to load: - index.js:24', e.message);
  }
  return new Map();
}

function saveUsers() {
  try {
    const obj = {};
    for (const [username, info] of users.entries()) {
      obj[username] = {
        id: info.id,
        username: username,
        publicKey: info.publicKey,
        registeredAt: info.registeredAt || new Date().toISOString(),
        lastSeen: info.lastSeen || new Date().toISOString(),
      };
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('[Registry] Failed to save: - index.js:43', e.message);
  }
}

function deleteUser(username) {
  const info = users.get(username);
  if (info) {
    userIdToUsername.delete(info.id);
    activeConnections.delete(info.id);
    users.delete(username);
    saveUsers();
    console.log(`[Registry] Deleted user: ${username} - index.js:54`);
    return true;
  }
  return false;
}

function updateLastSeen(uid) {
  const username = userIdToUsername.get(uid);
  if (username) {
    const info = users.get(username);
    if (info) {
      info.lastSeen = new Date().toISOString();
      users.set(username, info);
    }
  }
}

// ─── 48-Hour Inactivity Cleanup ───────────────────────────────────────────────
function cleanupInactiveUsers() {
  const now = Date.now();
  const cutoff = INACTIVITY_HOURS * 60 * 60 * 1000;
  let deleted = 0;

  for (const [username, info] of users.entries()) {
    // Skip currently active users
    if (activeConnections.has(info.id)) continue;

    const lastSeen = info.lastSeen ? new Date(info.lastSeen).getTime() : 0;
    const registeredAt = info.registeredAt ? new Date(info.registeredAt).getTime() : 0;
    const lastActivity = Math.max(lastSeen, registeredAt);

    if (now - lastActivity > cutoff) {
      deleteUser(username);
      deleted++;
    }
  }

  if (deleted > 0) {
    console.log(`[Cleanup] Deleted ${deleted} inactive users (48h+) - index.js:92`);
    saveUsers();
  }
}

// ─── In-Memory State ──────────────────────────────────────────────────────────
const users = loadUsers();
const activeConnections = new Map();   // userId -> WebSocket
const userIdToUsername = new Map();    // userId -> username

// Rebuild reverse lookup
for (const [username, info] of users.entries()) {
  userIdToUsername.set(info.id, username);
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ port: PORT, host: '0.0.0.0' });

console.log(`[Server] SecTher Chat Server running on port ${PORT} - index.js:110`);
console.log(`[Server] ${users.size} registered users in registry - index.js:111`);

wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[Connect] New connection from: ${clientIp} - index.js:115`);

  let userId = null;
  let username = null;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
    if (userId) updateLastSeen(userId);
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());

      // Update last seen on any activity
      if (userId) updateLastSeen(userId);

      switch (message.type) {

        // ── Register / Re-register ────────────────────────────────────────
        case 'register': {
          if (!message.username || !message.userId || !message.publicKey) {
            ws.send(JSON.stringify({ type: 'error', message: 'Missing required fields' }));
            return;
          }

          const existing = users.get(message.username);
          if (existing && existing.id !== message.userId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Username already taken' }));
            return;
          }

          username = message.username;
          userId = message.userId;

          users.set(username, {
            id: userId,
            publicKey: message.publicKey,
            registeredAt: existing?.registeredAt || new Date().toISOString(),
            lastSeen: new Date().toISOString(),
          });
          userIdToUsername.set(userId, username);
          saveUsers();

          activeConnections.set(userId, ws);

          console.log(`[Register] ${username} (${userId}) - index.js:162`);

          ws.send(JSON.stringify({
            type: 'registered',
            success: true,
            username: username,
            userId: userId,
          }));

          _broadcastOnlineStatus(userId, username, true);
          break;
        }

        // ── Delete Account ────────────────────────────────────────────────
        case 'delete_account': {
          if (!userId || !username) return;
          console.log(`[Delete] Account deleted: ${username} - index.js:178`);
          _broadcastOnlineStatus(userId, username, false);
          deleteUser(username);
          ws.send(JSON.stringify({ type: 'account_deleted', success: true }));
          break;
        }

        // ── Search by Username ────────────────────────────────────────────
        case 'search_user': {
          const query = (message.username || '').toLowerCase().trim();
          if (!query) {
            ws.send(JSON.stringify({ type: 'search_result', found: false }));
            return;
          }

          let found = null;
          // Exact match first
          for (const [un, u] of users.entries()) {
            if (un.toLowerCase() === query) {
              found = { username: un, ...u };
              break;
            }
          }
          // Partial match
          if (!found) {
            for (const [un, u] of users.entries()) {
              if (un.toLowerCase().includes(query)) {
                found = { username: un, ...u };
                break;
              }
            }
          }

          if (found) {
            ws.send(JSON.stringify({
              type: 'search_result',
              found: true,
              userId: found.id,
              username: found.username,
              publicKey: found.publicKey,
              online: activeConnections.has(found.id),
            }));
          } else {
            ws.send(JSON.stringify({ type: 'search_result', found: false }));
          }
          break;
        }

        // ── Search by User ID ─────────────────────────────────────────────
        case 'search_user_by_id': {
          const searchId = (message.userId || '').trim();
          if (!searchId) {
            ws.send(JSON.stringify({ type: 'search_result_by_id', found: false }));
            return;
          }

          const foundUsername = userIdToUsername.get(searchId);
          if (foundUsername) {
            const u = users.get(foundUsername);
            ws.send(JSON.stringify({
              type: 'search_result_by_id',
              found: true,
              userId: searchId,
              username: foundUsername,
              publicKey: u?.publicKey || '',
              online: activeConnections.has(searchId),
            }));
          } else {
            ws.send(JSON.stringify({ type: 'search_result_by_id', found: false }));
          }
          break;
        }

        // ── Legacy search ─────────────────────────────────────────────────
        case 'search': {
          const q = (message.query || '').toLowerCase();
          const results = [];
          for (const [un, u] of users.entries()) {
            if (un.toLowerCase().includes(q) || u.id.toLowerCase().includes(q)) {
              results.push({
                username: un,
                userId: u.id,
                publicKey: u.publicKey,
                online: activeConnections.has(u.id),
              });
            }
          }
          ws.send(JSON.stringify({ type: 'search_results', results }));
          break;
        }

        // ── Relay Message (NO storage) ────────────────────────────────────
        case 'message': {
          if (!message.toUserId || !message.encryptedContent || !message.encryptedAESKey) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
            return;
          }

          const recipientWs = activeConnections.get(message.toUserId);
          if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
            recipientWs.send(JSON.stringify({
              type: 'message',
              messageId: message.messageId,
              senderId: userId,
              senderUsername: username,
              encryptedContent: message.encryptedContent,
              encryptedAESKey: message.encryptedAESKey,
              messageType: message.messageType,
              timestamp: message.timestamp || Date.now(),
              mediaPath: message.mediaPath || null,
              mediaDuration: message.mediaDuration || null,
              mediaSize: message.mediaSize || null,
              mediaName: message.mediaName || null,
            }));
            ws.send(JSON.stringify({ type: 'message_sent', success: true, messageId: message.messageId }));
          } else {
            ws.send(JSON.stringify({ type: 'error', message: 'Recipient offline', messageId: message.messageId }));
          }
          break;
        }

        // ── Message Status ────────────────────────────────────────────────
        case 'message_status': {
          const targetWs = activeConnections.get(message.toUserId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({
              type: 'message_status',
              messageId: message.messageId,
              status: message.status,
              fromUserId: userId,
            }));
          }
          break;
        }

        // ── Delete Message ────────────────────────────────────────────────
        case 'delete_message': {
          if (message.toUserId) {
            const targetWs = activeConnections.get(message.toUserId);
            if (targetWs && targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(JSON.stringify({
                type: 'delete_message',
                messageId: message.messageId,
                fromUserId: userId,
              }));
            }
          }
          break;
        }

        // ── Reaction ──────────────────────────────────────────────────────
        case 'reaction':
        case 'remove_reaction': {
          const targetWs = activeConnections.get(message.toUserId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ ...message, fromUserId: userId }));
          }
          break;
        }

        // ── Call Signaling ────────────────────────────────────────────────
        case 'call_offer':
        case 'call_answer':
        case 'call_ice':
        case 'call_end': {
          const callTarget = message.toUserId || _getUserIdByUsername(message.to);
          if (callTarget) {
            const callWs = activeConnections.get(callTarget);
            if (callWs && callWs.readyState === WebSocket.OPEN) {
              callWs.send(JSON.stringify({ ...message, from: username, fromId: userId }));
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'User offline' }));
            }
          }
          break;
        }

        // ── Block / Unblock ───────────────────────────────────────────────
        case 'block_user':
        case 'notify_blocked': {
          const blockedWs = activeConnections.get(message.blockedUserId || message.toUserId);
          if (blockedWs && blockedWs.readyState === WebSocket.OPEN) {
            blockedWs.send(JSON.stringify({ type: 'user_blocked', byUserId: userId, byUsername: username }));
          }
          break;
        }

        case 'unblock_user': {
          const unblockedWs = activeConnections.get(message.unblockedUserId);
          if (unblockedWs && unblockedWs.readyState === WebSocket.OPEN) {
            unblockedWs.send(JSON.stringify({ type: 'user_unblocked', byUserId: userId, byUsername: username }));
          }
          break;
        }

        // ── Mute ──────────────────────────────────────────────────────────
        case 'notify_muted': {
          const mutedWs = activeConnections.get(message.toUserId);
          if (mutedWs && mutedWs.readyState === WebSocket.OPEN) {
            mutedWs.send(JSON.stringify({ type: 'user_muted', byUserId: userId, byUsername: username }));
          }
          break;
        }

        // ── Report ────────────────────────────────────────────────────────
        case 'report_user': {
          console.log(`[Report] ${userId} reported ${message.reportedUserId}: ${message.reason} - index.js:384`);
          ws.send(JSON.stringify({ type: 'report_received', success: true }));
          break;
        }

        // ── Ping ──────────────────────────────────────────────────────────
        case 'ping': {
          if (userId) updateLastSeen(userId);
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        }

        default:
          console.log(`[Unknown] Message type: ${message.type} - index.js:397`);
      }
    } catch (e) {
      console.error('[Error] Processing message: - index.js:400', e.message);
      try { ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' })); } catch (_) {}
    }
  });

  ws.on('close', () => {
    if (userId) {
      updateLastSeen(userId);
      saveUsers();
      activeConnections.delete(userId);
      _broadcastOnlineStatus(userId, username, false);
      console.log(`[Disconnect] ${username} (${userId}) - index.js:411`);
    }
  });

  ws.on('error', (error) => {
    console.error('[WS Error] - index.js:416', error.message);
  });

  ws.send(JSON.stringify({ type: 'connected', message: 'Connected to SecTher Server' }));
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _getUserIdByUsername(uname) {
  if (!uname) return null;
  const u = users.get(uname);
  return u ? u.id : null;
}

function _broadcastOnlineStatus(uid, uname, isOnline) {
  const statusMsg = JSON.stringify({
    type: isOnline ? 'user_online' : 'user_offline',
    userId: uid,
    username: uname,
  });
  for (const [, ws] of activeConnections.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(statusMsg); } catch (_) {}
    }
  }
}

// ─── Heartbeat (30s) ──────────────────────────────────────────────────────────
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ─── 48-Hour Cleanup (runs every hour) ───────────────────────────────────────
setInterval(() => {
  cleanupInactiveUsers();
}, 60 * 60 * 1000);

// Run cleanup on startup too
setTimeout(cleanupInactiveUsers, 5000);

// ─── Stats (every 5 min) ──────────────────────────────────────────────────────
setInterval(() => {
  console.log(`[Stats] Registered: ${users.size} | Online: ${activeConnections.size} - index.js:462`);
}, 5 * 60 * 1000);

console.log('[Server] Ready for connections - index.js:465');
