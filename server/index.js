import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { VibeStore } from './store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export function createAppServer({ dataDir } = {}) {
  const resolvedDataDir = dataDir || process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
  const store = new VibeStore({ dataDir: resolvedDataDir });

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  app.set('trust proxy', 1);
  app.use(express.json({ limit: '4mb' }));
  app.use('/shared', express.static(path.join(ROOT_DIR, 'shared')));
  app.use('/uploads', express.static(store.uploadsDir));
  app.use(express.static(path.join(ROOT_DIR, 'public')));

  function broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  function wrap(handler) {
    return (req, res) => {
      try {
        handler(req, res);
      } catch (err) {
        const status = err.statusCode || 400;
        res.status(status).json({ error: err.message || 'Ошибка сервера' });
      }
    };
  }

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, activePins: store.listPins().length });
  });

  app.get(
    '/api/pins',
    wrap((req, res) => {
      res.json({ pins: store.listPins({ category: req.query.category }) });
    })
  );

  app.get(
    '/api/pins/:id',
    wrap((req, res) => {
      const pin = store.getPin(req.params.id);
      if (!pin) return res.status(404).json({ error: 'Метка не найдена или истекла' });
      return res.json({ pin });
    })
  );

  app.post(
    '/api/pins',
    wrap((req, res) => {
      const result = store.createPin(req.body);
      broadcast({ type: 'pin_created', pin: result.pin });
      res.status(201).json(result);
    })
  );

  app.post(
    '/api/pins/:id/confirm',
    wrap((req, res) => {
      const pin = store.confirmPin(req.params.id);
      broadcast({ type: 'pin_updated', pin });
      res.json({ pin });
    })
  );

  app.post(
    '/api/pins/:id/ended',
    wrap((req, res) => {
      const result = store.flagEnded(req.params.id);
      if (result.removed) {
        broadcast({ type: 'pin_removed', id: result.id });
      } else {
        broadcast({ type: 'pin_updated', pin: result.pin });
      }
      res.json(result);
    })
  );

  app.delete(
    '/api/pins/:id',
    wrap((req, res) => {
      const authorToken = req.body?.authorToken || req.get('x-author-token');
      const result = store.deletePin(req.params.id, { authorToken });
      broadcast({ type: 'pin_removed', id: result.id });
      res.json(result);
    })
  );

  app.post(
    '/api/pins/:id/reactions',
    wrap((req, res) => {
      const pin = store.addReaction(req.params.id, req.body?.emoji);
      broadcast({ type: 'pin_updated', pin });
      res.json({ pin });
    })
  );

  app.post(
    '/api/pins/:id/comments',
    wrap((req, res) => {
      const pin = store.addComment(req.params.id, req.body);
      broadcast({ type: 'pin_updated', pin });
      res.json({ pin });
    })
  );

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
  });

  const heartbeatTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 25_000);
  heartbeatTimer.unref();

  const pruneTimer = setInterval(() => {
    const removed = store.pruneExpired();
    for (const id of removed) {
      broadcast({ type: 'pin_removed', id });
    }
  }, 60_000);
  pruneTimer.unref();

  return {
    app,
    server,
    wss,
    store,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeatTimer);
        clearInterval(pruneTimer);
        wss.close(() => server.close(resolve));
      })
  };
}

function getLocalLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const PORT = Number(process.env.PORT || 3002);
  const appServer = createAppServer();
  appServer.server.listen(PORT, '0.0.0.0', () => {
    const lanIp = getLocalLanIp();
    console.log(`VibeMap запущен: http://localhost:${PORT}`);
    if (lanIp) {
      console.log(`В локальной Wi-Fi сети: http://${lanIp}:${PORT}`);
    }
  });

  const shutdown = async () => {
    await appServer.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
