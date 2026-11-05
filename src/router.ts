import type { Graph } from './graph.ts';
import { segDist2, toX, toY, toLat, toLon, bearing } from './geo.ts';
import {
  CLASSES, Cls, CRASH_CAP, CRASH_METRES, CROSSING_PENALTY, CRUISE_KMH, MARKED_FACTOR, MODES,
  SIGNAL_FACTOR, FACILITY_LABELS, type Mode,
} from './model.ts';

const SIGNAL = 1;
const MARKED = 2;

interface Snap {
  edge: number;
  along: number; // metres from edgeFrom
  lat: number;
  lon: number;
  dist: number;
}

// A piece of an edge travelled from `a` to `b` (metres from edgeFrom; b < a means reverse).
interface Leg {
  edge: number;
  a: number;
  b: number;
}

export function snap(g: Graph, lat: number, lon: number): Snap | null {
  const x = toX(lon);
  const y = toY(lat);
  for (const r of [60, 250, 1000]) {
    let best = -1;
    let bestScore = Infinity;
    let bestT = 0;
    g.segGrid.query(x, y, r, (p) => {
      const [d2, t] = segDist2(x, y, g.geomX[p], g.geomY[p], g.geomX[p + 1], g.geomY[p + 1]);
      const e = g.geomEdge[p];
      // Prefer snapping to rideable ways over footpaths or busy roads when they're about as close.
      const cls = g.edgeCls[e];
      const score = Math.sqrt(d2) + (cls === Cls.Walk ? 12 : cls === Cls.Busy ? 6 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = p;
        bestT = t;
      }
    });
    if (best < 0) continue;
    const e = g.geomEdge[best];
    let planar = 0;
    let along = 0;
    for (let p = g.edgeGeomStart[e]; p < g.edgeGeomStart[e + 1] - 1; p++) {
      const L = Math.hypot(g.geomX[p + 1] - g.geomX[p], g.geomY[p + 1] - g.geomY[p]);
      if (p === best) along = planar + bestT * L;
      planar += L;
    }
    const scale = planar > 0 ? g.edgeLen[e] / planar : 0;
    const sx = g.geomX[best] + bestT * (g.geomX[best + 1] - g.geomX[best]);
    const sy = g.geomY[best] + bestT * (g.geomY[best + 1] - g.geomY[best]);
    return { edge: e, along: along * scale, lat: toLat(sy), lon: toLon(sx), dist: Math.hypot(sx - x, sy - y) };
  }
  return null;
}

// Reusable search state (the server is single-threaded).
let state: { stamp: Uint32Array; gScore: Float64Array; pred: Int32Array; closed: Uint32Array; epoch: number } | null = null;

class Heap {
  k = new Float64Array(1024);
  v = new Int32Array(1024);
  n = 0;
  push(key: number, val: number) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop(): number {
    const top = this.v[0];
    const key = this.k[--this.n];
    const val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
  minKey() { return this.k[0]; }
}

function edgeRate(g: Graph, e: number, alpha: number) {
  return g.edgeTime[e] + alpha * (g.edgeMult[e] - 1);
}
function edgeCrashCost(g: Graph, e: number, alpha: number) {
  return alpha * Math.min(CRASH_CAP, g.edgeCrash[e] * CRASH_METRES);
}
function nodeCost(g: Graph, n: number, alpha: number) {
  return alpha * Math.min(CRASH_CAP, g.nodeCrash[n] * CRASH_METRES);
}
// Angle of the geometry leaving node n along edge e.
function armAngle(g: Graph, n: number, e: number): number {
  const s = g.edgeGeomStart[e];
  const t = g.edgeGeomStart[e + 1];
  const [p, q] = g.edgeFrom[e] === n ? [s, s + 1] : [t - 1, t - 2];
  return Math.atan2(g.geomY[q] - g.geomY[p], g.geomX[q] - g.geomX[p]);
}
// Is angle x inside the counter-clockwise sweep from a to b?
function inSweep(a: number, b: number, x: number): boolean {
  const TAU = 2 * Math.PI;
  const span = (((b - a) % TAU) + TAU) % TAU;
  const off = (((x - a) % TAU) + TAU) % TAU;
  return off < span;
}

// Penalty for crossing a road busier than both the street you arrive on and the one you leave on.
function crossing(g: Graph, n: number, inEdge: number, outEdge: number): number {
  const L = g.nodeMajor[n];
  if (L < 2 || inEdge < 0 || outEdge < 0) return 0;
  if (g.edgeLevel[inEdge] >= L || g.edgeLevel[outEdge] >= L) return 0;
  const arms = g.nodeMajorArms[n];
  // The major road ends here (e.g. turns into a minor street): nothing to cross.
  if (arms < 2) return 0;
  // The road passes straight through: only penalise if we end up on the other side of it.
  if (arms === 2) {
    const a = g.nodeArmA[n];
    const b = g.nodeArmB[n];
    if (inSweep(a, b, armAngle(g, n, inEdge)) === inSweep(a, b, armAngle(g, n, outEdge))) return 0;
  }
  const f = g.nodeFlags[n];
  return CROSSING_PENALTY[L] * (f & SIGNAL ? SIGNAL_FACTOR : f & MARKED ? MARKED_FACTOR : 1);
}

function search(g: Graph, s: Snap, t: Snap, alpha: number): Leg[] | null {
  if (!state || state.stamp.length !== g.N)
    state = { stamp: new Uint32Array(g.N), gScore: new Float64Array(g.N), pred: new Int32Array(g.N), closed: new Uint32Array(g.N), epoch: 0 };
  const st = state;
  const epoch = ++st.epoch;
  const heap = new Heap();
  const tx = toX(t.lon);
  const ty = toY(t.lat);
  const h = (n: number) => 0.99 * Math.hypot(g.nodeX[n] - tx, g.nodeY[n] - ty);

  const relax = (n: number, cost: number, pred: number) => {
    if (st.stamp[n] !== epoch) {
      st.stamp[n] = epoch;
      st.gScore[n] = Infinity;
    }
    if (cost < st.gScore[n]) {
      st.gScore[n] = cost;
      st.pred[n] = pred;
      heap.push(cost + h(n), n);
    }
  };

  // Sources: the two ends of the start edge (if that direction is allowed). pred = -1 - side.
  const se = s.edge;
  const sRate = edgeRate(g, se, alpha);
  if (g.edgeDir[se] & 1) relax(g.edgeTo[se], (g.edgeLen[se] - s.along) * sRate, -1);
  if (g.edgeDir[se] & 2) relax(g.edgeFrom[se], s.along * sRate, -2);

  // Targets: reaching edgeFrom then riding forward to the point, or edgeTo then backward.
  const te = t.edge;
  const tRate = edgeRate(g, te, alpha);
  const tailFrom = g.edgeDir[te] & 1 ? t.along * tRate : Infinity;
  const tailTo = g.edgeDir[te] & 2 ? (g.edgeLen[te] - t.along) * tRate : Infinity;

  let best = Infinity;
  let bestNode = -1;
  // Start and end on the same edge.
  if (se === te) {
    const fwd = t.along >= s.along;
    if (g.edgeDir[se] & (fwd ? 1 : 2)) {
      best = Math.abs(t.along - s.along) * sRate;
      bestNode = -2;
    }
  }

  while (heap.n > 0) {
    if (heap.minKey() >= best) break;
    const u = heap.pop();
    if (st.closed[u] === epoch) continue;
    st.closed[u] = epoch;
    const gu = st.gScore[u];

    if (u === g.edgeFrom[te] && gu + tailFrom < best) { best = gu + tailFrom; bestNode = u; }
    if (u === g.edgeTo[te] && gu + tailTo < best) { best = gu + tailTo; bestNode = u; }

    const p = st.pred[u];
    const inEdge = p >= 0 ? p >> 1 : se;
    for (let i = g.adjStart[u]; i < g.adjStart[u + 1]; i++) {
      const entry = g.adj[i];
      const e = entry >> 1;
      if (e === inEdge && p >= 0) continue; // no immediate U-turns
      const v = entry & 1 ? g.edgeFrom[e] : g.edgeTo[e];
      if (st.closed[v] === epoch) continue;
      const c =
        gu +
        g.edgeLen[e] * edgeRate(g, e, alpha) +
        edgeCrashCost(g, e, alpha) +
        nodeCost(g, v, alpha) +
        alpha * crossing(g, u, inEdge, e);
      relax(v, c, entry);
    }
  }
  if (bestNode === -1) return null;

  if (bestNode === -2) return [{ edge: se, a: s.along, b: t.along }];

  // Reconstruct.
  const legs: Leg[] = [];
  legs.push(
    bestNode === g.edgeFrom[te] && st.gScore[bestNode] + tailFrom === best
      ? { edge: te, a: 0, b: t.along }
      : { edge: te, a: g.edgeLen[te], b: t.along },
  );
  let n = bestNode;
  for (;;) {
    const p = st.pred[n];
    if (p < 0) {
      legs.push(p === -1 ? { edge: se, a: s.along, b: g.edgeLen[se] } : { edge: se, a: s.along, b: 0 });
      break;
    }
    const e = p >> 1;
    legs.push(p & 1 ? { edge: e, a: g.edgeLen[e], b: 0 } : { edge: e, a: 0, b: g.edgeLen[e] });
    n = p & 1 ? g.edgeTo[e] : g.edgeFrom[e];
  }
  legs.reverse();
  return legs.filter((l) => Math.abs(l.b - l.a) > 0.01 || legs.length === 1);
}

// Coordinates of an edge between two distances along it (in travel order).
function slice(g: Graph, e: number, a: number, b: number): [number, number][] {
  const start = g.edgeGeomStart[e];
  const end = g.edgeGeomStart[e + 1];
  const cum: number[] = [0];
  for (let p = start; p < end - 1; p++) cum.push(cum[cum.length - 1] + Math.hypot(g.geomX[p + 1] - g.geomX[p], g.geomY[p + 1] - g.geomY[p]));
  const scale = cum[cum.length - 1] > 0 ? g.edgeLen[e] / cum[cum.length - 1] : 1;
  const lo = Math.min(a, b) / scale;
  const hi = Math.max(a, b) / scale;
  const at = (d: number): [number, number] => {
    for (let i = 0; i < cum.length - 1; i++) {
      if (d <= cum[i + 1] || i === cum.length - 2) {
        const seg = cum[i + 1] - cum[i];
        const t = seg > 0 ? Math.min(1, Math.max(0, (d - cum[i]) / seg)) : 0;
        const p = start + i;
        return [toLon(g.geomX[p] + t * (g.geomX[p + 1] - g.geomX[p])), toLat(g.geomY[p] + t * (g.geomY[p + 1] - g.geomY[p]))];
      }
    }
    return [g.geomLon[start] / 1e7, g.geomLat[start] / 1e7];
  };
  const out: [number, number][] = [at(lo)];
  for (let i = 1; i < cum.length - 1; i++) if (cum[i] > lo && cum[i] < hi) out.push([g.geomLon[start + i] / 1e7, g.geomLat[start + i] / 1e7]);
  out.push(at(hi));
  if (b < a) out.reverse();
  return out;
}

// Join " · "-separated notes, dropping repeats.
function mergeNotes(...notes: (string | undefined)[]): string | undefined {
  const parts = [...new Set(notes.flatMap((n) => (n ? n.split(' · ') : [])))];
  return parts.length ? parts.join(' · ') : undefined;
}

function unnamed(cls: number): string {
  switch (cls) {
    case Cls.Separated: return 'the cycleway';
    case Cls.Shared: return 'the shared path';
    case Cls.Walk: return 'the footpath';
    case Cls.Quiet: return 'the laneway';
    default: return 'the road';
  }
}

function turnText(delta: number): { text: string; icon: string } {
  const a = Math.abs(delta);
  const side = delta < 0 ? 'left' : 'right';
  if (a < 25) return { text: 'Continue onto', icon: 'straight' };
  if (a < 60) return { text: `Bear ${side} onto`, icon: `slight-${side}` };
  if (a < 140) return { text: `Turn ${side} onto`, icon: side };
  return { text: `Make a sharp ${side} onto`, icon: `sharp-${side}` };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function describe(g: Graph, legs: Leg[], mode: Mode) {
  const coords: [number, number][][] = legs.map((l) => slice(g, l.edge, l.a, l.b));
  const byClass = new Array(CLASSES.length).fill(0);
  let distance = 0;
  let seconds = 0;
  let weighted = 0;
  let crashes = 0;
  const crossings: { name: string; signals: boolean; lat: number; lon: number }[] = [];

  // Pieces: consecutive legs with the same class merge into one coloured line.
  const features: any[] = [];
  const legInfo = legs.map((l, i) => {
    const len = Math.abs(l.b - l.a);
    const cls = g.edgeCls[l.edge];
    distance += len;
    byClass[cls] += len;
    seconds += (len * g.edgeTime[l.edge]) / (CRUISE_KMH / 3.6);
    weighted += len * g.edgeMult[l.edge] + Math.min(CRASH_CAP, g.edgeCrash[l.edge] * CRASH_METRES) * (len / Math.max(1, g.edgeLen[l.edge]));
    if (len > 0.5 * g.edgeLen[l.edge]) crashes += g.edgeCrashN[l.edge];
    let crossed: { name: string; signals: boolean } | null = null;
    if (i > 0) {
      // Node between the previous leg and this one.
      const prev = legs[i - 1];
      const node = prev.b >= prev.a ? g.edgeTo[prev.edge] : g.edgeFrom[prev.edge];
      crashes += g.nodeCrashN[node];
      weighted += Math.min(CRASH_CAP, g.nodeCrash[node] * CRASH_METRES);
      const pen = crossing(g, node, prev.edge, l.edge);
      weighted += pen;
      if (pen > 0) {
        const c = {
          name: g.names[g.nodeMajorName[node]] || 'a main road',
          signals: !!(g.nodeFlags[node] & SIGNAL),
          lat: g.nodeLat[node] / 1e7,
          lon: g.nodeLon[node] / 1e7,
        };
        // Both carriageways of a divided road count as one crossing.
        const prevC = crossings.at(-1);
        const same = prevC && prevC.name === c.name && Math.hypot(toX(prevC.lon) - toX(c.lon), toY(prevC.lat) - toY(c.lat)) < 80;
        if (same) prevC.signals = prevC.signals && c.signals;
        else {
          crossings.push(c);
          crossed = { name: c.name, signals: c.signals };
        }
      }
    }
    return { len, cls, name: g.names[g.edgeName[l.edge]], fac: g.edgeFac[l.edge], crossed };
  });

  for (let i = 0; i < legs.length; i++) {
    const last = features[features.length - 1];
    if (last && last.properties.cls === legInfo[i].cls) {
      last.geometry.coordinates.push(...coords[i].slice(1));
      last.properties.length += legInfo[i].len;
    } else {
      features.push({
        type: 'Feature',
        properties: { cls: legInfo[i].cls, length: legInfo[i].len },
        geometry: { type: 'LineString', coordinates: [...(last ? [last.geometry.coordinates.at(-1)] : []), ...coords[i].slice(last ? 1 : 0)] },
      });
    }
  }

  // Turn-by-turn steps: group legs by street name (or by class for unnamed paths).
  type Step = { name: string; cls: number; distance: number; legs: number[]; note?: string };
  const groups: Step[] = [];
  for (let i = 0; i < legs.length; i++) {
    const info = legInfo[i];
    const label = info.name || unnamed(info.cls);
    const last = groups[groups.length - 1];
    if (last && last.name === label && !info.crossed) {
      last.distance += info.len;
      last.legs.push(i);
    } else {
      groups.push({
        name: label,
        cls: info.cls,
        distance: info.len,
        legs: [i],
        note: info.crossed ? `Cross ${info.crossed.name}${info.crossed.signals ? ' at the lights' : ' – no signals, take care'}` : undefined,
      });
    }
  }
  // Fold short connectors (crossing ways, kerb ramps, slip paths) into the previous
  // step, carrying any crossing note forward onto the next step.
  for (let i = groups.length - 2; i > 0; i--) {
    const grp = groups[i];
    const isCrossingWay = /crossing/i.test(grp.name) && grp.distance < 40;
    if (grp.distance < 25 || isCrossingWay) {
      groups[i - 1].distance += grp.distance;
      groups[i - 1].legs.push(...grp.legs);
      if (grp.note) groups[i + 1].note = mergeNotes(grp.note, groups[i + 1].note);
      groups.splice(i, 1);
    }
  }
  // Merge neighbours that ended up with the same street name.
  for (let i = groups.length - 1; i > 0; i--) {
    if (groups[i].name === groups[i - 1].name && !groups[i].note) {
      groups[i - 1].distance += groups[i].distance;
      groups[i - 1].legs.push(...groups[i].legs);
      groups.splice(i, 1);
    }
  }
  const legCoords = (idx: number[]) => idx.flatMap((i) => coords[i]);
  const headingAt = (pts: [number, number][], fromEnd: boolean) => {
    const xs = pts.map(([lon, lat]) => [toX(lon), toY(lat)]);
    if (fromEnd) xs.reverse();
    let j = 1;
    while (j < xs.length - 1 && Math.hypot(xs[j][0] - xs[0][0], xs[j][1] - xs[0][1]) < 20) j++;
    if (xs.length < 2) return 0;
    const b = bearing(xs[0][0], xs[0][1], xs[j][0], xs[j][1]);
    return fromEnd ? (b + 180) % 360 : b;
  };
  const steps = groups.map((grp, i) => {
    const pts = legCoords(grp.legs);
    const domCls = (() => {
      const m = new Map<number, number>();
      for (const li of grp.legs) m.set(legInfo[li].cls, (m.get(legInfo[li].cls) ?? 0) + legInfo[li].len);
      return [...m].sort((a, b) => b[1] - a[1])[0][0];
    })();
    let instruction: string;
    let icon: string;
    if (i === 0) {
      instruction = `Start on ${grp.name}`;
      icon = 'start';
    } else {
      const prevPts = legCoords(groups[i - 1].legs);
      const delta = ((headingAt(pts, false) - headingAt(prevPts, true) + 540) % 360) - 180;
      const t = turnText(delta);
      instruction = t.icon === 'straight' && grp.name === groups[i - 1].name ? `Continue on ${grp.name}` : `${t.text} ${grp.name}`;
      icon = t.icon;
    }
    return {
      instruction,
      icon,
      note: grp.note,
      distance: Math.round(grp.distance),
      cls: domCls,
      location: pts[0],
    };
  });
  steps.push({ instruction: 'Arrive at your destination', icon: 'arrive', note: undefined, distance: 0, cls: legInfo.at(-1)!.cls, location: coords.at(-1)!.at(-1)! });

  const facilities = new Set<string>();
  for (const li of legInfo) if (li.fac && li.len > 50) facilities.add(FACILITY_LABELS[li.fac]);

  const all = coords.flat();
  const lons = all.map((c) => c[0]);
  const lats = all.map((c) => c[1]);
  return {
    mode,
    label: MODES[mode].label,
    distance: Math.round(distance),
    duration: Math.round(seconds),
    // 100 = entirely separated cycleway; lower means more exposure to traffic, crashes and risky crossings.
    // average danger multiplier 1.0 → 100, quiet streets (~1.45) → ~80, busy arterial (~5) → ~30.
    safetyScore: Math.round(100 / (1 + 0.6 * (Math.max(distance, weighted) / Math.max(1, distance) - 1))),
    lowStressShare: round1((100 * (byClass[Cls.Separated] + byClass[Cls.Shared] + byClass[Cls.Quiet])) / Math.max(1, distance)),
    byClass: byClass.map((m) => Math.round(m)),
    crashes,
    crossings,
    tfnswFacilities: [...facilities],
    bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
    geometry: { type: 'FeatureCollection', features },
    steps,
    edges: legs.map((l) => l.edge),
  };
}

export type RouteResult = ReturnType<typeof describe>;

export function planRoutes(g: Graph, from: [number, number], to: [number, number]) {
  const s = snap(g, from[0], from[1]);
  const t = snap(g, to[0], to[1]);
  if (!s || !t) return { error: 'Couldn’t find a path or street near one of those points. Is it inside Greater Sydney?' };
  const routes: (RouteResult & { modes: string[] })[] = [];
  for (const mode of Object.keys(MODES) as Mode[]) {
    const legs = search(g, s, t, MODES[mode].alpha);
    if (!legs) continue;
    const r = describe(g, legs, mode);
    // Merge routes that are essentially identical.
    const set = new Set(r.edges);
    const dup = routes.find((o) => {
      let shared = 0;
      let total = 0;
      for (const e of o.edges) { total += g.edgeLen[e]; if (set.has(e)) shared += g.edgeLen[e]; }
      return shared / Math.max(1, Math.min(total, r.distance)) > 0.9;
    });
    if (dup) dup.modes.push(MODES[mode].label);
    else routes.push({ ...r, modes: [MODES[mode].label] });
  }
  if (!routes.length) return { error: 'No bike-legal route found between those points.' };
  return {
    from: { lat: s.lat, lon: s.lon },
    to: { lat: t.lat, lon: t.lon },
    routes: routes.map(({ edges, ...r }) => r),
  };
}
