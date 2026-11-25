import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REACTIONS, TTL_OPTIONS, VIBE_CATEGORY_MAP, VIBE_TAGS } from '../shared/vibes.js';

const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
const MAX_TTL_MS = 6 * 3600 * 1000;
const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};

function createHttpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

export class VibeStore {
  constructor({ dataDir } = {}) {
    if (!dataDir) {
      throw new Error('dataDir is required');
    }
    this.dataDir = dataDir;
    this.uploadsDir = path.join(dataDir, 'uploads');
    this.storeFile = path.join(dataDir, 'store.json');

    fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.pins = [];
    this.load();
  }

  load() {
    if (fs.existsSync(this.storeFile)) {
      try {
        const raw = fs.readFileSync(this.storeFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.pins)) {
          this.pins = parsed.pins;
        }
      } catch {
        this.pins = [];
      }
    }
  }

  save() {
    const tmpPath = `${this.storeFile}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify({ pins: this.pins }, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.storeFile);
  }

  deletePhotoFile(photoUrl) {
    if (!photoUrl || !photoUrl.startsWith('/uploads/')) return;
    const filePath = path.join(this.uploadsDir, path.basename(photoUrl));
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // ignore cleanup error
    }
  }

  pruneExpired() {
    const now = Date.now();
    const removedIds = [];
    const kept = [];

    for (const pin of this.pins) {
      if (pin.expiresAt <= now || pin.endedVotes >= 2) {
        removedIds.push(pin.id);
        this.deletePhotoFile(pin.photoUrl);
      } else {
        kept.push(pin);
      }
    }

    if (removedIds.length > 0) {
      this.pins = kept;
      this.save();
    }
    return removedIds;
  }

  generateId() {
    const existing = new Set(this.pins.map((p) => p.id));
    for (let i = 0; i < 100; i++) {
      let id = '';
      for (let j = 0; j < 8; j++) {
        id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
      }
      if (!existing.has(id)) return id;
    }
    throw new Error('Не удалось сгенерировать ID метки');
  }

  findRaw(id) {
    const clean = String(id || '').trim().toUpperCase();
    return this.pins.find((p) => p.id === clean) || null;
  }

  sanitizePin(pin) {
    return {
      id: pin.id,
      lat: pin.lat,
      lng: pin.lng,
      title: pin.title,
      note: pin.note,
      category: pin.category,
      tags: [...pin.tags],
      authorName: pin.authorName,
      photoUrl: pin.photoUrl,
      createdAt: pin.createdAt,
      expiresAt: pin.expiresAt,
      confirmations: pin.confirmations,
      endedVotes: pin.endedVotes,
      reactions: { ...pin.reactions },
      comments: pin.comments.map((c) => ({ ...c }))
    };
  }

  savePhoto(imageDataUrl) {
    if (!imageDataUrl) return null;
    const str = String(imageDataUrl).trim();
    const match = str.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) {
      throw createHttpError('Поддерживаются только фото JPG, PNG или WebP', 400);
    }
    const ext = MIME_EXT[match[1].toLowerCase()];
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length === 0) throw createHttpError('Пустой файл изображения', 400);
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw createHttpError('Фото слишком большое (максимум 2.5 МБ)', 400);
    }
    const filename = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(this.uploadsDir, filename), buffer);
    return `/uploads/${filename}`;
  }

  listPins({ category = 'all' } = {}) {
    this.pruneExpired();
    let list = [...this.pins];
    if (category && category !== 'all') {
      list = list.filter((p) => p.category === category);
    }
    list.sort((a, b) => b.createdAt - a.createdAt);
    return list.map((p) => this.sanitizePin(p));
  }

  getPin(id) {
    this.pruneExpired();
    const pin = this.findRaw(id);
    return pin ? this.sanitizePin(pin) : null;
  }

  createPin({
    lat,
    lng,
    title,
    note = '',
    category = 'other',
    tags = [],
    ttlHours = 3,
    authorName = '',
    imageDataUrl = null
  } = {}) {
    this.pruneExpired();

    const numLat = Number(lat);
    const numLng = Number(lng);
    if (!Number.isFinite(numLat) || numLat < -90 || numLat > 90) {
      throw createHttpError('Некорректная широта', 400);
    }
    if (!Number.isFinite(numLng) || numLng < -180 || numLng > 180) {
      throw createHttpError('Некорректная долгота', 400);
    }

    const cleanTitle = String(title || '').trim().slice(0, 80);
    if (!cleanTitle) {
      throw createHttpError('Укажи короткий заголовок метки', 400);
    }

    const cleanCategory = Object.prototype.hasOwnProperty.call(VIBE_CATEGORY_MAP, category)
      ? category
      : 'other';

    const cleanTags = Array.isArray(tags)
      ? [...new Set(tags.filter((t) => VIBE_TAGS.includes(t)))].slice(0, 5)
      : [];

    const ttl = TTL_OPTIONS.includes(Number(ttlHours)) ? Number(ttlHours) : 3;
    const cleanNote = String(note || '').trim().slice(0, 240);
    const cleanAuthor = String(authorName || '').trim().slice(0, 24) || 'Аноним';
    const photoUrl = this.savePhoto(imageDataUrl);

    const now = Date.now();
    const id = this.generateId();
    const authorToken = crypto.randomUUID();
    const reactions = {};
    for (const r of REACTIONS) reactions[r] = 0;

    const pin = {
      id,
      lat: Number(numLat.toFixed(6)),
      lng: Number(numLng.toFixed(6)),
      title: cleanTitle,
      note: cleanNote,
      category: cleanCategory,
      tags: cleanTags,
      authorName: cleanAuthor,
      photoUrl,
      createdAt: now,
      expiresAt: now + ttl * 3600 * 1000,
      confirmations: 1,
      endedVotes: 0,
      authorToken,
      reactions,
      comments: []
    };

    this.pins.unshift(pin);
    this.save();
    return { pin: this.sanitizePin(pin), authorToken };
  }

  confirmPin(id) {
    this.pruneExpired();
    const pin = this.findRaw(id);
    if (!pin) throw createHttpError('Метка не найдена или уже исчезла', 404);

    pin.confirmations += 1;
    const cap = Date.now() + MAX_TTL_MS;
    pin.expiresAt = Math.min(cap, pin.expiresAt + 30 * 60 * 1000);
    this.save();
    return this.sanitizePin(pin);
  }

  flagEnded(id) {
    this.pruneExpired();
    const pin = this.findRaw(id);
    if (!pin) throw createHttpError('Метка не найдена', 404);

    pin.endedVotes += 1;
    if (pin.endedVotes >= 2) {
      this.pins = this.pins.filter((p) => p.id !== pin.id);
      this.deletePhotoFile(pin.photoUrl);
      this.save();
      return { removed: true, id: pin.id };
    }
    this.save();
    return { removed: false, pin: this.sanitizePin(pin) };
  }

  deletePin(id, { authorToken } = {}) {
    this.pruneExpired();
    const pin = this.findRaw(id);
    if (!pin) throw createHttpError('Метка не найдена', 404);
    if (!authorToken || pin.authorToken !== authorToken) {
      throw createHttpError('Удалить метку может только её автор', 403);
    }

    this.pins = this.pins.filter((p) => p.id !== pin.id);
    this.deletePhotoFile(pin.photoUrl);
    this.save();
    return { removed: true, id: pin.id };
  }

  addReaction(id, emoji) {
    this.pruneExpired();
    const pin = this.findRaw(id);
    if (!pin) throw createHttpError('Метка не найдена', 404);
    if (!REACTIONS.includes(emoji)) throw createHttpError('Неизвестная реакция', 400);

    pin.reactions[emoji] = (pin.reactions[emoji] || 0) + 1;
    this.save();
    return this.sanitizePin(pin);
  }

  addComment(id, { authorName = '', text } = {}) {
    this.pruneExpired();
    const pin = this.findRaw(id);
    if (!pin) throw createHttpError('Метка не найдена', 404);
    const cleanText = String(text || '').trim().slice(0, 200);
    if (!cleanText) throw createHttpError('Напиши текст комментария', 400);

    pin.comments.push({
      id: crypto.randomUUID(),
      authorName: String(authorName || '').trim().slice(0, 24) || 'Прохожий',
      text: cleanText,
      createdAt: Date.now()
    });
    if (pin.comments.length > 60) {
      pin.comments = pin.comments.slice(-60);
    }
    this.save();
    return this.sanitizePin(pin);
  }
}
