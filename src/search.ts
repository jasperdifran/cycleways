// Instant local place search over data/graph/places.json.gz (built by scripts/places.ts).
//
// Matching is token-based, case/punctuation/accent-insensitive, with street-type
// abbreviations folded both ways (street ↔ st, road ↔ rd, …). Every query token
// must match a distinct token of the entry's name or suburb, by prefix (exact
// matches score higher). Queries that start with a house number also search the
// address table, interpolating along the street when the exact number is missing.
import fs from 'node:fs';
import zlib from 'node:zlib';

export type SearchResult = { title: string; subtitle: string; lat: number; lon: number; kind: string };

// Long form → canonical short form. Applied to index and query tokens alike.
const ABBR: Record<string, string> = {
  street: 'st', str: 'st', road: 'rd', avenue: 'ave', av: 'ave', parade: 'pde', pd: 'pde', highway: 'hwy', drive: 'dr',
  crescent: 'cres', cr: 'cres', crs: 'cres', place: 'pl', lane: 'ln', close: 'cl', court: 'ct', terrace: 'tce', terr: 'tce',
  boulevard: 'blvd', boulevarde: 'blvd', bvd: 'blvd', circuit: 'cct', esplanade: 'esp', square: 'sq', grove: 'gr', parkway: 'pkwy',
  mount: 'mt', motorway: 'mwy', freeway: 'fwy', point: 'pt', circle: 'cir', glade: 'gld', ridge: 'rdg', and: '&',
};
const LONG_FORMS = Object.entries(ABBR).filter(([long]) => long.length > 2);

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
export function tokens(s: string): string[] {
  const n = normalize(s);
  const ts = n ? n.split(' ').map((t) => ABBR[t] ?? t) : [];
  // "The University of Sydney" ≡ "University of Sydney"
  return ts.length > 1 && ts[0] === 'the' ? ts.slice(1) : ts;
}

const PLACE_WEIGHT: Record<string, number> = {
  city: 300, town: 300, suburb: 300, station: 260, village: 220, locality: 220, quarter: 200, hamlet: 200,
  neighbourhood: 180, tram_stop: 200, ferry_terminal: 200,
};
const MAJOR_POI = new Set([
  'university', 'college', 'hospital', 'stadium', 'beach', 'park', 'aerodrome', 'terminal', 'attraction', 'museum', 'zoo',
  'theatre', 'nature_reserve', 'garden', 'gallery', 'library', 'school', 'marketplace', 'mall', 'golf_course', 'lighthouse',
  'pier', 'peak', 'bay', 'cape', 'island', 'viewpoint', 'arts_centre', 'events_venue', 'sports_centre', 'swimming_pool',
  'cemetery', 'townhall', 'courthouse', 'police', 'fire_station', 'place_of_worship', 'community_centre', 'conference_centre',
]);
const STREET_WEIGHT = 80;
const POI_WEIGHT = 100;
const MAJOR_WEIGHT = 150;
const ADDRESS_WEIGHT = 1000;
const NO_MATCH = -1e9;

// core: number of name tokens a query must cover to count as the full name ("Central Station" → 1).
type Entry = { title: string; subtitle: string; lat: number; lon: number; kind: string; weight: number; nt: string[]; st: string[]; core: number };

// Sorted vocabulary + postings for prefix lookups.
class PrefixIndex {
  vocab: string[] = [];
  post: Int32Array[] = [];
  constructor(postings: Map<string, number[]>) {
    this.vocab = [...postings.keys()].sort();
    this.post = this.vocab.map((t) => Int32Array.from(postings.get(t)!));
  }
  // Ids of everything with a token starting with `p` (plus exact `alts`).
  lookup(p: string, alts: string[], out: Set<number>) {
    let lo = 0;
    let hi = this.vocab.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.vocab[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.vocab.length && this.vocab[i].startsWith(p); i++) for (const id of this.post[i]) out.add(id);
    for (const a of alts) {
      const i = this.exact(a);
      if (i >= 0) for (const id of this.post[i]) out.add(id);
    }
  }
  exact(t: string): number {
    let lo = 0;
    let hi = this.vocab.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.vocab[mid];
      if (v === t) return mid;
      if (v < t) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}

function addPosting(m: Map<string, number[]>, t: string, id: number) {
  const a = m.get(t);
  if (!a) m.set(t, [id]);
  else if (a[a.length - 1] !== id) a.push(id);
}

// Query token → (exact canonical alternatives) e.g. "stre" → ["st"], "roa" → ["rd"].
function alternatives(q: string): string[] {
  if (q.length < 2) return [];
  return LONG_FORMS.filter(([long]) => long.startsWith(q) && long !== q).map(([, short]) => short);
}

type Q = { t: string; alts: string[] };
type Match = { score: number; inName: number; ordered: boolean; exactAll: boolean };

// Greedily assign each query token to a distinct name token (preferred) or suburb token.
function match(q: Q[], nt: string[], st: string[]): Match | null {
  let usedN = 0; // bitmask (names have < 31 tokens in practice)
  let usedS = 0;
  let score = 0;
  let inName = 0;
  let ordered = true;
  let exactAll = true;
  for (let i = 0; i < q.length; i++) {
    const { t, alts } = q[i];
    let hit = -1;
    let exact = false;
    // exact in name, prefix in name, exact in suburb, prefix in suburb
    for (let j = 0; j < nt.length && j < 31; j++) if (!(usedN & (1 << j)) && (nt[j] === t || alts.includes(nt[j]))) { hit = j; exact = true; break; }
    if (hit < 0) for (let j = 0; j < nt.length && j < 31; j++) if (!(usedN & (1 << j)) && nt[j].startsWith(t)) { hit = j; break; }
    if (hit >= 0) {
      usedN |= 1 << hit;
      inName++;
      if (hit !== i) ordered = false;
      score += exact ? 12 : 4;
      if (!exact) exactAll = false;
      continue;
    }
    if (i === 0) return null; // the first word has to be part of the name
    ordered = false;
    for (let j = 0; j < st.length; j++) if (!(usedS & (1 << j)) && (st[j] === t || alts.includes(st[j]))) { hit = j; exact = true; break; }
    if (hit < 0) for (let j = 0; j < st.length; j++) if (!(usedS & (1 << j)) && st[j].startsWith(t)) { hit = j; break; }
    if (hit < 0) return null;
    usedS |= 1 << hit;
    score += exact ? 10 : 3;
    if (!exact) exactAll = false;
  }
  return { score, inName, ordered, exactAll };
}

const km = (lat1: number, lon1: number, lat2: number, lon2: number) => Math.hypot(lat1 - lat2, (lon1 - lon2) * 0.83) * 111.2;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

export class PlaceIndex {
  entries: Entry[] = [];
  index: PrefixIndex;
  // Addresses
  subNames: string[];
  subTokens: string[][];
  streetNames: string[];
  streetTokens: string[][];
  streetIndex: PrefixIndex; // token → street ids
  aStreet: Int32Array;
  aNum: string[];
  aSub: Int32Array;
  aLat: Float64Array;
  aLon: Float64Array;
  byNum = new Map<string, number[]>(); // house number → address ids
  byStreet: number[][]; // street id → address ids

  constructor(file: string) {
    const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    this.subNames = d.subs;
    this.subTokens = d.subs.map(tokens);
    const post = new Map<string, number[]>();
    const e = d.e;
    for (let i = 0; i < e.n.length; i++) {
      const kind: string = d.kinds[e.k[i]];
      const isStreet = kind === 'street';
      const sub = e.s[i] >= 0 ? d.subs[e.s[i]] : '';
      const weight = PLACE_WEIGHT[kind] ?? (isStreet ? STREET_WEIGHT : MAJOR_POI.has(kind) ? MAJOR_WEIGHT : POI_WEIGHT);
      const subtitle = PLACE_WEIGHT[kind] && !sub ? cap(kind) : [e.a[i], sub].filter(Boolean).join(', ');
      const nt = tokens(e.n[i]);
      const id = this.entries.length;
      this.entries.push({ title: e.n[i], subtitle, lat: e.y[i] / 1e5, lon: e.x[i] / 1e5, kind, weight, nt, st: e.s[i] >= 0 ? this.subTokens[e.s[i]] : [], core: nt.length - (kind === 'station' && nt.length > 1 && nt[nt.length - 1] === 'station' ? 1 : 0) });
      for (const t of nt) addPosting(post, t, id);
    }
    this.index = new PrefixIndex(post);

    const a = d.ad;
    this.streetNames = a.st;
    this.streetTokens = a.st.map(tokens);
    const spost = new Map<string, number[]>();
    this.streetTokens.forEach((ts, id) => ts.forEach((t) => addPosting(spost, t, id)));
    this.streetIndex = new PrefixIndex(spost);
    const n = a.i.length;
    this.aStreet = Int32Array.from(a.i);
    this.aNum = a.h.map((h: string) => h.toLowerCase().replace(/\s+/g, ''));
    this.aSub = Int32Array.from(a.s);
    this.aLat = Float64Array.from(a.y, (v: number) => v / 1e5);
    this.aLon = Float64Array.from(a.x, (v: number) => v / 1e5);
    this.byStreet = this.streetNames.map(() => []);
    for (let i = 0; i < n; i++) {
      this.byStreet[this.aStreet[i]].push(i);
      const h = this.aNum[i];
      const range = h.match(/^(\d+)[a-z]?-(\d+)[a-z]?$/);
      const keys = [h];
      if (range) {
        const lo = +range[1];
        const hi = +range[2];
        if (hi > lo && hi - lo <= 40) for (let k = lo; k <= hi; k += 2) keys.push(String(k));
        else keys.push(String(lo));
      }
      for (const k of keys) {
        const arr = this.byNum.get(k);
        if (arr) arr.push(i);
        else this.byNum.set(k, [i]);
      }
    }
  }

  get size() {
    return { entries: this.entries.length, addresses: this.aNum.length };
  }

  search(query: string, lat: number, lon: number, limit = 8): SearchResult[] {
    const scored: { r: SearchResult; score: number }[] = [];
    const qt = tokens(query);
    if (!qt.length) return [];
    const toQ = (ts: string[]): Q[] => ts.map((t, i) => ({ t, alts: i === ts.length - 1 ? alternatives(t) : [] }));

    // House-number queries: "4 mitchell st, five dock", "2/45 smith st", "363 george".
    const m = query.trim().toLowerCase().match(/^(?:(?:unit|apt|shop|suite|u)\s*)?(\d+[a-z]?)\s*(?:([\/-])\s*(\d+[a-z]?))?[\s,]+(.*[a-z].*)$/);
    if (m) {
      const num = m[2] === '/' ? m[3] : m[1];
      const rest = toQ(tokens(m[4]));
      if (rest.length) this.searchAddresses(num, rest, lat, lon, scored);
      this.searchEntries(rest, normalize(m[4]), lat, lon, scored, -200);
    }
    this.searchEntries(toQ(qt), qt.join(' '), lat, lon, scored, 0);

    scored.sort((a, b) => b.score - a.score);
    const out: SearchResult[] = [];
    for (const { r } of scored) {
      // Drop near-duplicates (same name within ~300 m, e.g. a POI mapped twice, or a road split by a suburb edge).
      if (out.some((o) => o.title.toLowerCase() === r.title.toLowerCase() && km(o.lat, o.lon, r.lat, r.lon) < 0.3)) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  private searchEntries(q: Q[], qJoined: string, lat: number, lon: number, out: { r: SearchResult; score: number }[], bias: number) {
    if (!q.length) return;
    const cand = new Set<number>();
    this.index.lookup(q[0].t, q[0].alts, cand);
    // A single letter matches half the index: only suggest places and stations for it.
    const placesOnly = q.length === 1 && q[0].t.length === 1;
    for (const id of cand) {
      const e = this.entries[id];
      if (placesOnly && e.weight < MAJOR_WEIGHT) continue;
      const mt = match(q, e.nt, e.st);
      if (!mt) continue;
      const nameJoined = e.nt.join(' ');
      let s = e.weight + mt.score + bias;
      if (mt.inName === q.length) {
        if (nameJoined === qJoined || (mt.exactAll && mt.ordered && mt.inName >= e.core)) s += 600;
        else if (mt.ordered) s += 400;
        else s += 300;
        s -= 15 * Math.max(0, e.core - mt.inName);
      } else {
        // Matched partly on the suburb ("mitchell st five dock").
        s += mt.inName >= e.core ? 500 : 250;
        s -= 15 * Math.max(0, e.core - mt.inName);
      }
      s -= Math.min(200, km(lat, lon, e.lat, e.lon) * 4);
      out.push({ r: { title: e.title, subtitle: e.subtitle, lat: e.lat, lon: e.lon, kind: e.kind }, score: s });
    }
  }

  private searchAddresses(num: string, q: Q[], lat: number, lon: number, out: { r: SearchResult; score: number }[]) {
    const streets = new Set<number>();
    this.streetIndex.lookup(q[0].t, q[0].alts, streets);
    if (!streets.size) return;
    // Which (street, suburb) pairs match the query text, and how well.
    const pairScore = new Map<number, number>(); // street * 100000 + sub → match score (NO_MATCH if none)
    const pairOf = (i: number) => this.aStreet[i] * 100000 + (this.aSub[i] + 1);
    const scorePair = (st: number, sub: number): number => {
      const key = st * 100000 + (sub + 1);
      let s = pairScore.get(key);
      if (s === undefined) {
        const mt = match(q, this.streetTokens[st], sub >= 0 ? this.subTokens[sub] : []);
        const nt = this.streetTokens[st];
        s = !mt ? NO_MATCH : mt.score + (mt.inName === nt.length ? 100 : 0) - 15 * (nt.length - mt.inName) + (mt.inName < q.length ? 50 : 0) + (mt.ordered ? 20 : 0);
        pairScore.set(key, s);
      }
      return s;
    };
    const add = (i: number, title: string, approx: boolean, base: number) => {
      const sub = this.aSub[i] >= 0 ? this.subNames[this.aSub[i]] : '';
      out.push({
        r: { title, subtitle: approx ? [sub, 'approximate'].filter(Boolean).join(' · ') : sub, lat: this.aLat[i], lon: this.aLon[i], kind: 'address' },
        score: base - Math.min(200, km(lat, lon, this.aLat[i], this.aLon[i]) * 4),
      });
    };
    let found = 0;
    for (const i of this.byNum.get(num) ?? []) {
      if (!streets.has(this.aStreet[i])) continue;
      const s = scorePair(this.aStreet[i], this.aSub[i]);
      if (s === NO_MATCH) continue;
      const h = this.aNum[i];
      add(i, `${h === num ? h : num} ${this.streetNames[this.aStreet[i]]}`, false, ADDRESS_WEIGHT + s + (h === num ? 20 : 0));
      found++;
    }
    if (found || !/^\d+$/.test(num)) return;

    // Not mapped: interpolate between the nearest numbers on the same side of the street.
    const n = +num;
    const groups = new Map<number, number[]>();
    for (const st of streets)
      for (const i of this.byStreet[st]) {
        if (scorePair(st, this.aSub[i]) === NO_MATCH) continue;
        const k = pairOf(i);
        (groups.get(k) ?? groups.set(k, []).get(k)!).push(i);
      }
    for (const [key, ids] of groups) {
      let lo = -1, hi = -1, loN = -Infinity, hiN = Infinity;
      for (const i of ids) {
        const v = parseInt(this.aNum[i], 10);
        if (!Number.isFinite(v) || v % 2 !== n % 2) continue;
        if (v <= n && v > loN) { loN = v; lo = i; }
        if (v >= n && v < hiN) { hiN = v; hi = i; }
      }
      const s = pairScore.get(key)!;
      const title = `${num} ${this.streetNames[Math.floor(key / 100000)]}`;
      const base = ADDRESS_WEIGHT - 100 + s;
      if (lo >= 0 && hi >= 0 && hiN - loN <= 60 && km(this.aLat[lo], this.aLon[lo], this.aLat[hi], this.aLon[hi]) < 1) {
        const f = hiN === loN ? 0 : (n - loN) / (hiN - loN);
        const before = out.length;
        add(lo, title, true, base);
        out[before].r.lat = this.aLat[lo] + (this.aLat[hi] - this.aLat[lo]) * f;
        out[before].r.lon = this.aLon[lo] + (this.aLon[hi] - this.aLon[lo]) * f;
      } else if (lo >= 0 && n - loN <= 10) add(lo, title, true, base - 20);
      else if (hi >= 0 && hiN - n <= 10) add(hi, title, true, base - 20);
    }
  }
}
