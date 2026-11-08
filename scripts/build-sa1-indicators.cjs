/*
 * Builds src/data/sa1Indicators.json: measured indicators per SA1, the
 * inputs to the Priority mix layer. Only shares, averages and values
 * from the supplied layers; the weighting is chosen by the person using
 * the tool, not here.
 *
 *   node scripts/build-sa1-indicators.cjs
 *
 * flood: share of the SA1's area inside the 1 in 100 extent (30 m grid).
 * uhi / svi: average UHI category and SVI of heat cells centred in the
 *   SA1 (null where none are: the heat grid covers part of the LGA only).
 * density: the SA1's own "Density 21" value (null where the export has none).
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'src', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
const sa1s = read('sa1Boundaries.json');
const heat = read('heatVulnerability.json');
const flood = read('floodContours.json');
const density = read('dwellingDensity.json').byCode;

const GRID_M = 30;
function bbox(ring) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const [lat, lng] of ring) {
    if (lat < a) a = lat;
    if (lat > b) b = lat;
    if (lng < c) c = lng;
    if (lng > d) d = lng;
  }
  return { latLo: a, latHi: b, lngLo: c, lngHi: d };
}
const inBox = (lat, lng, x) => lat >= x.latLo && lat <= x.latHi && lng >= x.lngLo && lng <= x.lngHi;
function inRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [la, lo] = ring[i];
    const [lb, lob] = ring[j];
    if (la > lat !== lb > lat && lng < ((lob - lo) * (lat - la)) / (lb - la) + lo) inside = !inside;
  }
  return inside;
}
const floodRings = flood.returnPeriods['1in100'].flatMap((c) => c.rings.map((ring) => ({ ring, box: bbox(ring) })));
const cellCentres = heat.map((c) => {
  const b = bbox(c.rings[0]);
  return { lat: (b.latLo + b.latHi) / 2, lng: (b.lngLo + b.lngHi) / 2, uhi: c.uhiCat, svi: c.svi };
});

const bySa1 = {};
for (const a of sa1s) {
  const box = bbox(a.ring);
  const midLat = (box.latLo + box.latHi) / 2;
  const dLat = GRID_M / 111320;
  const dLng = GRID_M / (111320 * Math.cos((midLat * Math.PI) / 180));
  let n = 0;
  let hit = 0;
  for (let lat = box.latLo + dLat / 2; lat < box.latHi; lat += dLat) {
    for (let lng = box.lngLo + dLng / 2; lng < box.lngHi; lng += dLng) {
      if (!inRing(lat, lng, a.ring)) continue;
      n++;
      if (floodRings.some(({ ring, box: b }) => inBox(lat, lng, b) && inRing(lat, lng, ring))) hit++;
    }
  }
  const cells = cellCentres.filter((c) => inBox(c.lat, c.lng, box) && inRing(c.lat, c.lng, a.ring));
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const r = (v, d) => (v === null ? null : Number(v.toFixed(d)));
  bySa1[a.code] = {
    flood: n ? r(hit / n, 3) : null,
    uhi: r(avg(cells.map((c) => c.uhi)), 2),
    svi: r(avg(cells.map((c) => c.svi)), 2),
    cells: cells.length,
    density: density[a.code] ? density[a.code].value : null,
  };
}

fs.writeFileSync(
  path.join(dataDir, 'sa1Indicators.json'),
  JSON.stringify({
    method:
      'Per SA1, from the supplied layers: share of area in the 1 in 100 extent (30 m grid); average UHI category and SVI of heat cells centred in it; its Density 21 value.',
    bySa1,
  }) + '\n',
);
const vals = Object.values(bySa1);
console.log(
  'SA1s',
  vals.length,
  '| with flood>0',
  vals.filter((v) => v.flood > 0).length,
  '| with heat cells',
  vals.filter((v) => v.cells > 0).length,
  '| with density',
  vals.filter((v) => v.density !== null).length,
);
