// Downloads the raw datasets used to build the routing graph:
//  - OpenStreetMap (Geofabrik Australia extract, clipped to Greater Sydney with osmium)
//  - Transport for NSW "Infrastructure Cycleway Data" (bike network shapefile)
//  - Transport for NSW "NSW Crash Data" (crash + traffic unit tables)
//
// Usage: node scripts/download.ts [--force]
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { BBOX, RAW, RAW_DIR } from '../src/config.ts';

const FORCE = process.argv.includes('--force');
const CKAN = 'https://opendata.transport.nsw.gov.au/data/api/3/action/package_show?id=';
const GEOFABRIK = 'https://download.geofabrik.de/australia-oceania/australia-latest.osm.pbf';

type Resource = { name: string; url: string; format: string };

async function resources(dataset: string): Promise<Resource[]> {
  const res = await fetch(CKAN + dataset);
  if (!res.ok) throw new Error(`CKAN ${dataset}: HTTP ${res.status}`);
  return (await res.json()).result.resources;
}

async function download(url: string, dest: string) {
  if (!FORCE && fs.existsSync(dest)) {
    console.log(`✓ ${dest} (exists)`);
    return;
  }
  console.log(`↓ ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const tmp = dest + '.part';
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  console.log(`✓ ${dest}`);
}

// Pick the most recent "YYYY-YYYY - <kind>" crash resource.
function latestCrash(list: Resource[], kind: 'CRASH' | 'TRAFFIC UNIT'): Resource {
  const matches = list
    .filter((r) => r.name.toUpperCase().includes(kind) && /\d{4}\s*-\s*\d{4}/.test(r.name))
    .filter((r) => kind === 'TRAFFIC UNIT' || !r.name.toUpperCase().includes('TRAFFIC UNIT'))
    .sort((a, b) => endYear(b.name) - endYear(a.name));
  if (!matches.length) throw new Error(`No crash resource for ${kind}`);
  return matches[0];
}
const endYear = (s: string) => Number(s.match(/\d{4}\s*-\s*(\d{4})/)![1]);

fs.mkdirSync(RAW_DIR, { recursive: true });

const bike = (await resources('infrastructure-cycleway-data')).find((r) => r.format.toUpperCase() === 'ZIP');
if (!bike) throw new Error('Bike network shapefile not found on TfNSW portal');
await download(bike.url, RAW.bikeNetworkZip);
fs.rmSync(RAW.bikeNetworkDir, { recursive: true, force: true });
fs.mkdirSync(RAW.bikeNetworkDir);
execFileSync('unzip', ['-oq', RAW.bikeNetworkZip, '-d', RAW.bikeNetworkDir]);

const crash = await resources('nsw-crash-data');
const c = latestCrash(crash, 'CRASH');
const tu = latestCrash(crash, 'TRAFFIC UNIT');
console.log(`Crash data: ${c.name}`);
await download(c.url, RAW.crash);
await download(tu.url, RAW.trafficUnit);

if (FORCE || !fs.existsSync(RAW.osmSydney)) {
  await download(GEOFABRIK, RAW.osmAustralia);
  console.log('✂ Clipping OSM to Greater Sydney with osmium…');
  try {
    execFileSync(
      'osmium',
      ['extract', '-b', BBOX.join(','), '--strategy', 'smart', '-O', '-o', RAW.osmSydney, RAW.osmAustralia],
      { stdio: 'inherit' },
    );
  } catch (e) {
    throw new Error('osmium failed. Install it with `brew install osmium-tool` (or apt install osmium-tool).');
  }
}
console.log(`✓ ${RAW.osmSydney}`);
console.log('Done. Next: npm run build');
