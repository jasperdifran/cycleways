import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { BBOX, GRAPH_DIR, PUBLIC_DIR, ROOT, inBbox } from './config.ts';
import { loadGraph } from './graph.ts';
import { planRoutes } from './router.ts';
import { CLASSES, MODES } from './model.ts';
import { PlaceIndex, type SearchResult } from './search.ts';

const PORT = Number(process.env.PORT ?? 5173);
const UA = 'sydney-cycleways/0.1 (local route planner)';

console.log('Loading graph…');
const t0 = Date.now();
const graph = loadGraph();
console.log(`Graph loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${graph.N.toLocaleString()} nodes, ${graph.E.toLocaleString()} edges`);

// Local place index (scripts/places.ts). Without it, search falls back to Photon only.
const PLACES_FILE = path.join(GRAPH_DIR, 'places.json.gz');
let places: PlaceIndex | null = null;
if (fs.existsSync(PLACES_FILE)) {
  const t1 = Date.now();
  places = new PlaceIndex(PLACES_FILE);
  const { entries, addresses } = places.size;
  console.log(`Place index loaded in ${Date.now() - t1}ms: ${entries.toLocaleString()} places/streets, ${addresses.toLocaleString()} addresses`);
} else {
  console.warn('No data/graph/places.json.gz – run `npm run places`. Search will use Photon only.');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const VENDOR_DIR = path.join(ROOT, 'node_modules/maplibre-gl/dist');
const STATIC: Record<string, string> = {
  '/data/network.geojson': path.join(GRAPH_DIR, 'network.geojson'),
  '/data/crashes.geojson': path.join(GRAPH_DIR, 'crashes.geojson'),
};

const gzCache = new Map<string, { mtime: number; body: Buffer }>();
function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string) {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error();
  } catch {
    return send(res, 404, { error: 'Not found' });
  }
  const type = MIME[path.extname(file)] ?? 'application/octet-stream';
  const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  let cached = gzCache.get(file);
  if (gzip && (!cached || cached.mtime !== stat.mtimeMs)) {
    cached = { mtime: stat.mtimeMs, body: zlib.gzipSync(fs.readFileSync(file)) };
    gzCache.set(file, cached);
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': file.startsWith(PUBLIC_DIR) ? 'no-cache' : 'public, max-age=3600',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
  });
  res.end(gzip ? cached!.body : fs.readFileSync(file));
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

function parsePoint(s: string | null): [number, number] | null {
  if (!s) return null;
  const [lat, lon] = s.split(',').map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}

// Place search via Photon (OpenStreetMap-based geocoder), restricted to Greater Sydney.
const searchCache = new Map<string, unknown>();
const MINOR_KINDS = new Set(['bus_stop', 'platform', 'stop_position', 'stop', 'halt', 'stop_area', 'taxi', 'bicycle_parking', 'parking', 'parking_entrance', 'footway']);
async function photon(url: string): Promise<any[]> {
  if (searchCache.has(url)) return searchCache.get(url) as any[];
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Geocoder HTTP ${r.status}`);
  const data: any = await r.json();
  const results = (data.features ?? [])
    .filter((f: any) => inBbox(f.geometry.coordinates[0], f.geometry.coordinates[1]))
    .map((f: any) => {
      const p = f.properties;
      const street = [p.housenumber, p.street].filter(Boolean).join(' ');
      let title = p.name ?? (street || p.district || p.locality || p.city);
      // Sydney stations are named just "Parramatta" in OSM.
      if (p.osm_key === 'railway' && p.osm_value === 'station' && !/station/i.test(title)) title += ' Station';
      const sub = [p.name ? street : '', p.district ?? p.locality, p.city !== p.district ? p.city : '']
        .filter((s: string) => s && s !== title)
        .join(', ');
      return { title, subtitle: sub, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], kind: p.osm_value };
    });
  if (searchCache.size > 2000) searchCache.clear();
  searchCache.set(url, results);
  return results;
}

async function searchPhoton(q: string, lat: string, lon: string) {
  const base = { lang: 'en', bbox: BBOX.join(','), lat, lon };
  const general = photon(`https://photon.komoot.io/api/?${new URLSearchParams({ ...base, q, limit: '12' })}`);
  const stationQ = q.replace(/\b(railway|train|metro)?\s*station\b/i, '').trim();
  const stations =
    stationQ && stationQ !== q
      ? photon(`https://photon.komoot.io/api/?${new URLSearchParams({ ...base, q: stationQ, limit: '2', osm_tag: 'railway:station' })}`).catch(() => [])
      : Promise.resolve([]);
  const all = [...(await stations), ...(await general)];
  return all
    // Bus stands and platforms crowd out the place people actually mean.
    .map((r, i) => ({ r, rank: i + (MINOR_KINDS.has(r.kind) ? 100 : 0) }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ r }) => r)
    // Drop near-duplicates (same name within ~150 m).
    .filter((r, i, arr) => !arr.slice(0, i).some((o) => o.title === r.title && Math.abs(o.lat - r.lat) < 0.0015 && Math.abs(o.lon - r.lon) < 0.0015))
    .slice(0, 6);
}

// Local index first (instant); with `remote`, up to 3 Photon results that the local
// index doesn't already have are appended. A slow or failing Photon never loses the local results.
async function searchPlaces(q: string, lat: number, lon: number, limit: number, remote: boolean): Promise<SearchResult[]> {
  const t = performance.now();
  const local = places ? places.search(q, lat, lon, limit) : [];
  if (!remote) {
    console.log(`search "${q}": ${local.length} local in ${(performance.now() - t).toFixed(1)}ms`);
    return local;
  }
  const timeout = new Promise<SearchResult[]>((resolve) => setTimeout(() => resolve([]), 4000));
  const far = await Promise.race([searchPhoton(q, String(lat), String(lon)).catch(() => [] as SearchResult[]), timeout]);
  const near = (a: SearchResult, b: SearchResult) =>
    Math.abs(a.lat - b.lat) < 0.003 && Math.abs(a.lon - b.lon) < 0.003 && a.title.toLowerCase() === b.title.toLowerCase();
  // Up to 3 slots go to Photon-only results; local ones fill the rest.
  const extra = far.filter((r) => !local.some((m) => near(m, r))).slice(0, places ? 3 : limit);
  console.log(`search "${q}" +remote: ${local.length} local, ${extra.length} extra from Photon in ${(performance.now() - t).toFixed(0)}ms`);
  return [...local.slice(0, limit - extra.length), ...extra];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/route') {
      const from = parsePoint(url.searchParams.get('from'));
      const to = parsePoint(url.searchParams.get('to'));
      if (!from || !to) return send(res, 400, { error: 'from and to must be "lat,lon"' });
      if (!inBbox(from[1], from[0]) || !inBbox(to[1], to[0]))
        return send(res, 400, { error: 'Both points need to be inside Greater Sydney.' });
      const t = performance.now();
      const result = planRoutes(graph, from, to);
      console.log(`route ${from} → ${to}: ${(performance.now() - t).toFixed(0)}ms`);
      return send(res, 'error' in result ? 404 : 200, result);
    }
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q')?.trim();
      if (!q) return send(res, 200, []);
      const lat = parseFloat(url.searchParams.get('lat') ?? '') || -33.87;
      const lon = parseFloat(url.searchParams.get('lon') ?? '') || 151.21;
      const limit = Math.min(20, Math.max(1, parseInt(url.searchParams.get('limit') ?? '', 10) || 8));
      const remote = url.searchParams.get('remote') === '1' || !places;
      return send(res, 200, await searchPlaces(q, lat, lon, limit, remote));
    }
    if (url.pathname === '/api/reverse') {
      const p = new URLSearchParams({ lat: url.searchParams.get('lat') ?? '', lon: url.searchParams.get('lon') ?? '', limit: '1', lang: 'en' });
      const results = await photon(`https://photon.komoot.io/reverse?${p}`);
      return send(res, 200, results[0] ?? null);
    }
    if (url.pathname === '/api/meta') {
      return send(res, 200, {
        bbox: BBOX,
        classes: CLASSES,
        modes: MODES,
        builtAt: graph.meta.builtAt,
        crashes: graph.meta.crashes,
      });
    }
    if (STATIC[url.pathname]) return sendFile(req, res, STATIC[url.pathname]);
    if (url.pathname.startsWith('/vendor/')) {
      const file = path.normalize(path.join(VENDOR_DIR, url.pathname.slice('/vendor/'.length)));
      if (!file.startsWith(VENDOR_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
      return sendFile(req, res, file);
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
    return sendFile(req, res, file);
  } catch (e: any) {
    console.error(e);
    return send(res, 500, { error: e.message ?? 'Server error' });
  }
});

server.listen(PORT, () => console.log(`🚲 Sydney Cycleways running at http://localhost:${PORT}`));
