import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RAW_DIR = path.join(ROOT, 'data', 'raw');
export const GRAPH_DIR = path.join(ROOT, 'data', 'graph');
export const PUBLIC_DIR = path.join(ROOT, 'public');

// Greater Sydney: Penrith to Palm Beach, Windsor to Helensburgh.
// [minLon, minLat, maxLon, maxLat]
export const BBOX = [150.5, -34.25, 151.4, -33.5] as const;

export const RAW = {
  osmAustralia: path.join(RAW_DIR, 'australia-latest.osm.pbf'),
  osmSydney: path.join(RAW_DIR, 'sydney.osm.pbf'),
  bikeNetworkZip: path.join(RAW_DIR, 'tfnsw_bicycle_network.zip'),
  bikeNetworkDir: path.join(RAW_DIR, 'tfnsw_bicycle_network'),
  crash: path.join(RAW_DIR, 'nsw_crash_crash.xlsx'),
  trafficUnit: path.join(RAW_DIR, 'nsw_crash_traffic_unit.xlsx'),
};

export function inBbox(lon: number, lat: number): boolean {
  return lon >= BBOX[0] && lon <= BBOX[2] && lat >= BBOX[1] && lat <= BBOX[3];
}
