/*
 * Builds src/data/majorRoads.json from the SA Government's Functional
 * Hierarchy for South Australia's Land Transport Network (DIT,
 * data.sa.gov.au, CC BY 3.0 AU): the Major Traffic and Freight, Peak Hour
 * and Public Transport layers.
 *
 *   node scripts/build-roads.cjs <folder holding the *_GDA2020.geojson files>
 *
 * Only roads inside the council boundary are kept. These are the state's
 * classified roads, not every local street.
 *
 * The same stretch of road can appear in several layers and classes. Each
 * stretch is kept once and drawn under its most important role, in this
 * order: Priority Network, Strategic Routes, Peak Hour Routes, High
 * Frequency (bus) Corridor, Standard Frequency (bus) Corridor. Every role
 * a road has (freight included) is still listed against it.
 *
 * For every stretch it records the most frequent flood extent its midpoint
 * sits in (segClass: 3 = 1 in 5, 2 = 1 in 20, 1 = 1 in 100, 0 = outside),
 * and totals length by role and by extent.
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) throw new Error('Pass the folder holding the FunctionalHierarchy*_GDA2020.geojson files');
const FILES = [
  'FunctionalHierarchyMajorTraffic_GDA2020.geojson',
  'FunctionalHierarchyPeakHour_GDA2020.geojson',
  'FunctionalHierarchyPublicTransport_GDA2020.geojson',
];
const RANK = [
  'Priority Network',
  'Strategic Routes',
  'Peak Hour Routes',
  'High Frequency Corridor',
  'Standard Frequency Corridor',
];
const rank = (c) => (RANK.indexOf(c) < 0 ? RANK.length : RANK.indexOf(c));

const dataDir = path.join(__dirname, '..', 'src', 'data');
const lga = JSON.parse(fs.readFileSync(path.join(dataDir, 'lgaBoundary.json'), 'utf8')).ring;
const flood = JSON.parse(fs.readFileSync(path.join(dataDir, 'floodContours.json'), 'utf8'));

function bbox(ring) {
  let a = Infinity, z = -Infinity, c = Infinity, d = -Infinity;
  for (const [la, ln] of ring) {
    if (la < a) a = la;
    if (la > z) z = la;
    if (ln < c) c = ln;
    if (ln > d) d = ln;
  }
  return { a, z, c, d };
}
const inBox = (la, ln, x) => la >= x.a && la <= x.z && ln >= x.c && ln <= x.d;
function inRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [la, lo] = ring[i];
    const [lb, lob] = ring[j];
    if (la > lat !== lb > lat && lng < ((lob - lo) * (lat - la)) / (lb - la) + lo) inside = !inside;
  }
  return inside;
}
const lgaBox = bbox(lga);
const inLga = ([la, ln]) => inBox(la, ln, lgaBox) && inRing(la, ln, lga);
const extents = Object.fromEntries(
  Object.entries(flood.returnPeriods).map(([k, cs]) => [k, cs.flatMap((c) => c.rings.map((ring) => ({ ring, box: bbox(ring) })))]),
);
const inExt = (k, la, ln) => extents[k].some(({ ring, box }) => inBox(la, ln, box) && inRing(la, ln, ring));
const M = 111320;
const segLen = (a, c) => Math.hypot((c[1] - a[1]) * M * Math.cos((a[0] * Math.PI) / 180), (c[0] - a[0]) * M);
const segKey = (a, c) => [a, c].map((p) => p[0].toFixed(5) + ',' + p[1].toFixed(5)).sort().join('|');

// Every feature from the three layers, as lat/lng parts.
const features = [];
for (const f of FILES) {
  const gj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const ft of gj.features) {
    const g = ft.geometry;
    if (!g) continue;
    const parts = g.type === 'MultiLineString' ? g.coordinates : g.type === 'LineString' ? [g.coordinates] : [];
    features.push({
      name: ft.properties.local_road_name || null,
      role: ft.properties.fc_description,
      parts: parts.map((part) => part.map(([lng, lat]) => [Number(lat.toFixed(6)), Number(lng.toFixed(6))])),
    });
  }
}

// Every role each road name has inside the LGA (freight included).
const rolesByName = {};
for (const f of features) {
  if (!f.name) continue;
  if (!f.parts.some((part) => part.some(inLga))) continue;
  (rolesByName[f.name] ??= new Set()).add(f.role);
}

// Keep each stretch once, under its most important role.
features.sort((x, y) => rank(x.role) - rank(y.role));
const seen = new Set();
const roads = [];
for (const f of features) {
  if (rank(f.role) >= RANK.length) continue; // freight-only lines: overlap the others
  for (const pts of f.parts) {
    let run = [];
    const flush = () => {
      if (run.length >= 2) roads.push({ name: f.name, role: f.role, line: run });
      run = [];
    };
    for (const pt of pts) {
      if (!inLga(pt)) {
        flush();
        continue;
      }
      if (run.length > 0) {
        const k = segKey(run[run.length - 1], pt);
        if (seen.has(k)) {
          flush();
          run = [pt];
          continue;
        }
        seen.add(k);
      }
      run.push(pt);
    }
    flush();
  }
}

const kmByRole = {};
const kmInFlood = { '1in5': 0, '1in20': 0, '1in100': 0 };
const kmIn100ByRoad = {};
let total = 0;
for (const r of roads) {
  let digits = '';
  let mask = '';
  for (let i = 0; i < r.line.length - 1; i++) {
    const a = r.line[i];
    const c = r.line[i + 1];
    const L = segLen(a, c);
    total += L;
    kmByRole[r.role] = (kmByRole[r.role] ?? 0) + L;
    const ma = (a[0] + c[0]) / 2;
    const mn = (a[1] + c[1]) / 2;
    const e5 = inExt('1in5', ma, mn);
    const e20 = inExt('1in20', ma, mn);
    const e100 = inExt('1in100', ma, mn);
    digits += e5 ? '3' : e20 ? '2' : e100 ? '1' : '0';
    mask += String((e100 ? 1 : 0) + (e20 ? 2 : 0) + (e5 ? 4 : 0));
    if (e5) kmInFlood['1in5'] += L;
    if (e20) kmInFlood['1in20'] += L;
    if (e100) {
      kmInFlood['1in100'] += L;
      if (r.name) kmIn100ByRoad[r.name] = (kmIn100ByRoad[r.name] ?? 0) + L;
    }
  }
  r.segClass = digits;
  // Every extent each stretch is in: 1 = 1 in 100, 2 = 1 in 20, 4 = 1 in 5, summed.
  r.segMask = mask;
}

const km = (v) => Number((v / 1000).toFixed(2));
const out = {
  source:
    "SA Government, Department for Infrastructure and Transport: Functional Hierarchy for South Australia's Land Transport Network (Major Traffic and Freight, Peak Hour, Public Transport), data.sa.gov.au, CC BY 3.0 AU. Clipped to the LGA. Classified roads only, not every local street.",
  totalKm: km(total),
  kmByRole: Object.fromEntries(RANK.filter((r) => kmByRole[r]).map((r) => [r, km(kmByRole[r])])),
  kmInFlood: Object.fromEntries(Object.entries(kmInFlood).map(([k, v]) => [k, km(v)])),
  kmIn1in100ByRoad: Object.fromEntries(Object.entries(kmIn100ByRoad).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, km(v)])),
  rolesByName: Object.fromEntries(Object.entries(rolesByName).map(([k, v]) => [k, [...v].sort((a, b) => rank(a) - rank(b))])),
  roads,
};
fs.writeFileSync(path.join(dataDir, 'majorRoads.json'), JSON.stringify(out) + '\n');
console.log(`${roads.length} pieces, ${out.totalKm} km`, out.kmByRole, 'in flood', out.kmInFlood);
console.log('most in 1 in 100:', Object.entries(out.kmIn1in100ByRoad).slice(0, 8));
