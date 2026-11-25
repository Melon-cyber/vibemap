import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VibeStore } from '../server/store.js';

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibemap-test-'));
}

test('VibeStore creates pins, confirms TTL, handles reactions/comments, and deletes cleanly', () => {
  const dir = makeTempDir();
  try {
    const store = new VibeStore({ dataDir: dir });
    assert.equal(store.listPins().length, 0);

    const { pin, authorToken } = store.createPin({
      lat: 43.2389,
      lng: 76.8897,
      title: 'Тихо, есть розетки',
      note: 'Второй этаж у окна',
      category: 'work',
      tags: ['Розетки', 'Wi-Fi'],
      ttlHours: 2,
      authorName: 'Марат',
      imageDataUrl: TINY_PNG_DATA_URL
    });

    assert.equal(pin.confirmations, 1);
    assert.ok(pin.photoUrl.startsWith('/uploads/'));
    assert.equal(pin.authorToken, undefined);

    const imgFile = path.join(dir, 'uploads', path.basename(pin.photoUrl));
    assert.ok(fs.existsSync(imgFile));

    const prevExpires = pin.expiresAt;
    const confirmed = store.confirmPin(pin.id);
    assert.equal(confirmed.confirmations, 2);
    assert.ok(confirmed.expiresAt > prevExpires);

    const reacted = store.addReaction(pin.id, '🔥');
    assert.equal(reacted.reactions['🔥'], 1);

    const commented = store.addComment(pin.id, { authorName: 'Аня', text: 'Иду!' });
    assert.equal(commented.comments.length, 1);

    // Wrong author token -> 403
    assert.throws(
      () => store.deletePin(pin.id, { authorToken: 'bad-token' }),
      (err) => err.statusCode === 403
    );

    // Valid delete removes pin and photo file
    const delRes = store.deletePin(pin.id, { authorToken });
    assert.equal(delRes.removed, true);
    assert.equal(store.listPins().length, 0);
    assert.ok(!fs.existsSync(imgFile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('VibeStore prunes expired pins and removes after 2 ended flags', () => {
  const dir = makeTempDir();
  try {
    const store = new VibeStore({ dataDir: dir });
    const { pin: p1 } = store.createPin({
      lat: 55.75,
      lng: 37.61,
      title: 'Концерт на набережной',
      category: 'music',
      ttlHours: 1
    });

    const firstFlag = store.flagEnded(p1.id);
    assert.equal(firstFlag.removed, false);
    const secondFlag = store.flagEnded(p1.id);
    assert.equal(secondFlag.removed, true);
    assert.equal(store.getPin(p1.id), null);

    const { pin: p2 } = store.createPin({
      lat: 55.75,
      lng: 37.61,
      title: 'Закат',
      category: 'view',
      ttlHours: 1
    });
    store.pins[0].expiresAt = Date.now() - 500;
    assert.equal(store.listPins().length, 0);
    assert.equal(store.getPin(p2.id), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
