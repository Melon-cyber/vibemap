export const VIBE_CATEGORIES = [
  { id: 'work', icon: '☕', label: 'Тихо поработать', short: 'Тихо', color: '#38bdf8' },
  { id: 'music', icon: '🎵', label: 'Движ / музыка', short: 'Движ', color: '#a78bfa' },
  { id: 'view', icon: '🌅', label: 'Красивый вид', short: 'Вид', color: '#fbbf24' },
  { id: 'crowd', icon: '⏳', label: 'Очередь / забито', short: 'Очередь', color: '#ef4444' },
  { id: 'food', icon: '🍔', label: 'Вкусно / свободно', short: 'Еда', color: '#22c55e' },
  { id: 'hangout', icon: '👋', label: 'Сидим здесь', short: 'Сбор', color: '#f472b6' },
  { id: 'weather', icon: '☔', label: 'Погода / место', short: 'Погода', color: '#60a5fa' },
  { id: 'other', icon: '✨', label: 'Другое', short: 'Другое', color: '#e4e4e7' }
];

export const VIBE_CATEGORY_MAP = Object.fromEntries(VIBE_CATEGORIES.map((c) => [c.id, c]));

export const VIBE_TAGS = [
  'Розетки',
  'Wi-Fi',
  'Есть места',
  'Тихо',
  'Людно',
  'Живой звук',
  'Веранда',
  'Вкусный кофе'
];

export const REACTIONS = ['🔥', '👍', '👀', '❤️'];

export const TTL_OPTIONS = [1, 2, 3, 6];

export const CITY_PRESETS = [
  { name: 'Алматы', lat: 43.2389, lng: 76.8897, zoom: 13 },
  { name: 'Астана', lat: 51.1694, lng: 71.4491, zoom: 13 },
  { name: 'Москва', lat: 55.7558, lng: 37.6173, zoom: 12 },
  { name: 'Санкт-Петербург', lat: 59.9343, lng: 30.3351, zoom: 12 },
  { name: 'Стамбул', lat: 41.0082, lng: 28.9784, zoom: 12 },
  { name: 'Дубай', lat: 25.2048, lng: 55.2708, zoom: 12 }
];
