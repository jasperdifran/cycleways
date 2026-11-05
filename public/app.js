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

const clsColor = ['match', ['get', 'cls'], ...CLASSES.flatMap((c, i) => [i, c.color]), '#888'];
const empty = { type: 'FeatureCollection', features: [] };
const NETWORK_OPACITY = ['interpolate', ['linear'], ['zoom'], 10, 0.55, 14, 0.8];

map.on('load', () => {
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

  map.addSource('network', { type: 'geojson', data: '/data/network.geojson' });
  map.addLayer(
    {
      id: 'network',
      type: 'line',
      source: 'network',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': clsColor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 13, 1.8, 16, 3.5],
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
    if (e.defaultPrevented) return;
    const pt = { lat: e.lngLat.lat, lon: e.lngLat.lng, label: 'Dropped pin' };
    const which = !state.from ? 'from' : 'to';
    setPoint(which, pt);
    reverse(which, pt);
  });

  applyHash();
});

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
  $('#' + which).value = pt ? pt.label : '';
  if (pt) markers[which].setLngLat([pt.lon, pt.lat]).addTo(map);
  else markers[which].remove();
  updateClearButtons();
  writeHash();
  if (route) planRoute();
}

async function reverse(which, pt) {
  try {
    const r = await fetch(`/api/reverse?lat=${pt.lat}&lon=${pt.lon}`).then((r) => r.json());
    if (r && state[which] === pt) {
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
    pendingEnter = false;
    status('');
    setPoint(which, null);
    $('#' + which).focus();
  });
}
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
// ---------------------------------------------------------------------------
let activeField = null;
let suggestions = [];
let activeIdx = -1;
let searchTimer;
let searchSeq = 0;
let suggestionsFor = ''; // query the current suggestions belong to
let pendingEnter = false; // Enter pressed before results arrived
const MY_LOCATION = [{ title: 'My location', subtitle: 'Use your current position', myLocation: true }];

for (const which of ['from', 'to']) {
  const input = $('#' + which);
  input.addEventListener('focus', () => {
    activeField = which;
    $('#panel').classList.add('searching');
    input.select();
    if (!input.value) showSuggestions(MY_LOCATION);
  });
  input.addEventListener('input', () => {
    activeField = which;
    clearTimeout(searchTimer);
    pendingEnter = false;
    updateClearButtons();
    const q = input.value.trim();
    if (q.length < 2) return showSuggestions(q ? [] : MY_LOCATION);
    searchTimer = setTimeout(() => search(q), 180);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!suggestions.length) return;
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
      renderSuggestions();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = input.value.trim();
      if (q.length >= 2 && suggestionsFor !== q) {
        // Results for what's typed haven't arrived yet: pick the top one when they do.
        pendingEnter = true;
        clearTimeout(searchTimer);
        search(q);
      } else if (suggestions.length) choose(suggestions[Math.max(0, activeIdx)]);
    } else if (e.key === 'Escape') {
      hideSuggestions();
      input.blur();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => {
    hideSuggestions();
    if (!document.activeElement?.matches('#from, #to')) $('#panel').classList.remove('searching');
  }, 150));
}

async function search(q) {
  const seq = ++searchSeq;
  const c = map.getCenter();
  let res = [];
  try {
    res = await fetch(`/api/search?q=${encodeURIComponent(q)}&lat=${c.lat}&lon=${c.lng}`).then((r) => r.json());
  } catch {}
  if (seq !== searchSeq) return;
  showSuggestions(res, q);
  if (pendingEnter) {
    pendingEnter = false;
    if (res.length) choose(res[0]);
    else status(`No places found for “${q}”.`, true);
  }
}

function showSuggestions(list, query = '') {
  suggestions = list;
  suggestionsFor = query;
  activeIdx = list.length ? 0 : -1;
  renderSuggestions();
}
function renderSuggestions() {
  const ul = $('#suggestions');
  ul.hidden = !suggestions.length;
  ul.innerHTML = suggestions
    .map(
      (s, i) => `<li data-i="${i}" class="${i === activeIdx ? 'active' : ''}">
        <span class="pin ${s.myLocation ? 'loc' : ''}">${s.myLocation ? '➤' : '●'}</span>
        <div><div class="t">${esc(s.title)}</div><div class="s">${esc(s.subtitle || '')}</div></div></li>`,
    )
    .join('');
  ul.querySelectorAll('li').forEach((li) => li.addEventListener('mousedown', (e) => {
    e.preventDefault();
    choose(suggestions[+li.dataset.i]);
  }));
}
function hideSuggestions() {
  $('#suggestions').hidden = true;
}
function choose(s) {
  hideSuggestions();
  status('');
  const which = activeField;
  $('#' + which).blur();
  if (s.myLocation) return useMyLocation(which);
  setPoint(which, { lat: s.lat, lon: s.lon, label: s.title });
  if (!state.from || !state.to) map.flyTo({ center: [s.lon, s.lat], zoom: 15 });
  if (which === 'from' && !state.to) $('#to').focus();
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
let routeSeq = 0;
async function planRoute() {
  if (!state.from || !state.to) {
    state.routes = [];
    render();
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
      : { top: 70, bottom: $('#panel').offsetHeight + 24, left: 36, right: 60 },
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
  map.setPaintProperty('network', 'line-opacity', has ? 0.28 : NETWORK_OPACITY);

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

$('#legend').innerHTML = CLASSES.map((c) => `<div><i style="background:${c.color}"></i>${c.label}</div>`).join('');

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
