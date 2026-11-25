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
  markers: new Map(),
  draftMarker: null,
  pins: [],
  filterCategory: 'all',
  dropMode: false,
  selectedPinId: null,
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
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 19
  }).addTo(state.map);

  state.map.on('click', (e) => {
    if (state.dropMode || !$('sheet-create').classList.contains('hidden')) {
      openCreateSheetAt(e.latlng.lat, e.latlng.lng);
      setDropMode(false);
    }
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

function syncMarkers() {
  const visiblePins =
    state.filterCategory === 'all'
      ? state.pins
      : state.pins.filter((p) => p.category === state.filterCategory);

  const visibleIds = new Set(visiblePins.map((p) => p.id));

  for (const [id, marker] of state.markers.entries()) {
    if (!visibleIds.has(id)) {
      marker.remove();
      state.markers.delete(id);
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

    if (state.markers.has(pin.id)) {
      const m = state.markers.get(pin.id);
      m.setLatLng([pin.lat, pin.lng]);
      m.setIcon(icon);
    } else {
      const marker = L.marker([pin.lat, pin.lng], { icon }).addTo(state.map);
      marker.bindTooltip(escapeHtml(pin.title), { direction: 'top', offset: [0, -16] });
      marker.on('click', () => openDetailSheet(pin.id));
      state.markers.set(pin.id, marker);
    }
  }

  $('live-count').textContent = String(visiblePins.length);
  $('list-count').textContent = String(visiblePins.length);
  renderListSheet(visiblePins);
}

// === SHEETS ===

function openCreateSheetAt(lat, lng) {
  state.draftLatLng = { lat, lng };
  if (state.draftMarker) state.draftMarker.remove();
  const icon = L.divIcon({
    className: '',
    html: '<div class="draft-marker"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
  state.draftMarker = L.marker([lat, lng], { icon }).addTo(state.map);

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

function renderListSheet(visiblePins) {
  const body = $('vibes-list');
  if (visiblePins.length === 0) {
    body.innerHTML = '<p class="muted">Пока нет активных меток. Нажми «+ Отметить», чтобы поставить первую.</p>';
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
        openDetailSheet(pin.id);
      }
    });
  });
}

function openDetailSheet(id) {
  const pin = state.pins.find((p) => p.id === id);
  if (!pin) return;
  state.selectedPinId = id;
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
  if (state.selectedPinId === pin.id && !$('sheet-detail').classList.contains('hidden')) {
    openDetailSheet(pin.id);
  }
}

function removePinLocal(id) {
  state.pins = state.pins.filter((p) => p.id !== id);
  if (state.selectedPinId === id) {
    $('sheet-detail').classList.add('hidden');
    state.selectedPinId = null;
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
    if (c) state.map.flyTo([c.lat, c.lng], c.zoom, { duration: 0.6 });
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

  $('btn-locate').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('Геолокация не поддерживается', true);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.map.flyTo([pos.coords.latitude, pos.coords.longitude], 15, { duration: 0.6 });
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
    state.selectedPinId = null;
  });

  $('btn-toggle-list').addEventListener('click', () => {
    $('sheet-list').classList.toggle('hidden');
  });
  $('btn-close-list').addEventListener('click', () => $('sheet-list').classList.add('hidden'));

  // Create form chips
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
      openDetailSheet(pin.id);
      showToast('Метка добавлена на карту');
    } catch (err) {
      showToast(err.message, true);
    }
  });

  $('btn-close-lightbox').addEventListener('click', () => $('modal-lightbox').classList.add('hidden'));
  $('modal-lightbox').addEventListener('click', (e) => {
    if (e.target === $('modal-lightbox')) $('modal-lightbox').classList.add('hidden');
  });

  // Update TTL countdowns every 30s
  setInterval(() => {
    document.querySelectorAll('.ttl-tick').forEach((el) => {
      const exp = Number(el.dataset.expires);
      if (exp) el.textContent = formatRemaining(exp);
    });
  }, 30_000);

  // Initial load + deep link
  try {
    const { pins } = await api('/api/pins');
    state.pins = pins;
    syncMarkers();
  } catch (err) {
    showToast(err.message, true);
  }

  const deepPinId = new URLSearchParams(location.search).get('pin');
  if (deepPinId) {
    try {
      const { pin } = await api(`/api/pins/${encodeURIComponent(deepPinId)}`);
      upsertPin(pin);
      state.map.flyTo([pin.lat, pin.lng], 15, { duration: 0.6 });
      openDetailSheet(pin.id);
    } catch {
      showToast('Метка уже исчезла или не найдена', true);
    }
  }
}

init();
