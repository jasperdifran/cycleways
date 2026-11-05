// Dev tool: runs sample origin/destination pairs across Sydney and prints route stats.
// Usage: node scripts/audit.ts [pair,pair,...]   (V=1 for steps)
import { loadGraph } from '../src/graph.ts';
import { planRoutes } from '../src/router.ts';
const g = loadGraph();
const P: Record<string,[number,number]> = {
  newtown:[-33.8975,151.1790], opera:[-33.8568,151.2153], milsons:[-33.8467,151.2115], northsyd:[-33.8395,151.2070],
  parra:[-33.8150,151.0011], olympic:[-33.8470,151.0690], bondi:[-33.8915,151.2767], central:[-33.8830,151.2065],
  liverpool:[-33.9249,150.9237], penrith:[-33.7511,150.6942], manly:[-33.7969,151.2850], dywhy:[-33.7531,151.2867],
  sutherland:[-34.0310,151.0577], cronulla:[-34.0560,151.1525], bankstown:[-33.9175,151.0346], ryde:[-33.8150,151.1050],
  chatswood:[-33.7969,151.1803], hornsby:[-33.7046,151.0994], campbelltown:[-34.0650,150.8142], blacktown:[-33.7690,150.9063],
  marrickville:[-33.9110,151.1550], tempe:[-33.9230,151.1580], pyrmont:[-33.8700,151.1940], surry:[-33.8870,151.2120],
};
const pairs = (process.argv[2] ?? 'newtown-opera,central-northsyd,opera-chatswood,parra-olympic,bondi-central,liverpool-parra,penrith-blacktown,manly-dywhy,sutherland-cronulla,bankstown-marrickville,ryde-chatswood,hornsby-chatswood,campbelltown-liverpool,pyrmont-surry,marrickville-central,blacktown-parra,olympic-ryde,tempe-bondi,milsons-pyrmont').split(',');
for (const pr of pairs) {
  const [a,b] = pr.split('-');
  const t = performance.now();
  const r: any = planRoutes(g, P[a], P[b]);
  const ms = (performance.now()-t).toFixed(0);
  if (r.error) { console.log(pr, 'ERROR', r.error); continue; }
  for (const x of r.routes) {
    const bc = x.byClass.map((m:number)=>(m/1000).toFixed(1)).join('/');
    const unsig = x.crossings.filter((c:any)=>!c.signals).map((c:any)=>c.name);
    console.log(`${pr.padEnd(24)} ${x.modes.join('+').padEnd(26)} ${(x.distance/1000).toFixed(1)}km ${Math.round(x.duration/60)}min score ${x.safetyScore} cls[sep/sh/q/lane/mod/busy/walk]=${bc} crash ${x.crashes} unsig ${unsig.length} ${ms}ms`);
    if (process.env.V) { console.log('   unsig:', unsig.join('; ')); console.log('   ', x.steps.map((s:any)=>`${s.instruction} (${s.distance}${s.note?' !'+s.note:''})`).join(' | ')); }
  }
}
