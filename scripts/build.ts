// Builds the routing graph in data/graph/ from the raw datasets in data/raw/.
//
//   1. OSM → candidate ways → edges between intersections
//   2. TfNSW bike network → matched onto OSM edges (facility per edge)
//   3. Safety model → per-edge multiplier, class, direction
//   4. Keep the largest connected component
//   5. Node features: crossing a busier road, traffic signals, marked crossings
//   6. NSW crash data (crashes involving a bicycle) → penalties on nearby nodes/edges
//
// Usage: npm run build
import fs from 'node:fs';
import path from 'node:path';
import { createOSMStream } from 'osm-pbf-parser-node';
import * as shapefile from 'shapefile';
import proj4 from 'proj4';
import XLSX from 'xlsx';
import { GRAPH_DIR, RAW, inBbox, BBOX } from '../src/config.ts';
import {
  CANDIDATE_HIGHWAYS, WAY_TAGS, FACILITY_CODES, FACILITY_RANK, Fac, Cls, evaluate, crashWeight,
  CLASSES,
} from '../src/model.ts';
import { Grid, haversine, segDist2, toX, toY, bearing } from '../src/geo.ts';

const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

for (const f of [RAW.osmSydney, RAW.crash, RAW.trafficUnit]) {
  if (!fs.existsSync(f)) throw new Error(`Missing ${f} – run \`npm run download\` first.`);
}
const shpPath = path.join(RAW.bikeNetworkDir, 'Existing_Bicycle_Network.shp');
if (!fs.existsSync(shpPath)) throw new Error(`Missing ${shpPath} – run \`npm run download\` first.`);

// ---------------------------------------------------------------------------
// 1. OpenStreetMap
// ---------------------------------------------------------------------------
class F64 { a = new Float64Array(1 << 20); n = 0; push(v: number) { if (this.n === this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; } get() { return this.a.subarray(0, this.n); } }
class I32 { a = new Int32Array(1 << 20); n = 0; push(v: number) { if (this.n === this.a.length) { const b = new Int32Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; } get() { return this.a.subarray(0, this.n); } }

const SIGNAL = 1;
const MARKED = 2;

const osmIds = new F64();
const osmLat = new I32(); // degrees × 1e7
const osmLon = new I32();
const flaggedNodes: { id: number; flag: number }[] = [];
type Way = { id: number; refs: number[]; tags: Record<string, string> };
const ways: Way[] = [];
let sorted = true;
let lastId = -Infinity;

log('Reading OSM…');
for await (const item of createOSMStream(RAW.osmSydney, {
  withTags: { node: ['highway', 'crossing', 'crossing:signals', 'crossing:markings'], way: WAY_TAGS, relation: false },
}) as AsyncGenerator<any>) {
  if (item.type === 'node') {
    if (item.id < lastId) sorted = false;
    lastId = item.id;
    osmIds.push(item.id);
    osmLat.push(Math.round(item.lat * 1e7));
    osmLon.push(Math.round(item.lon * 1e7));
    const t = item.tags;
    if (t) {
      let flag = 0;
      if (t.highway === 'traffic_signals' || t.crossing === 'traffic_signals' || t['crossing:signals'] === 'yes') flag |= SIGNAL;
      if (['marked', 'zebra', 'uncontrolled'].includes(t.crossing) || (t['crossing:markings'] && t['crossing:markings'] !== 'no')) flag |= MARKED;
      if (flag) flaggedNodes.push({ id: item.id, flag });
    }
  } else if (item.type === 'way') {
    if (item.tags && CANDIDATE_HIGHWAYS.has(item.tags.highway)) ways.push({ id: item.id, refs: item.refs, tags: item.tags });
  }
}
if (!sorted) throw new Error('OSM nodes are not sorted by id (osmium output should be).');
const ids = osmIds.get();
const lats = osmLat.get();
const lons = osmLon.get();
log(`${ids.length.toLocaleString()} nodes, ${ways.length.toLocaleString()} candidate ways`);

function nodeIndex(id: number): number {
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ids[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// 2. Split ways into edges between junctions
// ---------------------------------------------------------------------------
const wayIdx: Int32Array[] = ways.map((w) => {
  const r = new Int32Array(w.refs.length);
  let k = 0;
  for (const id of w.refs) {
    const i = nodeIndex(id);
    if (i >= 0) r[k++] = i;
  }
  return r.subarray(0, k);
});
const useCount = new Uint8Array(ids.length);
for (const r of wayIdx) {
  for (let j = 0; j < r.length; j++) {
    const inc = j === 0 || j === r.length - 1 ? 2 : 1;
    useCount[r[j]] = Math.min(255, useCount[r[j]] + inc);
  }
}

const eFrom: number[] = []; // OSM node indices for now
const eTo: number[] = [];
const eWay: number[] = [];
const eGeomStart: number[] = [];
const geomNode = new I32(); // OSM node index for each geometry point
for (let w = 0; w < ways.length; w++) {
  const r = wayIdx[w];
  if (r.length < 2) continue;
  let start = 0;
  for (let j = 1; j < r.length; j++) {
    if (useCount[r[j]] >= 2 || j === r.length - 1) {
      if (r[start] !== r[j]) {
        eFrom.push(r[start]);
        eTo.push(r[j]);
        eWay.push(w);
        eGeomStart.push(geomNode.n);
        for (let k = start; k <= j; k++) geomNode.push(r[k]);
      }
      start = j;
    }
  }
}
eGeomStart.push(geomNode.n);
const nE0 = eFrom.length;
const gNode = geomNode.get();
const gx = new Float64Array(gNode.length);
const gy = new Float64Array(gNode.length);
const gEdge = new Uint32Array(gNode.length);
for (let e = 0; e < nE0; e++)
  for (let p = eGeomStart[e]; p < eGeomStart[e + 1]; p++) {
    gx[p] = toX(lons[gNode[p]] / 1e7);
    gy[p] = toY(lats[gNode[p]] / 1e7);
    gEdge[p] = e;
  }
const eLen = new Float64Array(nE0);
for (let e = 0; e < nE0; e++) {
  let L = 0;
  for (let p = eGeomStart[e]; p < eGeomStart[e + 1] - 1; p++) {
    const a = gNode[p], b = gNode[p + 1];
    L += haversine(lats[a] / 1e7, lons[a] / 1e7, lats[b] / 1e7, lons[b] / 1e7);
  }
  eLen[e] = L;
}
log(`${nE0.toLocaleString()} raw edges, ${gNode.length.toLocaleString()} geometry points`);

function segmentGrid(keep: (e: number) => boolean): Grid {
  const grid = new Grid(25);
  for (let e = 0; e < nE0; e++) {
    if (!keep(e)) continue;
    for (let p = eGeomStart[e]; p < eGeomStart[e + 1] - 1; p++)
      grid.add(p, Math.min(gx[p], gx[p + 1]), Math.min(gy[p], gy[p + 1]), Math.max(gx[p], gx[p + 1]), Math.max(gy[p], gy[p + 1]));
  }
  grid.finalize();
  return grid;
}

// ---------------------------------------------------------------------------
// 3. Match TfNSW bike network onto OSM edges
// ---------------------------------------------------------------------------
log('Matching TfNSW bike network…');
const NFAC = 13;
const tally = new Float32Array(nE0 * NFAC);
{
  const grid = segmentGrid(() => true);
  const wkt = fs.readFileSync(shpPath.replace(/\.shp$/, '.prj'), 'utf8');
  const project = proj4(wkt, 'WGS84');
  const SKIP_INFRA = new Set(['Ferry/Boat', 'Lift/Elevator', 'Steps', 'Bicycle Storage Area', 'Kerb Ramp']);
  const src = await shapefile.open(shpPath);
  const STEP = 5;
  const MAXD = 15;
  let feats = 0;
  let matched = 0;
  let total = 0;
  for (;;) {
    const r = await src.read();
    if (r.done) break;
    const p = r.value.properties as Record<string, any>;
    const fac = FACILITY_CODES[p.facility];
    if (!fac || SKIP_INFRA.has(p.infra)) continue;
    const g = r.value.geometry;
    if (!g) continue;
    const lines: number[][][] = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const line of lines) {
      const pts = line.map((c) => project.forward(c as [number, number]));
      if (!pts.some(([lon, lat]) => inBbox(lon, lat))) continue;
      feats++;
      const xs = pts.map(([lon]) => toX(lon));
      const ys = pts.map(([, lat]) => toY(lat));
      let carry = 0;
      for (let i = 0; i < xs.length - 1; i++) {
        const dx = xs[i + 1] - xs[i];
        const dy = ys[i + 1] - ys[i];
        const L = Math.hypot(dx, dy);
        if (L < 0.01) continue;
        const brg = bearing(xs[i], ys[i], xs[i + 1], ys[i + 1]);
        for (let s = carry; s < L; s += STEP) {
          const px = xs[i] + (dx * s) / L;
          const py = ys[i] + (dy * s) / L;
          total += STEP;
          let best = -1;
          let bestD = MAXD * MAXD;
          grid.query(px, py, MAXD, (q) => {
            const [d2] = segDist2(px, py, gx[q], gy[q], gx[q + 1], gy[q + 1]);
            if (d2 >= bestD) return;
            let diff = Math.abs(bearing(gx[q], gy[q], gx[q + 1], gy[q + 1]) - brg) % 180;
            if (diff > 90) diff = 180 - diff;
            if (diff > 35) return;
            bestD = d2;
            best = q;
          });
          if (best >= 0) {
            tally[gEdge[best] * NFAC + fac] += STEP;
            matched += STEP;
          }
        }
        carry = (carry - L) % STEP;
        if (carry < 0) carry += STEP;
      }
    }
  }
  log(`${feats.toLocaleString()} TfNSW lines in Sydney, ${((100 * matched) / total).toFixed(1)}% of length matched to OSM`);
}

const RAW_LEVEL_OF = (hw: string) =>
  (({ motorway: 6, motorway_link: 6, trunk: 5, trunk_link: 5, primary: 4, primary_link: 4, secondary: 3, secondary_link: 3,
    tertiary: 2, tertiary_link: 2, unclassified: 1, residential: 1, road: 1, living_street: 1, service: 1 }) as Record<string, number>)[hw] ?? 0;
const eFac = new Uint8Array(nE0);
for (let e = 0; e < nE0; e++) {
  const need = Math.max(3, 0.4 * eLen[e]);
  for (const f of FACILITY_RANK) {
    if (tally[e * NFAC + f] >= need) {
      eFac[e] = f;
      break;
    }
  }
}

// A TfNSW path drawn more than ~15 m from its OSM twin gets matched onto the
// adjacent road instead, which would make e.g. a 70 km/h arterial look like a
// shared path. If a parallel OSM path/footway/cycleway exists nearby, move the
// facility onto that path and leave the road as a road.
{
  const PATHY = new Set(['footway', 'path', 'cycleway', 'pedestrian', 'bridleway']);
  const isPathy = (e: number) => PATHY.has(ways[eWay[e]].tags.highway);
  const pathGrid = segmentGrid(isPathy);
  let moved = 0;
  let movedKm = 0;
  for (let e = 0; e < nE0; e++) {
    const f = eFac[e];
    if (!(f === Fac.BicyclePath || f === Fac.SeparatedPath || f === Fac.SharedPath) || isPathy(e)) continue;
    if ((RAW_LEVEL_OF(ways[eWay[e]].tags.highway)) < 1) continue;
    const found = new Map<number, number>();
    let samples = 0;
    let hits = 0;
    for (let p = eGeomStart[e]; p < eGeomStart[e + 1] - 1; p++) {
      const dx = gx[p + 1] - gx[p], dy = gy[p + 1] - gy[p];
      const L = Math.hypot(dx, dy);
      if (L < 0.01) continue;
      const brg = bearing(gx[p], gy[p], gx[p + 1], gy[p + 1]);
      for (let s = 0; s < L; s += 10) {
        const px = gx[p] + (dx * s) / L, py = gy[p] + (dy * s) / L;
        samples++;
        let best = -1;
        let bestD = 40 * 40;
        pathGrid.query(px, py, 40, (q) => {
          const [d2] = segDist2(px, py, gx[q], gy[q], gx[q + 1], gy[q + 1]);
          if (d2 >= bestD) return;
          let diff = Math.abs(bearing(gx[q], gy[q], gx[q + 1], gy[q + 1]) - brg) % 180;
          if (diff > 90) diff = 180 - diff;
          if (diff > 30) return;
          bestD = d2;
          best = gEdge[q];
        });
        if (best >= 0) { hits++; found.set(best, (found.get(best) ?? 0) + 10); }
      }
    }
    if (samples && hits / samples >= 0.5) {
      for (const [pe] of found) if (!eFac[pe] || FACILITY_RANK.indexOf(f) < FACILITY_RANK.indexOf(eFac[pe] as Fac)) eFac[pe] = f;
      // Fall back to the next-best non-path facility recorded on the road (e.g. a bike lane).
      eFac[e] = Fac.None;
      const need = Math.max(3, 0.4 * eLen[e]);
      for (const g of FACILITY_RANK) {
        if (g === Fac.BicyclePath || g === Fac.SeparatedPath || g === Fac.SharedPath) continue;
        if (tally[e * NFAC + g] >= need) { eFac[e] = g; break; }
      }
      moved++;
      movedKm += eLen[e] / 1000;
    }
  }
  log(`Moved path facility off ${moved} road edges (${movedKm.toFixed(1)} km) onto parallel OSM paths`);
}

// ---------------------------------------------------------------------------
// 4. Safety model + largest connected component
// ---------------------------------------------------------------------------
log('Scoring edges…');
const RAW_LEVEL: Record<string, number> = {
  motorway: 6, motorway_link: 6, trunk: 5, trunk_link: 5, primary: 4, primary_link: 4,
  secondary: 3, secondary_link: 3, tertiary: 2, tertiary_link: 2,
};
const props = new Array(nE0);
for (let e = 0; e < nE0; e++) props[e] = evaluate(ways[eWay[e]].tags, eFac[e] as Fac);

const parent = new Int32Array(ids.length).map((_, i) => i);
const find = (x: number): number => {
  while (parent[x] !== x) {
    parent[x] = parent[parent[x]];
    x = parent[x];
  }
  return x;
};
for (let e = 0; e < nE0; e++) {
  const p = props[e];
  if (p && (p.fwd || p.back)) {
    const a = find(eFrom[e]), b = find(eTo[e]);
    if (a !== b) parent[a] = b;
  }
}
const compSize = new Map<number, number>();
for (let e = 0; e < nE0; e++) if (props[e]) { const r = find(eFrom[e]); compSize.set(r, (compSize.get(r) ?? 0) + 1); }
let mainComp = -1;
let mainSize = 0;
for (const [r, s] of compSize) if (s > mainSize) { mainSize = s; mainComp = r; }
const keep = (e: number) => !!props[e] && find(eFrom[e]) === mainComp;

// Compact node numbering.
const gid = new Int32Array(ids.length).fill(-1);
let N = 0;
const edges: number[] = [];
for (let e = 0; e < nE0; e++) {
  if (!keep(e)) continue;
  edges.push(e);
  if (gid[eFrom[e]] < 0) gid[eFrom[e]] = N++;
  if (gid[eTo[e]] < 0) gid[eTo[e]] = N++;
}
const E = edges.length;
log(`Graph: ${N.toLocaleString()} nodes, ${E.toLocaleString()} edges (dropped ${(nE0 - E).toLocaleString()})`);

// ---------------------------------------------------------------------------
// 5. Node features
// ---------------------------------------------------------------------------
const nodeLat = new Int32Array(N);
const nodeLon = new Int32Array(N);
for (let i = 0; i < ids.length; i++) if (gid[i] >= 0) { nodeLat[gid[i]] = lats[i]; nodeLon[gid[i]] = lons[i]; }

const names: string[] = [''];
const nameIdx = new Map<string, number>([['', 0]]);
const intern = (s: string | undefined) => {
  s = s ?? '';
  let i = nameIdx.get(s);
  if (i === undefined) { i = names.length; names.push(s); nameIdx.set(s, i); }
  return i;
};

// Busiest road touching each node (including roads bikes can't use – you still have to cross them).
const nodeMajor = new Uint8Array(N);
const nodeMajorName = new Uint32Array(N);
const nodeDegree = new Uint8Array(N);
for (let e = 0; e < nE0; e++) {
  const lvl = RAW_LEVEL[ways[eWay[e]].tags.highway] ?? 0;
  for (const n of [eFrom[e], eTo[e]]) {
    const g = gid[n];
    if (g < 0) continue;
    if (keep(e)) nodeDegree[g] = Math.min(255, nodeDegree[g] + 1);
    const t = ways[eWay[e]].tags;
    if (lvl > nodeMajor[g] || (lvl === nodeMajor[g] && lvl > 0 && !names[nodeMajorName[g]] && (t.name ?? t.ref))) {
      nodeMajor[g] = lvl;
      nodeMajorName[g] = intern(t.name ?? t.ref);
    }
  }
}
// For crossing detection: how many arms of the major road meet at the node, and the
// direction of the first two arms (unit vectors). With exactly two arms the road passes
// straight through, so the router can tell whether a route actually crosses it or just
// touches it and stays on the same side.
const nodeMajorArms = new Uint8Array(N);
const nodeArmA = new Float32Array(N); // angle (radians) of arm A
const nodeArmB = new Float32Array(N);
for (let e = 0; e < nE0; e++) {
  const lvl = RAW_LEVEL[ways[eWay[e]].tags.highway] ?? 0;
  if (lvl < 2) continue;
  const s0 = eGeomStart[e], s1 = eGeomStart[e + 1];
  for (const [n, p, q] of [[eFrom[e], s0, s0 + 1], [eTo[e], s1 - 1, s1 - 2]]) {
    const g = gid[n];
    if (g < 0 || nodeMajor[g] !== lvl) continue;
    const ang = Math.atan2(gy[q] - gy[p], gx[q] - gx[p]);
    const k = nodeMajorArms[g];
    if (k === 0) nodeArmA[g] = ang;
    else if (k === 1) nodeArmB[g] = ang;
    nodeMajorArms[g] = Math.min(255, k + 1);
  }
}

const nodeFlags = new Uint8Array(N);
{
  const sigGrid = new Grid(50);
  const sx: number[] = [], sy: number[] = [], sf: number[] = [];
  for (const { id, flag } of flaggedNodes) {
    const i = nodeIndex(id);
    if (i < 0) continue;
    const x = toX(lons[i] / 1e7), y = toY(lats[i] / 1e7);
    sigGrid.add(sx.length, x, y, x, y);
    sx.push(x); sy.push(y); sf.push(flag);
  }
  sigGrid.finalize();
  for (let n = 0; n < N; n++) {
    if (nodeMajor[n] < 2) continue;
    const x = toX(nodeLon[n] / 1e7), y = toY(nodeLat[n] / 1e7);
    sigGrid.query(x, y, 30, (k) => {
      const d = Math.hypot(sx[k] - x, sy[k] - y);
      if (sf[k] & SIGNAL && d <= 30) nodeFlags[n] |= SIGNAL;
      if (sf[k] & MARKED && d <= 8) nodeFlags[n] |= MARKED;
    });
  }
}

// ---------------------------------------------------------------------------
// 6. Crashes involving a bicycle
// ---------------------------------------------------------------------------
log('Reading crash data…');
const sheetRows = (file: string) => {
  const wb = XLSX.read(fs.readFileSync(file), { dense: true });
  return XLSX.utils.sheet_to_json<Record<string, any>>(wb.Sheets[wb.SheetNames[0]]);
};
const bikeCrashIds = new Set<number>();
for (const r of sheetRows(RAW.trafficUnit)) if (r['TU type group'] === 'Pedal cycle') bikeCrashIds.add(r['Crash ID']);
const crashRows = sheetRows(RAW.crash).filter(
  (r) =>
    (bikeCrashIds.has(r['Crash ID']) || r['Key TU type'] === 'Pedal cycle' || r['Other TU type'] === 'Pedal cycle') &&
    typeof r.Latitude === 'number' &&
    inBbox(r.Longitude, r.Latitude),
);
log(`${crashRows.length.toLocaleString()} crashes involving a bicycle in Greater Sydney`);

const edgeCrash = new Float32Array(E);
const edgeCrashN = new Uint16Array(E);
const nodeCrash = new Float32Array(N);
const nodeCrashN = new Uint16Array(N);
const crashFeatures: any[] = [];
{
  const newIdx = new Int32Array(nE0).fill(-1);
  edges.forEach((e, i) => (newIdx[e] = i));
  const grid = segmentGrid(keep);
  const nodeGrid = new Grid(50);
  for (let n = 0; n < N; n++) {
    if (nodeDegree[n] < 3) continue;
    const x = toX(nodeLon[n] / 1e7), y = toY(nodeLat[n] / 1e7);
    nodeGrid.add(n, x, y, x, y);
  }
  nodeGrid.finalize();

  for (const r of crashRows) {
    const w = crashWeight(String(r['Degree of crash - detailed'] ?? r['Degree of crash'] ?? ''));
    const x = toX(r.Longitude), y = toY(r.Latitude);
    const multiVehicle = (r['No. of traffic units involved'] ?? 1) >= 2;
    crashFeatures.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [+r.Longitude.toFixed(5), +r.Latitude.toFixed(5)] },
      properties: {
        sev: String(r['Degree of crash - detailed'] ?? ''),
        year: r['Year of crash'],
        desc: String(r['RUM - description'] ?? ''),
        street: `${r['Street of crash'] ?? ''} ${r['Street type'] ?? ''}`.trim(),
        w,
      },
    });

    let bestNode = -1;
    let bestNodeD = 15;
    nodeGrid.query(x, y, 15, (n) => {
      const d = Math.hypot(toX(nodeLon[n] / 1e7) - x, toY(nodeLat[n] / 1e7) - y);
      if (d < bestNodeD) { bestNodeD = d; bestNode = n; }
    });
    if (bestNode >= 0) {
      nodeCrash[bestNode] += w;
      nodeCrashN[bestNode]++;
      continue;
    }
    let best = -1;
    let bestD = 30 * 30;
    grid.query(x, y, 30, (q) => {
      const e = gEdge[q];
      if (multiVehicle && (props[e].level === 0)) return; // collisions with vehicles happen on roads
      const [d2] = segDist2(x, y, gx[q], gy[q], gx[q + 1], gy[q + 1]);
      if (d2 < bestD) { bestD = d2; best = e; }
    });
    if (best >= 0) {
      edgeCrash[newIdx[best]] += w;
      edgeCrashN[newIdx[best]]++;
    }
  }
}

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------
log('Writing graph…');
const edgeFrom = new Uint32Array(E);
const edgeTo = new Uint32Array(E);
const edgeLen = new Float32Array(E);
const edgeMult = new Float32Array(E);
const edgeTime = new Float32Array(E);
const edgeCls = new Uint8Array(E);
const edgeLevel = new Uint8Array(E);
const edgeDir = new Uint8Array(E); // bit0 = forward allowed, bit1 = backward allowed
const edgeFac = new Uint8Array(E);
const edgeName = new Uint32Array(E);
const edgeGeomStart = new Uint32Array(E + 1);
let G = 0;
for (const e of edges) G += eGeomStart[e + 1] - eGeomStart[e];
const geomLat = new Int32Array(G);
const geomLon = new Int32Array(G);
const network: Record<number, number[][][]> = {};
let gp = 0;
edges.forEach((e, i) => {
  const p = props[e];
  const t = ways[eWay[e]].tags;
  edgeFrom[i] = gid[eFrom[e]];
  edgeTo[i] = gid[eTo[e]];
  edgeLen[i] = eLen[e];
  edgeMult[i] = p.mult;
  edgeTime[i] = p.time;
  edgeCls[i] = p.cls;
  edgeLevel[i] = p.level;
  edgeDir[i] = (p.fwd ? 1 : 0) | (p.back ? 2 : 0);
  edgeFac[i] = eFac[e];
  edgeName[i] = intern(t.name ?? t.ref);
  edgeGeomStart[i] = gp;
  const coords: number[][] = [];
  for (let q = eGeomStart[e]; q < eGeomStart[e + 1]; q++) {
    geomLat[gp] = lats[gNode[q]];
    geomLon[gp] = lons[gNode[q]];
    coords.push([+(lons[gNode[q]] / 1e7).toFixed(5), +(lats[gNode[q]] / 1e7).toFixed(5)]);
    gp++;
  }
  // Map overlay: the low-stress + bike-lane network.
  if (p.cls === Cls.Separated || p.cls === Cls.Shared || p.cls === Cls.Lane || (p.cls === Cls.Quiet && eFac[e] === Fac.Quietway))
    (network[p.cls] ??= []).push(coords);
});
edgeGeomStart[E] = gp;

fs.rmSync(GRAPH_DIR, { recursive: true, force: true });
fs.mkdirSync(GRAPH_DIR, { recursive: true });
const arrays: Record<string, ArrayBufferView & { length: number }> = {
  nodeLat, nodeLon, nodeFlags, nodeMajor, nodeMajorName, nodeMajorArms, nodeArmA, nodeArmB, nodeCrash, nodeCrashN,
  edgeFrom, edgeTo, edgeLen, edgeMult, edgeTime, edgeCls, edgeLevel, edgeDir, edgeFac, edgeName,
  edgeCrash, edgeCrashN, edgeGeomStart, geomLat, geomLon,
};
const manifest: Record<string, { type: string; length: number }> = {};
for (const [name, arr] of Object.entries(arrays)) {
  fs.writeFileSync(path.join(GRAPH_DIR, name + '.bin'), new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
  manifest[name] = { type: arr.constructor.name, length: arr.length };
}
fs.writeFileSync(
  path.join(GRAPH_DIR, 'meta.json'),
  JSON.stringify({ builtAt: new Date().toISOString(), bbox: BBOX, nodes: N, edges: E, crashes: crashRows.length, arrays: manifest, names }),
);
fs.writeFileSync(
  path.join(GRAPH_DIR, 'network.geojson'),
  JSON.stringify({
    type: 'FeatureCollection',
    features: Object.entries(network).map(([cls, lines]) => ({
      type: 'Feature',
      properties: { cls: +cls, label: CLASSES[+cls].label },
      geometry: { type: 'MultiLineString', coordinates: lines },
    })),
  }),
);
fs.writeFileSync(path.join(GRAPH_DIR, 'crashes.geojson'), JSON.stringify({ type: 'FeatureCollection', features: crashFeatures }));

// Summary of the network by class.
const km = new Array(CLASSES.length).fill(0);
for (let i = 0; i < E; i++) km[edgeCls[i]] += edgeLen[i] / 1000;
for (let c = 0; c < CLASSES.length; c++) log(`  ${CLASSES[c].label.padEnd(22)} ${km[c].toFixed(0).padStart(6)} km`);
log('Done.');
