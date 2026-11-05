// Builds the local place-search index data/graph/places.json.gz from the OSM extract.
//
//   places    place=suburb/town/city/… nodes (+ suburb boundaries without a place node)
//   stations  railway stations, light rail stops, ferry wharves
//   POIs      named amenities, tourism, leisure, shops, beaches, …
//   streets   one entry per street name per suburb (ways within ~1 km clustered)
//   addresses addr:housenumber + addr:street, suburb from addr:suburb or the suburb boundary
//
// The suburb of everything is found by point-in-polygon against the admin_level=9
// boundaries (Sydney's suburbs), falling back to the nearest place node.
//
// Usage: npm run places   (also run at the end of `npm run build`)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createOSMStream } from 'osm-pbf-parser-node';
import { GRAPH_DIR, RAW, inBbox } from '../src/config.ts';
import { normalize } from '../src/search.ts';

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
if (!fs.existsSync(RAW.osmSydney)) throw new Error(`Missing ${RAW.osmSydney} – run \`npm run download\` first.`);
const OUT = path.join(GRAPH_DIR, 'places.json.gz');

const PLACE_KINDS = new Set(['city', 'town', 'suburb', 'village', 'locality', 'neighbourhood', 'quarter', 'hamlet']);
const SKIP_AMENITY = new Set([
  'bench', 'waste_basket', 'waste_disposal', 'recycling', 'parking', 'parking_space', 'parking_entrance', 'bicycle_parking',
  'motorcycle_parking', 'vending_machine', 'post_box', 'telephone', 'drinking_water', 'bbq', 'shelter', 'charging_station',
  'atm', 'toilets', 'grit_bin', 'loading_dock', 'water_point', 'clock', 'fountain', 'hunting_stand', 'letter_box', 'bicycle_repair_station',
  'compressed_air', 'vacuum_cleaner', 'smoking_area', 'give_box', 'parcel_locker', 'taxi', 'bus_station',
]);
const LEISURE = new Set(['park', 'garden', 'stadium', 'sports_centre', 'pitch', 'nature_reserve', 'golf_course', 'playground', 'swimming_pool', 'marina', 'water_park', 'track', 'recreation_ground', 'dog_park', 'sports_hall', 'fitness_centre', 'beach_resort', 'common']);
const NATURAL = new Set(['beach', 'peak', 'bay', 'cape', 'cliff', 'water', 'wood', 'island', 'headland']);
const SKIP_HIGHWAY = new Set(['proposed', 'construction', 'platform', 'bus_stop', 'elevator', 'corridor', 'abandoned', 'razed', 'raceway', 'escape']);

// Kind for a tagged object, or null if it isn't searchable.
function kindOf(t: Record<string, string>): string | null {
  if (!t.name) return null;
  if (t.place && PLACE_KINDS.has(t.place)) return t.place;
  if (t.railway === 'station' || t.railway === 'halt') return t.station === 'light_rail' ? 'tram_stop' : 'station';
  if (t.railway === 'tram_stop') return 'tram_stop';
  if (t.amenity === 'ferry_terminal') return 'ferry_terminal';
  if (t.amenity && !SKIP_AMENITY.has(t.amenity)) return t.amenity;
  if (t.tourism && t.tourism !== 'information') return t.tourism;
  if (t.leisure && LEISURE.has(t.leisure)) return t.leisure;
  if (t.natural && NATURAL.has(t.natural)) return t.natural;
  if (t.shop) return t.shop === 'yes' ? 'shop' : t.shop;
  if (t.historic && t.historic !== 'yes') return t.historic;
  if (t.aeroway === 'aerodrome' || t.aeroway === 'terminal') return t.aeroway;
  if (t.office && t.office !== 'yes') return 'office';
  if (t.healthcare) return t.healthcare;
  if (t.landuse === 'cemetery' || t.landuse === 'recreation_ground') return t.landuse;
  if (t.man_made === 'lighthouse' || t.man_made === 'pier' || t.man_made === 'tower') return t.man_made;
  if (t.building && t.building !== 'yes' && ['university', 'school', 'hospital', 'stadium', 'church', 'cathedral', 'train_station'].includes(t.building)) return t.building;
  return null;
}
const TAGS = ['name', 'place', 'railway', 'station', 'amenity', 'tourism', 'leisure', 'natural', 'shop', 'historic', 'aeroway', 'office',
  'healthcare', 'landuse', 'man_made', 'building', 'highway', 'addr:housenumber', 'addr:street', 'addr:suburb', 'addr:unit',
  'boundary', 'admin_level', 'type', 'public_transport'];

// ---------------------------------------------------------------------------
// Pass 1: relations — suburb boundaries and named POI multipolygons.
// ---------------------------------------------------------------------------
type Rel = { name: string; ways: number[]; tags: Record<string, string> };
const boundaryRels: Rel[] = [];
const poiRels: Rel[] = [];
const neededWays = new Set<number>();
log('Pass 1: relations…');
for await (const it of createOSMStream(RAW.osmSydney, { withTags: { node: false, way: false, relation: TAGS } }) as AsyncGenerator<any>) {
  if (it.type !== 'relation' || !it.tags?.name) continue;
  const t = it.tags;
  const ways = it.members.filter((m: any) => m.type === 'way').map((m: any) => m.ref);
  if (!ways.length) continue;
  if (t.boundary === 'administrative' && t.admin_level === '9') boundaryRels.push({ name: t.name, ways, tags: t });
  else if (t.type === 'multipolygon' && (kindOf(t) || t['addr:housenumber'])) poiRels.push({ name: t.name, ways, tags: t });
  else continue;
  for (const w of ways) neededWays.add(w);
}
log(`${boundaryRels.length} suburb boundaries, ${poiRels.length} POI multipolygons`);

// ---------------------------------------------------------------------------
// Pass 2: nodes and ways.
// ---------------------------------------------------------------------------
class Grow<T extends Float64Array | Int32Array> {
  a: T; n = 0; make: (n: number) => T;
  constructor(make: (n: number) => T) { this.make = make; this.a = make(1 << 20); }
  push(v: number) { if (this.n === this.a.length) { const b = this.make(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
}
const nodeIds = new Grow((n) => new Float64Array(n));
const nodeLat = new Grow((n) => new Float64Array(n));
const nodeLon = new Grow((n) => new Float64Array(n));
function nodeIndex(id: number): number {
  const ids = nodeIds.a;
  let lo = 0;
  let hi = nodeIds.n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ids[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

type Item = { tags: Record<string, string>; lat: number; lon: number };
const items: Item[] = []; // POIs, places, addresses (nodes, ways, relations)
type StreetWay = { name: string; lat: number; lon: number; pts: number[] };
const streetWays: StreetWay[] = [];
const wayRefs = new Map<number, number[]>();

function centroid(refs: number[]): [number, number] | null {
  let la = 0;
  let lo = 0;
  let n = 0;
  const closed = refs.length > 2 && refs[0] === refs[refs.length - 1];
  for (let k = 0; k < refs.length - (closed ? 1 : 0); k++) {
    const i = nodeIndex(refs[k]);
    if (i < 0) continue;
    la += nodeLat.a[i];
    lo += nodeLon.a[i];
    n++;
  }
  return n ? [la / n, lo / n] : null;
}

log('Pass 2: nodes and ways…');
let sorted = true;
let lastId = -Infinity;
for await (const it of createOSMStream(RAW.osmSydney, { withTags: { node: TAGS, way: TAGS, relation: false } }) as AsyncGenerator<any>) {
  if (it.type === 'node') {
    if (it.id < lastId) sorted = false;
    lastId = it.id;
    nodeIds.push(it.id);
    nodeLat.push(it.lat);
    nodeLon.push(it.lon);
    const t = it.tags;
    if (t && (t['addr:housenumber'] || kindOf(t)) && inBbox(it.lon, it.lat)) items.push({ tags: t, lat: it.lat, lon: it.lon });
  } else if (it.type === 'way') {
    if (!sorted) throw new Error('OSM nodes are not sorted by id (osmium output should be).');
    if (neededWays.has(it.id)) wayRefs.set(it.id, it.refs);
    const t = it.tags;
    if (!t) continue;
    if (t.highway && t.name && !SKIP_HIGHWAY.has(t.highway)) {
      const pts: number[] = [];
      for (const ref of it.refs) {
        const i = nodeIndex(ref);
        if (i >= 0) pts.push(nodeLat.a[i], nodeLon.a[i]);
      }
      if (pts.length) {
        const m = (pts.length >> 2) << 1; // middle node
        if (inBbox(pts[m + 1], pts[m])) streetWays.push({ name: t.name, lat: pts[m], lon: pts[m + 1], pts });
      }
    }
    if (t['addr:housenumber'] || (!t.highway && kindOf(t))) {
      const c = centroid(it.refs);
      if (c && inBbox(c[1], c[0])) items.push({ tags: t, lat: c[0], lon: c[1] });
    }
  }
}
log(`${nodeIds.n.toLocaleString()} nodes, ${items.length.toLocaleString()} tagged items, ${streetWays.length.toLocaleString()} named street ways`);

for (const r of poiRels) {
  const refs = r.ways.flatMap((w) => wayRefs.get(w) ?? []);
  const c = centroid(refs);
  if (c && inBbox(c[1], c[0])) items.push({ tags: r.tags, lat: c[0], lon: c[1] });
}

// ---------------------------------------------------------------------------
// Suburb lookup: point-in-polygon on boundary segments (even-odd), grid-indexed.
// ---------------------------------------------------------------------------
type Poly = { name: string; seg: Float64Array; minX: number; minY: number; maxX: number; maxY: number; pts: number };
const polys: Poly[] = [];
for (const r of boundaryRels) {
  const segs: number[] = [];
  for (const w of r.ways) {
    const refs = wayRefs.get(w);
    if (!refs) continue;
    let px = NaN;
    let py = NaN;
    for (const ref of refs) {
      const i = nodeIndex(ref);
      if (i < 0) { px = NaN; continue; }
      const x = nodeLon.a[i];
      const y = nodeLat.a[i];
      if (!Number.isNaN(px)) segs.push(px, py, x, y);
      px = x;
      py = y;
    }
  }
  if (!segs.length) continue;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = 0; k < segs.length; k += 2) {
    minX = Math.min(minX, segs[k]); maxX = Math.max(maxX, segs[k]);
    minY = Math.min(minY, segs[k + 1]); maxY = Math.max(maxY, segs[k + 1]);
  }
  polys.push({ name: r.name, seg: Float64Array.from(segs), minX, minY, maxX, maxY, pts: segs.length / 4 });
}
const CELL = 0.02;
const cellKey = (x: number, y: number) => Math.floor(x / CELL) * 100000 + Math.floor(y / CELL);
const polyGrid = new Map<number, Poly[]>();
for (const p of polys) {
  for (let cx = Math.floor(p.minX / CELL); cx <= Math.floor(p.maxX / CELL); cx++)
    for (let cy = Math.floor(p.minY / CELL); cy <= Math.floor(p.maxY / CELL); cy++) {
      const k = cx * 100000 + cy;
      (polyGrid.get(k) ?? polyGrid.set(k, []).get(k)!).push(p);
    }
}
function inPoly(p: Poly, x: number, y: number): boolean {
  if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) return false;
  const s = p.seg;
  let inside = false;
  for (let k = 0; k < s.length; k += 4) {
    const y1 = s[k + 1];
    const y2 = s[k + 3];
    if (y1 > y !== y2 > y && x < ((s[k + 2] - s[k]) * (y - y1)) / (y2 - y1) + s[k]) inside = !inside;
  }
  return inside;
}
const placeNodes = items.filter((i) => i.tags.place && ['suburb', 'town', 'city', 'village', 'locality'].includes(i.tags.place) && i.tags.place !== 'city');
function suburbAt(lat: number, lon: number): string {
  for (const p of polyGrid.get(cellKey(lon, lat)) ?? []) if (inPoly(p, lon, lat)) return p.name;
  let best = '';
  let bd = Infinity;
  for (const n of placeNodes) {
    const d = (n.lat - lat) ** 2 + ((n.lon - lon) * 0.83) ** 2;
    if (d < bd) { bd = d; best = n.tags.name; }
  }
  return best;
}

// Tidy "FIVE DOCK" → "Five Dock".
const titleCase = (s: string) => (s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s);

// ---------------------------------------------------------------------------
// Assemble the index tables.
// ---------------------------------------------------------------------------
const subs: string[] = [];
const subIdx = new Map<string, number>();
const sub = (name: string) => {
  if (!name) return -1;
  name = titleCase(name.trim());
  let i = subIdx.get(name);
  if (i === undefined) { i = subs.length; subs.push(name); subIdx.set(name, i); }
  return i;
};
const kinds: string[] = [];
const kindIdx = new Map<string, number>();
const kind = (k: string) => {
  let i = kindIdx.get(k);
  if (i === undefined) { i = kinds.length; kinds.push(k); kindIdx.set(k, i); }
  return i;
};
const E = { n: [] as string[], k: [] as number[], s: [] as number[], a: [] as string[], y: [] as number[], x: [] as number[] };
const q5 = (v: number) => Math.round(v * 1e5);
function addEntry(name: string, k: string, s: number, extra: string, lat: number, lon: number) {
  E.n.push(name); E.k.push(kind(k)); E.s.push(s); E.a.push(extra); E.y.push(q5(lat)); E.x.push(q5(lon));
}

const A = { st: [] as string[], i: [] as number[], h: [] as string[], s: [] as number[], y: [] as number[], x: [] as number[] };
const streetNameIdx = new Map<string, number>();
const addrSeen = new Set<string>();
const poiSeen = new Set<string>();
let nPlaces = 0, nPois = 0;
const placeNames = new Set<string>();
log('Assigning suburbs…');
for (const it of items) {
  const t = it.tags;
  const k = kindOf(t);
  if (t['addr:housenumber'] && t['addr:street']) {
    const street = t['addr:street'].trim();
    const num = t['addr:housenumber'].trim();
    const s = sub(t['addr:suburb'] || suburbAt(it.lat, it.lon));
    for (const h of num.split(/\s*[;,]\s*/)) {
      const key = `${normalize(street)}|${h.toLowerCase()}|${s}`;
      if (!h || addrSeen.has(key)) continue;
      addrSeen.add(key);
      let si = streetNameIdx.get(street);
      if (si === undefined) { si = A.st.length; A.st.push(street); streetNameIdx.set(street, si); }
      A.i.push(si); A.h.push(h); A.s.push(s); A.y.push(q5(it.lat)); A.x.push(q5(it.lon));
    }
  }
  if (!k) continue;
  let name = t.name.trim();
  if (k === 'station' && !/station/i.test(name)) name += ' Station';
  if (PLACE_KINDS.has(k)) {
    addEntry(name, k, -1, '', it.lat, it.lon);
    placeNames.add(name.toLowerCase());
    nPlaces++;
    continue;
  }
  const s = sub(t['addr:suburb'] || suburbAt(it.lat, it.lon));
  // The same POI is often mapped as a node and an area; keep one per ~100 m.
  const key = `${name}|${k}|${Math.round(it.lat * 1000)}|${Math.round(it.lon * 1000)}`;
  if (poiSeen.has(key)) continue;
  poiSeen.add(key);
  const extra = t['addr:street'] ? [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') : '';
  addEntry(name, k, s, extra, it.lat, it.lon);
  nPois++;
}
// Suburb boundaries with no place node of the same name.
for (const p of polys) {
  if (placeNames.has(p.name.toLowerCase())) continue;
  let la = 0, lo = 0;
  for (let k = 0; k < p.seg.length; k += 4) { lo += p.seg[k]; la += p.seg[k + 1]; }
  const lat = la / p.pts, lon = lo / p.pts;
  if (!inBbox(lon, lat)) continue;
  addEntry(p.name, 'suburb', -1, '', lat, lon);
  nPlaces++;
}

// Streets: group ways by (name, suburb of midpoint), then cluster within ~1 km.
log('Clustering streets…');
const groups = new Map<string, StreetWay[]>();
for (const w of streetWays) {
  const key = `${w.name}|${suburbAt(w.lat, w.lon)}`;
  (groups.get(key) ?? groups.set(key, []).get(key)!).push(w);
}
let nStreets = 0;
const NEAR = 0.01; // ~1 km
for (const [key, ws] of groups) {
  const [name, suburb] = key.split('|');
  // Single-link clustering on way midpoints (groups are small).
  const parent = ws.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < ws.length; i++)
    for (let j = i + 1; j < ws.length; j++)
      if (Math.abs(ws[i].lat - ws[j].lat) < NEAR && Math.abs(ws[i].lon - ws[j].lon) < NEAR * 1.2) parent[find(i)] = find(j);
  const clusters = new Map<number, StreetWay[]>();
  for (let i = 0; i < ws.length; i++) (clusters.get(find(i)) ?? clusters.set(find(i), []).get(find(i))!).push(ws[i]);
  for (const c of clusters.values()) {
    // Representative point: the street node closest to the mean of the way midpoints.
    const mLat = c.reduce((s, w) => s + w.lat, 0) / c.length;
    const mLon = c.reduce((s, w) => s + w.lon, 0) / c.length;
    let best = [c[0].lat, c[0].lon];
    let bd = Infinity;
    for (const w of c)
      for (let k = 0; k < w.pts.length; k += 2) {
        const d = (w.pts[k] - mLat) ** 2 + (w.pts[k + 1] - mLon) ** 2;
        if (d < bd) { bd = d; best = [w.pts[k], w.pts[k + 1]]; }
      }
    addEntry(name, 'street', sub(suburb), '', best[0], best[1]);
    nStreets++;
  }
}

const out = { v: 1, builtAt: new Date().toISOString(), subs, kinds, e: E, ad: A };
const json = JSON.stringify(out);
const gz = zlib.gzipSync(json, { level: 9 });
fs.mkdirSync(GRAPH_DIR, { recursive: true });
fs.writeFileSync(OUT, gz);
log(`${nPlaces} places, ${nPois} POIs, ${nStreets} streets, ${A.i.length} addresses, ${subs.length} suburbs`);
log(`Wrote ${path.relative(process.cwd(), OUT)}: ${(gz.length / 1e6).toFixed(1)} MB (${(json.length / 1e6).toFixed(1)} MB uncompressed)`);
