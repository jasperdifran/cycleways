// Packs data/ into fixed-size shards under shards/ (plain git files), and
// unpacks them back. Each file is split into ≤ SHARD_MB pieces; shards/manifest.json
// records sizes and SHA-256 hashes so unpacking can verify the result.
//
// Usage:
//   node scripts/shards.ts pack     # data/ → shards/
//   node scripts/shards.ts unpack   # shards/ → data/  (also unzips the TfNSW shapefile)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ROOT, RAW } from '../src/config.ts';

const SHARD_MB = 25; // well under GitHub's 50 MB warning / 100 MB limit per file
const SHARD_BYTES = SHARD_MB * 1024 * 1024;
const DATA_DIR = path.join(ROOT, 'data');
const SHARD_DIR = path.join(ROOT, 'shards');
const MANIFEST = path.join(SHARD_DIR, 'manifest.json');

// What gets checked in. The Australia-wide extract (~1 GB) is only needed to
// re-clip Sydney, and the unzipped shapefile is recreated from its zip.
const INCLUDE = ['raw/sydney.osm.pbf', 'raw/tfnsw_bicycle_network.zip', 'raw/nsw_crash_crash.xlsx', 'raw/nsw_crash_traffic_unit.xlsx', 'graph'];

type Entry = { path: string; size: number; sha256: string; parts: string[] };

function listFiles(rel: string): string[] {
  const abs = path.join(DATA_DIR, rel);
  if (!fs.existsSync(abs)) throw new Error(`Missing data/${rel} – run \`npm run setup\` first.`);
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs).sort().flatMap((f) => listFiles(path.join(rel, f)));
}

const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

function pack() {
  fs.rmSync(SHARD_DIR, { recursive: true, force: true });
  const files: Entry[] = [];
  let total = 0;
  for (const rel of INCLUDE.flatMap(listFiles)) {
    const buf = fs.readFileSync(path.join(DATA_DIR, rel));
    const parts: string[] = [];
    for (let off = 0, i = 0; off < buf.length || i === 0; off += SHARD_BYTES, i++) {
      const name = `${rel}.part${String(i).padStart(3, '0')}`;
      const dest = path.join(SHARD_DIR, name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf.subarray(off, off + SHARD_BYTES));
      parts.push(name);
    }
    files.push({ path: rel, size: buf.length, sha256: sha256(buf), parts });
    total += buf.length;
  }
  fs.writeFileSync(MANIFEST, JSON.stringify({ shardMB: SHARD_MB, createdAt: new Date().toISOString(), files }, null, 2) + '\n');
  const shardCount = files.reduce((n, f) => n + f.parts.length, 0);
  console.log(`Packed ${files.length} files (${(total / 1e6).toFixed(0)} MB) into ${shardCount} shards in shards/`);
}

function unpack() {
  if (!fs.existsSync(MANIFEST)) throw new Error('shards/manifest.json not found.');
  const { files } = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as { files: Entry[] };
  for (const f of files) {
    const bufs = f.parts.map((p) => fs.readFileSync(path.join(SHARD_DIR, p)));
    const buf = Buffer.concat(bufs);
    if (bufs[0].subarray(0, 40).toString('utf8').startsWith('version https://git-lfs')) {
      throw new Error(`${f.path} is a Git LFS pointer (from an old checkout) – re-clone or run \`git pull\`.`);
    }
    if (buf.length !== f.size || sha256(buf) !== f.sha256) throw new Error(`Checksum mismatch for ${f.path}`);
    const dest = path.join(DATA_DIR, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  if (fs.existsSync(RAW.bikeNetworkZip)) {
    fs.rmSync(RAW.bikeNetworkDir, { recursive: true, force: true });
    fs.mkdirSync(RAW.bikeNetworkDir, { recursive: true });
    execFileSync('unzip', ['-oq', RAW.bikeNetworkZip, '-d', RAW.bikeNetworkDir]);
  }
  console.log(`Unpacked ${files.length} files into data/ (checksums verified)`);
}

const cmd = process.argv[2];
if (cmd === 'pack') pack();
else if (cmd === 'unpack') unpack();
else {
  console.error('Usage: node scripts/shards.ts pack|unpack');
  process.exit(1);
}
