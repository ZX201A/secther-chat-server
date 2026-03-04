const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PORT = process.env.PORT || 8080;

// ─── Persistent Storage ─────────────────────────────────────────────────────────
const PERSISTENT_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
console.log(`[Storage] Using persistent directory: ${PERSISTENT_DIR} - index.js:10`);

// ─── File Upload & Static Files Server ──────────────────────────────────────────
const UPLOAD_DIR = path.join(PERSISTENT_DIR, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log(`[Upload] Created uploads directory - index.js:17`);
}

// Combined HTTP server for file uploads and static files
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // File upload endpoint
  if (req.method === 'POST' && req.url === '/upload') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        
        let contentType = 'application/octet-stream';
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
          contentType = 'image/jpeg';
        } else if (buffer[0] === 0x89 && buffer[1] === 0x50) {
          contentType = 'image/png';
        } else if (buffer[0] === 0x47 && buffer[1] === 0x49) {
          contentType = 'image/gif';
        }

        const ext = contentType.split('/')[1] || 'bin';
        const filename = `${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`;
        const filepath = path.join(UPLOAD_DIR, filename);

        fs.writeFileSync(filepath, buffer);
        
        // Return full URL for Railway deployment
        const host = req.headers['host'] || 'secther-chat-server-production.up.railway.app';
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const fileUrl = `${protocol}://${host}/uploads/${filename}`;
        
        console.log(`[Upload] File saved: ${filename} - index.js:60`);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, url: fileUrl, filename: filename }));
      } catch (e) {
        console.error('[Upload] Error: - index.js:65', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Serve uploaded files
  if (req.method === 'GET' && req.url.startsWith('/uploads/')) {
    const filename = req.url.split('/').pop();
    const filepath = path.join(UPLOAD_DIR, filename);
    
    if (fs.existsSync(filepath)) {
      const ext = path.extname(filename).toLowerCase();
      const contentTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.pdf': 'application/pdf',
      };
      
      res.writeHead(200, { 
        'Content-Type': contentTypes[ext] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filepath).pipe(res);
      return;
    }
  }

  // Health check endpoint
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', users: users ? users.size : 0, online: activeConnections ? activeConnections.size : 0 }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// ─── Persistent User Registry ─────────────────────────────────────────────────
const USERS_FILE = path.join(PERSISTENT_DIR, 'users_registry.json');
const INACTIVITY_HOURS = 30 * 24;

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      const parsed = JSON.parse(data);
      const map = new Map();
      for (const [username, info] of Object.entries(parsed)) {
        map.set(username, info);
      }
      console.log(`[Registry] Loaded ${map.size} users - index.js:123`);
      return map;
    }
  } catch (e) {
    console.error('[Registry] Failed to load: - index.js:127', e.message);
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
        accountId: info.accountId || '',
        publicKey: info.publicKey,
        registeredAt: info.registeredAt || new Date().toISOString(),
        lastSeen: info.lastSeen || new Date().toISOString(),
      };
    }
    fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('[Registry] Failed to save: - index.js:147', e.message);
  }
}

function deleteUser(username) {
  const info = users.get(username);
  if (info) {
    userIdToUsername.delete(info.id);
    if (info.accountId) {
      accountIdToUsername.delete(info.accountId);
    }
    activeConnections.delete(info.id);
    users.delete(username);
    saveUsers();
    console.log(`[Registry] Deleted user: ${username} - index.js:161`);
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

function cleanupInactiveUsers() {
  const now = Date.now();
  const cutoff = INACTIVITY_HOURS * 60 * 60 * 1000;
  let deleted = 0;

  for (const [username, info] of users.entries()) {
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
    console.log(`[Cleanup] Deleted ${deleted} inactive users (30 days+) - index.js:197`);
    saveUsers();
  }
}

// ─── In-Memory State ──────────────────────────────────────────────────────────
const users = loadUsers();
const activeConnections = new Map();
const userIdToUsername = new Map();
const accountIdToUsername = new Map();

for (const [username, info] of users.entries()) {
  userIdToUsername.set(info.id, username);
  if (info.accountId) {
    accountIdToUsername.set(info.accountId, username);
  }
}

// ─── Start HTTP Server ────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[HTTP] Server running on port ${PORT} - index.js:217`);
});

// ─── WebSocket Server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

console.log(`[Server] SecTher Server running on port ${PORT} - index.js:223`);
console.log(`[Server] ${users.size} registered users in registry - index.js:224`);

wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[Connect] New connection from: ${clientIp} - index.js:228`);

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

      if (userId) updateLastSeen(userId);

      switch (message.type) {

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
          const accountId = message.accountId || '';

          users.set(username, {
            id: userId,
            accountId: accountId,
            publicKey: message.publicKey,
            registeredAt: existing?.registeredAt || new Date().toISOString(),
            lastSeen: new Date().toISOString(),
          });
          userIdToUsername.set(userId, username);
          if (accountId) {
            accountIdToUsername.set(accountId, username);
          }
          saveUsers();

          activeConnections.set(userId, ws);

          console.log(`[Register] ${username} (${userId}) AccountID: ${accountId} - index.js:278`);

          ws.send(JSON.stringify({
            type: 'registered',
            success: true,
            username: username,
            userId: userId,
          }));

          _broadcastOnlineStatus(userId, username, true);
          break;
        }

        case 'delete_account': {
          if (!userId || !username) return;
          console.log(`[Delete] Account deleted: ${username} - index.js:293`);
          
          const deletedUserInfo = {
            userId: userId,
            username: username,
            accountId: users.get(username)?.accountId || '',
          };
          
          _broadcastUserDeleted(deletedUserInfo);
          _broadcastOnlineStatus(userId, username, false);
          deleteUser(username);
          ws.send(JSON.stringify({ type: 'account_deleted', success: true }));
          break;
        }

        case 'search_user_by_id': {
          const query = (message.accountId || '').trim();
          if (!query) {
            ws.send(JSON.stringify({ type: 'search_result_by_id', found: false, error: 'Account ID required' }));
            return;
          }

          // First try exact accountId match
          let foundUsername = accountIdToUsername.get(query);
          let found = null;

          if (foundUsername) {
            found = users.get(foundUsername);
            ws.send(JSON.stringify({
              type: 'search_result_by_id',
              found: true,
              userId: found.id,
              accountId: found.accountId || '',
              username: foundUsername,
              publicKey: found?.publicKey || '',
              online: activeConnections.has(found.id),
            }));
            return;
          }

          // Also search by username (partial match)
          const lowerQuery = query.toLowerCase();
          for (const [username, userInfo] of users.entries()) {
            if (username.toLowerCase().includes(lowerQuery)) {
              ws.send(JSON.stringify({
                type: 'search_result_by_id',
                found: true,
                userId: userInfo.id,
                accountId: userInfo.accountId || '',
                username: username,
                publicKey: userInfo.publicKey || '',
                online: activeConnections.has(userInfo.id),
              }));
              return;
            }
          }

          // Also search by userId
          const foundByUserId = userIdToUsername.get(query);
          if (foundByUserId) {
            const u = users.get(foundByUserId);
            ws.send(JSON.stringify({
              type: 'search_result_by_id',
              userId: u?.id || query,
              accountId: u?.accountId || '',
              username: foundByUserId,
              publicKey: u?.publicKey || '',
              online: activeConnections.has(u?.id),
            }));
            return;
          }

          // User not found
          ws.send(JSON.stringify({ type: 'search_result_by_id', found: false, error: 'User not found' }));
          break;
        }

        case 'search': {
          const q = (message.query || '').trim();
          const results = [];
          
          if (q.length > 0) {
            const byUserId = userIdToUsername.get(q);
            if (byUserId) {
              const u = users.get(byUserId);
              results.push({
                username: byUserId,
                userId: u?.id || q,
                accountId: u?.accountId || '',
                publicKey: u?.publicKey || '',
                online: activeConnections.has(u?.id || q),
              });
            }
            const byAccountId = accountIdToUsername.get(q);
            if (byAccountId && byAccountId !== byUserId) {
              const u = users.get(byAccountId);
              results.push({
                username: byAccountId,
                userId: u?.id || '',
                accountId: q,
                publicKey: u?.publicKey || '',
                online: activeConnections.has(u?.id),
              });
            }
          }
          ws.send(JSON.stringify({ type: 'search_results', results }));
          break;
        }

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

        case 'reaction':
        case 'remove_reaction': {
          const targetWs = activeConnections.get(message.toUserId);
          if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({ ...message, fromUserId: userId }));
          }
          break;
        }

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

        case 'notify_muted': {
          const mutedWs = activeConnections.get(message.toUserId);
          if (mutedWs && mutedWs.readyState === WebSocket.OPEN) {
            mutedWs.send(JSON.stringify({ type: 'user_muted', byUserId: userId, byUsername: username }));
          }
          break;
        }

        case 'report_user': {
          console.log(`[Report] ${userId} reported ${message.reportedUserId}: ${message.reason} - index.js:509`);
          ws.send(JSON.stringify({ type: 'report_received', success: true }));
          break;
        }

        case 'ping': {
          if (userId) updateLastSeen(userId);
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
        }

        default:
          console.log(`[Unknown] Message type: ${message.type} - index.js:521`);
      }
    } catch (e) {
      console.error('[Error] Processing message: - index.js:524', e.message);
      try { ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' })); } catch (_) {}
    }
  });

  ws.on('close', () => {
    if (userId) {
      updateLastSeen(userId);
      saveUsers();
      activeConnections.delete(userId);
      _broadcastOnlineStatus(userId, username, false);
      console.log(`[Disconnect] ${username} (${userId}) - index.js:535`);
    }
  });

  ws.on('error', (error) => {
    console.error('[WS Error] - index.js:540', error.message);
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

function _broadcastUserDeleted(deletedUserInfo) {
  const deletedMsg = JSON.stringify({
    type: 'user_deleted',
    userId: deletedUserInfo.userId,
    username: deletedUserInfo.username,
    accountId: deletedUserInfo.accountId,
  });
  for (const [, ws] of activeConnections.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(deletedMsg); } catch (_) {}
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

// ─── Cleanup (runs every hour) ───────────────────────────────────────────────
setInterval(() => {
  cleanupInactiveUsers();
}, 60 * 60 * 1000);

setTimeout(cleanupInactiveUsers, 5000);

// ─── Stats (every 5 min) ──────────────────────────────────────────────────────
setInterval(() => {
  console.log(`[Stats] Registered: ${users.size} | Online: ${activeConnections.size} - index.js:599`);
}, 5 * 60 * 1000);

console.log('[Server] Ready for connections - index.js:602');

