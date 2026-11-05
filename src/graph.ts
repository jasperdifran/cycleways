import fs from 'node:fs';
import path from 'node:path';
import { GRAPH_DIR } from './config.ts';
import { Grid, toX, toY } from './geo.ts';

const CTORS: Record<string, any> = { Int32Array, Uint32Array, Uint16Array, Uint8Array, Float32Array, Float64Array };

export interface Graph {
  N: number;
  E: number;
  names: string[];
  meta: any;
  nodeLat: Int32Array;
  nodeLon: Int32Array;
  nodeX: Float64Array;
  nodeY: Float64Array;
  nodeFlags: Uint8Array;
  nodeMajor: Uint8Array;
  nodeMajorName: Uint32Array;
  nodeMajorArms: Uint8Array;
  nodeArmA: Float32Array;
  nodeArmB: Float32Array;
  nodeCrash: Float32Array;
  nodeCrashN: Uint16Array;
  edgeFrom: Uint32Array;
  edgeTo: Uint32Array;
  edgeLen: Float32Array;
  edgeMult: Float32Array;
  edgeTime: Float32Array;
  edgeCls: Uint8Array;
  edgeLevel: Uint8Array;
  edgeDir: Uint8Array;
  edgeFac: Uint8Array;
  edgeName: Uint32Array;
  edgeCrash: Float32Array;
  edgeCrashN: Uint16Array;
  edgeGeomStart: Uint32Array;
  geomLat: Int32Array;
  geomLon: Int32Array;
  geomX: Float64Array;
  geomY: Float64Array;
  geomEdge: Uint32Array;
  // Adjacency (CSR): for node n, entries adj[adjStart[n]..adjStart[n+1]) are edge*2+dir,
  // dir 0 = travelling from edgeFrom to edgeTo, 1 = reverse.
  adjStart: Uint32Array;
  adj: Uint32Array;
  segGrid: Grid;
}

export function loadGraph(): Graph {
  const metaPath = path.join(GRAPH_DIR, 'meta.json');
  if (!fs.existsSync(metaPath)) throw new Error('No graph found – run `npm run setup` (download + build) first.');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const g: any = { meta, names: meta.names, N: meta.nodes, E: meta.edges };
  for (const [name, { type, length }] of Object.entries<any>(meta.arrays)) {
    const buf = fs.readFileSync(path.join(GRAPH_DIR, name + '.bin'));
    const arr = new CTORS[type](length);
    new Uint8Array(arr.buffer).set(buf);
    g[name] = arr;
  }
  const G = g as Graph;

  G.nodeX = new Float64Array(G.N);
  G.nodeY = new Float64Array(G.N);
  for (let n = 0; n < G.N; n++) {
    G.nodeX[n] = toX(G.nodeLon[n] / 1e7);
    G.nodeY[n] = toY(G.nodeLat[n] / 1e7);
  }
  const P = G.geomLat.length;
  G.geomX = new Float64Array(P);
  G.geomY = new Float64Array(P);
  G.geomEdge = new Uint32Array(P);
  for (let e = 0; e < G.E; e++)
    for (let p = G.edgeGeomStart[e]; p < G.edgeGeomStart[e + 1]; p++) {
      G.geomX[p] = toX(G.geomLon[p] / 1e7);
      G.geomY[p] = toY(G.geomLat[p] / 1e7);
      G.geomEdge[p] = e;
    }

  const deg = new Uint32Array(G.N + 1);
  for (let e = 0; e < G.E; e++) {
    if (G.edgeDir[e] & 1) deg[G.edgeFrom[e]]++;
    if (G.edgeDir[e] & 2) deg[G.edgeTo[e]]++;
  }
  G.adjStart = new Uint32Array(G.N + 1);
  for (let n = 0; n < G.N; n++) G.adjStart[n + 1] = G.adjStart[n] + deg[n];
  G.adj = new Uint32Array(G.adjStart[G.N]);
  const fill = G.adjStart.slice(0, G.N);
  for (let e = 0; e < G.E; e++) {
    if (G.edgeDir[e] & 1) G.adj[fill[G.edgeFrom[e]]++] = e * 2;
    if (G.edgeDir[e] & 2) G.adj[fill[G.edgeTo[e]]++] = e * 2 + 1;
  }

  G.segGrid = new Grid(40);
  for (let e = 0; e < G.E; e++)
    for (let p = G.edgeGeomStart[e]; p < G.edgeGeomStart[e + 1] - 1; p++)
      G.segGrid.add(
        p,
        Math.min(G.geomX[p], G.geomX[p + 1]),
        Math.min(G.geomY[p], G.geomY[p + 1]),
        Math.max(G.geomX[p], G.geomX[p + 1]),
        Math.max(G.geomY[p], G.geomY[p + 1]),
      );
  G.segGrid.finalize();
  return G;
}
