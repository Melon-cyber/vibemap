import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createAppServer } from '../server/index.js';

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function nextWsMsg(ws, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS timeout')), 4000);
    function onMsg(raw) {
      const msg = JSON.parse(raw.toString());
      if (predicate(msg)) {
        clearTimeout(t);
        ws.off('message', onMsg);
        resolve(msg);
      }
    }
    ws.on('message', onMsg);
  });
}

test('VibeMap HTTP API, discover, place reviews, and WebSocket broadcasts work end-to-end', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibemap-srv-'));
  const stubDiscover = async () => ({
    weather: { temp: 6, icon: '☁️', label: 'Пасмурно', sunsetTime: '16:20' },
    places: [
      {
        id: 'osm-999',
        source: 'osm',
        lat: 43.24,
        lng: 76.9,
        title: 'Кофейня Тест',
        category: 'work',
        kindLabel: 'Кофейня',
        tags: ['Wi-Fi'],
        description: 'Кофейня'
      }
    ]
  });

  const appServer = createAppServer({ dataDir, discoverFn: stubDiscover });
  await new Promise((resolve) => appServer.server.listen(0, '127.0.0.1', resolve));
  const { port } = appServer.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  try {
    const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.activePins, 0);

    // Place review + discover summary enrichment
    const revEventPromise = nextWsMsg(ws, (m) => m.type === 'place_review_added');
    const revRes = await fetch(`${baseUrl}/api/places/osm-999/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 5, text: 'Супер место', authorName: 'Саня' })
    });
    assert.equal(revRes.status, 201);
    const revMsg = await revEventPromise;
    assert.equal(revMsg.summary.avgRating, 5);

    const discoverData = await fetch(`${baseUrl}/api/discover?lat=43.24&lng=76.9`).then((r) => r.json());
    assert.equal(discoverData.weather.temp, 6);
    assert.equal(discoverData.places[0].reviewCount, 1);
    assert.equal(discoverData.places[0].avgRating, 5);

    const createdPromise = nextWsMsg(ws, (m) => m.type === 'pin_created');
    const createRes = await fetch(`${baseUrl}/api/pins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lat: 43.24,
        lng: 76.9,
        title: 'Есть свободные места',
        category: 'work',
        tags: ['Wi-Fi', 'Розетки'],
        ttlHours: 3,
        imageDataUrl: TINY_PNG_DATA_URL
      })
    });
    assert.equal(createRes.status, 201);
    const created = await createRes.json();
    const createdMsg = await createdPromise;
    assert.equal(createdMsg.pin.id, created.pin.id);

    const imgRes = await fetch(`${baseUrl}${created.pin.photoUrl}`);
    assert.equal(imgRes.status, 200);

    const updatedPromise = nextWsMsg(ws, (m) => m.type === 'pin_updated');
    await fetch(`${baseUrl}/api/pins/${created.pin.id}/confirm`, { method: 'POST' });
    const updatedMsg = await updatedPromise;
    assert.equal(updatedMsg.pin.confirmations, 2);

    const removedPromise = nextWsMsg(ws, (m) => m.type === 'pin_removed');
    const delRes = await fetch(`${baseUrl}/api/pins/${created.pin.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorToken: created.authorToken })
    });
    assert.equal(delRes.status, 200);
    const removedMsg = await removedPromise;
    assert.equal(removedMsg.id, created.pin.id);
  } finally {
    ws.close();
    await appServer.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
