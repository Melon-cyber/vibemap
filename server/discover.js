const CACHE_TTL_MS = 15 * 60 * 1000;
const areaCache = new Map();

const OVERPASS_MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];

function mapWeatherCode(code) {
  if (code === 0) return { icon: '☀️', label: 'Ясно' };
  if (code === 1 || code === 2) return { icon: '⛅', label: 'Облачно' };
  if (code === 3) return { icon: '☁️', label: 'Пасмурно' };
  if (code === 45 || code === 48) return { icon: '🌫️', label: 'Туман' };
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return { icon: '🌧️', label: 'Дождь' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: '❄️', label: 'Снег' };
  if (code >= 95) return { icon: '⛈️', label: 'Гроза' };
  return { icon: '🌡️', label: 'Погода' };
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWeather(lat, lng, fetchImpl) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lng)}&current=temperature_2m,weather_code,wind_speed_10m` +
    `&daily=sunset&timezone=auto&forecast_days=1`;
  const res = await fetchWithTimeout(fetchImpl, url, {}, 6000);
  if (!res.ok) throw new Error(`Weather HTTP ${res.status}`);
  const data = await res.json();
  const cur = data.current || {};
  const mapped = mapWeatherCode(cur.weather_code);
  const rawSunset = data.daily?.sunset?.[0] || '';
  const sunsetTime = rawSunset.includes('T') ? rawSunset.split('T')[1].slice(0, 5) : null;
  return {
    temp: typeof cur.temperature_2m === 'number' ? Math.round(cur.temperature_2m) : null,
    wind: typeof cur.wind_speed_10m === 'number' ? Math.round(cur.wind_speed_10m) : null,
    icon: mapped.icon,
    label: mapped.label,
    sunsetTime
  };
}

function classifyOsmTags(tags = {}) {
  const amenity = tags.amenity || '';
  const tourism = tags.tourism || '';
  const leisure = tags.leisure || '';

  if (amenity === 'cafe' || amenity === 'coworking_space' || amenity === 'library') {
    return {
      category: 'work',
      kindLabel: amenity === 'cafe' ? 'Кофейня' : amenity === 'library' ? 'Библиотека' : 'Коворкинг'
    };
  }
  if (amenity === 'bar' || amenity === 'pub' || amenity === 'cinema') {
    return {
      category: 'music',
      kindLabel: amenity === 'cinema' ? 'Кино' : 'Бар / Паб'
    };
  }
  if (amenity === 'restaurant' || amenity === 'fast_food') {
    return {
      category: 'food',
      kindLabel: amenity === 'restaurant' ? 'Ресторан' : 'Стритфуд'
    };
  }
  if (tourism === 'viewpoint' || tourism === 'museum' || tourism === 'gallery' || tourism === 'attraction') {
    return {
      category: 'view',
      kindLabel: tourism === 'viewpoint' ? 'Смотровая' : tourism === 'museum' ? 'Музей' : 'Интересное место'
    };
  }
  if (leisure === 'park' || leisure === 'garden') {
    return { category: 'view', kindLabel: 'Парк' };
  }
  return { category: 'other', kindLabel: 'Место' };
}

function deriveOsmTags(tags = {}) {
  const out = [];
  if (tags.internet_access === 'wlan' || tags.internet_access === 'yes' || tags.wifi === 'yes') {
    out.push('Wi-Fi');
  }
  if (tags.outdoor_seating === 'yes') out.push('Веранда');
  if (tags.takeaway === 'yes') out.push('С собой');
  if (tags.cuisine) {
    const first = String(tags.cuisine).split(';')[0].replace(/_/g, ' ').trim();
    if (first) out.push(first.slice(0, 20));
  }
  return out.slice(0, 4);
}

function safeHttpUrl(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

async function fetchOsmPlaces(lat, lng, fetchImpl) {
  const query =
    `[out:json][timeout:8];(` +
    `node[amenity~"^(cafe|bar|pub|restaurant|fast_food|cinema|library|coworking_space)$"][name](around:1300,${lat},${lng});` +
    `node[tourism~"^(viewpoint|museum|gallery|attraction)$"][name](around:1800,${lat},${lng});` +
    `node[leisure~"^(park|garden)$"][name](around:1800,${lat},${lng});` +
    `);out body 35;`;

  let payload = null;
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const res = await fetchWithTimeout(
        fetchImpl,
        mirror,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'VibeMap/1.0'
          },
          body: `data=${encodeURIComponent(query)}`
        },
        7500
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data?.elements)) {
        payload = data.elements;
        break;
      }
    } catch {
      // try next mirror
    }
  }

  if (!payload) return [];

  return payload
    .filter((el) => Number.isFinite(el.lat) && Number.isFinite(el.lon) && el.tags?.name)
    .map((el) => {
      const tags = el.tags;
      const { category, kindLabel } = classifyOsmTags(tags);
      const address = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(', ');
      const derivedTags = deriveOsmTags(tags);
      const summaryParts = [kindLabel];
      if (address) summaryParts.push(address);
      if (tags.opening_hours) summaryParts.push(`Часы: ${tags.opening_hours}`);

      return {
        id: `osm-${el.id}`,
        source: 'osm',
        lat: Number(el.lat.toFixed(6)),
        lng: Number(el.lon.toFixed(6)),
        title: String(tags.name).trim().slice(0, 80),
        category,
        kindLabel,
        address: address || null,
        openingHours: tags.opening_hours || null,
        cuisine: tags.cuisine || null,
        website: safeHttpUrl(tags.website || tags['contact:website']),
        tags: derivedTags,
        description: summaryParts.join(' · '),
        photoUrl: null,
        wikiUrl: null
      };
    });
}

async function fetchWikiPlaces(lat, lng, fetchImpl) {
  const url =
    `https://ru.wikipedia.org/w/api.php?action=query&generator=geosearch` +
    `&ggscoord=${encodeURIComponent(lat)}|${encodeURIComponent(lng)}` +
    `&ggsradius=4000&ggslimit=12&prop=coordinates|extracts|pageimages|info` +
    `&inprop=url&exintro=1&explaintext=1&exsentences=2&piprop=thumbnail&pithumbsize=520&format=json`;

  const res = await fetchWithTimeout(
    fetchImpl,
    url,
    { headers: { 'User-Agent': 'VibeMap/1.0' } },
    6500
  );
  if (!res.ok) throw new Error(`Wiki HTTP ${res.status}`);
  const data = await res.json();
  const pages = Object.values(data?.query?.pages || {});

  return pages
    .filter((p) => p.coordinates?.[0] && p.title)
    .slice(0, 10)
    .map((p) => {
      const coord = p.coordinates[0];
      return {
        id: `wiki-${p.pageid}`,
        source: 'wiki',
        lat: Number(coord.lat.toFixed(6)),
        lng: Number(coord.lon.toFixed(6)),
        title: String(p.title).trim().slice(0, 80),
        category: 'view',
        kindLabel: 'Википедия',
        address: null,
        openingHours: null,
        cuisine: null,
        website: null,
        tags: ['Локация'],
        description: String(p.extract || 'Интересный объект поблизости.').trim().slice(0, 260),
        photoUrl: safeHttpUrl(p.thumbnail?.source),
        wikiUrl: safeHttpUrl(p.fullurl)
      };
    });
}

export async function discoverArea({ lat, lng, fetchImpl = fetch } = {}) {
  const numLat = Number(lat);
  const numLng = Number(lng);
  if (!Number.isFinite(numLat) || !Number.isFinite(numLng)) {
    throw new Error('Некорректные координаты');
  }

  const cacheKey = `${numLat.toFixed(2)},${numLng.toFixed(2)}`;
  const cached = areaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() && fetchImpl === fetch) {
    return cached.data;
  }

  const [weatherRes, osmRes, wikiRes] = await Promise.allSettled([
    fetchWeather(numLat, numLng, fetchImpl),
    fetchOsmPlaces(numLat, numLng, fetchImpl),
    fetchWikiPlaces(numLat, numLng, fetchImpl)
  ]);

  const weather = weatherRes.status === 'fulfilled' ? weatherRes.value : null;
  const osmPlaces = osmRes.status === 'fulfilled' ? osmRes.value : [];
  const wikiPlaces = wikiRes.status === 'fulfilled' ? wikiRes.value : [];

  const seenTitles = new Set();
  const places = [];
  for (const place of [...osmPlaces, ...wikiPlaces]) {
    const key = place.title.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    places.push(place);
  }

  const result = { weather, places };
  if (fetchImpl === fetch && (weather || places.length > 0)) {
    areaCache.set(cacheKey, {
      data: result,
      expiresAt: Date.now() + CACHE_TTL_MS
    });
  }
  return result;
}
