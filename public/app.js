import * as maplibregl from '/vendor/maplibre-gl.mjs';

const $ = (s) => document.querySelector(s);
const meta = await fetch('/api/meta').then((r) => r.json());
const CLASSES = meta.classes;
const SYDNEY = [151.2093, -33.8688];
const dark = matchMedia('(prefers-color-scheme: dark)').matches;

const state = {
  from: null, // {lat, lon, label}
  to: null,
  routes: [],
  selected: 0,
  showNetwork: true,
  showCrashes: false,
};

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = new maplibregl.Map({
  container: 'map',
  style: `https://tiles.openfreemap.org/styles/${dark ? 'dark' : 'positron'}`,
  center: SYDNEY,
  zoom: 12,
  maxBounds: [[meta.bbox[0] - 0.4, meta.bbox[1] - 0.3], [meta.bbox[2] + 0.4, meta.bbox[3] + 0.3]],
  attributionControl: false,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
const geolocate = new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false });
map.addControl(geolocate, 'top-right');

// Brighter variants so paths stand out on the dark basemap.
const DARK_COLORS = { separated: '#1fd16b', shared: '#7cf09f', quiet: '#4fe3f2', lane: '#ffd43b', moderate: '#ff9a45', busy: '#ff5a4f', walk: '#b0b0b8' };
const clsColor = ['match', ['get', 'cls'], ...CLASSES.flatMap((c, i) => [i, (dark && DARK_COLORS[c.key]) || c.color]), '#888'];
const empty = { type: 'FeatureCollection', features: [] };
const NETWORK_OPACITY = ['interpolate', ['linear'], ['zoom'], 10, 0.8, 14, 0.95];

map.on('load', () => {
  // Draw our layers above every basemap shape (roads, land, buildings) but under its labels.
  // Some styles interleave early symbol layers, so use the first label after the last shape.
  const baseLayers = map.getStyle().layers;
  const lastShape = baseLayers.findLastIndex((l) => l.type !== 'symbol');
  const firstSymbol = baseLayers.slice(lastShape + 1).find((l) => l.type === 'symbol')?.id;

  map.addSource('network', { type: 'geojson', data: '/data/network.geojson' });
  map.addLayer(
    {
      id: 'network',
      type: 'line',
      source: 'network',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': clsColor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.3, 13, 2.6, 16, 5],
        'line-opacity': NETWORK_OPACITY,
      },
    },
    firstSymbol,
  );

  map.addSource('crashes', { type: 'geojson', data: '/data/crashes.geojson' });
  map.addLayer({
    id: 'crash-heat',
    type: 'heatmap',
    source: 'crashes',
    maxzoom: 15,
    layout: { visibility: 'none' },
    paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'w'], 0, 0, 6, 1],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 15, 2],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 15, 18],
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.7, 15, 0],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(255,59,48,0)', 0.3, 'rgba(255,159,10,0.5)', 1, 'rgba(255,59,48,0.9)'],
    },
  });
  map.addLayer({
    id: 'crash-points',
    type: 'circle',
    source: 'crashes',
    minzoom: 13,
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'w'], 0.5, 3.5, 6, 8],
      'circle-color': ['interpolate', ['linear'], ['get', 'w'], 0.5, '#ff9f0a', 3, '#ff3b30', 6, '#8b0000'],
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1.5,
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14, 0.9],
      'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14, 1],
    },
  });

  map.addSource('alts', { type: 'geojson', data: empty });
  map.addLayer({ id: 'alts-casing', type: 'line', source: 'alts', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? '#2c2c2e' : '#fff', 'line-width': 10 } });
  map.addLayer({ id: 'alts', type: 'line', source: 'alts', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? '#636366' : '#a2b4c6', 'line-width': 6 } });

  map.addSource('route', { type: 'geojson', data: empty });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? '#000' : '#fff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 16, 14] } });
  map.addLayer({ id: 'route', type: 'line', source: 'route', filter: ['!=', ['get', 'cls'], 6], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': clsColor, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 9] } });
  map.addLayer({ id: 'route-walk', type: 'line', source: 'route', filter: ['==', ['get', 'cls'], 6], layout: { 'line-join': 'round' }, paint: { 'line-color': '#8e8e93', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 9], 'line-dasharray': [0.6, 0.8] } });

  map.addSource('crossings', { type: 'geojson', data: empty });
  map.addLayer({
    id: 'crossings',
    type: 'circle',
    source: 'crossings',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, ['case', ['get', 'signals'], 1.5, 3.5], 16, ['case', ['get', 'signals'], 5, 8]],
      'circle-color': ['case', ['get', 'signals'], '#0a84ff', '#ff9f0a'],
      'circle-stroke-width': ['case', ['get', 'signals'], 1, 2],
      'circle-stroke-color': '#fff',
    },
  });

  // Interactions
  map.on('click', 'alts', (e) => {
    e.preventDefault();
    selectRoute(e.features[0].properties.idx);
  });
  for (const id of ['alts', 'route', 'route-walk', 'crash-points', 'crossings']) {
    map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
  }
  const popup = new maplibregl.Popup({ closeButton: false, offset: 8 });
  map.on('click', 'crash-points', (e) => {
    e.preventDefault();
    const p = e.features[0].properties;
    popup.setLngLat(e.lngLat).setHTML(`<b>${esc(p.sev)} · ${p.year}</b>${esc(p.street)}<br>${esc(p.desc)}`).addTo(map);
  });
  map.on('click', 'crossings', (e) => {
    e.preventDefault();
    const p = e.features[0].properties;
    popup.setLngLat(e.lngLat).setHTML(`<b>Crossing ${esc(p.name)}</b>${p.signals ? 'At traffic lights' : 'No traffic signals here – take care'}`).addTo(map);
  });
  map.on('click', 'route', (e) => {
    e.preventDefault();
    const p = e.features[0].properties;
    popup.setLngLat(e.lngLat).setHTML(`<b>${CLASSES[p.cls].label}</b>${fmtDist(p.length)}`).addTo(map);
  });

  map.on('click', (e) => {
    if (e.defaultPrevented || pointerDown.dragged || map.isMoving()) return;
    const which = pickTarget(pointerDown.field);
    if (which) dropPin(which, e.lngLat);
    else showPinMenu(e.lngLat); // both points set: never move one on a plain click
  });
  map.on('contextmenu', (e) => {
    e.preventDefault();
    showPinMenu(e.lngLat);
  });

  applyHash();
});

// ---------------------------------------------------------------------------
// Map clicks: which point does a click set?
// ---------------------------------------------------------------------------
// A plain click fills the field being edited, or the only empty field. Once both
// points are set it opens a "Start here / Go here" menu instead of moving a pin.
const pointerDown = { x: 0, y: 0, dragged: false, field: null };
const canvasEl = map.getCanvasContainer();
const DRAG_PX = 5;
function onPointerDown(x, y) {
  Object.assign(pointerDown, { x, y, dragged: false });
  // The input loses focus on mousedown, so remember which one was being edited.
  const f = document.activeElement?.id;
  pointerDown.field = f === 'from' || f === 'to' ? f : null;
}
function onPointerMove(x, y) {
  if (Math.hypot(x - pointerDown.x, y - pointerDown.y) > DRAG_PX) pointerDown.dragged = true;
}
canvasEl.addEventListener('mousedown', (e) => onPointerDown(e.clientX, e.clientY), true);
canvasEl.addEventListener('mousemove', (e) => e.buttons && onPointerMove(e.clientX, e.clientY), true);

// Long-press on touch devices opens the same menu as right-click.
let pressTimer;
canvasEl.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  onPointerDown(t.clientX, t.clientY);
  clearTimeout(pressTimer);
  if (e.touches.length !== 1) return (pointerDown.dragged = true);
  pressTimer = setTimeout(() => {
    if (pointerDown.dragged || map.isMoving()) return;
    pointerDown.dragged = true; // swallow the click that follows
    const r = canvasEl.getBoundingClientRect();
    showPinMenu(map.unproject([t.clientX - r.left, t.clientY - r.top]));
  }, 550);
}, { capture: true, passive: true });
canvasEl.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  onPointerMove(t.clientX, t.clientY);
  if (pointerDown.dragged) clearTimeout(pressTimer);
}, { capture: true, passive: true });
canvasEl.addEventListener('touchend', () => clearTimeout(pressTimer), { capture: true, passive: true });

function pickTarget(focused = null) {
  if (focused) return focused;
  const empty = ['from', 'to'].filter((w) => !state[w] && !$('#' + w).value.trim());
  if (empty.length) return empty[0];
  const unset = ['from', 'to'].filter((w) => !state[w]);
  return unset.length === 1 ? unset[0] : null;
}
function updatePickTarget() {
  const f = document.activeElement?.id;
  const target = f === 'from' || f === 'to' ? null : pickTarget();
  for (const w of ['from', 'to']) $(`.field[data-which="${w}"]`).classList.toggle('target', w === target);
}

updatePickTarget();

function dropPin(which, lngLat) {
  pinMenu.remove();
  const pt = { lat: lngLat.lat, lon: lngLat.lng, label: 'Dropped pin' };
  if (document.activeElement?.id === which) $('#' + which).blur();
  setPoint(which, pt);
  reverse(which, pt);
}

const pinMenu = new maplibregl.Popup({ closeButton: false, offset: 10, className: 'pin-menu', maxWidth: 'none' });
function showPinMenu(lngLat) {
  const el = document.createElement('div');
  el.className = 'pin-menu-btns';
  el.innerHTML = `<button data-which="from"><span class="dot start"></span>Start here</button>
    <button data-which="to"><span class="dot end"></span>Go here</button>`;
  el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => dropPin(b.dataset.which, lngLat)));
  pinMenu.setLngLat(lngLat).setDOMContent(el).addTo(map);
}
map.on('movestart', (e) => e.originalEvent && pinMenu.remove());
document.addEventListener('keydown', (e) => e.key === 'Escape' && pinMenu.remove());

// ---------------------------------------------------------------------------
// Markers & points
// ---------------------------------------------------------------------------
function makeMarker(which) {
  let el;
  if (which === 'from') {
    el = document.createElement('div');
    el.className = 'marker-start';
  } else {
    el = document.createElement('div');
    el.className = 'marker-end';
    el.innerHTML = `<svg viewBox="0 0 30 30" width="30" height="30"><path d="M15 29s10-9.5 10-17A10 10 0 0 0 5 12c0 7.5 10 17 10 17z" fill="#ff3b30" stroke="#fff" stroke-width="2"/><circle cx="15" cy="12" r="4" fill="#fff"/></svg>`;
  }
  const m = new maplibregl.Marker({ element: el, draggable: true, anchor: which === 'from' ? 'center' : 'bottom' });
  m.on('dragend', () => {
    const ll = m.getLngLat();
    const pt = { lat: ll.lat, lon: ll.lng, label: 'Dropped pin' };
    setPoint(which, pt);
    reverse(which, pt);
  });
  return m;
}
const markers = { from: makeMarker('from'), to: makeMarker('to') };

function setPoint(which, pt, { route = true } = {}) {
  state[which] = pt;
  dirty[which] = false;
  setFieldError(which, '');
  $('#' + which).value = pt ? pt.label : '';
  if (pt) markers[which].setLngLat([pt.lon, pt.lat]).addTo(map);
  else markers[which].remove();
  updateClearButtons();
  updatePickTarget();
  writeHash();
  if (route) planRoute();
}

async function reverse(which, pt) {
  try {
    const r = await fetch(`/api/reverse?lat=${pt.lat}&lon=${pt.lon}`).then((r) => r.json());
    if (r && state[which] === pt && !dirty[which]) {
      pt.label = r.title + (r.subtitle ? `, ${r.subtitle.split(',')[0]}` : '');
      $('#' + which).value = pt.label;
      updateClearButtons();
    }
  } catch {}
}

$('#swap').onclick = () => {
  const { from, to } = state;
  setPoint('from', to, { route: false });
  setPoint('to', from);
};

$('#locate').onclick = () => useMyLocation('from');

for (const which of ['from', 'to']) {
  $(`.clear[data-which="${which}"]`).addEventListener('mousedown', (e) => {
    e.preventDefault(); // keep focus behaviour predictable
    clearTimeout(searchTimer);
    setPoint(which, null);
    $('#' + which).focus();
  });
}
document.addEventListener('focusin', updatePickTarget);
document.addEventListener('focusout', () => setTimeout(updatePickTarget, 0));
function updateClearButtons() {
  for (const which of ['from', 'to']) $(`.clear[data-which="${which}"]`).hidden = !$('#' + which).value;
}

function useMyLocation(which) {
  if (!navigator.geolocation) return status('Location isn’t available in this browser.', true);
  status('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    (p) => {
      status('');
      setPoint(which, { lat: p.coords.latitude, lon: p.coords.longitude, label: 'My location' });
    },
    () => status('Couldn’t get your location.', true),
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

// ---------------------------------------------------------------------------
// Search / autocomplete
//
// - Results are cached per normalised query, so resolving typed text on blur
//   or Enter reuses whatever the autocomplete already fetched.
// - While a query is in flight the previous suggestions stay on screen; a
//   response is rendered as long as its query is still a prefix of the input.
// - /api/search (local index, a few ms) runs on every keystroke. The slower
//   `&remote=1` variant (same local results + a few geocoder extras) runs when
//   typing pauses, or straight away if the local index found nothing, and its
//   extras are merged in. If the server ignores `remote`, merging is a no-op.
// ---------------------------------------------------------------------------
const MIN_Q = 2;
const DEBOUNCE_MS = 80;
const REMOTE_PAUSE_MS = 600;
const MY_LOCATION = [{ title: 'My location', subtitle: 'Use your current position', myLocation: true }];
const searchCache = new Map(); // normalised query -> entry
const dirty = { from: false, to: false }; // input text not yet resolved to a point
const resolving = { from: null, to: null }; // { text, promise } while auto-resolving
const fieldErrors = { from: '', to: '' };
let activeField = null; // field whose suggestions are showing
let shown = { which: null, key: null, list: [] }; // what the dropdown currently lists
let activeIdx = -1;
let navigated = false; // arrow keys used since last keystroke
let searchTimer;
let remoteTimer;

const norm = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

async function fetchJSON(url) {
  // A few retries: the dev server may be restarting.
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      return Array.isArray(body) ? body : body?.results || [];
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((res) => setTimeout(res, 600));
    }
  }
}

function mergeResults(a, b) {
  const k = (s) => `${norm(s.title)}|${s.lat?.toFixed(3)},${s.lon?.toFixed(3)}`;
  const seen = new Set(a.map(k));
  return a.concat(b.filter((s) => !seen.has(k(s))));
}

/** Start (or reuse) a local search for q. entry.promise resolves to the list (falling back to remote if empty). */
function lookup(q) {
  const key = norm(q);
  const cached = searchCache.get(key);
  if (cached && !cached.failed) return cached;
  const c = map.getCenter();
  const e = {
    key, results: [], local: false, done: false, failed: false, remote: null,
    url: `/api/search?q=${encodeURIComponent(q.trim())}&lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`,
  };
  e.promise = (async () => {
    try {
      e.results = await fetchJSON(e.url);
    } catch {
      e.failed = true;
    }
    e.local = true;
    if (!e.failed && !e.results.length) {
      onSearchProgress(e);
      await lookupRemote(e); // nothing locally: the remote geocoder is our only hope
    }
    e.done = true;
    onSearchProgress(e);
    return e.results;
  })();
  searchCache.delete(key);
  searchCache.set(key, e);
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value);
  return e;
}

/** Supplement an entry with remote geocoder results (once). */
function lookupRemote(e) {
  e.remote ??= fetchJSON(e.url + '&remote=1')
    .then((list) => (e.results = mergeResults(e.results, list)))
    .catch(() => {})
    .finally(() => {
      e.remoteDone = true;
      onSearchProgress(e);
    });
  return e.remote;
}

function onSearchProgress(e) {
  const which = activeField;
  if (!which) return;
  const cur = norm($('#' + which).value);
  if (!cur.startsWith(e.key)) return; // no longer relevant to what's typed
  // Prefer the most specific results we have; don't swap good results for an empty prefix result.
  const isExact = e.key === cur;
  const shownStillRelevant = shown.which === which && shown.key != null && cur.startsWith(shown.key);
  const better = isExact || !shownStillRelevant || e.key.length >= shown.key.length;
  if (better && (isExact || e.results.length || !shown.list.length)) setShown(which, e.key, e.results);
  else renderSuggestions(); // update loading indicator
}

function setShown(which, key, list) {
  const sameList = shown.which === which && shown.list === list;
  shown = { which, key, list };
  if (!sameList && !navigated) activeIdx = list.length ? 0 : -1;
  if (activeIdx >= list.length) activeIdx = list.length - 1;
  renderSuggestions();
}

function updateSearch(which) {
  const q = $('#' + which).value.trim();
  clearTimeout(searchTimer);
  scheduleRemote(which);
  if (!q) return setShown(which, '', MY_LOCATION);
  if (q.length < MIN_Q) return setShown(which, null, []);
  const hit = searchCache.get(norm(q));
  if (hit) {
    if (hit.local) setShown(which, hit.key, hit.results);
    else renderSuggestions();
    if (!hit.failed) return;
  }
  renderSuggestions(); // show "Searching…" / keep previous list
  searchTimer = setTimeout(() => lookup(q), DEBOUNCE_MS);
}
function scheduleRemote(which) {
  clearTimeout(remoteTimer);
  const q = $('#' + which).value.trim();
  if (q.length < 3) return;
  remoteTimer = setTimeout(() => {
    if (activeField === which && $('#' + which).value.trim() === q) lookup(q).promise.then(() => {
      if (activeField === which && $('#' + which).value.trim() === q) lookupRemote(lookup(q));
    });
  }, REMOTE_PAUSE_MS);
}

function renderSuggestions() {
  const ul = $('#suggestions');
  const which = activeField;
  if (!which || shown.which !== which) {
    ul.hidden = true;
    return;
  }
  const q = $('#' + which).value.trim();
  const entry = q.length >= MIN_Q ? searchCache.get(norm(q)) : null;
  const loading = q.length >= MIN_Q && (!entry?.done || (entry.remote && !entry.remoteDone));
  const list = shown.list;
  let extra = '';
  if (!list.length) {
    if (q.length > 0 && q.length < MIN_Q) extra = `<li class="info">Keep typing…</li>`;
    else if (loading) extra = `<li class="info"><span class="spinner"></span>Searching…</li>`;
    else if (entry?.failed) extra = `<li class="info">Search isn’t available right now — try again</li>`;
    else if (q) extra = `<li class="info">No matches for “${esc(q)}”</li>`;
  }
  // Keep the other field's lookup error visible; the dropdown covers the status line.
  const otherErr = fieldErrors[which === 'from' ? 'to' : 'from'];
  if (otherErr) extra = `<li class="info error">${esc(otherErr)}</li>` + extra;
  ul.classList.toggle('loading', loading && list.length > 0);
  ul.hidden = !list.length && !extra;
  ul.innerHTML =
    list
      .map(
        (s, i) => `<li data-i="${i}" class="${i === activeIdx ? 'active' : ''}">
        <span class="pin ${kindClass(s)}">${KIND_GLYPH[kindClass(s)]}</span>
        <div><div class="t">${esc(s.title)}</div><div class="s">${esc(s.subtitle || '')}</div></div></li>`,
      )
      .join('') + extra;
  ul.querySelectorAll('li').forEach((li) =>
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus in the input (no blur → no auto-resolve)
      if (li.dataset.i != null) choose(which, list[+li.dataset.i]);
    }),
  );
}
const PLACE_KINDS = new Set(['suburb', 'town', 'city', 'village', 'locality', 'neighbourhood', 'hamlet', 'quarter', 'district', 'county', 'state', 'island', 'place']);
const KIND_GLYPH = {
  loc: '➤',
  address: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 3 2 11h3v9h5v-6h4v6h5v-9h3z"/></svg>',
  street: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M8 3 5 21M16 3l3 18M12 5v2.5M12 11v2.5M12 17v2.5"/></svg>',
  transit: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 3h12a2 2 0 0 1 2 2v10a3 3 0 0 1-2.2 2.9L19 21h-2.3l-1-3H8.3l-1 3H5l1.2-3.1A3 3 0 0 1 4 15V5a2 2 0 0 1 2-2zm0 3v5h12V6zm1.5 7.5a1.5 1.5 0 1 0 0 .01zm9 0a1.5 1.5 0 1 0 0 .01z"/></svg>',
  place: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 20 9.5 8l4 6 2.5-3.5L21 20z"/></svg>',
  poi: '●',
};
function kindClass(s) {
  if (s.myLocation) return 'loc';
  const k = s.kind || '';
  if (k === 'address' || k === 'house') return 'address';
  if (k === 'street' || k === 'residential' || k === 'road') return 'street';
  if (/station|stop|terminal|halt|platform/.test(k)) return 'transit';
  if (PLACE_KINDS.has(k)) return 'place';
  return 'poi';
}
function hideSuggestions() {
  activeField = null;
  $('#suggestions').hidden = true;
}

function labelFor(s) {
  const area = (s.subtitle || '').split(/[,·]/)[0].trim();
  const generic = PLACE_KINDS.has(area.toLowerCase()) || area.toLowerCase() === (s.kind || '').toLowerCase();
  return area && !generic && area !== s.title ? `${s.title}, ${area}` : s.title;
}

function choose(which, s, { advance = true } = {}) {
  if (activeField === which) hideSuggestions();
  setFieldError(which, '');
  if (s.myLocation) {
    $('#' + which).blur();
    return useMyLocation(which);
  }
  setPoint(which, { lat: s.lat, lon: s.lon, label: labelFor(s) });
  if (!state.from || !state.to) map.flyTo({ center: [s.lon, s.lat], zoom: 15 });
  const other = which === 'from' ? 'to' : 'from';
  if (advance && which === 'from' && !state.to && !$('#to').value.trim()) $('#to').focus();
  else if (advance) $('#' + which).blur();
  if (dirty[other]) resolve(other);
}

/** Resolve the typed text in a field to its top search result. Resolves to true if the field has a point. */
function resolve(which, { explicit = false } = {}) {
  const input = $('#' + which);
  // Never replace text under the user's fingers unless they asked (Enter).
  if (!explicit && document.activeElement === input) return Promise.resolve(!!state[which]);
  const text = input.value.trim();
  if (!dirty[which]) return Promise.resolve(!!state[which]);
  if (!text) {
    dirty[which] = false;
    if (state[which]) setPoint(which, null);
    return Promise.resolve(false);
  }
  const pending = resolving[which];
  if (pending?.text === text && (pending.explicit || !explicit)) return pending.promise;
  const field = input.closest('.field');
  field.classList.add('resolving');
  setFieldError(which, '');
  const promise = (async () => {
    const results = text.length >= MIN_Q ? await lookup(text).promise : [];
    // The user may have changed the text, or picked a point some other way, meanwhile.
    if (input.value.trim() !== text || !dirty[which]) return !!state[which];
    if (!explicit && document.activeElement === input) return !!state[which];
    const top = results.find((s) => !s.myLocation && Number.isFinite(s.lat));
    if (!top) {
      const failed = searchCache.get(norm(text))?.failed;
      setFieldError(which, failed ? `Search isn’t available right now — couldn’t look up “${text}”.` : `Couldn’t find “${text}” — pick a suggestion.`);
      return false;
    }
    choose(which, top, { advance: false });
    return true;
  })();
  resolving[which] = { text, promise, explicit };
  promise.finally(() => {
    if (resolving[which]?.promise === promise) {
      resolving[which] = null;
      field.classList.remove('resolving');
    }
  });
  return promise;
}

function setFieldError(which, msg) {
  const prev = fieldErrors.from || fieldErrors.to;
  fieldErrors[which] = msg;
  $('#' + which).closest('.field').classList.toggle('invalid', !!msg);
  $('#' + which).setAttribute('aria-invalid', msg ? 'true' : 'false');
  const now = fieldErrors.from || fieldErrors.to;
  if (now) status(now, true);
  else if (prev && $('#status').textContent === prev) status('');
  if (activeField && activeField !== which) renderSuggestions();
}

for (const which of ['from', 'to']) {
  const input = $('#' + which);
  input.addEventListener('focus', () => {
    activeField = which;
    navigated = false;
    $('#panel').classList.add('searching');
    input.select();
    updateSearch(which);
  });
  input.addEventListener('input', () => {
    activeField = which;
    dirty[which] = true;
    navigated = false;
    if (fieldErrors[which]) setFieldError(which, '');
    updateClearButtons();
    updateSearch(which);
  });
  input.addEventListener('keydown', (e) => {
    const list = shown.which === which ? shown.list : [];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!list.length) return;
      navigated = true;
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      renderSuggestions();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      const current = shown.which === which && shown.key === (q ? norm(q) : '');
      if (list.length && activeIdx >= 0 && (current || navigated)) choose(which, list[activeIdx]);
      else if (!dirty[which] && state[which]) {
        hideSuggestions();
        input.blur();
      } else
        resolve(which, { explicit: true }).then((ok) => {
          if (!ok || document.activeElement !== input) return;
          if (which === 'from' && !state.to && !$('#to').value.trim()) $('#to').focus();
          else input.blur();
        });
    } else if (e.key === 'Escape') {
      if (state[which]) {
        input.value = state[which].label;
        dirty[which] = false;
      }
      hideSuggestions();
      input.blur();
    }
  });
  input.addEventListener('blur', () =>
    setTimeout(() => {
      if (document.activeElement === input) return;
      if (activeField === which) hideSuggestions();
      if (!document.activeElement?.matches('#from, #to')) $('#panel').classList.remove('searching');
      if (dirty[which]) resolve(which); // typed but never picked: use the top match
    }, 150),
  );
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
let routeSeq = 0;
async function planRoute() {
  if (!state.from || !state.to) {
    state.routes = [];
    render();
    // Typed-but-unresolved text in a missing field: look it up rather than silently doing nothing.
    for (const which of ['from', 'to']) if (!state[which] && dirty[which]) resolve(which);
    return;
  }
  const seq = ++routeSeq;
  status('Finding the safest route…');
  try {
    const r = await fetch(`/api/route?from=${state.from.lat},${state.from.lon}&to=${state.to.lat},${state.to.lon}`);
    const data = await r.json();
    if (seq !== routeSeq) return;
    if (!r.ok) throw new Error(data.error || 'Routing failed');
    status('');
    state.routes = data.routes;
    state.selected = 0;
    render();
    fit();
  } catch (e) {
    if (seq !== routeSeq) return;
    state.routes = [];
    render();
    status(e.message, true);
  }
}

function selectRoute(i) {
  state.selected = i;
  render();
}

function fit() {
  const r = state.routes[state.selected];
  if (!r) return;
  const wide = innerWidth > 720;
  map.fitBounds([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], {
    padding: wide
      ? { top: 70, bottom: 50, left: 420, right: 70 }
      : // The sheet may still be expanded for typing; size for its resting height (62vh).
        { top: 70, bottom: Math.min($('#panel').offsetHeight, innerHeight * 0.62) + 24, left: 36, right: 60 },
    maxZoom: 16,
    duration: 700,
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render() {
  const has = state.routes.length > 0;
  $('#empty').hidden = has;
  $('#routes').hidden = !has;
  $('#details').hidden = !has;
  $('#panel').classList.toggle('has-route', has);
  if (!map.getSource('route')) return;
  map.setPaintProperty('network', 'line-opacity', has ? 0.4 : NETWORK_OPACITY);

  if (!has) {
    map.getSource('route').setData(empty);
    map.getSource('alts').setData(empty);
    map.getSource('crossings').setData(empty);
    return;
  }
  const sel = state.routes[state.selected];
  map.getSource('route').setData(sel.geometry);
  map.getSource('alts').setData({
    type: 'FeatureCollection',
    features: state.routes
      .map((r, idx) => ({
        type: 'Feature',
        properties: { idx },
        geometry: { type: 'MultiLineString', coordinates: r.geometry.features.map((f) => f.geometry.coordinates) },
      }))
      .filter((f) => f.properties.idx !== state.selected),
  });
  map.getSource('crossings').setData({
    type: 'FeatureCollection',
    features: sel.crossings.map((c) => ({ type: 'Feature', properties: c, geometry: { type: 'Point', coordinates: [c.lon, c.lat] } })),
  });

  $('#routes').innerHTML = state.routes
    .map((r, i) => {
      const unsig = r.crossings.filter((c) => !c.signals).length;
      return `<button class="route ${i === state.selected ? 'selected' : ''}" data-i="${i}">
        <div class="time">${fmtTime(r.duration)}<small>${fmtDist(r.distance)}</small></div>
        <div class="score" style="--p:${r.safetyScore};--c:${scoreColor(r.safetyScore)}"><span>${r.safetyScore}</span></div>
        <div class="chips">${r.modes.map((m) => `<span class="chip ${m === 'Safest' ? 'safe' : ''}">${m}</span>`).join('')}</div>
        ${bar(r)}
        <div class="meta">${Math.round(r.lowStressShare)}% on paths &amp; quiet streets${unsig ? ` · ${unsig} unsignalised crossing${unsig > 1 ? 's' : ''}` : ''}</div>
      </button>`;
    })
    .join('');
  $('#routes').querySelectorAll('.route').forEach((b) => (b.onclick = () => { selectRoute(+b.dataset.i); fit(); }));

  const unsig = sel.crossings.filter((c) => !c.signals);
  const sig = sel.crossings.filter((c) => c.signals);
  const warnings = [];
  if (unsig.length)
    warnings.push(`<div class="warn amber"><span class="ico">⚠️</span><div>Crosses <b>${unique(unsig.map((c) => c.name)).join(', ')}</b> without traffic lights. Orange dots on the map show where.</div></div>`);
  if (sel.crashes)
    warnings.push(`<div class="warn amber"><span class="ico">🚑</span><div>Passes ${sel.crashes} spot${sel.crashes > 1 ? 's' : ''} where crashes involving bikes were reported (TfNSW, 2021–2025).</div></div>`);
  else warnings.push(`<div class="warn green"><span class="ico">✅</span><div>No reported bike crashes along this route (TfNSW, 2021–2025).</div></div>`);
  if (sig.length) warnings.push(`<div class="warn green"><span class="ico">🚦</span><div>${sig.length} main-road crossing${sig.length > 1 ? 's' : ''} at traffic lights.</div></div>`);

  $('#details').innerHTML = `
    <div class="card breakdown">
      <h3>Route makeup</h3>
      ${sel.byClass
        .map((m, c) => (m > 0 ? `<div class="row"><i style="background:${CLASSES[c].color}"></i><span>${CLASSES[c].label}</span><span>${fmtDist(m)}</span></div>` : ''))
        .join('')}
    </div>
    ${warnings.join('')}
    <div class="card steps-card">
      <h3>Directions</h3>
      <ol class="steps">
        ${sel.steps
          .map(
            (s, i) => `<li data-i="${i}">
              <span class="arrow" style="background:${s.icon === 'arrive' ? '#ff3b30' : s.icon === 'start' ? '#34c759' : CLASSES[s.cls].color}">${ARROWS[s.icon] ?? '↑'}</span>
              <div><div class="instr">${esc(s.instruction)}</div>
              ${s.distance ? `<div class="sub">${fmtDist(s.distance)} · ${CLASSES[s.cls].label}</div>` : ''}
              ${s.note ? `<div class="note">${esc(unique(s.note.split(' · ')).join(' · '))}</div>` : ''}</div></li>`,
          )
          .join('')}
      </ol>
    </div>`;
  $('#details').querySelectorAll('.steps li').forEach((li) => {
    li.onclick = () => {
      const s = sel.steps[+li.dataset.i];
      map.flyTo({ center: s.location, zoom: 17, duration: 800 });
    };
  });
}

const ARROWS = { start: '•', arrive: '⚑', straight: '↑', left: '←', right: '→', 'slight-left': '↖', 'slight-right': '↗', 'sharp-left': '↙', 'sharp-right': '↘' };

function bar(r) {
  return `<div class="bar">${r.byClass
    .map((m, c) => (m > 0 ? `<i style="width:${(100 * m) / r.distance}%;background:${CLASSES[c].color}" title="${CLASSES[c].label}"></i>` : ''))
    .join('')}</div>`;
}

$('#legend').innerHTML = CLASSES.map((c) => `<div><i style="background:${(dark && DARK_COLORS[c.key]) || c.color}"></i>${c.label}</div>`).join('');

// ---------------------------------------------------------------------------
// Layer toggles
// ---------------------------------------------------------------------------
$('#toggle-network').onclick = (e) => {
  state.showNetwork = !state.showNetwork;
  e.currentTarget.classList.toggle('on', state.showNetwork);
  map.setLayoutProperty('network', 'visibility', state.showNetwork ? 'visible' : 'none');
};
$('#toggle-crashes').onclick = (e) => {
  state.showCrashes = !state.showCrashes;
  e.currentTarget.classList.toggle('on', state.showCrashes);
  for (const id of ['crash-heat', 'crash-points']) map.setLayoutProperty(id, 'visibility', state.showCrashes ? 'visible' : 'none');
};

// ---------------------------------------------------------------------------
// URL hash (shareable routes)
// ---------------------------------------------------------------------------
function writeHash() {
  const parts = [];
  for (const which of ['from', 'to'])
    if (state[which]) parts.push(`${which}=${state[which].lat.toFixed(5)},${state[which].lon.toFixed(5)}`);
  history.replaceState(null, '', parts.length ? '#' + parts.join('&') : location.pathname + location.search);
}
function applyHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  for (const which of ['from', 'to']) {
    const v = p.get(which);
    if (!v) continue;
    const [lat, lon] = v.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const pt = { lat, lon, label: 'Dropped pin' };
    setPoint(which, pt, { route: false });
    reverse(which, pt);
  }
  planRoute();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function status(msg, error = false) {
  const el = $('#status');
  el.hidden = !msg;
  el.textContent = msg;
  el.classList.toggle('error', error);
}
function fmtDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10 || Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}
function fmtTime(s) {
  const min = Math.max(1, Math.round(s / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}
function scoreColor(s) {
  return s >= 70 ? '#34c759' : s >= 45 ? '#ff9f0a' : '#ff3b30';
}
function unique(a) {
  return [...new Set(a)];
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
