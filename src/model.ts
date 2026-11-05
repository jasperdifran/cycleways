// Bike safety model.
//
// Every edge gets:
//   mult  – danger multiplier on length (1.0 = separated cycleway, ~5 = busy arterial).
//   time  – travel-time factor relative to riding at CRUISE_KMH (walking a bike ≈ 4).
//   cls   – display class (see CLASSES).
//   level – road hierarchy (0 = not a motor road … 6 = motorway); used to detect
//           where a route crosses a busier road.
//
// Facility information comes from two sources:
//   - OpenStreetMap tags (highway=cycleway, cycleway=lane, maxspeed, …)
//   - Transport for NSW "Infrastructure Cycleway Data", which classifies the bike
//     network (Separated Path, Shared Use Path, Quietway, Bicycle Lane, …). TfNSW is
//     particularly useful for footpaths that are legally shared paths but lack
//     bicycle=yes tags in OSM – in NSW adults may not ride on ordinary footpaths.

export const CRUISE_KMH = 18;

export const Cls = { Separated: 0, Shared: 1, Quiet: 2, Lane: 3, Moderate: 4, Busy: 5, Walk: 6 } as const;
export type Cls = (typeof Cls)[keyof typeof Cls];

export const CLASSES = [
  { key: 'separated', label: 'Separated bike path', color: '#0b8a43' },
  { key: 'shared', label: 'Shared path', color: '#3cc46a' },
  { key: 'quiet', label: 'Quiet street', color: '#2eb8c9' },
  { key: 'lane', label: 'Painted bike lane', color: '#f2b705' },
  { key: 'moderate', label: 'Moderate traffic', color: '#f07c22' },
  { key: 'busy', label: 'Busy road', color: '#e0342a' },
  { key: 'walk', label: 'Walk your bike', color: '#8e8e93' },
];

// TfNSW facility codes (field `facility` in Existing_Bicycle_Network.shp).
export const Fac = {
  None: 0, BicyclePath: 1, SeparatedPath: 2, SharedPath: 3, Quietway: 4, SharedZone: 5, BicycleLane: 6,
  ContraFlow: 7, BusLane: 8, ParkingLane: 9, Shoulder: 10, MixedTraffic: 11, MotorOnly: 12,
} as const;
export type Fac = (typeof Fac)[keyof typeof Fac];

export const FACILITY_CODES: Record<string, Fac> = {
  'Bicycle Path': Fac.BicyclePath,
  'Separated Path': Fac.SeparatedPath,
  'Shared Use Path': Fac.SharedPath,
  Quietway: Fac.Quietway,
  'Shared Zone': Fac.SharedZone,
  'Bicycle Lane': Fac.BicycleLane,
  'Contra-flow Permitted': Fac.ContraFlow,
  'Bus Lane': Fac.BusLane,
  'Bus Only Lane': Fac.BusLane,
  'Parking Lane': Fac.ParkingLane,
  'Emergency Stopping Lane': Fac.Shoulder,
  'High-speed Shoulder': Fac.Shoulder,
  'Mixed Traffic': Fac.MixedTraffic,
  'Vehicle (motor) Only': Fac.MotorOnly,
};

export const FACILITY_LABELS = [
  '',
  'Bicycle path',
  'Separated path',
  'Shared path',
  'Quietway',
  'Shared zone',
  'Bicycle lane',
  'Contra-flow bike access',
  'Bus lane',
  'Parking lane',
  'Road shoulder',
  'Mixed traffic',
  'No bicycles',
];

// When an edge matches several TfNSW facilities, prefer the safest one.
export const FACILITY_RANK: Fac[] = [
  Fac.BicyclePath,
  Fac.SeparatedPath,
  Fac.SharedPath,
  Fac.Quietway,
  Fac.SharedZone,
  Fac.BicycleLane,
  Fac.BusLane,
  Fac.ParkingLane,
  Fac.Shoulder,
  Fac.ContraFlow,
  Fac.MixedTraffic,
  Fac.MotorOnly,
];

// Highways we load from OSM (whether bikes may use them is decided in evaluate()).
export const CANDIDATE_HIGHWAYS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
  'residential', 'road', 'living_street', 'service', 'track', 'cycleway', 'path',
  'footway', 'pedestrian', 'bridleway', 'steps', 'busway',
]);

export const WAY_TAGS = [
  'highway', 'name', 'ref', 'access', 'bicycle', 'foot', 'motor_vehicle', 'oneway',
  'oneway:bicycle', 'junction', 'maxspeed', 'lanes', 'surface', 'service', 'footway',
  'segregated', 'cycleway', 'cycleway:both', 'cycleway:left', 'cycleway:right',
  'ramp:bicycle', 'area', 'bridge', 'tunnel', 'layer',
];

const LEVEL: Record<string, number> = {
  motorway: 6, motorway_link: 6, trunk: 5, trunk_link: 5, primary: 4, primary_link: 4,
  secondary: 3, secondary_link: 3, tertiary: 2, tertiary_link: 2, unclassified: 1,
  residential: 1, road: 1, living_street: 1, service: 1, busway: 1,
};

const DEFAULT_SPEED: Record<number, number> = { 1: 50, 2: 60, 3: 60, 4: 70, 5: 80, 6: 100 };

const YES = new Set(['yes', 'designated', 'permissive', 'official']);
const UNPAVED = new Set(['unpaved', 'gravel', 'dirt', 'ground', 'grass', 'sand', 'earth', 'mud', 'woodchips', 'pebblestone', 'rock']);
const SEMI_PAVED = new Set(['compacted', 'fine_gravel', 'paving_stones', 'sett', 'cobblestone', 'unhewn_cobblestone']);

export interface EdgeProps {
  fwd: boolean;
  back: boolean;
  mult: number;
  time: number;
  cls: Cls;
  level: number;
}

function parseSpeed(v: string | undefined, level: number): number {
  if (v) {
    const n = parseFloat(v);
    if (!Number.isNaN(n)) return v.includes('mph') ? n * 1.609 : n;
    if (v === 'walk') return 10;
  }
  return DEFAULT_SPEED[level] ?? 50;
}

// Danger multiplier for riding in mixed traffic.
function mixedTraffic(level: number, speed: number, lanes: number): number {
  let m: number;
  switch (level) {
    case 1: m = speed <= 30 ? 1.25 : speed <= 40 ? 1.45 : speed <= 50 ? 1.75 : 2.4; break;
    case 2: m = speed <= 40 ? 1.9 : speed <= 50 ? 2.4 : 3.0; break;
    case 3: m = speed <= 50 ? 3.0 : 3.8; break;
    case 4: m = speed <= 50 ? 3.8 : 5.0; break;
    case 5: m = 6.5; break;
    default: m = 10;
  }
  if (speed >= 70) m *= 1.3;
  if (speed >= 90) m *= 1.3;
  if (lanes >= 4) m *= 1.15;
  return m;
}

function cycleTags(t: Record<string, string>): string[] {
  return [t.cycleway, t['cycleway:both'], t['cycleway:left'], t['cycleway:right']].filter(Boolean) as string[];
}

// Returns null when bikes can't (legally or physically) use the way at all.
export function evaluate(t: Record<string, string>, fac: Fac): EdgeProps | null {
  const hw = t.highway;
  if (!hw || !CANDIDATE_HIGHWAYS.has(hw) || t.area === 'yes') return null;

  const bike = t.bicycle;
  const bikeYes = bike !== undefined && YES.has(bike);
  if (bike === 'no' && !(fac >= Fac.BicyclePath && fac <= Fac.SharedZone)) return null;
  if ((t.access === 'no' || t.access === 'private') && !bikeYes) return null;
  if (fac === Fac.MotorOnly && !bikeYes) return null;
  if (hw === 'busway' && !bikeYes) return null;
  if ((hw === 'motorway' || hw === 'motorway_link') && !bikeYes && fac !== Fac.Shoulder) return null;

  let level = LEVEL[hw] ?? 0;
  let mult: number;
  let time = 1;
  let cls: Cls;

  const tfnswPath = fac === Fac.BicyclePath || fac === Fac.SeparatedPath || fac === Fac.SharedPath;

  if (hw === 'cycleway') {
    const shared = t.segregated === 'no' || t.foot === 'designated';
    mult = shared ? 1.08 : 1.0;
    cls = shared ? Cls.Shared : Cls.Separated;
  } else if (hw === 'path' || hw === 'bridleway') {
    if (bike === 'designated' && t.segregated === 'yes') { mult = 1.0; cls = Cls.Separated; }
    else if (fac === Fac.BicyclePath || fac === Fac.SeparatedPath) { mult = 1.0; cls = Cls.Separated; }
    else { mult = 1.12; cls = Cls.Shared; }
  } else if (hw === 'footway' || hw === 'pedestrian') {
    if (bikeYes || tfnswPath || fac === Fac.SharedZone || fac === Fac.Quietway) {
      mult = hw === 'pedestrian' ? 1.25 : 1.15;
      cls = fac === Fac.BicyclePath || fac === Fac.SeparatedPath ? Cls.Separated : Cls.Shared;
      if (cls === Cls.Separated) mult = 1.0;
      time = 1.1;
    } else {
      // Adults can't legally ride on NSW footpaths: walk the bike.
      mult = 1.1;
      time = t.footway === 'crossing' ? 2 : 4;
      cls = Cls.Walk;
    }
  } else if (hw === 'steps') {
    mult = 1.2;
    time = t['ramp:bicycle'] === 'yes' ? 4 : 10;
    cls = Cls.Walk;
  } else if (hw === 'track') {
    mult = 1.3;
    time = 1.25;
    cls = Cls.Quiet;
    level = 0;
  } else {
    // Motor road.
    const speed = parseSpeed(t.maxspeed, level);
    const lanes = parseInt(t.lanes ?? '', 10) || (level >= 4 ? 4 : 2);
    if (hw === 'living_street') mult = 1.2;
    else if (hw === 'service') mult = t.service === 'parking_aisle' || t.service === 'drive-through' ? 1.6 : 1.45;
    else mult = mixedTraffic(level, speed, lanes);
    const base = mult;

    // Best on-road facility from OSM tags.
    for (const c of cycleTags(t)) {
      if (c === 'track' || c === 'opposite_track') mult = Math.min(mult, 1.05);
      else if (c === 'lane' || c === 'opposite_lane') mult = Math.min(mult, Math.max(1.3, 1 + (base - 1) * 0.5));
      else if (c === 'share_busway' || c === 'opposite_share_busway') mult = Math.min(mult, base * 0.7);
      else if (c === 'shoulder') mult = Math.min(mult, base * 0.75);
      else if (c === 'shared_lane') mult = Math.min(mult, base * 0.92);
    }
    // TfNSW facility (when the edge is the road itself, or a path drawn beside it).
    switch (fac) {
      case Fac.BicyclePath:
      case Fac.SeparatedPath: mult = Math.min(mult, 1.05); break;
      case Fac.SharedPath: mult = Math.min(mult, 1.15); break;
      case Fac.Quietway:
      case Fac.SharedZone: mult = Math.min(mult, 1.3); break;
      case Fac.BicycleLane: mult = Math.min(mult, Math.max(1.3, 1 + (base - 1) * 0.5)); break;
      case Fac.BusLane: mult = Math.min(mult, base * 0.7); break;
      case Fac.ParkingLane: mult = Math.min(mult, base * 0.85); break;
      case Fac.Shoulder: mult = Math.min(mult, base * 0.75); break;
    }
    if (bike === 'use_sidepath') mult *= 1.5;

    const laneTagged = cycleTags(t).some((c) => c.includes('lane')) || fac === Fac.BicycleLane;
    if (mult <= 1.05) cls = Cls.Separated;
    else if (mult <= 1.2 && tfnswPath) cls = Cls.Shared;
    else if (mult <= 1.8) cls = Cls.Quiet;
    else if (laneTagged && mult < base) cls = Cls.Lane;
    else if (mult <= 3.2) cls = Cls.Moderate;
    else cls = Cls.Busy;
  }

  const surface = t.surface;
  if (surface && UNPAVED.has(surface)) { mult *= 1.2; time = Math.max(time, 1.35); }
  else if (surface && SEMI_PAVED.has(surface)) { mult *= 1.05; time = Math.max(time, 1.1); }

  // Direction.
  let fwd = true;
  let back = true;
  const ow = t.oneway;
  const impliedOneway = t.junction === 'roundabout' || t.junction === 'circular' || hw === 'motorway';
  if (ow === 'yes' || ow === '1' || ow === 'true' || (impliedOneway && ow !== 'no')) back = false;
  else if (ow === '-1' || ow === 'reverse') { fwd = false; }
  const contraflow =
    t['oneway:bicycle'] === 'no' ||
    cycleTags(t).some((c) => c.startsWith('opposite')) ||
    fac === Fac.ContraFlow;
  if (contraflow) { fwd = true; back = true; }
  // Walking a bike: one-way rules don't apply on footpaths.
  if (cls === Cls.Walk) { fwd = true; back = true; }

  return { fwd, back, mult, time, cls, level };
}

// Extra cost (metres-equivalent) for crossing a road of this level without help.
export const CROSSING_PENALTY = [0, 0, 35, 80, 150, 240, 320];
export const SIGNAL_FACTOR = 0.2;
export const MARKED_FACTOR = 0.55;

// Crash weights by severity (NSW "Degree of crash - detailed").
export function crashWeight(degree: string): number {
  const d = degree.toLowerCase();
  if (d.startsWith('fatal')) return 6;
  if (d.startsWith('serious')) return 3;
  if (d.startsWith('moderate')) return 2;
  if (d.startsWith('minor')) return 1;
  return 0.5;
}
// Metres-equivalent per unit of crash weight, capped per edge/node.
export const CRASH_METRES = 90;
export const CRASH_CAP = 1500;

// Mode weights: how much safety counts relative to distance/time.
export const MODES = {
  safest: { alpha: 1, label: 'Safest' },
  balanced: { alpha: 0.4, label: 'Balanced' },
  direct: { alpha: 0.08, label: 'Most direct' },
} as const;
export type Mode = keyof typeof MODES;
