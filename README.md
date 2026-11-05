# Cycleways

Find the safest bike route across Sydney. Pick a start and destination and it routes you along bike paths and quiet streets, avoiding busy roads, risky crossings and crash spots. It also shows a *Balanced* and a *Most direct* option.

## Run it

Needs Node 23.6 or newer.

```bash
npm install
npm run data:unpack   # unpack the bundled data
npm start             # http://localhost:5173
```

To rebuild from the latest data (needs [osmium](https://osmcode.org/osmium-tool/)):

```bash
npm run setup         # download + build
npm run data:pack     # update the bundled data, then commit
```

## Data

- **Streets and paths:** [OpenStreetMap](https://www.openstreetmap.org)
- **Bike network:** Transport for NSW [Cycleway Data](https://opendata.transport.nsw.gov.au/dataset/infrastructure-cycleway-data)
- **Bike crashes:** Transport for NSW [NSW Crash Data](https://opendata.transport.nsw.gov.au/dataset/nsw-crash-data)
- **Map tiles:** [OpenFreeMap](https://openfreemap.org)
- **Search:** a local index built from OpenStreetMap, plus [Photon](https://photon.komoot.io)

## How it works

Every street and path gets a danger score: separated bike paths are safest, then shared paths and quiet streets, then busier and faster roads. The router finds the route with the least total danger, and adds penalties for reported bike crashes and unsignalised crossings of main roads. The safety weights live in `src/model.ts`.

## Limitations

- Hills aren't taken into account yet.
- Only reported crashes are counted.
- Footpath rules follow NSW adult rules (under 16s may ride on footpaths).

## Licence

Code is [MIT](LICENSE). OpenStreetMap data is © OpenStreetMap contributors under the [ODbL](https://www.openstreetmap.org/copyright). Transport for NSW data is © State of NSW under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
