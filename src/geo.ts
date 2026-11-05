// Small geometry helpers. Within Sydney a flat local projection (metres) is accurate
// to well under 1%, which is plenty for snapping and matching.

const LAT0 = -33.87;
const LON0 = 151.0;
const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110574;

export const toX = (lon: number) => (lon - LON0) * KX;
export const toY = (lat: number) => (lat - LAT0) * KY;
export const toLon = (x: number) => x / KX + LON0;
export const toLat = (y: number) => y / KY + LAT0;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

// Bearing in degrees (0 = north, clockwise) in the local planar frame.
export function bearing(x1: number, y1: number, x2: number, y2: number): number {
  return ((Math.atan2(x2 - x1, y2 - y1) * 180) / Math.PI + 360) % 360;
}

// Squared distance from point P to segment AB, and the projection parameter t ∈ [0,1].
export function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return [qx * qx + qy * qy, t];
}

// Static uniform grid over planar coordinates. Build with add(), then finalize().
export class Grid {
  cell: number;
  private pending: { keys: number[]; ids: number[] } | null = { keys: [], ids: [] };
  private index = new Map<number, number>();
  private start!: Uint32Array;
  private items!: Uint32Array;

  constructor(cell: number) {
    this.cell = cell;
  }

  private key(ix: number, iy: number) {
    return (ix + 100000) * 200000 + (iy + 100000);
  }

  add(id: number, minx: number, miny: number, maxx: number, maxy: number) {
    const c = this.cell;
    const p = this.pending!;
    for (let ix = Math.floor(minx / c); ix <= Math.floor(maxx / c); ix++)
      for (let iy = Math.floor(miny / c); iy <= Math.floor(maxy / c); iy++) {
        p.keys.push(this.key(ix, iy));
        p.ids.push(id);
      }
  }

  finalize() {
    const { keys, ids } = this.pending!;
    const counts: number[] = [];
    for (const k of keys) {
      let ci = this.index.get(k);
      if (ci === undefined) {
        ci = counts.length;
        this.index.set(k, ci);
        counts.push(0);
      }
      counts[ci]++;
    }
    this.start = new Uint32Array(counts.length + 1);
    for (let i = 0; i < counts.length; i++) this.start[i + 1] = this.start[i] + counts[i];
    const fill = this.start.slice(0, counts.length);
    this.items = new Uint32Array(keys.length);
    for (let i = 0; i < keys.length; i++) this.items[fill[this.index.get(keys[i])!]++] = ids[i];
    this.pending = null;
  }

  // Calls fn(id) for every item in cells overlapping the square of radius r around (x, y).
  // An item may be reported more than once if it spans several cells.
  query(x: number, y: number, r: number, fn: (id: number) => void) {
    const c = this.cell;
    for (let ix = Math.floor((x - r) / c); ix <= Math.floor((x + r) / c); ix++)
      for (let iy = Math.floor((y - r) / c); iy <= Math.floor((y + r) / c); iy++) {
        const ci = this.index.get(this.key(ix, iy));
        if (ci === undefined) continue;
        for (let j = this.start[ci]; j < this.start[ci + 1]; j++) fn(this.items[j]);
      }
  }
}
