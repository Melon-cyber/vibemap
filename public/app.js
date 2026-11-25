import {
  CITY_PRESETS,
  REACTIONS,
  TTL_OPTIONS,
  VIBE_CATEGORIES,
  VIBE_CATEGORY_MAP,
  VIBE_TAGS
} from '/shared/vibes.js';

const TOKENS_KEY = 'vibemap-tokens';
const L = window.L;

const state = {
  map: null,
  vibeMarkers: new Map(),
  placeMarkers: new Map(),
  draftMarker: null,
  pins: [],
  places: [],
  weather: null,
  lastDiscoverCenter: null,
  filterCategory: 'all',
  listTab: 'places', // 'places' | 'vibes'
  dropMode: false,
  selectedType: null, // 'pin' | 'place'
  selectedId: null,
  selectedRating: 5,
  draftLatLng: null,
  draftPhotoDataUrl: null,
  createForm: {
    category: 'work',
    tags: new Set(),
    ttlHours: 3
  }
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(text, isError = false) {
  const container = $('toast-container');
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.textContent = text;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

function loadTokens() {
  try {
    return JSON.parse(localStorage.getItem(TOKENS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveAuthorToken(id, token) {
  const all = loadTokens();
  all[id] = token;
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

function getAuthorToken(id) {
  return loadTokens()[id] || null;
}

function formatRemaining(expiresAt) {
  const diff = expiresAt - Date.now();
  if (diff <= 0) return 'истекла';
  const totalMin = Math.floor(diff / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `ещё ${h}ч ${m}м` : `ещё ${m}м`;
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Некорректное изображение'));
      img.onload = () => {
        const maxSide = 960;
        let { width, height } = img;
        if (width > maxSide || height > maxSide) {
          if (width >= height) {
            height = Math.round((height * maxSide) / width);
            width = maxSide;
          } else {
            width = Math.round((width * maxSide) / height);
            height = maxSide;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// === MAP ===

function initMap() {
  const def = CITY_PRESETS[0];
  state.map = L.map('map', { zoomControl: false }).setView([def.lat, def.lng], def.zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(state.map);

  state.map.on('click', (e) => {
    if (state.dropMode || !$('sheet-create').classList.contains('hidden')) {
      openCreateSheetAt(e.latlng.lat, e.latlng.lng);
      setDropMode(false);
    }
  });

  state.map.on('moveend', () => {
    if (!state.lastDiscoverCenter) return;
    const c = state.map.getCenter();
    const dist = state.map.distance(c, L.latLng(state.lastDiscoverCenter.lat, state.lastDiscoverCenter.lng));
    $('btn-search-area').classList.toggle('hidden', dist < 1100);
  });
}

function setDropMode(active) {
  state.dropMode = active;
  $('drop-banner').classList.toggle('hidden', !active);
  if (active) {
    $('sheet-detail').classList.add('hidden');
    $('sheet-list').classList.add('hidden');
  }
}

function getFilteredPins() {
  return state.filterCategory === 'all'
    ? state.pins
    : state.pins.filter((p) => p.category === state.filterCategory);
}

function getFilteredPlaces() {
  return state.filterCategory === 'all'
    ? state.places
    : state.places.filter((p) => p.category === state.filterCategory);
}

function syncMarkers() {
  const visiblePins = getFilteredPins();
  const visiblePlaces = getFilteredPlaces();

  // 1. Discovered real places (OSM + Wikipedia)
  const placeIds = new Set(visiblePlaces.map((p) => p.id));
  for (const [id, marker] of state.placeMarkers.entries()) {
    if (!placeIds.has(id)) {
      marker.remove();
      state.placeMarkers.delete(id);
    }
  }
  for (const place of visiblePlaces) {
    const cat = VIBE_CATEGORY_MAP[place.category] || VIBE_CATEGORY_MAP.other;
    const icon = L.divIcon({
      className: '',
      html: `<div class="place-marker">${escapeHtml(cat.icon)}</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
    if (state.placeMarkers.has(place.id)) {
      const m = state.placeMarkers.get(place.id);
      m.setLatLng([place.lat, place.lng]);
    } else {
      const marker = L.marker([place.lat, place.lng], { icon }).addTo(state.map);
      marker.bindTooltip(`${escapeHtml(place.title)} · ${escapeHtml(place.kindLabel)}`, {
        direction: 'top',
        offset: [0, -12]
      });
      marker.on('click', () => openPlaceDetailSheet(place.id));
      state.placeMarkers.set(place.id, marker);
    }
  }

  // 2. Live ephemeral vibe pins (on top)
  const pinIds = new Set(visiblePins.map((p) => p.id));
  for (const [id, marker] of state.vibeMarkers.entries()) {
    if (!pinIds.has(id)) {
      marker.remove();
      state.vibeMarkers.delete(id);
    }
  }
  for (const pin of visiblePins) {
    const cat = VIBE_CATEGORY_MAP[pin.category] || VIBE_CATEGORY_MAP.other;
    const icon = L.divIcon({
      className: '',
      html: `<div class="vibe-marker" style="border-color:${cat.color}">${escapeHtml(cat.icon)}</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    });
    if (state.vibeMarkers.has(pin.id)) {
      const m = state.vibeMarkers.get(pin.id);
      m.setLatLng([pin.lat, pin.lng]);
      m.setIcon(icon);
    } else {
      const marker = L.marker([pin.lat, pin.lng], { icon, zIndexOffset: 500 }).addTo(state.map);
      marker.bindTooltip(escapeHtml(pin.title), { direction: 'top', offset: [0, -16] });
      marker.on('click', () => openPinDetailSheet(pin.id));
      state.vibeMarkers.set(pin.id, marker);
    }
  }

  const total = visiblePins.length + visiblePlaces.length;
  $('live-count').textContent = String(total);
  $('list-count').textContent = String(total);
  $('tab-list-places').textContent = `Места (${visiblePlaces.length})`;
  $('tab-list-vibes').textContent = `Вайбы (${visiblePins.length})`;
  renderListSheet(visiblePlaces, visiblePins);
}

// === DISCOVER AREA (WEATHER + OSM + WIKI) ===

async function loadDiscoverArea(lat, lng) {
  state.lastDiscoverCenter = { lat, lng };
  $('btn-search-area').classList.add('hidden');
  try {
    const data = await api(`/api/discover?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`);
    state.weather = data.weather;
    state.places = data.places || [];
    renderWeather();
    syncMarkers();
  } catch {
    // non-fatal if upstream geo API is slow
  }
}

function renderWeather() {
  const pill = $('weather-pill');
  if (!state.weather || state.weather.temp === null) {
    pill.classList.add('hidden');
    return;
  }
  const sign = state.weather.temp > 0 ? '+' : '';
  const sunsetPart = state.weather.sunsetTime ? ` · закат ${state.weather.sunsetTime}` : '';
  pill.textContent = `${state.weather.icon} ${sign}${state.weather.temp}°${sunsetPart}`;
  pill.classList.remove('hidden');
}

// === SHEETS ===

function openCreateSheetAt(lat, lng, preset = {}) {
  state.draftLatLng = { lat, lng };
  if (state.draftMarker) state.draftMarker.remove();
  const icon = L.divIcon({
    className: '',
    html: '<div class="draft-marker"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
  state.draftMarker = L.marker([lat, lng], { icon }).addTo(state.map);

  if (preset.title) $('p-title').value = preset.title;
  if (preset.category && VIBE_CATEGORY_MAP[preset.category]) {
    state.createForm.category = preset.category;
    renderCreateChips();
  }

  $('create-coords-hint').textContent = `Точка: ${lat.toFixed(4)}, ${lng.toFixed(4)} (можно кликнуть на другое место)`;
  $('sheet-detail').classList.add('hidden');
  $('sheet-list').classList.add('hidden');
  $('sheet-create').classList.remove('hidden');
}

function closeCreateSheet() {
  $('sheet-create').classList.add('hidden');
  if (state.draftMarker) {
    state.draftMarker.remove();
    state.draftMarker = null;
  }
}

function renderCreateChips() {
  $('create-categories').innerHTML = VIBE_CATEGORIES.map(
    (c) => `<button type="button" class="chip${c.id === state.createForm.category ? ' active' : ''}" data-cat="${c.id}">${escapeHtml(c.icon)} ${escapeHtml(c.short)}</button>`
  ).join('');

  $('create-tags').innerHTML = VIBE_TAGS.map(
    (t) => `<button type="button" class="chip${state.createForm.tags.has(t) ? ' active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`
  ).join('');

  $('create-ttl').innerHTML = TTL_OPTIONS.map(
    (h) => `<button type="button" class="chip${h === state.createForm.ttlHours ? ' active' : ''}" data-ttl="${h}">${h}ч</button>`
  ).join('');
}

function renderListSheet(visiblePlaces, visiblePins) {
  const body = $('vibes-list');

  if (state.listTab === 'vibes') {
    if (visiblePins.length === 0) {
      body.innerHTML = '<p class="muted">Пока нет живых вайбов. Отметь что-нибудь рядом или нажми на любое место на карте.</p>';
      return;
    }
    body.innerHTML = visiblePins
      .map((pin) => {
        const cat = VIBE_CATEGORY_MAP[pin.category] || VIBE_CATEGORY_MAP.other;
        return `
          <div class="list-item" data-pin-id="${escapeHtml(pin.id)}">
            <div class="list-item-top">
              <span>${escapeHtml(cat.icon)} ${escapeHtml(cat.label)}</span>
              <span class="ttl-tick" data-expires="${pin.expiresAt}">${escapeHtml(formatRemaining(pin.expiresAt))}</span>
            </div>
            <div style="font-weight:600;">${escapeHtml(pin.title)}</div>
          </div>`;
      })
      .join('');

    body.querySelectorAll('.list-item').forEach((item) => {
      item.addEventListener('click', () => {
        const pin = state.pins.find((p) => p.id === item.dataset.pinId);
        if (pin) {
          state.map.flyTo([pin.lat, pin.lng], Math.max(state.map.getZoom(), 15), { duration: 0.5 });
          openPinDetailSheet(pin.id);
        }
      });
    });
    return;
  }

  if (visiblePlaces.length === 0) {
    body.innerHTML = '<p class="muted">Места загружаются или сдвинь карту и нажми «Обновить места здесь».</p>';
    return;
  }

  body.innerHTML = visiblePlaces
    .map((place) => {
      const cat = VIBE_CATEGORY_MAP[place.category] || VIBE_CATEGORY_MAP.other;
      const ratingBadge = place.avgRating ? `★ ${place.avgRating} (${place.reviewCount})` : place.kindLabel;
      return `
        <div class="list-item" data-place-id="${escapeHtml(place.id)}">
          <div class="list-item-top">
            <span>${escapeHtml(cat.icon)} ${escapeHtml(place.kindLabel)}</span>
            <span>${escapeHtml(ratingBadge)}</span>
          </div>
          <div style="font-weight:600;">${escapeHtml(place.title)}</div>
          ${place.description ? `<div class="list-item-sub">${escapeHtml(place.description)}</div>` : ''}
        </div>`;
    })
    .join('');

  body.querySelectorAll('.list-item').forEach((item) => {
    item.addEventListener('click', () => {
      const place = state.places.find((p) => p.id === item.dataset.placeId);
      if (place) {
        state.map.flyTo([place.lat, place.lng], Math.max(state.map.getZoom(), 16), { duration: 0.5 });
        openPlaceDetailSheet(place.id);
      }
    });
  });
}

async function openPlaceDetailSheet(placeId) {
  const place = state.places.find((p) => p.id === placeId);
  if (!place) return;
  state.selectedType = 'place';
  state.selectedId = placeId;
  state.selectedRating = 5;
  closeCreateSheet();
  $('sheet-list').classList.add('hidden');

  const cat = VIBE_CATEGORY_MAP[place.category] || VIBE_CATEGORY_MAP.other;
  $('detail-cat-pill').innerHTML = `<span style="color:${cat.color}">●</span> ${escapeHtml(cat.icon)} ${escapeHtml(place.kindLabel)}`;

  const query = encodeURIComponent(`${place.title} ${place.address || ''}`.trim());
  const gmapsUrl = `https://www.google.com/maps/search/?api=1&query=${query}`;
  const yandexUrl = `https://yandex.ru/maps/?text=${query}`;

  const tagsHtml = place.tags?.length
    ? `<div class="tag-chips">${place.tags.map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';

  $('detail-body').innerHTML = `
    <h2 class="detail-title">${escapeHtml(place.title)}</h2>
    ${place.photoUrl ? `<img src="${escapeHtml(place.photoUrl)}" class="detail-photo" id="detail-photo-img" alt="Фото места" />` : ''}
    ${place.description ? `<p class="muted">${escapeHtml(place.description)}</p>` : ''}
    ${tagsHtml}

    <div class="detail-actions">
      <button type="button" class="btn btn-primary btn-sm" id="btn-drop-here">Отметить вайб здесь</button>
    </div>

    <div class="external-links">
      <a class="btn btn-ghost btn-sm" href="${gmapsUrl}" target="_blank" rel="noopener noreferrer">Отзывы в Google Maps ↗</a>
      <a class="btn btn-ghost btn-sm" href="${yandexUrl}" target="_blank" rel="noopener noreferrer">Яндекс Карты ↗</a>
      ${place.wikiUrl ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(place.wikiUrl)}" target="_blank" rel="noopener noreferrer">Википедия ↗</a>` : ''}
      ${place.website ? `<a class="btn btn-ghost btn-sm" href="${escapeHtml(place.website)}" target="_blank" rel="noopener noreferrer">Сайт ↗</a>` : ''}
    </div>

    <div class="reviews-box" id="place-reviews-box">
      <div class="reviews-head">
        <span>Отзывы в VibeMap</span>
        <span class="muted" id="place-rating-summary">Загрузка…</span>
      </div>
      <div id="place-reviews-list" class="comments-list"></div>
      <form id="form-place-review" class="field">
        <div class="rating-picker" id="review-stars">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star-btn${n === 5 ? ' active' : ''}" data-star="${n}">★ ${n}</button>`).join('')}
        </div>
        <input id="rev-author" type="text" maxlength="24" placeholder="Твоё имя (необяз.)" />
        <div class="comment-form">
          <input id="rev-text" type="text" maxlength="240" placeholder="Как тут атмосфера, кофе, места?" required />
          <button type="submit" class="btn btn-secondary btn-sm">Ок</button>
        </div>
      </form>
    </div>
  `;

  $('sheet-detail').classList.remove('hidden');

  if ($('detail-photo-img')) {
    $('detail-photo-img').addEventListener('click', () => {
      $('lightbox-img').src = place.photoUrl;
      $('modal-lightbox').classList.remove('hidden');
    });
  }

  $('btn-drop-here').addEventListener('click', () => {
    openCreateSheetAt(place.lat, place.lng, {
      title: place.title,
      category: place.category
    });
  });

  $('review-stars').addEventListener('click', (e) => {
    const btn = e.target.closest('.star-btn');
    if (!btn) return;
    state.selectedRating = Number(btn.dataset.star);
    $('review-stars').querySelectorAll('.star-btn').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.star) <= state.selectedRating);
    });
  });

  $('form-place-review').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await api(`/api/places/${encodeURIComponent(place.id)}/reviews`, {
        method: 'POST',
        body: JSON.stringify({
          rating: state.selectedRating,
          authorName: $('rev-author').value.trim(),
          text: $('rev-text').value.trim()
        })
      });
      $('rev-text').value = '';
      renderPlaceReviews(res);
      place.reviewCount = res.count;
      place.avgRating = res.avgRating;
      syncMarkers();
      showToast('Отзыв добавлен');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  try {
    const data = await api(`/api/places/${encodeURIComponent(place.id)}/reviews`);
    renderPlaceReviews(data);
  } catch {
    $('place-rating-summary').textContent = 'Нет отзывов';
  }
}

function renderPlaceReviews({ reviews = [], count = 0, avgRating = null }) {
  const summary = $('place-rating-summary');
  const list = $('place-reviews-list');
  if (!summary || !list) return;

  summary.textContent = count > 0 ? `★ ${avgRating} (${count})` : 'Пока нет';
  if (reviews.length === 0) {
    list.innerHTML = '<p class="muted">Оставь первый отзыв или посмотри отзывы в Google / Яндекс Картах выше.</p>';
    return;
  }
  list.innerHTML = reviews
    .map(
      (r) => `
      <div class="review-card">
        <div class="review-top">
          <strong>${escapeHtml(r.authorName)}</strong>
          <span>${'★'.repeat(r.rating)}</span>
        </div>
        <div>${escapeHtml(r.text)}</div>
      </div>`
    )
    .join('');
}

function openPinDetailSheet(id) {
  const pin = state.pins.find((p) => p.id === id);
  if (!pin) return;
  state.selectedType = 'pin';
  state.selectedId = id;
  closeCreateSheet();
  $('sheet-list').classList.add('hidden');

  const cat = VIBE_CATEGORY_MAP[pin.category] || VIBE_CATEGORY_MAP.other;
  const isAuthor = Boolean(getAuthorToken(pin.id));

  $('detail-cat-pill').innerHTML = `<span style="color:${cat.color}">●</span> ${escapeHtml(cat.icon)} ${escapeHtml(cat.label)}`;

  const tagsHtml = pin.tags.length
    ? `<div class="tag-chips">${pin.tags.map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>`
    : '';

  const reactionsHtml = REACTIONS.map(
    (em) => `<button type="button" class="react-btn" data-emoji="${escapeHtml(em)}">${escapeHtml(em)} <span>${pin.reactions?.[em] || 0}</span></button>`
  ).join('');

  const commentsHtml = pin.comments.length
    ? pin.comments
        .map(
          (cm) => `<div class="comment-row"><strong>${escapeHtml(cm.authorName)}</strong>: ${escapeHtml(cm.text)}</div>`
        )
        .join('')
    : '<p class="muted">Комментариев пока нет.</p>';

  $('detail-body').innerHTML = `
    <h2 class="detail-title">${escapeHtml(pin.title)}</h2>
    <div class="detail-meta">
      <span>${escapeHtml(pin.authorName)}</span>
      <span class="ttl-tick" data-expires="${pin.expiresAt}">${escapeHtml(formatRemaining(pin.expiresAt))}</span>
      <span>Подтверждений: ${pin.confirmations}</span>
    </div>
    ${pin.note ? `<p class="muted">${escapeHtml(pin.note)}</p>` : ''}
    ${tagsHtml}
    ${pin.photoUrl ? `<img src="${escapeHtml(pin.photoUrl)}" class="detail-photo" id="detail-photo-img" alt="Фото" />` : ''}

    <div class="detail-actions">
      <button type="button" class="btn btn-primary btn-sm" id="btn-confirm-pin">Актуально (+30м)</button>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-share-pin">Поделиться</button>
      <button type="button" class="btn btn-ghost btn-sm" id="btn-ended-pin">Уже прошло</button>
      ${isAuthor ? `<button type="button" class="btn btn-danger btn-sm" id="btn-delete-pin">Удалить</button>` : ''}
    </div>

    <div class="reactions-bar" id="detail-reactions">${reactionsHtml}</div>

    <div class="comments-list">${commentsHtml}</div>
    <form id="form-pin-comment" class="comment-form">
      <input id="pin-cm-text" type="text" maxlength="200" placeholder="Спросить или дополнить..." required />
      <button type="submit" class="btn btn-secondary btn-sm">Ок</button>
    </form>
  `;

  $('sheet-detail').classList.remove('hidden');

  if ($('detail-photo-img')) {
    $('detail-photo-img').addEventListener('click', () => {
      $('lightbox-img').src = pin.photoUrl;
      $('modal-lightbox').classList.remove('hidden');
    });
  }

  $('btn-confirm-pin').addEventListener('click', async () => {
    try {
      const { pin: updated } = await api(`/api/pins/${pin.id}/confirm`, { method: 'POST' });
      upsertPin(updated);
      showToast('Продлено на +30 минут');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('btn-share-pin').addEventListener('click', async () => {
    const url = `${location.origin}/?pin=${encodeURIComponent(pin.id)}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'VibeMap', text: pin.title, url });
        return;
      } catch {
        // fallback
      }
    }
    await navigator.clipboard.writeText(url).catch(() => {});
    showToast('Ссылка на метку скопирована');
  });

  $('btn-ended-pin').addEventListener('click', async () => {
    try {
      const res = await api(`/api/pins/${pin.id}/ended`, { method: 'POST' });
      if (res.removed) {
        removePinLocal(pin.id);
        showToast('Метка убрана как неактуальная');
      } else {
        upsertPin(res.pin);
        showToast('Отметка учтена');
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });

  if ($('btn-delete-pin')) {
    $('btn-delete-pin').addEventListener('click', async () => {
      try {
        await api(`/api/pins/${pin.id}`, {
          method: 'DELETE',
          body: JSON.stringify({ authorToken: getAuthorToken(pin.id) })
        });
        removePinLocal(pin.id);
        showToast('Метка удалена');
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }

  $('detail-reactions').addEventListener('click', async (e) => {
    const btn = e.target.closest('.react-btn');
    if (!btn) return;
    try {
      const { pin: updated } = await api(`/api/pins/${pin.id}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ emoji: btn.dataset.emoji })
      });
      upsertPin(updated);
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('form-pin-comment').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { pin: updated } = await api(`/api/pins/${pin.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text: $('pin-cm-text').value.trim() })
      });
      upsertPin(updated);
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

function upsertPin(pin) {
  const idx = state.pins.findIndex((p) => p.id === pin.id);
  if (idx >= 0) state.pins[idx] = pin;
  else state.pins.unshift(pin);
  syncMarkers();
  if (state.selectedType === 'pin' && state.selectedId === pin.id && !$('sheet-detail').classList.contains('hidden')) {
    openPinDetailSheet(pin.id);
  }
}

function removePinLocal(id) {
  state.pins = state.pins.filter((p) => p.id !== id);
  if (state.selectedType === 'pin' && state.selectedId === id) {
    $('sheet-detail').classList.add('hidden');
    state.selectedId = null;
  }
  syncMarkers();
}

// === WEBSOCKET ===

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}`);
  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if ((msg.type === 'pin_created' || msg.type === 'pin_updated') && msg.pin) {
      upsertPin(msg.pin);
    } else if (msg.type === 'pin_removed' && msg.id) {
      removePinLocal(msg.id);
    } else if (msg.type === 'place_review_added' && msg.placeId) {
      const place = state.places.find((p) => p.id === msg.placeId);
      if (place && msg.summary) {
        place.reviewCount = msg.summary.count;
        place.avgRating = msg.summary.avgRating;
        syncMarkers();
      }
    }
  });
  ws.addEventListener('close', () => setTimeout(connectWs, 2500));
}

// === INIT ===

async function init() {
  initMap();
  connectWs();
  renderCreateChips();

  $('city-select').innerHTML = CITY_PRESETS.map(
    (c, idx) => `<option value="${idx}">${escapeHtml(c.name)}</option>`
  ).join('');
  $('city-select').addEventListener('change', (e) => {
    const c = CITY_PRESETS[Number(e.target.value)];
    if (c) {
      state.map.flyTo([c.lat, c.lng], c.zoom, { duration: 0.6 });
      loadDiscoverArea(c.lat, c.lng);
    }
  });

  $('category-filters').innerHTML = [
    `<button type="button" class="filter-pill active" data-cat="all">Все</button>`,
    ...VIBE_CATEGORIES.map(
      (c) => `<button type="button" class="filter-pill" data-cat="${c.id}">${escapeHtml(c.icon)} ${escapeHtml(c.short)}</button>`
    )
  ].join('');
  $('category-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-pill');
    if (!btn) return;
    state.filterCategory = btn.dataset.cat;
    $('category-filters').querySelectorAll('.filter-pill').forEach((p) => p.classList.toggle('active', p === btn));
    syncMarkers();
  });

  $('btn-search-area').addEventListener('click', () => {
    const c = state.map.getCenter();
    loadDiscoverArea(c.lat, c.lng);
  });

  $('btn-locate').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('Геолокация не поддерживается', true);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        state.map.flyTo([latitude, longitude], 15, { duration: 0.6 });
        loadDiscoverArea(latitude, longitude);
      },
      () => showToast('Не удалось определить геолокацию', true),
      { enableHighAccuracy: true, timeout: 6000 }
    );
  });

  $('btn-drop-mode').addEventListener('click', () => setDropMode(!state.dropMode));
  $('btn-cancel-drop').addEventListener('click', () => setDropMode(false));
  $('btn-close-create').addEventListener('click', closeCreateSheet);
  $('btn-close-detail').addEventListener('click', () => {
    $('sheet-detail').classList.add('hidden');
    state.selectedId = null;
  });

  $('btn-toggle-list').addEventListener('click', () => {
    $('sheet-list').classList.toggle('hidden');
  });
  $('btn-close-list').addEventListener('click', () => $('sheet-list').classList.add('hidden'));

  document.querySelectorAll('.list-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.listTab = tab.dataset.listTab;
      document.querySelectorAll('.list-tab').forEach((t) => t.classList.toggle('active', t === tab));
      renderListSheet(getFilteredPlaces(), getFilteredPins());
    });
  });

  $('create-categories').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.createForm.category = btn.dataset.cat;
    renderCreateChips();
  });

  $('create-tags').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const tag = btn.dataset.tag;
    if (state.createForm.tags.has(tag)) state.createForm.tags.delete(tag);
    else if (state.createForm.tags.size < 5) state.createForm.tags.add(tag);
    renderCreateChips();
  });

  $('create-ttl').addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    state.createForm.ttlHours = Number(btn.dataset.ttl);
    renderCreateChips();
  });

  $('p-photo').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      state.draftPhotoDataUrl = await compressImage(file);
      $('p-photo-preview').src = state.draftPhotoDataUrl;
      $('p-photo-preview').classList.remove('hidden');
      $('p-photo-status').textContent = 'Фото прикреплено';
      $('p-photo-status').classList.remove('hidden');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('form-create-pin').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.draftLatLng) return;
    try {
      const { pin, authorToken } = await api('/api/pins', {
        method: 'POST',
        body: JSON.stringify({
          lat: state.draftLatLng.lat,
          lng: state.draftLatLng.lng,
          title: $('p-title').value.trim(),
          note: $('p-note').value.trim(),
          category: state.createForm.category,
          tags: [...state.createForm.tags],
          ttlHours: state.createForm.ttlHours,
          authorName: $('p-author').value.trim(),
          imageDataUrl: state.draftPhotoDataUrl
        })
      });
      saveAuthorToken(pin.id, authorToken);
      e.target.reset();
      state.draftPhotoDataUrl = null;
      $('p-photo-preview').classList.add('hidden');
      $('p-photo-status').classList.add('hidden');
      state.createForm.tags.clear();
      renderCreateChips();
      closeCreateSheet();
      upsertPin(pin);
      openPinDetailSheet(pin.id);
      showToast('Метка добавлена на карту');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('btn-close-lightbox').addEventListener('click', () => $('modal-lightbox').classList.add('hidden'));
  $('modal-lightbox').addEventListener('click', (e) => {
    if (e.target === $('modal-lightbox')) $('modal-lightbox').classList.add('hidden');
  });

  setInterval(() => {
    document.querySelectorAll('.ttl-tick').forEach((el) => {
      const exp = Number(el.dataset.expires);
      if (exp) el.textContent = formatRemaining(exp);
    });
  }, 30_000);

  // Initial load: live pins + discovered real places & weather
  const def = CITY_PRESETS[0];
  await Promise.allSettled([
    api('/api/pins').then((d) => {
      state.pins = d.pins || [];
    }),
    loadDiscoverArea(def.lat, def.lng)
  ]);
  syncMarkers();

  const deepPinId = new URLSearchParams(location.search).get('pin');
  if (deepPinId) {
    try {
      const { pin } = await api(`/api/pins/${encodeURIComponent(deepPinId)}`);
      upsertPin(pin);
      state.map.flyTo([pin.lat, pin.lng], 15, { duration: 0.6 });
      openPinDetailSheet(pin.id);
    } catch {
      showToast('Метка уже исчезла или не найдена', true);
    }
  }
}

init();
