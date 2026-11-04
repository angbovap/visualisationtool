/*
 * Builds src/data/stormwaterPipes.json from council's StormwaterPipes.shp.
 *
 *   node scripts/build-stormwater.cjs [path/to/StormwaterPipes.shp]
 *
 * The export came as a .shp alone (no .dbf, no .prj): geometry only, no
 * diameter, material or age. Its coordinates fall in the GDA2020 MGA
 * Zone 54 range, the same grid as council's flood files, so it is
 * reprojected from EPSG:7854 to WGS84 lat/lng. Coordinates are rounded to
 * 6 decimals (about 0.1 m); nothing is simplified or clipped.
 *
 * It also measures how much of the network's length lies inside each
 * flood extent (by testing points every 5 m along every pipe), so the app
 * can show that without doing the work on every load.
 */
const fs = require('fs');
const path = require('path');
const proj4 = require('proj4');

const src = process.argv[2] || 'C:/Users/61411/Desktop/shpfilescocs/StormwaterPipes.shp';
const out = path.join(__dirname, '..', 'src', 'data', 'stormwaterPipes.json');

proj4.defs('EPSG:7854', '+proj=utm +zone=54 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
const toLatLng = ([x, y]) => {
  const [lng, lat] = proj4('EPSG:7854', 'EPSG:4326', [x, y]);
  return [Number(lat.toFixed(6)), Number(lng.toFixed(6))];
};

// --- Read the PolyLine records (shape type 3) ----------------------------
const b = fs.readFileSync(src);
if (b.readInt32LE(32) !== 3) throw new Error('Expected a PolyLine shapefile (type 3)');
const lines = [];
let off = 100;
while (off < b.length) {
  const contentLen = b.readInt32BE(off + 4) * 2;
  const rec = off + 8;
  const type = b.readInt32LE(rec);
  if (type === 3) {
    const numParts = b.readInt32LE(rec + 36);
    const numPoints = b.readInt32LE(rec + 40);
    const parts = [];
    for (let i = 0; i < numParts; i++) parts.push(b.readInt32LE(rec + 44 + i * 4));
    const ptsOff = rec + 44 + numParts * 4;
    for (let i = 0; i < numParts; i++) {
      const start = parts[i];
      const end = i + 1 < numParts ? parts[i + 1] : numPoints;
      const line = [];
      for (let j = start; j < end; j++) {
        line.push(toLatLng([b.readDoubleLE(ptsOff + j * 16), b.readDoubleLE(ptsOff + j * 16 + 8)]));
      }
      if (line.length >= 2) lines.push(line);
    }
  }
  off = rec + contentLen;
}

// --- Length, and length inside each flood extent ------------------------
const M = 111320;
const segLen = (a, c) =>
  Math.hypot((c[1] - a[1]) * M * Math.cos((a[0] * Math.PI) / 180), (c[0] - a[0]) * M);
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
const flood = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'floodContours.json'), 'utf8'));
const extents = Object.fromEntries(
  Object.entries(flood.returnPeriods).map(([k, cs]) => [k, cs.flatMap((c) => c.rings.map((ring) => ({ ring, box: bbox(ring) })))]),
);

let total = 0;
const insideLen = { '1in5': 0, '1in20': 0, '1in100': 0 };
for (const line of lines) {
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const c = line[i + 1];
    const L = segLen(a, c);
    total += L;
    const steps = Math.max(1, Math.round(L / 5));
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      const la = a[0] + t * (c[0] - a[0]);
      const ln = a[1] + t * (c[1] - a[1]);
      for (const k of Object.keys(insideLen)) {
        if (extents[k].some(({ ring, box }) => inBox(la, ln, box) && inRing(la, ln, ring))) insideLen[k] += L / steps;
      }
    }
  }
}

const result = {
  source:
    'Council GIS export, StormwaterPipes.shp (geometry only: no .dbf or .prj supplied), read as GDA2020 MGA Zone 54 and reprojected to WGS84.',
  pipes: lines.length,
  totalKm: Number((total / 1000).toFixed(1)),
  kmInFlood: Object.fromEntries(Object.entries(insideLen).map(([k, v]) => [k, Number((v / 1000).toFixed(1))])),
  lines,
};
fs.writeFileSync(out, JSON.stringify(result) + '\n');
console.log(
  `${lines.length} pipes, ${result.totalKm} km; in flood km:`,
  result.kmInFlood,
  `; ${(fs.statSync(out).size / 1e6).toFixed(2)} MB`,
);
