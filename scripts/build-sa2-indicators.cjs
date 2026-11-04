/*
 * Builds src/data/sa2Indicators.json: measured indicators per SA2, worked
 * out only from the layers already in src/data. No weights, scores or
 * cut-offs are introduced; each figure is a share, an average or a count.
 *
 *   node scripts/build-sa2-indicators.cjs
 *
 * Flood: share of each SA2's area inside each flood extent, estimated by
 *   testing a regular grid of points (GRID_M apart) against the SA2 and
 *   flood polygons.
 * Heat: each heat grid cell is assigned to the SA2 holding its centre;
 *   then the average UHI category, the share of cells in category 4 and
 *   the average SVI of those cells. Cells cover part of the LGA only, so
 *   the cell count is kept alongside.
 * Dwelling density: SA1 "Density 21" values averaged across each SA2,
 *   weighted by SA1 area, over the SA1s that have a value.
 */
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'src', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));

const sa2s = read('sa2Boundaries.json');
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

const extents = {
  '1in5': flood.returnPeriods['1in5'],
  '1in20': flood.returnPeriods['1in20'],
  '1in100': flood.returnPeriods['1in100'],
};
const floodRings = Object.fromEntries(
  Object.entries(extents).map(([k, catchments]) => [
    k,
    catchments.flatMap((c) => c.rings.map((ring) => ({ ring, box: bbox(ring) }))),
  ]),
);
const inExtent = (k, lat, lng) => floodRings[k].some(({ ring, box }) => inBox(lat, lng, box) && inRing(lat, lng, ring));

const out = {
  method:
    'Measured from the supplied layers only. Flood: share of SA2 area inside each extent, from a ' +
    GRID_M +
    ' m point grid. Heat: heat grid cells assigned to the SA2 holding their centre; average UHI category, share in category 4, average SVI. Dwelling density: SA1 "Density 21" values averaged across the SA2, weighted by SA1 area.',
  gridMetres: GRID_M,
  bySa2: {},
};

for (const s of sa2s) {
  const box = bbox(s.ring);
  const midLat = (box.latLo + box.latHi) / 2;
  const dLat = GRID_M / 111320;
  const dLng = GRID_M / (111320 * Math.cos((midLat * Math.PI) / 180));
  let n = 0;
  const hits = { '1in5': 0, '1in20': 0, '1in100': 0, any: 0 };
  for (let lat = box.latLo + dLat / 2; lat < box.latHi; lat += dLat) {
    for (let lng = box.lngLo + dLng / 2; lng < box.lngHi; lng += dLng) {
      if (!inRing(lat, lng, s.ring)) continue;
      n++;
      let any = false;
      for (const k of ['1in5', '1in20', '1in100']) {
        if (inExtent(k, lat, lng)) {
          hits[k]++;
          any = true;
        }
      }
      if (any) hits.any++;
    }
  }

  const cells = heat.filter((c) => {
    const b = bbox(c.rings[0]);
    const lat = (b.latLo + b.latHi) / 2;
    const lng = (b.lngLo + b.lngHi) / 2;
    return inBox(lat, lng, box) && inRing(lat, lng, s.ring);
  });
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  const kids = sa1s.filter((a) => a.sa2Code === s.code && density[a.code]);
  const areaSum = kids.reduce((t, a) => t + a.areaSqKm, 0);
  const densityAvg = areaSum ? kids.reduce((t, a) => t + density[a.code].value * a.areaSqKm, 0) / areaSum : null;

  const r = (v, d = 3) => (v === null ? null : Number(v.toFixed(d)));
  out.bySa2[s.code] = {
    floodShare: {
      '1in5': r(hits['1in5'] / n),
      '1in20': r(hits['1in20'] / n),
      '1in100': r(hits['1in100'] / n),
      any: r(hits.any / n),
    },
    heatCells: cells.length,
    uhiAvg: r(avg(cells.map((c) => c.uhiCat)), 2),
    uhiCat4Share: cells.length ? r(cells.filter((c) => c.uhiCat === 4).length / cells.length) : null,
    sviAvg: r(avg(cells.map((c) => c.svi)), 2),
    densityAvg: r(densityAvg, 2),
    densitySa1s: kids.length,
  };
  console.log(s.name, JSON.stringify(out.bySa2[s.code]));
}

fs.writeFileSync(path.join(dataDir, 'sa2Indicators.json'), JSON.stringify(out, null, 1) + '\n');
console.log('wrote src/data/sa2Indicators.json');
