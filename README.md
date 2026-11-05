# Cycleways — safest bike routes for Sydney

A map app in the style of Apple Maps, built for cycling. Choose a start and destination, either by search or by clicking the map. It finds the **safest** route it can, preferring separated cycleways, shared paths and quiet streets. It also shows a *Balanced* and a *Most direct* alternative so you can see the trade-off.

Coverage is Greater Sydney: Penrith to Palm Beach, Windsor to Helensburgh.

## Quick start

Requires Node ≥ 23.6 (TypeScript runs natively). Rebuilding data from scratch also needs [osmium](https://osmcode.org/osmium-tool/) (`brew install osmium-tool`).

The data, including a pre-built routing graph, is checked in under `shards/` with [Git LFS](https://git-lfs.com), split into ≤ 50 MB pieces:

```bash
git lfs install && git lfs pull
npm install
npm run data:unpack   # reassemble shards/ → data/ (checksums verified)
npm start             # http://localhost:5173
```

To refresh from the latest government and OSM data instead (needs osmium):

```bash
npm run setup         # download (~1 GB OSM extract) + build the routing graph (~15 s)
npm run data:pack     # re-shard data/ → shards/, then commit
```

## Data sources

| Data | Source | Used for |
| --- | --- | --- |
| Streets and paths | [OpenStreetMap](https://www.openstreetmap.org) via the [Geofabrik](https://download.geofabrik.de/australia-oceania.html) Australia extract, clipped to Sydney | The routing graph: road type, speed limit, lanes, painted lanes, one-way streets, surface, traffic signals |
| Bike network | Transport for NSW [Infrastructure Cycleway Data](https://opendata.transport.nsw.gov.au/dataset/infrastructure-cycleway-data) (shapefile, updated monthly) | Each OSM segment is matched to the official facility type: Separated Path, Shared Use Path, Quietway, Bicycle Lane, Parking Lane, motorway shoulder, "Vehicle (motor) Only", etc. |
| Crashes | Transport for NSW [NSW Crash Data](https://opendata.transport.nsw.gov.au/dataset/nsw-crash-data) (latest 5 years) | Every crash involving a pedal cycle is attached to the nearest intersection or segment and weighted by severity |
| Base map | [OpenFreeMap](https://openfreemap.org) vector tiles | Display only |
| Search | [Photon](https://photon.komoot.io) (OSM geocoder) | Place search and reverse geocoding |

The TfNSW data fills a gap in OSM. In NSW, adults may not ride on ordinary footpaths, so footpaths that are officially *shared paths* matter a lot. Those paths often lack `bicycle=yes` tags in OSM. Without the TfNSW data the router would make you walk them.

## How "safe" is computed

Each segment gets a **danger multiplier** on its length (`src/model.ts`):

| Facility | Multiplier (approx.) |
| --- | --- |
| Separated cycleway | 1.0 |
| Shared path | 1.1–1.25 |
| Quiet street (≤ 40 km/h), quietway, shared zone | 1.2–1.5 |
| 50 km/h residential | 1.75 |
| Painted lane | halfway between the road's value and 1 |
| Collector / tertiary road | 2–3 |
| Arterial (secondary / primary) | 3–5+ |
| Highway or 70 km/h+ | 6–10+ |
| Walking your bike (footpath or steps) | Safe, but costed at walking speed |

The route cost is then:

```
cost = Σ length × (time factor + α × (multiplier − 1))
     + α × crash penalties          (severity-weighted bike crashes at that intersection or segment)
     + α × crossing penalties       (crossing a road busier than both streets you're on;
                                      reduced at traffic lights or marked crossings)
```

`α` is 1 for *Safest*, 0.4 for *Balanced* and 0.08 for *Most direct*. The search is A* with a straight-line heuristic, and typically takes 10–50 ms per route.

The **safety score** (0–100) summarises the average danger multiplier, crash exposure and risky crossings along the route. 100 means an entirely separated cycleway.

## Project layout

```
scripts/download.ts   fetch OSM + TfNSW data (uses the TfNSW CKAN API to find the latest files)
scripts/build.ts      build data/graph/*.bin + overlay GeoJSON
scripts/shards.ts     pack/unpack data/ ↔ shards/ (Git LFS, 50 MB pieces + manifest.json with SHA-256)
scripts/audit.ts      route ~20 test trips across Sydney and print stats (V=1 for directions)
src/model.ts          the safety model (edit weights here, then `npm run build`)
src/router.ts         snapping, A*, turn-by-turn directions, route stats
src/server.ts         HTTP API + static files
public/               the web app (MapLibre GL)
```

API: `GET /api/route?from=lat,lon&to=lat,lon` returns up to three routes, each with coloured geometry, stats and steps. Other endpoints: `/api/search?q=`, `/api/reverse?lat=&lon=`, `/data/network.geojson`, `/data/crashes.geojson`.

## Limitations

- Hills aren't considered yet. Sydney is hilly; adding elevation data would be the next improvement.
- Crash data only covers *reported* crashes, and busier bike routes naturally see more of them.
- Footpath legality follows NSW adult rules. Riders under 16, or adults supervising them, may ride on footpaths.
- Matching TfNSW data to OSM is geometric (within 15 m and a similar bearing), so a handful of segments may be misclassified.
