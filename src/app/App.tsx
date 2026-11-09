/*
 * CoCS Climate Risk Tolerance Tool
 * Decision-support surface for City of Charles Sturt council staff.
 *
 * Shows council's own GIS layers, the real ABS SA2 and SA1 boundaries and
 * the council asset register. Where no real figure has been supplied, it
 * shows nothing for that figure rather than an estimate.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { Map as LeafletMap, Layer as LeafletLayer } from 'leaflet';

// Real asset register export. See "Real buildings register" below for the
// column mapping and why the raw file needed collapsing before use.
import ccsBuildingsRaw from '@/data/ccsBuildings.json';

// Real ABS ASGS 2021 digital boundaries for the Charles Sturt SA3 (which
// this council area maps to exactly, one LGA to one SA3). Fetched from
// geo.abs.gov.au, not hand-drawn. See "Real SA1 / SA2 boundaries" below.
import sa2BoundaryData from '@/data/sa2Boundaries.json';
import sa1BoundaryData from '@/data/sa1Boundaries.json';

// The actual Council LGA boundary, not an ABS statistical approximation
// of it. Supplied as a QGIS shapefile (geometry only, WGS84 lat/lng
// confirmed against its own bounding box), parsed to a single ring. It
// replaces the 8 SA2 shapes as the outer edge of the LGA on the map;
// those still draw individually for the suburb divisions inside it.
import lgaBoundaryData from '@/data/lgaBoundary.json';

// Real geometry from the same batch of council QGIS shapefiles, clipped
// from statewide layers to the LGA (with a small buffer) during import,
// or matched to the real LGA boundary where a point either sits inside
// it or does not. See "Real vector layers from QGIS" below for how each
// was reprojected and clipped.
import railwaysData from '@/data/railways.json';
import trainStationsData from '@/data/trainStations.json';
import watercoursesData from '@/data/watercourses.json';
import waterbodiesData from '@/data/waterbodies.json';
import obstetricHospitalsData from '@/data/obstetricHospitals.json';
import floodContoursData from '@/data/floodContours.json';
import pedestrianNetworkData from '@/data/pedestrianNetwork.json';
import dwellingDensityData from '@/data/dwellingDensity.json';
// Measured per-SA2 indicators, built by scripts/build-sa2-indicators.cjs
// from the layers above. No weights or cut-offs, see that script.
import sa2IndicatorsData from '@/data/sa2Indicators.json';
// Measured per-SA1 inputs for the Priority mix layer, built by
// scripts/build-sa1-indicators.cjs. The weighting is chosen in the tool.
import sa1IndicatorsData from '@/data/sa1Indicators.json';
// The Queen Elizabeth Hospital's site outline and centre, from
// OpenStreetMap (amenity=hospital) via Nominatim. Not council data.
import tqehSiteData from '@/data/tqehSite.json';
// StormwaterPipes.shp, built by scripts/build-stormwater.cjs: geometry
// only (no attribute table was supplied).
import stormwaterPipesData from '@/data/stormwaterPipes.json';
// The state's classified roads (DIT Functional Hierarchy), built by
// scripts/build-roads.cjs. Not council's road register.
import majorRoadsData from '@/data/majorRoads.json';

// UrbanHeatSocialVulnDay2022.shp + .dbf: a fine-grained grid, individual
// cells of a few hectares each, carrying a real Urban Heat Island
// category (2 to 4) and Social Vulnerability Index from council's GIS
// export. Reprojected from GDA2020 MGA Zone 54 and clipped to the LGA.
import heatVulnerabilityData from '@/data/heatVulnerability.json';

// Approximate positions for real buildings, geocoded from the register's
// own address field via OpenStreetMap Nominatim (free, no key, one-time
// batch at their 1 request/second limit). Not part of the source export.
// See BUILDING_LOCATION below for why most of these are street-level.
import ccsBuildingsGeocoded from '@/data/ccsBuildingsGeocoded.json';
import ccsRegisterDates from '@/data/ccsRegisterDates.json';
import vapLogo from '@/assets/vaplogo.png';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */


type PanelTab = 'layers' | 'assets' | 'place' | 'cases' | 'help';

type LayerGroup =
  | 'hazard'
  | 'vulnerability'
  | 'transport'
  | 'infrastructure'
  | 'planning';

type LayerKind = 'choropleth' | 'canvas' | 'vector';



type BoundsMode = 'none' | 'sa2' | 'sa1';


/** Latitude / longitude pair in the order Leaflet expects. */
type LatLngTuple = [number, number];



interface Suburb {
  id: string;
  name: string;
  sa2: string;
  /** Real ABS boundary, looked up by sa2 code, not authored by hand. */
  path: LatLngTuple[];
  /** Bounding-box centre and half-extent of the real polygon, used by the
   *  schematic overlays (heat grid, PT stops, industrial blocks) that need
   *  an approximate box rather than the polygon itself. */
  centroid: LatLngTuple;
  span: [number, number];
}

// SA1Area is declared further down, next to the real boundary data it is
// built from (see "SA1 sub-areas").


interface LayerDef {
  id: string;
  name: string;
  group: LayerGroup;
  kind: LayerKind;
  /** Ramp endpoints. Overlay and vector layers leave these unset. */
  lo?: string;
  hi?: string;
  unit: string;
  /** Plain-language description of what the layer actually measures. */
  note: string;
  /** Where the equivalent real dataset would come from. */
  source: string;
  /** Time-series steps, when the dataset has any. */
  steps?: number[];
  /** Year the source file itself states (from its filename), for a fixed
   *  snapshot with no time series. Left unset when the source gives none. */
  vintage?: number;
}


/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const ACCENT = '#006E78';

/** One colour per hazard, used wherever that hazard appears in the UI. */
const HAZARD_COLOR = {
  flood: '#1D4ED8',
  heat: '#DC2626',
  water: '#0284C7',
  people: '#B45309',
  assets: '#374151',
} as const;
type HazardKey = keyof typeof HAZARD_COLOR;




const MAP_CENTER: LatLngTuple = [-34.898, 138.535];
const MAP_ZOOM = 12;

/* ------------------------------------------------------------------ *
 * Basemaps
 *
 * Staff locate themselves by street names and rooflines, not by polygon
 * outlines, so the default is a real street map rather than a blank
 * canvas. All four options below work without a key.
 *
 * Put VITE_MAPTILER_KEY in a .env file and two MapTiler styles appear at
 * the front of the list, which is the route to higher zoom and aerial
 * imagery with a licence attached to it.
 * ------------------------------------------------------------------ */

interface BasemapDef {
  id: string;
  name: string;
  url: string;
  attribution: string;
  /** Reference or label tiles drawn above the fills, where the base has none. */
  labels?: string;
  maxZoom: number;
  /** Imagery needs light strokes over it rather than dark ones. */
  dark?: boolean;
}

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY as string | undefined;

const OSM_ATTR = '&copy; OpenStreetMap contributors';
const ESRI_IMAGERY_ATTR = 'Esri, Maxar, Earthstar Geographics, GIS community';

const BASEMAPS: BasemapDef[] = [
  {
    id: 'streets',
    name: 'Streets',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: OSM_ATTR,
    maxZoom: 19,
  },
  {
    id: 'satellite',
    name: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    labels:
      'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    attribution: ESRI_IMAGERY_ATTR,
    maxZoom: 19,
    dark: true,
  },
  {
    id: 'topo',
    name: 'Topographic',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Esri, HERE, Garmin, GIS community',
    maxZoom: 19,
  },
  {
    id: 'light',
    name: 'Light',
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: OSM_ATTR + ', tiles CARTO',
    maxZoom: 19,
  },
];

if (MAPTILER_KEY) {
  BASEMAPS.unshift(
    {
      id: 'maptiler-streets',
      name: 'Streets+',
      url:
        'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=' +
        MAPTILER_KEY,
      attribution: 'MapTiler, ' + OSM_ATTR,
      maxZoom: 20,
    },
    {
      id: 'maptiler-hybrid',
      name: 'Hybrid',
      url:
        'https://api.maptiler.com/maps/hybrid/{z}/{x}/{y}.jpg?key=' +
        MAPTILER_KEY,
      attribution: 'MapTiler, ' + OSM_ATTR,
      maxZoom: 20,
      dark: true,
    },
  );
}

const BASEMAP_BY_ID: Record<string, BasemapDef> = Object.fromEntries(
  BASEMAPS.map((b) => [b.id, b]),
);

/* ------------------------------------------------------------------ *
 * Layer catalogue
 *
 * `lo` and `hi` are the ends of the choropleth ramp. Vector overlays
 * carry a single colour in `hi` and no ramp. `note` and `source` feed the
 * rollover text, because a layer nobody can interrogate is a layer nobody
 * should act on.
 * ------------------------------------------------------------------ */

const LAYERS: LayerDef[] = [
  {
    id: 'heat-vuln',
    name: 'Heat Vulnerability',
    group: 'hazard',
    kind: 'canvas',
    lo: '#FFFBEB',
    hi: '#EF4444',
    unit: 'UHI category 2 (lowest) to 4 (highest)',
    note: 'Daytime Urban Heat Island category per grid cell (about 3 ha each on average), with a Social Vulnerability Index attached (hover a cell). A fixed 2022 snapshot, not a time series. The grid covers about 22 km² of the council area; elsewhere there is no heat data.',
    source: 'Council GIS export, "UrbanHeatSocialVulnDay2022.shp/.dbf", reprojected from GDA2020 MGA Zone 54 and clipped to the LGA',
    vintage: 2022,
  },
  {
    id: 'flood-1in5-real',
    name: 'Flood 1 in 5 (long-term)',
    group: 'hazard',
    kind: 'vector',
    hi: '#1D4ED8',
    unit: 'flood polygons',
    note: '1 in 5 flood polygons for the Meakin, PAT, Port Road, River Torrens, TE, TRDA, WC and West Lakes catchments. Trimmer has not been supplied, so this is not the full picture. No depth is shown, the attribute tables were not supplied. Every file is a long-term run as labelled in the supplied file names ("longterm"; River Torrens "LT2050", a 2050 horizon), so these are future extents, not current conditions. Council has not confirmed what the long-term assumption is.',
    source: 'Council GIS export, flood contour polygons per catchment, 1 in 5 ARI, reprojected from GDA2020 MGA Zone 54',
  },
  {
    id: 'flood-1in20-real',
    name: 'Flood 1 in 20 (long-term)',
    group: 'hazard',
    kind: 'vector',
    hi: '#2563EB',
    unit: 'flood polygons',
    note: '1 in 20 flood polygons for the River Torrens, TRDA and Trimmer catchments only. The rest have not been supplied, so this is not the full picture. No depth is shown, the attribute tables were not supplied. Every file is a long-term run as labelled in the supplied file names ("longterm"; River Torrens "LT2050", a 2050 horizon), so these are future extents, not current conditions. Council has not confirmed what the long-term assumption is.',
    source: 'Council GIS export, flood contour polygons per catchment, 1 in 20 ARI, reprojected from GDA2020 MGA Zone 54',
  },
  {
    id: 'flood-1in100-real',
    name: 'Flood 1 in 100 (long-term)',
    group: 'hazard',
    kind: 'vector',
    hi: '#1E3A8A',
    unit: 'flood polygons',
    note: '1 in 100 flood polygons for the Meakin, PAT, Port Road, River Torrens, TE, TRDA, Trimmer, WC and West Lakes catchments, every catchment supplied so far. No depth is shown, the attribute tables were not supplied. Every file is a long-term run as labelled in the supplied file names ("longterm"; River Torrens "LT2050", a 2050 horizon), so these are future extents, not current conditions. Council has not confirmed what the long-term assumption is.',
    source: 'Council GIS export, flood contour polygons per catchment, 1 in 100 ARI, reprojected from GDA2020 MGA Zone 54',
  },
  {
    id: 'watercourses',
    name: 'Watercourses',
    group: 'hazard',
    kind: 'vector',
    hi: '#0EA5E9',
    unit: 'line features',
    note: 'Creeks, drains and the Port River edge. The receiving system for everything upstream.',
    source: 'Council GIS export, TOPO_Watercourses_GDA2020.shp, clipped to the LGA from the statewide layer',
  },
  {
    id: 'waterbodies',
    name: 'Waterbodies',
    group: 'hazard',
    kind: 'vector',
    hi: '#0369A1',
    unit: 'polygon features',
    note: 'Lakes, basins and other standing water, including West Lakes. Storage capacity and a flood risk if it overtops.',
    source: 'Council GIS export, TOPO_Waterbodies_GDA2020.shp, clipped to the LGA from the statewide layer',
  },
  {
    id: 'obstetric-hospitals',
    name: 'Obstetric Hospitals',
    group: 'infrastructure',
    kind: 'vector',
    hi: '#DB2777',
    unit: 'facilities',
    note: 'Not a council asset, but a state health facility inside the LGA, of the four in the statewide dataset only one point actually falls inside the boundary once checked against the LGA boundary.',
    source: 'Council GIS export, "Obstetric_Hospitals_2014.shp" (statewide, GDA2020 SA Lambert), reprojected and matched to the LGA boundary',
    vintage: 2014,
  },
  {
    id: 'railways',
    name: 'Railways',
    group: 'transport',
    kind: 'vector',
    hi: '#334155',
    unit: 'rail corridor',
    note: 'Passenger rail corridors, from the statewide rail network layer clipped to the LGA.',
    source: 'Project GIS drive export, Railways_GDA2020.shp (Adelaide-wide), clipped to the LGA',
  },
  {
    id: 'train-stations',
    name: 'Train Stations',
    group: 'transport',
    kind: 'vector',
    hi: '#334155',
    unit: 'stations',
    note: 'Train station locations inside the LGA, from the same rail network export as the Railways layer.',
    source: 'Council GIS export, "Train Stations.shp"',
  },
  {
    id: 'pedestrian-network',
    name: 'Pedestrian Network',
    group: 'transport',
    kind: 'vector',
    hi: '#0D9488',
    unit: 'line features',
    note: 'Classified pedestrian routes from the statewide functional hierarchy export, clipped to the LGA. All 20 segments inside the LGA carry the same classification, "High Activity Pedestrian Area" (hover a segment); the export\'s other two categories, Pedestrian Local and Priority Pedestrian Area, only occur outside Charles Sturt.',
    source: 'Statewide GIS export, "FunctionalHierarchyPedestrian_GDA94.shp/.dbf", clipped to the LGA boundary, fc_descrip is the classification field',
  },
  {
    id: 'dwelling-density',
    name: 'Dwelling Density (2021)',
    group: 'vulnerability',
    kind: 'vector',
    hi: '#6B3FA0',
    unit: 'Very Low / Low / Medium / High (unit not confirmed by council)',
    note: 'Council\'s density category for 253 of the 257 SA1s, from the "Density 21" field and the breaks set in the CoCS_DwellingDensity2021 QGIS layer: Emp. Only (0, no dwellings), Very Low 0-10, Low 10-22, Medium 22-40, High 40-180. The other 4 SA1s have an overflowed value in the export and are left uncoloured. Council hasn\'t confirmed the unit or who produced the figures.',
    source: 'Council GIS export, CoCS_DwellingDensity2021.shp/.dbf, "Density 21" field, classified using the export\'s own QGIS symbology',
  },
  {
    id: 'major-roads',
    name: 'Major Roads',
    group: 'transport',
    kind: 'vector',
    hi: '#374151',
    unit: 'classified road lines',
    note: 'The state\'s classified roads inside the LGA: the Priority Network and Strategic Routes (major traffic and freight), Peak Hour Routes, and high and standard frequency bus corridors. Where a road plays several roles it is drawn under the most important one, and every role is listed when you hover it. Not council\'s road register: local streets aren\'t included.',
    source: "SA Government (DIT), Functional Hierarchy for South Australia's Land Transport Network, data.sa.gov.au, CC BY 3.0 AU",
  },
  {
    id: 'priority-mix',
    name: 'Priority mix (your weights)',
    group: 'vulnerability',
    kind: 'vector',
    hi: '#D7191C',
    unit: 'SA1 areas, lower to higher',
    note: 'Each SA1 is measured on four things from the supplied layers: share of its area in the 1 in 100 flood extent, the average UHI category and SVI of its heat cells, and its Density 21 value. Each is turned into a rank against the other SA1s (0 = lowest, 100 = highest), then averaged using the weights you set. Nothing is weighted for you: all four start equal. Where an SA1 has no value for something (the heat grid covers part of the LGA only), it is averaged over the rest, and its tooltip says so.',
    source: 'Built from the flood, heat and dwelling density layers by scripts/build-sa1-indicators.cjs',
  },
  {
    id: 'stormwater-pipes',
    name: 'Stormwater Pipes',
    group: 'infrastructure',
    kind: 'vector',
    hi: '#15803D',
    unit: 'pipe lines',
    note: 'Council\'s stormwater pipe network across the LGA. Geometry only: the export came without its attribute table, so pipe diameter, material, age and flow direction are not known, and nothing about capacity is shown. Read as GDA2020 MGA Zone 54 (no .prj was supplied); the lines fall exactly on the LGA, which confirms it.',
    source: 'Council GIS export, StormwaterPipes.shp (no .dbf or .prj), reprojected to WGS84',
  },
];

/* ------------------------------------------------------------------ *
 * Blueprints
 *
 * A one-click preset that turns on a curated set of real layers at once,
 * nothing more. There is no suburb ranking or score attached, because
 * none of the real layers carries one: the right panel just lists which
 * layers the preset includes and where each one came from.
 * ------------------------------------------------------------------ */

type BlueprintId = 'heat' | 'flood' | 'transport';

interface Blueprint {
  id: BlueprintId;
  title: string;
  accent: string;
  description: string;
  layers: string[];
}

const BLUEPRINTS: Blueprint[] = [
  {
    id: 'heat',
    title: 'Heat Vulnerability',
    accent: '#D97706',
    description: 'The Urban Heat Island grid, with its Social Vulnerability Index.',
    layers: ['heat-vuln'],
  },
  {
    id: 'flood',
    title: 'Flood Risk',
    accent: '#2563EB',
    description: 'Every flood return-period layer supplied so far, plus the watercourses and waterbodies they interact with.',
    layers: ['flood-1in5-real', 'flood-1in20-real', 'flood-1in100-real', 'watercourses', 'waterbodies'],
  },
  {
    id: 'transport',
    title: 'Transport Network',
    accent: '#0891B2',
    description: 'Rail, train stations and the pedestrian network supplied so far.',
    layers: ['railways', 'train-stations', 'pedestrian-network'],
  },
];

const BLUEPRINT_BY_ID: Record<BlueprintId, Blueprint> = Object.fromEntries(
  BLUEPRINTS.map((b) => [b.id, b]),
) as Record<BlueprintId, Blueprint>;

const LAYER_BY_ID: Record<string, LayerDef> = Object.fromEntries(
  LAYERS.map((l) => [l.id, l]),
);

const GROUP_LABEL: Record<LayerGroup, string> = {
  hazard: 'Hazard layers',
  vulnerability: 'Vulnerability & Population',
  transport: 'Transport & Access',
  infrastructure: 'Infrastructure',
  planning: 'Planning & Land Use',
};

// The layers sourced from council's GIS export. Scopes what the Layers tab
// shows, and flags which layers are real for the layer info panel.
/** Council's own Dwelling Density categories, coloured light to dark
 *  purple in the same order as the CoCS_DwellingDensity2021 QGIS layer.
 *  Colour only encodes that real ordering, not a severity judgement.
 *  Emp. Only sits outside the density scale entirely (no dwellings), so
 *  it gets a neutral grey rather than a step on the purple ramp. */
const DWELLING_DENSITY_COLOR: Record<string, string> = {
  'Emp. Only': '#9CA3AF',
  'Very Low': '#EDE4F7',
  Low: '#C9AEEA',
  Medium: '#9B6FD1',
  High: '#6B3FA0',
};

const WORKSHOP_LAYER_IDS = new Set([
  'watercourses',
  'waterbodies',
  'flood-1in5-real',
  'flood-1in20-real',
  'flood-1in100-real',
  'pedestrian-network',
  'railways',
  'train-stations',
  'obstetric-hospitals',
  'heat-vuln',
  'dwelling-density',
  'stormwater-pipes',
  'priority-mix',
  'major-roads',
]);

interface RealBoundary {
  code: string;
  name?: string;
  sa2Code?: string;
  areaSqKm: number;
  ring: LatLngTuple[];
}

const SA2_BOUNDARIES = sa2BoundaryData as RealBoundary[];
const SA1_BOUNDARIES = sa1BoundaryData as RealBoundary[];

/** The real Council LGA boundary, one ring, from council's own GIS export
 *  rather than ABS statistical geography. Used as the outer edge of the
 *  map; the 8 SA2 shapes still draw individually inside it. */
const LGA_BOUNDARY = lgaBoundaryData as { name: string; areaSqKm: number; ring: LatLngTuple[] };

/* ------------------------------------------------------------------ *
 * Real vector layers from QGIS
 *
 * Railways, Train Stations, Watercourses and Waterbodies came as
 * statewide shapefiles (Railways and the two TOPO_ layers), already in
 * WGS84 lat/lng; each was clipped down to lines and polygons touching
 * the LGA plus a 2km buffer, without simplifying or redrawing anything
 * kept. Obstetric Hospitals came in GDA2020 SA Lambert (EPSG:8058, a
 * statewide grid with a 1,000,000/2,000,000 false easting/northing,
 * identified from its bounding box and confirmed by reprojecting it
 * into South Australia's real extent) and was reprojected, then tested
 * against the real LGA ring rather than a bounding box: of 4 statewide
 * points nearby, only 1 actually falls inside the boundary. None of the
 * four shapefiles came with an attribute table (.dbf), so there are no
 * names or classifications to show, only real position and shape.
 * ------------------------------------------------------------------ */

const RAILWAYS = railwaysData as LatLngTuple[][];
const TRAIN_STATIONS = trainStationsData as LatLngTuple[];
const WATERCOURSES = watercoursesData as LatLngTuple[][];
const WATERBODIES = waterbodiesData as LatLngTuple[][][];
const OBSTETRIC_HOSPITALS = obstetricHospitalsData as LatLngTuple[];

interface HeatVulnCell {
  rings: LatLngTuple[][];
  uhiCat: number;
  svi: number;
}
const HEAT_VULNERABILITY = heatVulnerabilityData as HeatVulnCell[];

/** Bounding-box centre and half-extent of a ring, in place of a hand-picked
 *  centroid. Schematic overlays (the heat grid, PT stop scatter, industrial
 *  and zoning blocks) use this as an approximate box, they never draw the
 *  ring itself. */
function ringBBox(ring: LatLngTuple[]): { centroid: LatLngTuple; span: [number, number] } {
  let latLo = Infinity, latHi = -Infinity, lngLo = Infinity, lngHi = -Infinity;
  for (const [lat, lng] of ring) {
    if (lat < latLo) latLo = lat;
    if (lat > latHi) latHi = lat;
    if (lng < lngLo) lngLo = lng;
    if (lng > lngHi) lngHi = lng;
  }
  return {
    centroid: [(latLo + latHi) / 2, (lngLo + lngHi) / 2],
    span: [(latHi - latLo) / 2, (lngHi - lngLo) / 2],
  };
}

/** Standard ray-casting point-in-polygon test, used to assign a geocoded
 *  building to the real SA2 it actually falls inside, rather than
 *  matching the register's locality text against a name it might not
 *  share with the SA2 (ABS suburbs and SA2s are different structures and
 *  do not always nest cleanly). */
function pointInRing(lat: number, lng: number, ring: LatLngTuple[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [latI, lngI] = ring[i];
    const [latJ, lngJ] = ring[j];
    const intersects =
      latI > lat !== latJ > lat &&
      lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI;
    if (intersects) inside = !inside;
  }
  return inside;
}






/* ------------------------------------------------------------------ *
 * SA2s
 *
 * The eight real ABS SA2s covering the LGA. Names and boundaries are the
 * official ones, nothing about them is invented.
 * ------------------------------------------------------------------ */

const SUBURBS: Suburb[] = SA2_BOUNDARIES.map((b) => {
  const { centroid, span } = ringBBox(b.ring);
  return {
    id: (b.name ?? b.code).toLowerCase().replace(/ - | /g, '-'),
    name: b.name ?? b.code,
    sa2: b.code,
    path: b.ring,
    centroid,
    span,
  };
});

const SUBURB_BY_ID: Record<string, Suburb> = Object.fromEntries(
  SUBURBS.map((s) => [s.id, s]),
);

const SA2_CODE_TO_SUBURB_ID: Record<string, string> = Object.fromEntries(
  SUBURBS.map((s) => [s.sa2, s.id]),
);

/* ------------------------------------------------------------------ *
 * SA1 sub-areas
 *
 * All 257 real ASGS 2021 SA1s inside the eight SA2s above, one polygon
 * per SA1, no invented shape or count standing in for them.
 *
 * ------------------------------------------------------------------ */

interface SA1Area {
  /** Real SA1 code, e.g. "40401109501". */
  id: string;
  /** App suburb id of the parent SA2, or BEVERLEY_ID. */
  parentId: string;
  path: LatLngTuple[];
  centroid: LatLngTuple;
}

const SA1S: SA1Area[] = SA1_BOUNDARIES.map((b) => {
  const parentId = SA2_CODE_TO_SUBURB_ID[b.sa2Code ?? ''];
  if (!parentId) {
    throw new Error(`SA1 ${b.code} has no matching SA2 for code ${b.sa2Code}`);
  }
  const { centroid } = ringBBox(b.ring);
  return {
    id: b.code,
    parentId,
    path: b.ring,
    centroid,
  };
});

/* ------------------------------------------------------------------ *
 * Dwelling and planning data
 *
 * Zoned capacity is residential hectares multiplied by the zoned gross
 * density. It is a ceiling under the current code, not a forecast, and
 * historic take-up has run well below it.
 * ------------------------------------------------------------------ */



/* ------------------------------------------------------------------ *
 * Numeric helpers
 * ------------------------------------------------------------------ */

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}


function lerpHex(lo: string, hi: string, t: number): string {
  const k = clamp(t, 0, 1);
  const [r1, g1, b1] = hexToRgb(lo);
  const [r2, g2, b2] = hexToRgb(hi);
  const r = Math.round(lerp(r1, r2, k));
  const g = Math.round(lerp(g1, g2, k));
  const b = Math.round(lerp(b1, b2, k));
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}





/* ------------------------------------------------------------------ *
 * Icons
 * ------------------------------------------------------------------ */

interface IconProps {
  size?: number;
  className?: string;
}

const svgBase = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

const IconLayers = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" />
    <path d="M3 12.5 12 17l9-4.5" />
    <path d="M3 17 12 21.5 21 17" />
  </svg>
);

const IconPlace = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z" />
    <circle cx="12" cy="10" r="2.4" />
  </svg>
);

const IconAssets = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M5 21V6l7-3 7 3v15" />
    <path d="M5 21h14" />
    <path d="M9 21v-5h6v5" />
    <path d="M9 10h2M13 10h2M9 14h2M13 14h2" />
  </svg>
);

const IconHelp = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.4" />
    <path d="M12 17h.01" />
  </svg>
);

const IconClose = ({ size = 15, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const IconSearch = ({ size = 15, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </svg>
);

const IconChevron = ({ size = 14, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const IconPlus = ({ size = 15, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const IconMinus = ({ size = 15, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M5 12h14" />
  </svg>
);

const IconInfo = ({ size = 15, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <path d="M12 7.6v.1" />
  </svg>
);

const IconHome = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M4 10.5 12 4l8 6.5" />
    <path d="M6 9v10h12V9" />
    <path d="M10 19v-5h4v5" />
  </svg>
);

/** Basemap: a folded map sheet. */
const IconMap = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Z" />
    <path d="M9 4v14M15 6v14" />
  </svg>
);

/** Boundaries: a polygon outline split into areas. */
const IconBounds = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M5 5h14v14H5z" />
    <path d="M5 12h7V5M12 12v7" />
  </svg>
);

/** Focus on the LGA: a frame with the subject inside it. */
const IconFocus = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
    <circle cx="12" cy="12" r="3.2" />
  </svg>
);

const IconHeat = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M10 13.5V5a2 2 0 1 1 4 0v8.5a4 4 0 1 1-4 0Z" />
    <path d="M12 9v6" />
  </svg>
);

const IconFlood = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M12 3.5s5 5.6 5 9.2a5 5 0 0 1-10 0c0-3.6 5-9.2 5-9.2Z" />
    <path d="M3 20c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1" />
  </svg>
);

const IconTransport = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <rect x="6" y="3.5" width="12" height="13" rx="3" />
    <path d="M6 11h12M9.5 14h.01M14.5 14h.01M8.5 20l1.5-3.5M15.5 20 14 16.5" />
  </svg>
);

const IconHazard = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M12 4 21 19.5H3L12 4Z" />
    <path d="M12 10v4.5M12 17v.1" />
  </svg>
);

const IconPeople = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <circle cx="9" cy="8.5" r="3" />
    <path d="M3.5 19c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5" />
    <circle cx="16.5" cy="9.5" r="2.4" />
    <path d="M16 14.2c2.4.2 4 1.8 4.5 4.3" />
  </svg>
);

const IconList = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M9 6.5h11M9 12h11M9 17.5h11" />
    <path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />
  </svg>
);

const IconGauge = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M4 16a8 8 0 1 1 16 0" />
    <path d="M12 16l3.5-5" />
    <path d="M3.5 20h17" />
  </svg>
);

/** Recentre on the LGA. */
const IconThermo = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M10 13.5V5a2 2 0 1 1 4 0v8.5a4 4 0 1 1-4 0Z" />
    <path d="M12 9v7" />
  </svg>
);

const IconHospital = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);

const IconLocate = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <circle cx="12" cy="12" r="6.5" />
    <circle cx="12" cy="12" r="1.8" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
  </svg>
);

/* ------------------------------------------------------------------ *
 * UI atoms
 * ------------------------------------------------------------------ */

/**
 * Hover explainer. The brief from staff was blunt: as much information on
 * rollover as can be fitted, and no conclusions. So Tip carries the
 * definition, the source and the caveat, and stops there.
 */
function Tip({
  label,
  body,
  source,
  children,
  side = 'right',
}: {
  label: string;
  body: string;
  source?: string;
  children: React.ReactNode;
  side?: 'right' | 'left' | 'top';
}) {
  // Hover shows it; a click pins it open until a click elsewhere or Esc.
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hover || pinned;
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const [xy, setXy] = useState<{ x: number; y: number } | null>(null);

  // Rendered into <body> with fixed coordinates, so a scrolling panel or
  // the map's edge can never clip it. Placed on the preferred side, flipped
  // if that side has no room, then clamped inside the window.
  useLayoutEffect(() => {
    if (!open) {
      setXy(null);
      return;
    }
    const t = triggerRef.current?.getBoundingClientRect();
    const tip = tipRef.current?.getBoundingClientRect();
    if (!t || !tip) return;
    const gap = 6;
    const m = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x: number;
    let y: number;
    if (side === 'top') {
      x = t.left;
      y = t.top - tip.height - gap;
      if (y < m) y = t.bottom + gap;
    } else {
      const rightX = t.right + gap;
      const leftX = t.left - tip.width - gap;
      const fitsRight = rightX + tip.width <= vw - m;
      const fitsLeft = leftX >= m;
      x = side === 'left' ? (fitsLeft || !fitsRight ? leftX : rightX) : fitsRight || !fitsLeft ? rightX : leftX;
      y = t.top;
    }
    x = Math.min(Math.max(x, m), vw - tip.width - m);
    y = Math.min(Math.max(y, m), vh - tip.height - m);
    setXy({ x, y });
  }, [open, side]);

  useEffect(() => {
    if (!pinned) return;
    const close = (e: MouseEvent) => {
      if (!triggerRef.current?.contains(e.target as Node)) setPinned(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPinned(false);
    const off = () => setPinned(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('resize', off);
    document.addEventListener('scroll', off, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('resize', off);
      document.removeEventListener('scroll', off, true);
    };
  }, [pinned]);

  return (
    <span
      ref={triggerRef}
      className="inline-flex"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={(e) => {
        // A tip wrapped around a real button (the rail) leaves its clicks alone.
        const ctl = (e.target as HTMLElement).closest('button, a');
        if (ctl && triggerRef.current?.contains(ctl)) return;
        // Don't let the click also toggle the row the (i) sits in.
        e.stopPropagation();
        e.preventDefault();
        setPinned((p) => !p);
      }}
    >
      {children}
      {open &&
        createPortal(
          <span
            ref={tipRef}
            role="tooltip"
            className="fade-up pointer-events-none fixed z-[3000] block w-[260px] max-w-[calc(100vw-16px)] rounded-[3px] border border-[#233634] bg-[#10201F] px-2.5 py-2 text-base leading-[1.45] text-[#D8E4E3] shadow-[0_2px_6px_rgba(0,0,0,0.3)]"
            style={{ left: xy?.x ?? 0, top: xy?.y ?? 0, visibility: xy ? 'visible' : 'hidden' }}
          >
            <span className="mb-1 block text-base font-semibold text-white">{label}</span>
            <span className="block text-[#C2D2D1]">{body}</span>
            {source && (
              <span className="mt-1 block border-t border-[#25403E] pt-1 text-xs text-[#7E9997]">
                Source: {source}
              </span>
            )}
          </span>,
          document.body,
        )}
    </span>
  );
}




/** Collapsible section used by the Layers accordion and the Help guide. */
function Accordion({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-b border-line last:border-b-0">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left transition-colors hover:bg-surface-2"
      >
        <IconChevron
          size={14}
          className={`shrink-0 text-ink-3 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
        />
        <span className="flex-1 text-xl font-semibold tracking-[0.01em] text-ink">
          {title}
        </span>
        {count && <span className="num text-base text-ink-3">{count}</span>}
      </button>
      {open && <div className="pb-1.5">{children}</div>}
    </div>
  );
}

/** Square checkbox in the accent colour. */
/** An on/off switch, for anything that is literally on or off on the map,
 *  so the state reads at a glance from the knob's side and colour rather
 *  than from a small tick. */
function Switch({ on, color = ACCENT }: { on: boolean; color?: string }) {
  return (
    <span
      className="relative inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full transition-colors duration-200"
      style={{ background: on ? color : '#D5DDDC' }}
    >
      <span
        className="absolute h-[14px] w-[14px] rounded-full bg-white shadow-[0_1px_2px_rgba(20,32,31,0.3)] transition-transform duration-200"
        style={{ transform: on ? 'translateX(16px)' : 'translateX(2px)' }}
      />
    </span>
  );
}

/** A small drawing of how a layer looks on the map: a line for line
 *  layers, a dot for point layers, the actual category colours for the
 *  heat and density layers, an outlined fill for flood and water areas. */
const LINE_LAYERS = new Set(['watercourses', 'railways', 'pedestrian-network', 'stormwater-pipes', 'major-roads']);
const POINT_LAYERS = new Set(['train-stations', 'obstetric-hospitals']);
function LayerGlyph({ l }: { l: LayerDef }) {
  const c = l.hi ?? ACCENT;
  let body: React.ReactNode;
  if (l.id === 'heat-vuln') {
    body = [0, 1, 2].map((i) => <rect key={i} x={1 + i * 5.4} y="2" width="5.4" height="8" fill={lerpHex(l.lo!, l.hi!, i / 2)} />);
  } else if (l.id === 'dwelling-density') {
    body = ['Very Low', 'Low', 'Medium'].map((k, i) => (
      <rect key={k} x={1 + i * 5.4} y="2" width="5.4" height="8" fill={DWELLING_DENSITY_COLOR[k]} />
    ));
  } else if (l.id === 'major-roads') {
    body = (
      <>
        <path d="M1.5 6 H16.5" stroke="#fff" strokeWidth="5" />
        <path d="M1.5 6 H16.5" stroke="#111827" strokeWidth="3" />
      </>
    );
  } else if (l.id === 'priority-mix') {
    body = PRIORITY_COLORS.map((c, i) => <rect key={c} x={1 + i * 3.2} y="2" width="3.2" height="8" fill={c} />);
  } else if (l.id === 'stormwater-pipes') {
    body = PIPE_CLASSES.map((c, i) => (
      <path key={c.id} d={`M${1.5 + i * 3.9} 6 H${1.5 + (i + 1) * 3.9}`} stroke={c.color} strokeWidth="2.4" />
    ));
  } else if (l.id === 'railways') {
    body = (
      <>
        <path d="M1.5 6 H16.5" stroke={c} strokeWidth="3" />
        <path d="M1.5 6 H16.5" stroke="#fff" strokeWidth="1" strokeDasharray="2 2.5" />
      </>
    );
  } else if (LINE_LAYERS.has(l.id)) {
    body = (
      <path
        d="M1.5 8.5 C5 2.5, 10 10.5, 16.5 3.5"
        fill="none"
        stroke={c}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={l.id === 'pedestrian-network' ? '0.5 3' : undefined}
      />
    );
  } else if (l.id === 'obstetric-hospitals') {
    body = (
      <>
        <rect x="7.6" y="1.5" width="2.8" height="9" fill={c} />
        <rect x="4.5" y="4.6" width="9" height="2.8" fill={c} />
      </>
    );
  } else if (POINT_LAYERS.has(l.id)) {
    body = <circle cx="9" cy="6" r="3.5" fill={c} />;
  } else {
    body = <rect x="1.5" y="2" width="15" height="8" fill={c} fillOpacity="0.3" stroke={c} strokeWidth="1.2" />;
  }
  return (
    <svg width="18" height="12" viewBox="0 0 18 12" className="shrink-0" aria-hidden>
      {body}
    </svg>
  );
}

/** Segmented control. Used for the Blueprint panel's tab switch. */

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  accent = ACCENT,
  dense,
}: {
  options: { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  accent?: string;
  dense?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-[2px] rounded-[3px] border border-line bg-surface-2 p-[2px]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={`num rounded-[3.5px] ${dense ? 'px-1.5 py-[2px]' : 'px-2 py-[3px]'} text-base font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35`}
            style={
              on
                ? { background: accent, color: '#fff' }
                : { background: 'transparent', color: '#5B6B6A' }
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Small all-caps heading used inside panels. */
/** The one section-heading style, used everywhere a panel needs to say
 *  what a block of content is before showing it. Bumped up from 11.5px
 *  once too many stacked sections started reading as one undifferentiated
 *  block, changing it here fixes hierarchy everywhere it's used at once,
 *  rather than one-off font sizes creeping back in per call site. */
/** Back button plus where you are, for a view opened from a tile. */
function BackBar({ onBack, parent, title }: { onBack: () => void; parent: string; title: string }) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <button
        onClick={onBack}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] border border-line text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
        aria-label={`Back to ${parent}`}
      >
        <IconChevron size={14} className="rotate-180" />
      </button>
      <div className="min-w-0">
        <div className="text-xs text-ink-3">{parent}</div>
        <div className="truncate text-xl font-semibold leading-tight text-ink">{title}</div>
      </div>
    </div>
  );
}

const ASSET_VIEW_TITLE = {
  types: 'Building types',
  list: 'Browse buildings',
  condition: 'Condition',
  about: 'Data sources',
} as const;

function PanelHeading({
  children,
  right,
  color,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
  /** A hazard colour: a solid bar before the heading. */
  color?: string;
}) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <span className="flex items-center gap-2 text-xl font-bold text-ink">
        {color && <span className="h-[14px] w-[3px] shrink-0 rounded-[1px]" style={{ background: color }} />}
        {children}
      </span>
      {right}
    </div>
  );
}


/* ------------------------------------------------------------------ *
 * Map
 *
 * Leaflet is imported inside the effect so the bundle does not pull it in
 * before the shell has painted. The pattern is a full rebuild: one effect
 * tears down every layer it made and rebuilds from current state, plus a
 * separate lightweight effect for hover, which changes far more often and
 * must not trigger a rebuild.
 * ------------------------------------------------------------------ */

interface MapViewProps {
  checkedLayers: Set<string>;
  overlayOpacity: number;
  layerOpacity: Record<string, number>;
  boundsMode: BoundsMode;
  setBoundsMode: (b: BoundsMode) => void;
  selectedId: string | null;
  onSelectSuburb: (id: string) => void;
  hoveredSuburb: string | null;
  setHoveredSuburb: (id: string | null) => void;
  /** Accent for the selected-suburb pill. */
  rightPanelAccent: string;
  showBuildings: boolean;
  buildingOffTypes: Set<string>;
  selectedBuildingKey: string | null;
  onSelectBuildingPoint: (key: string, ids: string[]) => void;
  /** The SA2 to label real buildings for, and which ones: null means
   *  every real building in that SA2, otherwise only these ids. */
  focusSuburbId: string | null;
  focusBuildingIds: string[] | null;
  /** Where a search result asked the map to go. key changes on every
   *  search pick, so choosing the same place twice still moves the map. */
  flyTarget: { lat: number; lng: number; zoom: number; key: number } | null;
  /** Suburbs shaded by a Place index: fill per suburb id, tooltip text,
   *  and the legend's low/high ends. */
  suburbShade: SuburbShade | null;
  /** A point the current view is about (the TQEH use case), ringed. */
  highlight: {
    lat: number;
    lng: number;
    label: string;
    links?: CaseLink[];
    /** Layers drawn only around the site, the edge of that window, and
     *  which of them are switched on. */
    area?: CaseArea;
    show?: Set<CaseLayer>;
  } | null;
  /** Clicking the always-on TQEH marker opens its case study. */
  onOpenCase: () => void;
  /** The flood event scenario shown on the map ('none' = off). */
  floodEvent: FloodEvent;
  setFloodEvent: (e: FloodEvent) => void;
  /** The heat category scenario shown on the map ('none' = off). */
  heatEvent: HeatEvent;
  setHeatEvent: (e: HeatEvent) => void;
  /** Inspect-a-point: when on, a click reads that spot; the last point read. */
  probeMode: boolean;
  setProbeMode: (v: boolean) => void;
  onProbe: (lat: number, lng: number) => void;
  probePoint: { lat: number; lng: number } | null;
  /** Hide the dock's hazard picker (a case study has its own). */
  hideHazards: boolean;
}

interface SuburbShade {
  label: string;
  color: string;
  colors: Record<string, string>;
  text: Record<string, string>;
  lo: string;
  hi: string;
}



function MapView(props: MapViewProps) {
  const {
    checkedLayers,
    overlayOpacity,
    layerOpacity,
    boundsMode,
    setBoundsMode,
    selectedId,
    onSelectSuburb,
    hoveredSuburb,
    setHoveredSuburb,
    rightPanelAccent,
    showBuildings,
    buildingOffTypes,
    selectedBuildingKey,
    onSelectBuildingPoint,
    focusSuburbId,
    focusBuildingIds,
    flyTarget,
    suburbShade,
    highlight,
    onOpenCase,
    floodEvent,
    setFloodEvent,
    heatEvent,
    setHeatEvent,
    probeMode,
    setProbeMode,
    onProbe,
    probePoint,
    hideHazards,
  } = props;
  // Read from inside the map's own click handler, set up once.
  const probeRef = useRef({ probeMode, onProbe });
  probeRef.current = { probeMode, onProbe };

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const LRef = useRef<typeof import('leaflet') | null>(null);
  const builtRef = useRef<LeafletLayer[]>([]);
  const hoverRef = useRef<LeafletLayer[]>([]);
  const [ready, setReady] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(MAP_ZOOM);
  const [basemap, setBasemap] = useState(BASEMAPS[0].id);
  const [dimOutside, setDimOutside] = useState(true);
  const [openControl, setOpenControl] = useState<'basemap' | 'bounds' | 'scenario' | null>(null);
  // The map controls card can fold down to one button when it's in the way.
  const [controlsOpen, setControlsOpen] = useState(true);
  // Which hazard the scenario dock is set to.
  const [dockHazard, setDockHazard] = useState<'flood' | 'heat'>('flood');
  const { sel: scenario, set: setScenario } = React.useContext(ScenarioContext);
  const { w: priorityW } = React.useContext(PriorityContext);
  const { by: roadBy } = React.useContext(RoadColourContext);
  const baseDef = BASEMAP_BY_ID[basemap] ?? BASEMAPS[0];
  const darkBase = !!baseDef.dark;

  const sa1Mode = boundsMode === 'sa1';

  /* -- Map creation. Runs once. ---------------------------------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mod = await import('leaflet');
      // Leaflet ships a UMD bundle. Through Vite's CommonJS interop it arrives
      // as a default export with no named exports, so reach for default first
      // and fall back to the namespace for bundlers that do lift the names.
      const L = ((mod as any).default ?? mod) as typeof import('leaflet');
      if (cancelled || !containerRef.current || mapRef.current) return;
      LRef.current = L;
      const map = L.map(containerRef.current, {
        center: MAP_CENTER,
        zoom: MAP_ZOOM,
        zoomControl: false,
        attributionControl: true,
        preferCanvas: true,
      });
      map.on('zoomend', () => {
        setZoomLevel(map.getZoom());
      });
      map.on('click', (e) => {
        if (probeRef.current.probeMode) probeRef.current.onProbe(e.latlng.lat, e.latlng.lng);
      });
      mapRef.current = map;
      setReady(true);
    })();
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  /* -- Basemap. Swapped on its own so changing it never rebuilds the
     stack of data layers sitting above it. ---------------------- */
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;
    const added: LeafletLayer[] = [];
    const base = L.tileLayer(baseDef.url, {
      maxZoom: baseDef.maxZoom,
      attribution: baseDef.attribution,
    });
    base.addTo(map);
    base.setZIndex(1);
    added.push(base);
    if (baseDef.labels) {
      const labels = L.tileLayer(baseDef.labels, {
        maxZoom: baseDef.maxZoom,
        pane: 'shadowPane',
      });
      labels.addTo(map);
      added.push(labels);
    }
    return () => {
      for (const l of added) {
        if (map.hasLayer(l)) map.removeLayer(l);
      }
    };
  }, [ready, baseDef]);

  /* -- Full rebuild ----------------------------------------------- */
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;

    const added: LeafletLayer[] = [];
    const push = <T extends LeafletLayer>(l: T): T => {
      l.addTo(map);
      added.push(l);
      return l;
    };

    const opacityFor = (id: string) =>
      clamp((layerOpacity[id] ?? 1) * overlayOpacity, 0, 1);

    // A thin overlay line drawn straight onto a saturated hazard or
    // vulnerability fill disappears, especially at high opacity. A pale
    // casing underneath, wider than the line itself, keeps roads, pipes
    // and the like readable against whatever colour is under them,
    // without touching the fill's own opacity or the line's own colour.
    const haloLine = (
      latlngs: LatLngTuple[],
      opts: { color: string; weight: number; opacity: number; dashArray?: string },
    ) => {
      push(
        L.polyline(latlngs, {
          color: darkBase ? '#1B2A28' : '#FFFFFF',
          weight: opts.weight + 2.2,
          opacity: Math.min(1, opts.opacity + 0.35),
        }),
      );
      push(L.polyline(latlngs, opts));
    };

    /* Vector overlays. Each is a schematic rendering of the network, drawn
       from the SA2 geometry so the shape stays honest about its resolution. */
    const vecAlpha = (id: string) => opacityFor(id);

    /* Transport and infrastructure, drawn first so the hazard layers
       below always paint on top of them, never the other way round. */
    if (checkedLayers.has('railways')) {
      const c = LAYER_BY_ID['railways'].hi!;
      for (const line of RAILWAYS) {
        push(L.polyline(line, { color: c, weight: 2.2, opacity: vecAlpha('railways') }));
        push(
          L.polyline(line, {
            color: '#fff',
            weight: 1,
            opacity: vecAlpha('railways'),
            dashArray: '2 5',
          }),
        );
      }
    }

    if (checkedLayers.has('train-stations')) {
      const c = LAYER_BY_ID['train-stations'].hi!;
      for (const [lat, lng] of TRAIN_STATIONS) {
        push(
          L.circleMarker([lat, lng] as LatLngTuple, {
            radius: 4,
            color: '#fff',
            weight: 1.4,
            fillColor: c,
            fillOpacity: vecAlpha('train-stations'),
          }).bindTooltip('Train station', { direction: 'top', offset: [0, -3] }),
        );
      }
    }

    if (checkedLayers.has('major-roads')) {
      const alpha = vecAlpha('major-roads');
      if (roadBy === 'flood') {
        const runs = roadRunsByFlood();
        for (const c of [...PIPE_CLASSES].reverse()) {
          push(L.polyline(runs[c.id], { color: '#fff', weight: 6, opacity: alpha * 0.9, interactive: false }));
          push(L.polyline(runs[c.id], { color: c.color, weight: 3.6, opacity: alpha, interactive: false }));
        }
      } else {
        // Least important first, so the main roads draw on top.
        for (const style of [...ROAD_ROLES].reverse()) {
          for (const r of ROADS.filter((x) => x.role === style.role)) {
            push(L.polyline(r.line, { color: '#fff', weight: style.weight + 2.4, opacity: alpha * 0.9, interactive: false }));
            push(
              L.polyline(r.line, { color: style.color, weight: style.weight, opacity: alpha }).bindTooltip(
                `${roadName(r.name)} · ${roadRoles(r.name).join(', ') || style.label}`,
                { sticky: true, direction: 'top', offset: [0, -4] },
              ),
            );
          }
        }
      }
    }

    if (checkedLayers.has('priority-mix')) {
      const scores = priorityScores(priorityW);
      const alpha = vecAlpha('priority-mix');
      for (const a of SA1S) {
        const sc = scores.get(a.id);
        if (!sc || sc.score === null) continue;
        const missing = sc.missing.length
          ? ` · no ${sc.missing.map((m) => PRIORITY_INPUTS.find((i) => i.id === m)!.label.toLowerCase()).join(' or ')} data`
          : '';
        push(
          L.polygon(a.path, {
            color: '#fff',
            weight: 0.5,
            opacity: alpha * 0.8,
            fillColor: priorityColor(sc.score),
            fillOpacity: alpha * 0.72,
            interactive: true,
          }).bindTooltip(`Priority ${Math.round(sc.score * 100)} of 100${missing}`, { direction: 'top', offset: [0, -3] }),
        );
      }
    }

    if (checkedLayers.has('stormwater-pipes')) {
      const runs = (pipeRunCache ??= pipeRuns());
      for (const c of [...PIPE_CLASSES].reverse()) {
        push(
          L.polyline(runs[c.id], {
            color: c.color,
            weight: c.id === '0' ? 1.1 : 2,
            opacity: vecAlpha('stormwater-pipes') * (c.id === '0' ? 0.75 : 1),
            interactive: false,
          }),
        );
      }
    }

    if (checkedLayers.has('pedestrian-network')) {
      const c = LAYER_BY_ID['pedestrian-network'].hi!;
      for (const seg of pedestrianNetworkData.segments) {
        haloLine(seg.line as LatLngTuple[], { color: c, weight: 2, opacity: vecAlpha('pedestrian-network'), dashArray: '1 3' });
        push(
          L.polyline(seg.line as LatLngTuple[], { opacity: 0, weight: 8 }).bindTooltip(seg.category, {
            direction: 'top',
            offset: [0, -3],
            sticky: true,
          }),
        );
      }
    }

    if (checkedLayers.has('obstetric-hospitals')) {
      const c = LAYER_BY_ID['obstetric-hospitals'].hi!;
      // A plain dot reads as just another point on a map full of them.
      // The standard white-badge-with-a-cross hospital sign reads as
      // "hospital" on sight, which is the point of a critical facility.
      const hospitalIcon = L.divIcon({
        html: `<div style="width:20px;height:20px;background:#fff;border:2px solid ${c};border-radius:4px;box-shadow:0 1px 4px rgba(20,32,31,0.35);display:flex;align-items:center;justify-content:center;">
          <svg width="11" height="11" viewBox="0 0 11 11"><rect x="4.3" y="0" width="2.4" height="11" fill="${c}"/><rect x="0" y="4.3" width="11" height="2.4" fill="${c}"/></svg>
        </div>`,
        className: '',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });
      for (const [lat, lng] of OBSTETRIC_HOSPITALS) {
        push(
          L.marker([lat, lng] as LatLngTuple, {
            icon: hospitalIcon,
            opacity: vecAlpha('obstetric-hospitals'),
          }).bindTooltip('Obstetric hospital (state facility, not council)', { direction: 'top', offset: [0, -10] }),
        );
      }
    }

    if (checkedLayers.has('dwelling-density')) {
      const alpha = vecAlpha('dwelling-density');
      for (const a of SA1S) {
        const entry = (dwellingDensityData.byCode as Record<string, { value: number; category: string }>)[a.id];
        if (!entry) continue;
        push(
          L.polygon(a.path, {
            stroke: false,
            fillColor: DWELLING_DENSITY_COLOR[entry.category] ?? '#9CA3AF',
            fillOpacity: alpha * 0.65,
            interactive: true,
          }).bindTooltip(`${entry.category} (Density 21: ${entry.value})`, { direction: 'top', offset: [0, -3] }),
        );
      }
    }

    /* Hazards. Always drawn last in this effect so they sit visually
       above transport and infrastructure, never underneath them. */
    if (checkedLayers.has('heat-vuln')) {
      const def = LAYER_BY_ID['heat-vuln'];
      const alpha = opacityFor('heat-vuln');
      for (const cell of HEAT_VULNERABILITY) {
        const t = (cell.uhiCat - 2) / 2;
        push(
          L.polygon(cell.rings, {
            stroke: false,
            fillColor: lerpHex(def.lo!, def.hi!, t),
            fillOpacity: alpha * 0.6,
            interactive: true,
          }).bindTooltip(
            `UHI category ${cell.uhiCat} · SVI ${cell.svi.toFixed(2)}`,
            { direction: 'top', offset: [0, -3] },
          ),
        );
      }
    }

    if (checkedLayers.has('watercourses')) {
      const c = LAYER_BY_ID['watercourses'].hi!;
      for (const line of WATERCOURSES) {
        haloLine(line, { color: c, weight: 1.6, opacity: vecAlpha('watercourses') });
      }
    }

    if (checkedLayers.has('waterbodies')) {
      const c = LAYER_BY_ID['waterbodies'].hi!;
      for (const rings of WATERBODIES) {
        push(
          L.polygon(rings, {
            color: c,
            weight: 1,
            fillColor: c,
            fillOpacity: vecAlpha('waterbodies') * 0.55,
            opacity: vecAlpha('waterbodies'),
          }),
        );
      }
    }

    for (const [layerId, catchments] of [
      ['flood-1in5-real', floodContoursData.returnPeriods['1in5']],
      ['flood-1in20-real', floodContoursData.returnPeriods['1in20']],
      ['flood-1in100-real', floodContoursData.returnPeriods['1in100']],
    ] as const) {
      if (!checkedLayers.has(layerId)) continue;
      const c = LAYER_BY_ID[layerId].hi!;
      for (const catchment of catchments) {
        for (const rings of catchment.rings) {
          push(
            L.polygon(rings as LatLngTuple[], {
              color: c,
              weight: 0.6,
              fillColor: c,
              fillOpacity: vecAlpha(layerId) * 0.45,
              opacity: vecAlpha(layerId) * 0.8,
              interactive: false,
            }),
          );
        }
      }
    }








    /* Everything outside the council boundary dimmed, so the LGA reads as
       the subject and the rest of Adelaide as context. A polygon with the
       LGA ring cut out as a hole, drawn over every data layer (flood
       catchments spill past the boundary) but under the outlines. */
    if (dimOutside) {
      const outer: LatLngTuple[] = [
        [-36.5, 136.5],
        [-36.5, 141],
        [-33, 141],
        [-33, 136.5],
      ];
      push(
        L.polygon([outer, LGA_BOUNDARY.ring], {
          stroke: false,
          fillColor: darkBase ? '#0B1211' : '#F6F8F8',
          fillOpacity: darkBase ? 0.6 : 0.72,
          interactive: false,
        }),
      );
    }

    /* Boundary outlines sit above every fill so they stay legible. The
       real council LGA shape (from council's own GIS, not an ABS
       statistical approximation) draws as the bold outer edge; the 8
       SA2 shapes draw lighter, inside it, for the suburb divisions. */
    if (boundsMode === 'sa2') {
      for (const s of SUBURBS) {
        const shade = suburbShade?.colors[s.id];
        push(
          L.polygon(s.path, {
            fill: !!shade,
            fillColor: shade,
            fillOpacity: 0.62,
            color: darkBase ? '#F2F7F6' : '#2B3C3A',
            weight: shade ? 1 : 0.7,
            opacity: darkBase ? 0.55 : shade ? 0.6 : 0.4,
            interactive: true,
          })
            .bindTooltip(suburbShade ? `${s.name}: ${suburbShade.text[s.id] ?? 'n/a'}` : s.name, {
              direction: 'top',
              offset: [0, -3],
            })
            .on('click', () => onSelectSuburb(s.id)),
        );
      }
      push(
        L.polygon(LGA_BOUNDARY.ring, {
          fill: false,
          color: darkBase ? '#F2F7F6' : '#14201F',
          weight: 1.8,
          opacity: darkBase ? 0.9 : 0.8,
          interactive: false,
        }),
      );
    }

    if (sa1Mode) {
      for (const a of SA1S) {
        push(
          L.polygon(a.path, {
            fill: false,
            color: darkBase ? '#F2F7F6' : '#2B3C3A',
            weight: 1.1,
            opacity: darkBase ? 0.75 : 0.65,
            interactive: true,
          })
            .bindTooltip(`SA1 ${a.id}`, { direction: 'top', offset: [0, -3] })
            .on('click', () => onSelectSuburb(a.parentId)),
        );
      }
      push(
        L.polygon(LGA_BOUNDARY.ring, {
          fill: false,
          color: darkBase ? '#F2F7F6' : '#14201F',
          weight: 1.8,
          opacity: darkBase ? 0.9 : 0.8,
          interactive: false,
        }),
      );
    }

    /* Real buildings, on top of everything else, since the point of
       showing them is to read them against whatever hazard fill is
       underneath. Filtered by the same Building Type toggles as Layers,
       Assets, geocoded positions only, no fallback to a fabricated point
       when a building has none.

       Of the 263 that geocoded inside the LGA, only 14 matched an actual
       building or named place, most register addresses are a street
       name with no number. The other 249 matched a road, meaning the
       point sits somewhere along that street, not at the building. A
       fainter dot at the same size would still read as "the building is
       here" on a quick glance, so precise and street-level get visibly
       different marks: a filled dot against a hollow ring.

       A second, separate problem: many buildings share one address text
       verbatim, a whole aged care campus or a scoreboard and its oval
       both filed under one facility name, so they geocode to the exact
       same point. Plotting each as its own dot would stack them
       invisibly, one dot standing in for what might be thirty buildings,
       which reads as sparse and wrong. Grouping by exact coordinate and
       sizing the marker by how many buildings sit there is the honest
       version of the same information. */
    if (showBuildings) {
      const byPoint = new Map<
        string,
        { lat: number; lng: number; precision: 'site' | 'street'; names: string[]; ids: string[] }
      >();
      for (const b of REAL_BUILDINGS) {
        const loc = BUILDING_LOCATION[b.id];
        if (!loc) continue;
        const typeKey = b.buildingType ?? UNCLASSIFIED;
        if (buildingOffTypes.has(typeKey)) continue;
        const key = `${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}`;
        const bucket = byPoint.get(key);
        if (bucket) {
          bucket.names.push(b.name);
          bucket.ids.push(b.id);
        } else {
          byPoint.set(key, { lat: loc.lat, lng: loc.lng, precision: loc.precision, names: [b.name], ids: [b.id] });
        }
      }
      for (const [key, { lat, lng, precision, names, ids }] of byPoint) {
        const siteLevel = precision === 'site';
        const count = names.length;
        // Radius grows with count so a 29-building cluster reads as
        // visibly bigger than a single building, not just a darker dot.
        const radius = (siteLevel ? 5 : 4) + (count > 1 ? Math.min(9, Math.log2(count) * 3) : 0);
        const label =
          count === 1
            ? `${names[0]}${siteLevel ? '' : ' — street-level estimate, not the building'}`
            : `${count} buildings here${siteLevel ? '' : ', street-level estimate'}: ${names.slice(0, 4).join(', ')}${count > 4 ? `, +${count - 4} more` : ''}`;
        const isSelected = key === selectedBuildingKey;
        // A click opens the same real register detail on the right that
        // the Assets tab shows, so a dot is never a dead end, just
        // hovering for a name was the only way to read one before this.
        // The ring underneath, not the dot itself, carries the selected
        // state so the dot's own site/street encoding stays legible.
        if (isSelected) {
          push(
            L.circleMarker([lat, lng] as LatLngTuple, {
              radius: radius + 4,
              color: ACCENT,
              weight: 2,
              fill: false,
              interactive: false,
            }),
          );
        }
        push(
          L.circleMarker([lat, lng] as LatLngTuple, {
            radius,
            color: siteLevel ? '#fff' : ACCENT,
            weight: siteLevel ? 1.2 : 1.6,
            fillColor: siteLevel ? ACCENT : '#fff',
            fillOpacity: siteLevel ? 0.95 : 0.5,
            interactive: true,
          })
            .bindTooltip(label, { direction: 'top', offset: [0, -3] })
            .on('click', () => onSelectBuildingPoint(key, ids)),
        );
      }
    }

    /* Focused SA2: an outline plus a permanent name label for each real
       building in it, on top of everything else. Driven by either Place's
       selected suburb (every one of its real buildings) or a Blueprint's
       "By SA2" drill-down (only the buildings that preset's hazard
       actually touches there), set by the root component. */
    if (focusSuburbId) {
      const s = SUBURB_BY_ID[focusSuburbId];
      if (s) {
        push(
          L.polygon(s.path, {
            fill: false,
            color: ACCENT,
            weight: 2.4,
            opacity: 0.9,
            interactive: false,
          }),
        );
        const inSuburb = REAL_BUILDINGS_BY_SUBURB[focusSuburbId] ?? [];
        const idSet = focusBuildingIds ? new Set(focusBuildingIds) : null;
        const toLabel = idSet ? inSuburb.filter((b) => idSet.has(b.id)) : inSuburb;
        for (const b of toLabel) {
          const loc = BUILDING_LOCATION[b.id];
          if (!loc) continue;
          push(
            L.circleMarker([loc.lat, loc.lng] as LatLngTuple, {
              radius: 5,
              color: '#fff',
              weight: 1.4,
              fillColor: ACCENT,
              fillOpacity: 0.95,
              interactive: false,
            }).bindTooltip(b.name, {
              permanent: true,
              direction: 'top',
              offset: [0, -5],
              className: 'building-label',
            }),
          );
        }
      }
    }

    if (floodEvent !== 'none') {
      const ev = FLOOD_EVENTS.find((x) => x.id === floodEvent)!;
      const view = eventView(floodEvent);
      const fc = LAYER_BY_ID[ev.layer].hi!;
      for (const ring of floodRingsFor(ev.layer)) {
        push(L.polygon(ring.ring, { stroke: false, fillColor: fc, fillOpacity: 0.32, interactive: false }));
      }
      // Muted context first, then what the event reaches.
      push(L.polyline(view.pipes.outside, { color: '#9AA8A7', weight: 0.8, opacity: 0.45, interactive: false }));
      push(L.polyline(view.roads.outside, { color: '#9AA8A7', weight: 2, opacity: 0.7, interactive: false }));
      push(L.polyline(view.pipes.inside, { color: EVENT_COLOR, weight: 1.6, opacity: 0.9, interactive: false }));
      push(L.polyline(view.roads.inside, { color: '#fff', weight: 6, opacity: 0.95, interactive: false }));
      push(L.polyline(view.roads.inside, { color: '#7F1D1D', weight: 3.6, opacity: 1, interactive: false }));
      for (const b of view.buildings) {
        const loc = BUILDING_LOCATION[b.id];
        push(
          L.circleMarker([loc.lat, loc.lng], { radius: 4.5, color: '#fff', weight: 1.3, fillColor: '#7F1D1D', fillOpacity: 1 })
            .bindTooltip(`${b.name} · inside the ${ev.label} extent`, { direction: 'top', offset: [0, -4] }),
        );
      }
    }

    if (heatEvent !== 'none') {
      const def = LAYER_BY_ID['heat-vuln'];
      const view = heatView(heatEvent);
      const fill = lerpHex(def.lo!, def.hi!, (Number(heatEvent) - 2) / 2);
      for (const c of view.cells) {
        push(
          L.polygon(c.rings, { color: '#7F1D1D', weight: 0.4, opacity: 0.5, fillColor: fill, fillOpacity: 0.75 }).bindTooltip(
            `UHI category ${c.uhiCat} · SVI ${c.svi.toFixed(2)}`,
            { direction: 'top', offset: [0, -3] },
          ),
        );
      }
      for (const b of view.buildings) {
        const loc = BUILDING_LOCATION[b.id];
        push(
          L.circleMarker([loc.lat, loc.lng], { radius: 4.5, color: '#fff', weight: 1.3, fillColor: '#7F1D1D', fillOpacity: 1 })
            .bindTooltip(`${b.name} · UHI category ${heatEvent}`, { direction: 'top', offset: [0, -4] }),
        );
      }
    }

    builtRef.current = added;
    return () => {
      for (const l of added) {
        if (map.hasLayer(l)) map.removeLayer(l);
      }
      builtRef.current = [];
    };
  }, [
    ready,
    floodEvent,
    heatEvent,
    priorityW,
    roadBy,
    suburbShade,
    checkedLayers,
    overlayOpacity,
    layerOpacity,
    boundsMode,
    sa1Mode,
    selectedId,
    onSelectSuburb,
    setHoveredSuburb,
    darkBase,
    showBuildings,
    buildingOffTypes,
    selectedBuildingKey,
    onSelectBuildingPoint,
    focusSuburbId,
    focusBuildingIds,
    dimOutside,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !flyTarget) return;
    map.flyTo([flyTarget.lat, flyTarget.lng], flyTarget.zoom, { duration: 0.8 });
  }, [ready, flyTarget]);

  /* -- Highlighted point (TQEH), its own layer so it never rebuilds. -- */
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map || !highlight) return;
    // Case layers get their own panes above the normal overlays: first the
    // fade outside the area, then everything drawn for the case on top.
    for (const [name, z] of [['caseMask', '410'], ['caseContent', '420']] as const) {
      if (!map.getPane(name)) map.createPane(name).style.zIndex = z;
    }
    const added: LeafletLayer[] = [];
    const show = highlight.show ?? new Set<CaseLayer>();
    const area = highlight.area;
    if (area && show.has('focus')) {
      const world: LatLngTuple[] = [
        [-36.5, 136.5],
        [-36.5, 141],
        [-33, 141],
        [-33, 136.5],
      ];
      added.push(
        L.polygon([world, area.ring], {
          stroke: false,
          fillColor: darkBase ? '#0B1211' : '#F6F8F8',
          fillOpacity: darkBase ? 0.72 : 0.82,
          interactive: false,
          pane: 'caseMask',
        }).addTo(map),
      );
    }
    if (area) {
      const heatOn = new Set(
        (Object.entries(HEAT_CASE_KEYS) as [CaseLayer, number][]).filter(([k]) => show.has(k)).map(([, cat]) => cat),
      );
      if (heatOn.size) {
        const def = LAYER_BY_ID['heat-vuln'];
        for (const h of area.heat.filter((x) => heatOn.has(x.cat))) {
          added.push(
            L.polygon(h.ring, {
              stroke: false,
              fillColor: lerpHex(def.lo!, def.hi!, (h.cat - 2) / 2),
              fillOpacity: 0.6,
              interactive: true, pane: 'caseContent' })
              .bindTooltip(`UHI category ${h.cat} · SVI ${h.svi.toFixed(2)}`, { direction: 'top', offset: [0, -3] })
              .addTo(map),
          );
        }
      }
      for (const [key, id] of [
        ['flood100', 'flood-1in100-real'],
        ['flood20', 'flood-1in20-real'],
        ['flood5', 'flood-1in5-real'],
      ] as const) {
        if (!show.has(key)) continue;
        const fc = LAYER_BY_ID[id].hi!;
        for (const r of area.flood[id]) {
          added.push(
            L.polygon(r, { color: fc, weight: 0.6, opacity: 0.7, fillColor: fc, fillOpacity: 0.3, interactive: false, pane: 'caseContent' }).addTo(map),
          );
        }
      }
      if (show.has('roads')) {
        for (const style of [...ROAD_ROLES].reverse()) {
          for (const rd of area.roads.filter((x) => x.role === style.role)) {
            added.push(
              L.polyline(rd.line, { color: '#fff', weight: style.weight + 2.4, opacity: 0.95, interactive: false, pane: 'caseContent' }).addTo(map),
              L.polyline(rd.line, { color: style.color, weight: style.weight, opacity: 1, pane: 'caseContent' })
                .bindTooltip(`${roadName(rd.name)} · ${roadRoles(rd.name).join(', ') || style.label}`, { sticky: true, direction: 'top', offset: [0, -4] })
                .addTo(map),
            );
          }
        }
      }
      if (show.has('pipes')) {
        for (const c of [...PIPE_CLASSES].reverse()) {
          added.push(
            L.polyline(area.pipes[c.id], {
              color: c.color,
              weight: c.id === '0' ? 1.4 : 2.2,
              opacity: 0.95,
              interactive: false, pane: 'caseContent' }).addTo(map),
          );
        }
      }
      if (show.has('buildings')) {
        for (const g of area.buildings) {
          added.push(
            L.circleMarker([g.lat, g.lng], { radius: 5, color: '#fff', weight: 1.4, fillColor: ACCENT, fillOpacity: 1, pane: 'caseContent' })
              .bindTooltip(g.ids.length > 1 ? `${g.names[0]} and ${g.ids.length - 1} more` : g.names[0], {
                direction: 'top',
                offset: [0, -4],
              })
              .on('click', () => onSelectBuildingPoint(`${g.lat.toFixed(6)},${g.lng.toFixed(6)}`, g.ids))
              .addTo(map),
          );
        }
      }
      added.push(
        L.polygon(area.ring, { color: '#4A5A59', weight: 1, dashArray: '3 4', opacity: 0.7, fill: false, interactive: false, pane: 'caseContent' }).addTo(map),
      );
    }
    added.push(
      L.circleMarker([highlight.lat, highlight.lng], {
        radius: 17,
        color: '#14201F',
        weight: 2,
        fill: false,
        interactive: false, pane: 'caseContent' }).addTo(map),
    );
    for (const link of show.has('lines') ? highlight.links ?? [] : []) {
      added.push(
        L.polyline([[highlight.lat, highlight.lng], link.to], {
          color: '#14201F',
          weight: 1.6,
          opacity: 0.8,
          dashArray: '5 4',
          interactive: false, pane: 'caseContent' }).addTo(map),
        L.circleMarker(link.to, { radius: 4, color: '#fff', weight: 1.4, fillColor: '#14201F', fillOpacity: 1, interactive: false, pane: 'caseContent' })
          .bindTooltip(link.label, { permanent: true, direction: 'top', offset: [0, -5], className: 'building-label' })
          .addTo(map),
      );
    }
    return () => {
      for (const l of added) l.remove();
    };
  }, [ready, highlight, darkBase]);

  // Opening a case, or changing its area, fits the map to that area.
  const caseRadius = highlight?.area?.radius;
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map || !highlight?.area) return;
    map.flyToBounds(L.latLngBounds(highlight.area.ring), { padding: [36, 36], duration: 0.8 });
    // Only when the area itself changes, not on every switch toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, caseRadius, highlight?.lat, highlight?.lng]);

  /* -- Crosshair while inspecting. Toggled on the element directly:
     React must never rewrite this container's className, or it strips
     the classes Leaflet put there (including the one that clips it). */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.classList.toggle('probe-mode', probeMode);
  }, [probeMode, ready]);

  /* -- The point being inspected. -------------------------------- */
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map || !probePoint || !probeMode) return;
    const ring = L.circleMarker([probePoint.lat, probePoint.lng], {
      radius: 10,
      color: '#14201F',
      weight: 2,
      fill: false,
      interactive: false,
    }).addTo(map);
    const dot = L.circleMarker([probePoint.lat, probePoint.lng], {
      radius: 3,
      color: '#fff',
      weight: 1,
      fillColor: '#14201F',
      fillOpacity: 1,
      interactive: false,
    }).addTo(map);
    return () => {
      ring.remove();
      dot.remove();
    };
  }, [ready, probePoint, probeMode]);

  /* -- The Queen Elizabeth Hospital, marked at all times. ---------- */
  const onOpenCaseRef = useRef(onOpenCase);
  onOpenCaseRef.current = onOpenCase;
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;
    const icon = L.divIcon({
      html: `<div class="tqeh-pin">
        <span class="tqeh-pin__pulse"></span>
        <span class="tqeh-pin__shadow"></span>
        <span class="tqeh-pin__badge">
          <svg width="13" height="13" viewBox="0 0 12 12"><rect x="4.6" y="0.5" width="2.8" height="11" fill="#C8102E"/><rect x="0.5" y="4.6" width="11" height="2.8" fill="#C8102E"/></svg>
        </span>
      </div>`,
      className: '',
      iconSize: [40, 44],
      // Anchored at the base of the shadow, so the badge stands above the site.
      iconAnchor: [20, 40],
    });
    const grounds = L.polygon(TQEH_SITE, {
      color: '#C8102E',
      weight: 1.5,
      dashArray: '4 3',
      fillColor: '#C8102E',
      fillOpacity: 0.06,
      interactive: false,
    }).addTo(map);
    const marker = L.marker([TQEH.lat, TQEH.lng], { icon, zIndexOffset: 1000, keyboard: true, title: TQEH.label })
      .bindTooltip(TQEH.label, { permanent: true, direction: 'right', offset: [8, -22], className: 'building-label' })
      .on('click', () => onOpenCaseRef.current())
      .addTo(map);
    return () => {
      grounds.remove();
      marker.remove();
    };
  }, [ready]);

  /* -- Hover. Kept separate so it never rebuilds the stack. -------- */
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;
    const added: LeafletLayer[] = [];

    if (hoveredSuburb) {
      const s = SUBURB_BY_ID[hoveredSuburb];
      if (s) {
        added.push(
          L.polygon(s.path, {
            fill: false,
            color: ACCENT,
            weight: 2,
            opacity: 0.9,
            interactive: false,
          }).addTo(map),
        );
      }
    }

    hoverRef.current = added;
    return () => {
      for (const l of added) {
        if (map.hasLayer(l)) map.removeLayer(l);
      }
      hoverRef.current = [];
    };
  }, [ready, hoveredSuburb]);

  const selected = selectedId ? SUBURB_BY_ID[selectedId] : null;
  const hovered = hoveredSuburb ? SUBURB_BY_ID[hoveredSuburb] : null;

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />

      {/* Map controls: one card, each row naming what it changes and its
          current setting, so nothing depends on guessing an icon. Basemap
          and boundaries open a menu beside their row; Focus is a switch. */}
      {!controlsOpen && (
        <button
          data-tour="map-settings"
          onClick={() => setControlsOpen(true)}
          aria-expanded={false}
          className="absolute right-3 top-3 z-[999] flex items-center gap-2 rounded-[4px] bg-white px-2.5 py-1.5 text-sm font-semibold text-ink shadow-[0_1px_2px_rgba(20,32,31,0.22),0_0_0_1px_rgba(20,32,31,0.06)] hover:bg-surface-2"
        >
          <IconMap size={15} className="text-ink-2" />
          Map settings
          {(probeMode || scenario.scenario !== 'today') && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-label="Some settings are on" />}
          <IconChevron size={12} className="rotate-90 text-ink-3" />
        </button>
      )}
      {controlsOpen && (
      <div data-tour="map-settings" className="absolute right-3 top-3 z-[999] w-[214px] rounded-[4px] bg-white p-1 shadow-[0_1px_2px_rgba(20,32,31,0.22),0_0_0_1px_rgba(20,32,31,0.06)]">
        <button
          onClick={() => {
            setControlsOpen(false);
            setOpenControl(null);
          }}
          aria-label="Minimise map settings"
          title="Minimise"
          className="flex w-full items-center justify-between rounded-[3px] px-2 py-1 text-ink-3 hover:bg-surface-2 hover:text-ink"
        >
          <span className="text-xs font-semibold">Map settings</span>
          <IconChevron size={12} className="-rotate-90" />
        </button>
        {(
          [
            {
              id: 'basemap' as const,
              icon: IconMap,
              label: 'Basemap',
              options: BASEMAPS.map((b) => ({ value: b.id, label: b.name })),
              value: basemap as string,
              onChange: (v: string) => setBasemap(v),
            },
            {
              id: 'bounds' as const,
              icon: IconBounds,
              label: 'Boundaries',
              options: [
                { value: 'none', label: 'None' },
                { value: 'sa2', label: 'SA2 suburbs' },
                { value: 'sa1', label: 'SA1 areas' },
              ],
              value: boundsMode as string,
              onChange: (v: string) => setBoundsMode(v as BoundsMode),
            },
            {
              id: 'scenario' as const,
              icon: IconThermo,
              label: 'Scenario',
              options: SCENARIO_OPTIONS.map((o) => ({
                value: o.value,
                label: o.value === 'today' ? o.label : `${o.label} (speculative)`,
              })),
              value: scenarioKey(scenario),
              onChange: (v: string) => setScenario(SCENARIO_OPTIONS.find((o) => o.value === v)?.sel ?? TODAY),
            },
          ]
        ).map((c) => {
          const Icon = c.icon;
          const open = openControl === c.id;
          const current = c.options.find((o) => o.value === c.value)?.label ?? '';
          return (
            <div key={c.id} className="relative">
              <button
                onClick={() => setOpenControl(open ? null : c.id)}
                className={`flex w-full items-center gap-2.5 rounded-[4px] px-2 py-1.5 text-left transition-colors ${open ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
                aria-expanded={open}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] ${open ? 'text-accent' : 'text-ink-2'}`}
                >
                  <Icon size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{c.label}</span>
                  <span className="block truncate text-xs text-ink-3">{current}</span>
                </span>
                <IconChevron size={13} className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-180' : ''}`} />
              </button>
              {open && (
                <div className={`fade-up absolute right-[calc(100%+10px)] top-0 ${c.id === 'scenario' ? 'w-[230px]' : 'w-[170px]'} rounded-[4px] bg-white p-1.5 shadow-[0_2px_6px_rgba(20,32,31,0.22)]`}>
                  <div className="px-1.5 pb-1 pt-0.5 text-2xs font-semibold text-ink-3">
                    {c.label}
                  </div>
                  {c.options.map((o) => {
                    const on = c.value === o.value;
                    return (
                      <button
                        key={o.value}
                        onClick={() => {
                          c.onChange(o.value);
                          setOpenControl(null);
                        }}
                        className={`flex w-full items-center justify-between rounded-[3px] px-2 py-1.5 text-left text-base transition-colors ${on ? 'font-semibold text-accent' : 'text-ink-2 hover:bg-surface-2'}`}
                      >
                        {o.label}
                        {on && <span className="h-[6px] w-[6px] rounded-full bg-accent" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        <button
          onClick={() => setDimOutside((v) => !v)}
          aria-pressed={dimOutside}
          className="flex w-full items-center gap-2.5 rounded-[4px] px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center text-ink-2">
            <IconFocus size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink">Focus on council</span>
            <span className="block text-xs text-ink-3">Dims the area outside it</span>
          </span>
          <Switch on={dimOutside} />
        </button>
        <button
          onClick={() => setProbeMode(!probeMode)}
          aria-pressed={probeMode}
          className="flex w-full items-center gap-2.5 rounded-[4px] px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
        >
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center ${probeMode ? 'text-accent' : 'text-ink-2'}`}>
            <IconLocate size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-ink">Inspect a point</span>
            <span className="block text-xs text-ink-3">{probeMode ? 'Click the map to read it' : 'Read any spot from every layer'}</span>
          </span>
          <Switch on={probeMode} />
        </button>
      </div>
      )}

      {/* Scenario dock: a flood or heat scenario to play out, what it
          reaches, and the speculative climate scenario when one is on. */}
      {/* In a case study the left panel picks the hazards, so only the
          speculative scenario row shows here; with neither, no dock. */}
      {(!hideHazards || scenario.scenario !== 'today') && (
      <div data-tour="flood-dock" className="absolute bottom-4 left-1/2 z-[999] w-[min(540px,calc(100%-500px))] min-w-[320px] -translate-x-1/2">
        <div className="rounded-[4px] bg-white shadow-[0_1px_2px_rgba(20,32,31,0.22),0_0_0_1px_rgba(20,32,31,0.06)]">
          {!hideHazards && (
          <>
          <div className="flex items-center gap-3 px-3 py-2">
            {/* Which hazard to play out. */}
            <div className="flex shrink-0 gap-3 border-r border-line pr-3" role="tablist" aria-label="Hazard">
              {(
                [
                  ['flood', 'Flood'],
                  ['heat', 'Heat'],
                ] as const
              ).map(([id, label]) => {
                const on = dockHazard === id;
                return (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={on}
                    onClick={() => setDockHazard(id)}
                    className={`-mb-px border-b-2 pb-0.5 text-sm transition-colors ${on ? 'font-semibold' : 'border-transparent text-ink-3 hover:text-ink'}`}
                    style={on ? { borderColor: HAZARD_COLOR[id], color: HAZARD_COLOR[id] } : undefined}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-1 gap-1" role="radiogroup" aria-label={dockHazard === 'flood' ? 'Flood event' : 'Heat category'}>
              {(dockHazard === 'flood'
                ? ([{ id: 'none', label: 'Off' }, ...FLOOD_EVENTS] as { id: string; label: string }[])
                : ([{ id: 'none', label: 'Off' }, ...HEAT_EVENTS] as { id: string; label: string }[])
              ).map((o) => {
                const on = dockHazard === 'flood' ? floodEvent === o.id : heatEvent === o.id;
                return (
                  <button
                    key={o.id}
                    role="radio"
                    aria-checked={on}
                    onClick={() => {
                      // One hazard scenario on the map at a time.
                      if (dockHazard === 'flood') {
                        setFloodEvent(o.id as FloodEvent);
                        if (o.id !== 'none') setHeatEvent('none');
                      } else {
                        setHeatEvent(o.id as HeatEvent);
                        if (o.id !== 'none') setFloodEvent('none');
                      }
                    }}
                    className={`num flex-1 whitespace-nowrap rounded-[3px] border px-1.5 py-1 text-sm transition-colors ${on ? 'font-semibold text-white' : 'border-line text-ink-2 hover:border-ink-3'}`}
                    style={on ? (o.id === 'none' ? { background: '#14201F', borderColor: '#14201F' } : { background: HAZARD_COLOR[dockHazard], borderColor: HAZARD_COLOR[dockHazard] }) : undefined}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
          {(() => {
            let cells: [string, string, string][] | null = null;
            let note = '';
            if (floodEvent !== 'none') {
              const v = eventView(floodEvent);
              cells = [
                ['Buildings', String(v.buildings.length), formatMoney(v.insured)],
                ['Major roads', `${v.roadKm.toFixed(1)} km`, 'inside'],
                ['Pipes', `${Math.round(v.pipeKm)} km`, 'inside'],
                ['Council area', pct(v.areaShare), 'covered'],
              ];
              note = `Flood ${FLOOD_EVENTS.find((x) => x.id === floodEvent)!.label}. ${EVENT_COVERAGE[floodEvent]}`;
            } else if (heatEvent !== 'none') {
              const v = heatView(heatEvent);
              cells = [
                ['Buildings', String(v.buildings.length), formatMoney(v.insured)],
                ['Area', `${v.areaKm2.toFixed(2)} km²`, `${v.cells.length} cells`],
                ['Average SVI', v.sviAvg.toFixed(2), 'of these cells'],
                ['Of heat grid', pct(v.gridKm2 ? v.areaKm2 / v.gridKm2 : 0), 'by area'],
              ];
              note = `UHI category ${heatEvent}. The heat grid covers about ${v.gridKm2.toFixed(1)} km² of the council's ${LGA_BOUNDARY.areaSqKm.toFixed(0)} km², so areas outside it read as no data, not as cool.`;
            }
            if (!cells) return null;
            return (
              <>
                <div className="grid grid-cols-4 divide-x divide-line border-t border-line">
                  {cells.map(([k, val, sub]) => (
                    <div key={k} className="px-3 py-1.5">
                      <div className="text-xs text-ink-3">{k}</div>
                      <div className="num text-lg font-semibold leading-tight text-ink">{val}</div>
                      <div className="num text-xs text-ink-3">{sub}</div>
                    </div>
                  ))}
                </div>
                <div className="border-t border-line px-3 py-1 text-xs leading-[1.45] text-ink-3">{note}</div>
              </>
            );
          })()}
          </>
          )}
          {scenario.scenario !== 'today' && (
            <div className="border-t border-line px-3 py-2" style={{ boxShadow: 'inset 4px 0 0 #B45309' }}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-[#92400E]">Speculative scenario · {scenarioName(scenario)}</span>
                <button onClick={() => setScenario(TODAY)} className="text-sm font-medium text-[#92400E] underline hover:text-[#78350F]">
                  Back to today
                </button>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5">
                {SPECULATIVE_OUTLOOK[scenario.scenario][scenario.year].map(([k, v]) => (
                  <span key={k} className="text-sm text-[#92400E]">
                    {k} <span className="num font-semibold text-[#78350F]">{v}</span>
                  </span>
                ))}
              </div>
              <div className="mt-0.5 text-xs text-[#92400E]">{SCENARIO_NOTE[scenario.scenario]} Placeholder figures, not modelled projections.</div>
            </div>
          )}
        </div>
      </div>
      )}

      {selected && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-[999] -translate-x-1/2">
          <div
            className="fade-up flex items-center gap-1.5 rounded-[4px] border bg-white px-2.5 py-1 shadow-[0_1px_2px_rgba(20,32,31,0.22),0_0_0_1px_rgba(20,32,31,0.06)]"
            style={{ borderColor: rightPanelAccent }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: rightPanelAccent }} />
            <span className="text-xl font-semibold text-ink">{selected.name}</span>
            <span className="num text-base text-ink-3">{selected.sa2}</span>
          </div>
        </div>
      )}

      {hovered && (
        <div className="pointer-events-none absolute left-3 top-3 z-[999] w-[240px]">
          <div className="fade-up rounded-[3px] border border-line bg-white/96 p-2 shadow-[0_1px_2px_rgba(20,32,31,0.22),0_0_0_1px_rgba(20,32,31,0.06)] backdrop-blur">
            <div className="flex items-baseline justify-between">
              <span className="text-xl font-semibold text-ink">{hovered.name}</span>
              <span className="num text-sm text-ink-3">{hovered.sa2}</span>
            </div>
          </div>
        </div>
      )}

      {/* Bottom-left column: the locator (when zoomed in) above the legend. */}
      <div className="pointer-events-none absolute bottom-4 left-3 z-[999] flex flex-col items-start gap-2 [&>*]:pointer-events-auto">
        {ready && LRef.current && mapRef.current && (
          <LocatorMap L={LRef.current} main={mapRef.current} selectedId={selectedId} />
        )}
        <MapLegend
          checkedLayers={checkedLayers}
          showBuildings={showBuildings}
          shade={suburbShade}
          caseShow={highlight?.area ? highlight.show : undefined}
          caseRadius={highlight?.area?.radius}
          floodEvent={floodEvent}
          heatEvent={heatEvent}
        />
      </div>

      <div className="absolute bottom-4 right-3 z-[999] flex flex-col items-center gap-2">
        <button
          onClick={() => {
            const L = LRef.current;
            if (L) mapRef.current?.flyToBounds(L.latLngBounds(LGA_BOUNDARY.ring), { padding: [24, 24], duration: 0.8 });
          }}
          className="flex h-9 w-9 items-center justify-center rounded-[4px] bg-white text-ink-2 shadow-[0_1px_2px_rgba(20,32,31,0.22),0_0_0_1px_rgba(20,32,31,0.06)] transition-colors hover:text-accent"
          aria-label="Back to the whole council area"
          title="Back to the whole council area"
        >
          <IconLocate size={18} />
        </button>
        <div className="flex w-9 flex-col items-center rounded-[4px] bg-white py-1 shadow-[0_1px_2px_rgba(20,32,31,0.22),0_0_0_1px_rgba(20,32,31,0.06)]">
          <button
            onClick={() => mapRef.current?.zoomIn()}
            className="flex h-7 w-7 items-center justify-center rounded-[3px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-accent"
            aria-label="Zoom in"
          >
            <IconPlus size={16} />
          </button>
          {/* Where the current zoom sits between fully out and fully in. */}
          <div className="relative my-1 h-[52px] w-[3px] rounded-full bg-line">
            <span
              className="absolute left-1/2 h-[9px] w-[9px] -translate-x-1/2 translate-y-1/2 rounded-full border-2 border-white bg-accent shadow-[0_0_0_1px_rgba(0,110,120,0.35)] transition-all duration-200"
              style={{ bottom: `${(Math.min(Math.max(zoomLevel - 10, 0), 9) / 9) * 100}%` }}
            />
          </div>
          <button
            onClick={() => mapRef.current?.zoomOut()}
            className="flex h-7 w-7 items-center justify-center rounded-[3px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-accent"
            aria-label="Zoom out"
          >
            <IconMinus size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ *
 * Map legend
 *
 * One entry per layer on the map, drawn the way the map draws it: the
 * category colours for heat and dwelling density, a line or area or dot
 * for everything else, plus the two building marker styles.
 * ------------------------------------------------------------------ */

function LegendScale({ items }: { items: { label: string; color: string; opacity?: number }[] }) {
  return (
    <div className="mt-1.5 space-y-1">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-2">
          <span
            className="h-[10px] w-[18px] shrink-0"
            style={{ background: it.color, opacity: it.opacity ?? 1, boxShadow: 'inset 0 0 0 1px rgba(20,32,31,0.08)' }}
          />
          <span className="text-sm text-ink-2">{it.label}</span>
        </div>
      ))}
    </div>
  );
}

function MapLegend({
  checkedLayers,
  showBuildings,
  shade,
  caseShow,
  caseRadius,
  floodEvent = 'none',
  heatEvent = 'none',
}: {
  checkedLayers: Set<string>;
  showBuildings: boolean;
  shade: SuburbShade | null;
  caseShow?: Set<CaseLayer>;
  caseRadius?: number;
  floodEvent?: FloodEvent;
  heatEvent?: HeatEvent;
}) {
  const [open, setOpen] = useState(true);
  const layers = LAYERS.filter((l) => checkedLayers.has(l.id));
  return (
    <div className="w-[208px] overflow-hidden rounded-[4px] border border-line bg-white shadow-[0_1px_2px_rgba(20,32,31,0.22),0_0_0_1px_rgba(20,32,31,0.06)]">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-3 py-2 text-base font-semibold text-ink"
      >
        Legend
        <IconChevron size={12} className={`text-ink-3 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="thin-scroll max-h-[280px] space-y-3 overflow-y-auto border-t border-line px-3 py-2.5">
          {heatEvent !== 'none' && (
            <div className="space-y-1">
              <div className="text-sm font-medium text-ink">Heat, UHI category {heatEvent}</div>
              <div className="flex items-center gap-2">
                <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden>
                  <rect
                    x="1.5"
                    y="2"
                    width="15"
                    height="8"
                    fill={lerpHex(LAYER_BY_ID['heat-vuln'].lo!, LAYER_BY_ID['heat-vuln'].hi!, (Number(heatEvent) - 2) / 2)}
                    stroke="#7F1D1D"
                    strokeWidth="0.6"
                  />
                </svg>
                <span className="text-sm text-ink-2">UHI category {heatEvent} cell</span>
              </div>
              <div className="flex items-center gap-2">
                <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden>
                  <circle cx="9" cy="6" r="4" fill="#7F1D1D" stroke="#fff" strokeWidth="1.2" />
                </svg>
                <span className="text-sm text-ink-2">Council building in one</span>
              </div>
            </div>
          )}
          {floodEvent !== 'none' &&
            (() => {
              const ev = FLOOD_EVENTS.find((x) => x.id === floodEvent)!;
              return (
                <div className="space-y-1">
                  <div className="text-sm font-medium text-ink">Flood event, {ev.label} (long-term)</div>
                  {(
                    [
                      ['area', LAYER_BY_ID[ev.layer].hi!, 'Extent'],
                      ['road', '#7F1D1D', 'Major road inside'],
                      ['pipe', EVENT_COLOR, 'Pipe inside'],
                      ['dot', '#7F1D1D', 'Council building inside'],
                      ['muted', '#9AA8A7', 'Roads and pipes outside'],
                    ] as const
                  ).map(([kind, c, label]) => (
                    <div key={label} className="flex items-center gap-2">
                      <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden>
                        {kind === 'area' ? (
                          <rect x="1.5" y="2" width="15" height="8" fill={c} fillOpacity="0.35" />
                        ) : kind === 'dot' ? (
                          <circle cx="9" cy="6" r="4" fill={c} stroke="#fff" strokeWidth="1.2" />
                        ) : (
                          <path d="M1.5 6 H16.5" stroke={c} strokeWidth={kind === 'road' ? 3.4 : 1.8} />
                        )}
                      </svg>
                      <span className="text-sm text-ink-2">{label}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          {caseShow && (
            <div className="space-y-1">
              <div className="text-sm font-medium text-ink">Case study: The Queen Elizabeth Hospital</div>
              {CASE_LAYER_DEFS.filter((d) => caseShow.has(d.id)).map((d) => (
                <div key={d.id} className="flex items-center gap-2">
                  <CaseGlyph id={d.id} />
                  <span className="text-sm text-ink-2">{d.label}</span>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden>
                  <path d="M1.5 6 H16.5" stroke="#4A5A59" strokeWidth="1.2" strokeDasharray="3 3" />
                </svg>
                <span className="text-sm text-ink-2">Area shown, {caseRadius} m around</span>
              </div>
            </div>
          )}
          {shade && (
            <div>
              <div className="text-sm font-medium text-ink">Suburbs: {shade.label}</div>
              <div
                className="mt-1.5 h-[8px] w-full"
                style={{ background: `linear-gradient(90deg, #EEF2F2, ${shade.color})`, opacity: 0.85 }}
              />
              <div className="num mt-0.5 flex justify-between text-sm text-ink-3">
                <span>{shade.lo}</span>
                <span>{shade.hi}</span>
              </div>
            </div>
          )}
          {layers.map((l) => {
            if (l.id === 'heat-vuln') {
              return (
                <div key={l.id}>
                  <div className="text-sm font-medium text-ink">Urban heat (UHI category)</div>
                  <LegendScale
                    items={[4, 3, 2].map((c) => ({
                      label: `Category ${c}${c === 4 ? ', hottest' : c === 2 ? ', coolest' : ''}`,
                      color: lerpHex(l.lo!, l.hi!, (c - 2) / 2),
                      opacity: 0.75,
                    }))}
                  />
                </div>
              );
            }
            if (l.id === 'major-roads') {
              return <RoadLegend key={l.id} />;
            }
            if (l.id === 'priority-mix') {
              return (
                <div key={l.id}>
                  <div className="text-sm font-medium text-ink">Priority mix, your weights</div>
                  <div className="mt-1.5 flex h-[8px] w-full overflow-hidden">
                    {PRIORITY_COLORS.map((c) => (
                      <span key={c} className="flex-1" style={{ background: c, opacity: 0.85 }} />
                    ))}
                  </div>
                  <div className="mt-0.5 flex justify-between text-sm text-ink-3">
                    <span>Lower</span>
                    <span>Higher</span>
                  </div>
                </div>
              );
            }
            if (l.id === 'stormwater-pipes') {
              return (
                <div key={l.id}>
                  <div className="text-sm font-medium text-ink">Stormwater pipes, by flood</div>
                  <LegendScale items={PIPE_CLASSES.map((c) => ({ label: c.label, color: c.color }))} />
                </div>
              );
            }
            if (l.id === 'dwelling-density') {
              return (
                <div key={l.id}>
                  <div className="text-sm font-medium text-ink">{l.name}</div>
                  <LegendScale
                    items={Object.entries(DWELLING_DENSITY_COLOR)
                      .reverse()
                      .map(([label, color]) => ({ label, color, opacity: 0.8 }))}
                  />
                </div>
              );
            }
            return (
              <div key={l.id} className="flex items-center gap-2">
                <LayerGlyph l={l} />
                <span className="text-sm text-ink">{l.name}</span>
              </div>
            );
          })}
          <div className="flex items-center gap-2">
            <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden>
              <rect x="3" y="1" width="12" height="12" rx="3" fill="#fff" stroke="#C8102E" strokeWidth="1.6" />
              <rect x="7.9" y="3.5" width="2.2" height="7" fill="#C8102E" />
              <rect x="5.5" y="5.9" width="7" height="2.2" fill="#C8102E" />
            </svg>
            <span className="text-sm text-ink">The Queen Elizabeth Hospital</span>
          </div>
          {showBuildings && (
            <div>
              <div className="text-sm font-medium text-ink">Council buildings</div>
              <div className="mt-1.5 space-y-1">
                <div className="flex items-center gap-2">
                  <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden>
                    <circle cx="9" cy="6" r="4.5" fill={ACCENT} stroke="#fff" strokeWidth="1.2" />
                  </svg>
                  <span className="text-sm text-ink-2">At the building</span>
                </div>
                <div className="flex items-center gap-2">
                  <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden>
                    <circle cx="9" cy="6" r="4" fill="#fff" fillOpacity="0.5" stroke={ACCENT} strokeWidth="1.6" />
                  </svg>
                  <span className="text-sm text-ink-2">Street-level position</span>
                </div>
                <div className="flex items-center gap-2">
                  <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden>
                    <circle cx="9" cy="6" r="5.5" fill={ACCENT} stroke="#fff" strokeWidth="1.2" />
                  </svg>
                  <span className="text-sm text-ink-2">Larger: several at one point</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RoadLegend() {
  const { by } = React.useContext(RoadColourContext);
  return (
    <div>
      <div className="text-sm font-medium text-ink">Major roads{by === 'flood' ? ', by flood' : ''}</div>
      {by === 'flood' ? (
        <LegendScale items={PIPE_CLASSES.map((c) => ({ label: c.label, color: c.color }))} />
      ) : (
        <div className="mt-1.5 space-y-1">
          {ROAD_ROLES.map((r) => (
            <div key={r.role} className="flex items-center gap-2">
              <svg width="18" height="10" viewBox="0 0 18 10" aria-hidden>
                <path d="M1 5 H17" stroke={r.color} strokeWidth={Math.min(r.weight, 4)} />
              </svg>
              <span className="text-sm text-ink-2">{r.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Locator map
 *
 * A small fixed map of the whole council area in the corner, with a box
 * showing what the main map is looking at, so a zoomed-in view always
 * says where in the LGA it is. Clicking it moves the main map there.
 * ------------------------------------------------------------------ */

function LocatorMap({
  L,
  main,
  selectedId,
}: {
  L: typeof import('leaflet');
  main: LeafletMap;
  selectedId: string | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const miniRef = useRef<LeafletMap | null>(null);
  const selRef = useRef<LeafletLayer | null>(null);
  // Only shown once the whole council area is no longer in view.
  const lgaBounds = useMemo(() => L.latLngBounds(LGA_BOUNDARY.ring), [L]);
  const [open, setOpen] = useState(() => !main.getBounds().contains(lgaBounds));
  useEffect(() => {
    const check = () => setOpen(!main.getBounds().contains(lgaBounds));
    main.on('moveend zoomend resize', check);
    return () => {
      main.off('moveend zoomend resize', check);
    };
  }, [main, lgaBounds]);

  useEffect(() => {
    if (!open || !ref.current) return;
    const mini = L.map(ref.current, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
    });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', { subdomains: 'abcd' }).addTo(mini);
    for (const s of SUBURBS) {
      L.polygon(s.path, { color: '#9AA8A7', weight: 0.6, fill: false, interactive: false }).addTo(mini);
    }
    L.polygon(LGA_BOUNDARY.ring, { color: ACCENT, weight: 1.4, fillColor: ACCENT, fillOpacity: 0.05, interactive: false }).addTo(mini);
    mini.fitBounds(lgaBounds, { padding: [6, 6] });
    const box = L.rectangle(main.getBounds(), {
      color: '#14201F',
      weight: 1.5,
      fillColor: '#14201F',
      fillOpacity: 0.08,
      interactive: false,
    }).addTo(mini);
    const sync = () => box.setBounds(main.getBounds());
    main.on('move zoom resize', sync);
    mini.on('click', (e) => main.panTo(e.latlng));
    miniRef.current = mini;
    return () => {
      main.off('move zoom resize', sync);
      mini.remove();
      miniRef.current = null;
      selRef.current = null;
    };
  }, [open, L, main, lgaBounds]);

  // The suburb open in Place, shaded so it's findable at a glance.
  useEffect(() => {
    const mini = miniRef.current;
    if (!mini) return;
    selRef.current?.remove();
    selRef.current = null;
    const s = selectedId ? SUBURB_BY_ID[selectedId] : null;
    if (s) {
      selRef.current = L.polygon(s.path, { stroke: false, fillColor: ACCENT, fillOpacity: 0.3, interactive: false }).addTo(mini);
    }
  }, [selectedId, open, L]);

  // The locator's tiles are CARTO's, credited alongside the main basemap.
  useEffect(() => {
    const credit = 'Locator: &copy; CARTO, OpenStreetMap';
    main.attributionControl?.addAttribution(credit);
    return () => {
      main.attributionControl?.removeAttribution(credit);
    };
  }, [main]);

  if (!open) return null;
  return (
    <div className="fade-in overflow-hidden rounded-[4px] border border-line bg-white shadow-[0_1px_2px_rgba(20,32,31,0.22),0_0_0_1px_rgba(20,32,31,0.06)]">
      <div ref={ref} className="h-[150px] w-[188px] cursor-pointer" title="Click to move the map here" />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tab 1. Layers
 * ------------------------------------------------------------------ */

interface LayersTabProps {
  checkedLayers: Set<string>;
  toggleLayer: (id: string) => void;
  overlayOpacity: number;
  setOverlayOpacity: (v: number) => void;
  layerOpacity: Record<string, number>;
  setLayerOpacity: (id: string, v: number) => void;
  clearAllLayers: () => void;
  activeBlueprint: BlueprintId | null;
  applyBlueprint: (id: BlueprintId) => void;
}

function LayersTab({
  checkedLayers,
  toggleLayer,
  overlayOpacity,
  setOverlayOpacity,
  layerOpacity,
  setLayerOpacity,
  clearAllLayers,
  activeBlueprint,
  applyBlueprint,
}: LayersTabProps) {
  const visibleLayers = LAYERS.filter((l) => WORKSHOP_LAYER_IDS.has(l.id));

  // Ordered by how often a council user needs it: the hazard itself,
  // then the supporting network and policy layers behind it. No group
  // is a generic 'overlays' catch-all, each one names the actual
  // category it holds. Asset/building-type toggles moved to Place, next
  // to the register they actually control, once this tab was scoped
  // down to the 8 workshop layers. One sub-tab visible at a time, not
  // several accordions stacked, so picking a category costs a tap, not
  // a scroll past the others.
  type LayersSection = LayerGroup;
  // null is the top level (the category grid). Picking a category drills
  // in to its layer list, a real step down, not a second heading stacked
  // under the first at the same weight. withViewTransition gives the
  // step an actual crossfade, the same pattern Assets' own drill-downs
  // already use, rather than two sections just appearing at once.
  const [activeTab, setActiveTab] = useState<LayersSection | null>(null);
  const [displayOpen, setDisplayOpen] = useState(false);
  const CATEGORY_ICON: Record<LayerGroup, (p: IconProps) => React.ReactElement> = {
    hazard: IconHazard,
    vulnerability: IconPeople,
    transport: IconTransport,
    infrastructure: IconAssets,
    planning: IconBounds,
  };
  const selectTab = (v: LayersSection | null) => withViewTransition(() => setActiveTab(v));

  const allCategories: { value: LayersSection; label: string; color: string; on: number; total: number }[] = [
    {
      value: 'hazard',
      label: GROUP_LABEL.hazard,
      color: '#DC2626',
      on: visibleLayers.filter((l) => l.group === 'hazard' && checkedLayers.has(l.id)).length,
      total: visibleLayers.filter((l) => l.group === 'hazard').length,
    },
    {
      value: 'vulnerability',
      label: GROUP_LABEL.vulnerability,
      color: '#7C3AED',
      on: visibleLayers.filter((l) => l.group === 'vulnerability' && checkedLayers.has(l.id)).length,
      total: visibleLayers.filter((l) => l.group === 'vulnerability').length,
    },
    {
      value: 'transport',
      label: GROUP_LABEL.transport,
      color: '#0891B2',
      on: visibleLayers.filter((l) => l.group === 'transport' && checkedLayers.has(l.id)).length,
      total: visibleLayers.filter((l) => l.group === 'transport').length,
    },
    {
      value: 'infrastructure',
      label: GROUP_LABEL.infrastructure,
      color: '#2563EB',
      on: visibleLayers.filter((l) => l.group === 'infrastructure' && checkedLayers.has(l.id)).length,
      total: visibleLayers.filter((l) => l.group === 'infrastructure').length,
    },
    // Development Zones has no real layer yet, council hasn't supplied the
    // export. Kept visible with a held place rather than disappearing, so
    // staff who were told "planning layers are coming" can see it's a
    // known, waiting slot, not something forgotten.
    {
      value: 'planning',
      label: GROUP_LABEL.planning,
      color: '#059669',
      on: 0,
      total: 1,
    },
  ];
  const categories = allCategories.filter((c) => c.total > 0);

  const renderLayerList = (g: LayerGroup) => {
    // A heading here, not just the category card above, so which group
    // is showing stays clear once you've scrolled past the card grid.
    const heading = (
      <div className="px-3 pt-2">
        <PanelHeading>{GROUP_LABEL[g]}</PanelHeading>
      </div>
    );
    if (g === 'planning') {
      return (
        <div className="pb-1.5">
          {heading}
          <div className="mx-3 overflow-hidden rounded-[4px] border border-dashed border-line">
            <div className="flex items-center gap-2.5 px-3 py-2.5">
              <span className="h-[12px] w-[12px] shrink-0 rounded-[3px] bg-[#A7D9C2] opacity-60" />
              <span className="flex-1 truncate text-lg text-ink-3">Development Zones</span>
              <span className="text-xs text-ink-3">Not supplied yet</span>
            </div>
          </div>
        </div>
      );
    }
    const layers = visibleLayers.filter((l) => l.group === g);
    return (
      <div className="pb-1.5">
        {heading}
        <div className="mx-3 divide-y divide-line overflow-hidden rounded-[4px] border border-line">
        {layers.map((l) => {
          const checked = checkedLayers.has(l.id);
          const op = layerOpacity[l.id] ?? 1;
          return (
            <div
              key={l.id}
              className="bg-white px-3 py-2.5"
            >
              <div className="flex items-center gap-2.5">
                <button
                  onClick={() => toggleLayer(l.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  aria-pressed={checked}
                >
                  <LayerGlyph l={l} />
                  <span className={`flex-1 truncate text-lg ${checked ? 'font-medium text-ink' : 'text-ink-2'}`}>
                    {l.name}
                  </span>
                </button>
                <Tip label={l.name} body={l.note} source={l.source} side="left">
                  <span className="flex h-[18px] w-[18px] cursor-help items-center justify-center text-ink-3 transition-colors hover:text-ink">
                    <IconInfo size={14} />
                  </span>
                </Tip>
                <button
                  onClick={() => toggleLayer(l.id)}
                  aria-label={`${checked ? 'Turn off' : 'Turn on'} ${l.name}`}
                >
                  <Switch on={checked} />
                </button>
              </div>
              {checked && (
                <div className="fade-up mt-2 flex items-center gap-2.5 pl-[24px]">
                  <span className="text-xs text-ink-3">Opacity</span>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={Math.round(op * 100)}
                    onChange={(e) => setLayerOpacity(l.id, Number(e.target.value) / 100)}
                    className="h-3 flex-1"
                  />
                  <span className="num w-[32px] text-right text-xs text-ink-3">{Math.round(op * 100)}%</span>
                </div>
              )}
            </div>
          );
        })}
        </div>
      </div>
    );
  };

  return (
    <div className="flex min-h-full flex-col">
      {/* Two sections, one divider between them. Inside each, hierarchy
          comes from structure rather than lines: Blueprints are rows you
          apply, categories are tiles you open, and an open category shows
          its layers as a tray of switch rows. */}

      <div className="pt-4">
        <div className="px-3">
          <PanelHeading>Blueprints</PanelHeading>
        </div>
        <div className="space-y-0.5 px-1.5">
          {BLUEPRINTS.map((b) => {
            const on = activeBlueprint === b.id;
            const Icon = b.id === 'heat' ? IconHeat : b.id === 'flood' ? IconFlood : IconTransport;
            return (
              <button
                key={b.id}
                onClick={() => applyBlueprint(b.id)}
                aria-pressed={on}
                className="group flex w-full items-center gap-3 rounded-[4px] px-1.5 py-2 text-left transition-colors hover:bg-surface-2"
                style={on ? { boxShadow: `inset 3px 0 0 ${b.accent}` } : undefined}
              >
                <span className="shrink-0" style={{ color: b.accent }}>
                  <Icon size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-lg ${on ? 'font-semibold text-ink' : 'font-medium text-ink'}`}>
                    {b.title}
                  </span>
                  <span className="num block text-xs text-ink-3">{b.layers.length} layers</span>
                </span>
                <span
                  className={`shrink-0 text-sm font-semibold ${on ? '' : 'text-ink-3 group-hover:text-ink'}`}
                  style={on ? { color: b.accent } : undefined}
                >
                  {on ? 'Applied' : 'Apply'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* The one divider: between "pick a ready-made set" and "build your own". */}
      <div className="mx-3 mt-3 border-t border-line" />

      <div className="flex-1 pb-4 pt-4" style={{ viewTransitionName: 'layers-category-step' } as React.CSSProperties}>
        {activeTab === null ? (
          <>
            <div className="px-3">
              <PanelHeading>Browse layers</PanelHeading>
            </div>
            <div className="grid grid-cols-2 gap-2 px-3">
              {categories.map((c) => {
                const Icon = CATEGORY_ICON[c.value];
                const pending = c.value === 'planning';
                return (
                  <button
                    key={c.value}
                    onClick={() => selectTab(c.value)}
                    className={`group flex flex-col rounded-[4px] border bg-white p-2.5 text-left transition-all hover:border-ink-3 ${pending ? 'border-dashed border-line' : 'border-line'}`}
                    style={c.on > 0 ? { borderColor: c.color } : undefined}
                  >
                    <span className="flex items-start justify-between">
                      <span
                        className="flex h-6 items-center"
                        style={{ color: c.color }}
                      >
                        <Icon size={17} />
                      </span>
                      {c.on > 0 && (
                        <span
                          className="num rounded-[3px] px-1.5 py-[1px] text-2xs font-semibold text-white"
                          style={{ background: c.color }}
                        >
                          {c.on} on
                        </span>
                      )}
                    </span>
                    <span className="mt-2.5 text-base font-semibold leading-tight text-ink">{c.label}</span>
                    <span className="num mt-1 text-xs text-ink-3">
                      {pending ? 'Not supplied yet' : `${c.total} layer${c.total === 1 ? '' : 's'}`}
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div>
            <div className="mb-2.5 flex items-center gap-2 px-3">
              <button
                onClick={() => selectTab(null)}
                className="flex h-7 w-7 items-center justify-center rounded-[4px] border border-line text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
                aria-label="Back to all layer categories"
              >
                <IconChevron size={14} className="rotate-180" />
              </button>
              <span className="text-sm text-ink-3">Browse layers</span>
            </div>
            {renderLayerList(activeTab)}
          </div>
        )}
      </div>

      {/* What's on and how strongly it shows, together, docked at the
          bottom: one summary line that opens to the controls for every
          layer at once, so neither reads as a stray setting. */}
      <div className="sticky bottom-0 border-t border-line bg-white">
        {displayOpen && (
          <div className="fade-up space-y-3 border-b border-line px-3 py-3">
            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm font-medium text-ink">Opacity of all layers</span>
                <span className="num text-sm font-semibold text-accent">{Math.round(overlayOpacity * 100)}%</span>
              </div>
              <input
                type="range"
                min={10}
                max={100}
                value={Math.round(overlayOpacity * 100)}
                onChange={(e) => setOverlayOpacity(Number(e.target.value) / 100)}
                className="w-full"
              />
            </div>
            <button
              onClick={() => {
                clearAllLayers();
                setDisplayOpen(false);
              }}
              disabled={checkedLayers.size === 0}
              className="w-full rounded-[4px] border border-line px-3 py-1.5 text-sm font-medium text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:opacity-40"
            >
              Turn all layers off
            </button>
          </div>
        )}
        <button
          onClick={() => setDisplayOpen((v) => !v)}
          aria-expanded={displayOpen}
          className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
        >
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-[4px] ${checkedLayers.size > 0 ? 'bg-accent text-white' : 'bg-surface-2 text-ink-3'}`}
          >
            <IconLayers size={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-semibold text-ink">
              {checkedLayers.size === 0
                ? 'No layers on'
                : `${checkedLayers.size} layer${checkedLayers.size === 1 ? '' : 's'} on the map`}
            </span>
            <span className="num block text-xs text-ink-3">
              Opacity {Math.round(overlayOpacity * 100)}%
            </span>
          </span>
          <IconChevron size={14} className={`text-ink-3 transition-transform ${displayOpen ? 'rotate-90' : '-rotate-90'}`} />
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tab 2. Place
 * ------------------------------------------------------------------ */

interface PlaceTabProps {
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  onOpenBuilding: (id: string) => void;
  onOpenBuildings: (ids: string[]) => void;
  /** Buildings open on the right, to mark their row. */
  activeIds: string[];
  /** The index suburbs are compared on, also shading the map. */
  indexId: IndexId;
  setIndexId: (v: IndexId) => void;
}

/* ------------------------------------------------------------------ *
 * Suburb indexes
 *
 * Measured, not scored: each one is a share, an average or a count from
 * the supplied layers (see scripts/build-sa2-indicators.cjs), and suburbs
 * are ranked on each one separately. There is no combined index, because
 * no weighting between hazards has been agreed.
 * ------------------------------------------------------------------ */

interface Sa2Indicator {
  floodShare: Record<'1in5' | '1in20' | '1in100' | 'any', number>;
  heatCells: number;
  uhiAvg: number | null;
  uhiCat4Share: number | null;
  sviAvg: number | null;
  densityAvg: number | null;
  densitySa1s: number;
}
const SA2_IND = sa2IndicatorsData.bySa2 as Record<string, Sa2Indicator>;

type IndexId = 'flood100' | 'flood5' | 'bflood' | 'uhi' | 'heat4' | 'svi' | 'density';
interface IndexDef {
  id: IndexId;
  group: 'Flood' | 'Heat' | 'People' | 'Assets';
  label: string;
  short: string;
  /** How it was measured, in one line. */
  how: string;
  color: string;
  format: (v: number) => string;
  value: (s: Suburb) => number | null;
}
const pct = (v: number) => `${Math.round(v * 100)}%`;
const INDEXES: IndexDef[] = [
  {
    id: 'flood100',
    group: 'Flood',
    label: 'Area inside the 1 in 100 flood extent',
    short: '1 in 100 flood area',
    how: "Share of the suburb's area inside the 1 in 100 extent, from a 30 m point grid.",
    color: '#1E3A8A',
    format: pct,
    value: (s) => SA2_IND[s.sa2]?.floodShare['1in100'] ?? null,
  },
  {
    id: 'flood5',
    group: 'Flood',
    label: 'Area inside the 1 in 5 flood extent',
    short: '1 in 5 flood area',
    how: "Share of the suburb's area inside the 1 in 5 extent, from a 30 m point grid. Trimmer not supplied.",
    color: '#1D4ED8',
    format: pct,
    value: (s) => SA2_IND[s.sa2]?.floodShare['1in5'] ?? null,
  },
  {
    id: 'bflood',
    group: 'Assets',
    label: 'Council buildings inside a flood extent',
    short: 'Buildings in flood',
    how: "Share of the suburb's mapped council buildings inside at least one flood extent.",
    color: ACCENT,
    format: pct,
    value: (s) => {
      const bs = REAL_BUILDINGS_BY_SUBURB[s.id] ?? [];
      if (bs.length === 0) return null;
      const p = hazardProfiles();
      return bs.filter((b) => (p.get(b.id)?.flood.length ?? 0) > 0).length / bs.length;
    },
  },
  {
    id: 'uhi',
    group: 'Heat',
    label: 'Average UHI category',
    short: 'Average UHI',
    how: 'Average Urban Heat Island category (2 to 4) of the heat grid cells centred in the suburb.',
    color: '#EF4444',
    format: (v) => v.toFixed(2),
    value: (s) => SA2_IND[s.sa2]?.uhiAvg ?? null,
  },
  {
    id: 'heat4',
    group: 'Heat',
    label: 'Heat cells in category 4',
    short: 'Category 4 cells',
    how: "Share of the suburb's heat grid cells in the hottest category.",
    color: '#DC2626',
    format: pct,
    value: (s) => SA2_IND[s.sa2]?.uhiCat4Share ?? null,
  },
  {
    id: 'svi',
    group: 'People',
    label: 'Average Social Vulnerability Index',
    short: 'Average SVI',
    how: 'Average SVI of the heat grid cells centred in the suburb.',
    color: '#B45309',
    format: (v) => v.toFixed(2),
    value: (s) => SA2_IND[s.sa2]?.sviAvg ?? null,
  },
  {
    id: 'density',
    group: 'People',
    label: 'Dwelling density',
    short: 'Dwelling density',
    how: 'SA1 "Density 21" values averaged across the suburb, weighted by SA1 area.',
    color: '#6B3FA0',
    format: (v) => v.toFixed(1),
    value: (s) => SA2_IND[s.sa2]?.densityAvg ?? null,
  },
];
const INDEX_BY_ID = Object.fromEntries(INDEXES.map((d) => [d.id, d])) as Record<IndexId, IndexDef>;

/** Every suburb's value on one index, highest first, with its rank. */
/* ------------------------------------------------------------------ *
 * SSP scenarios. SPECULATIVE.
 *
 * Placeholder figures, asked for as speculative, so the scenario switch
 * can be shown and used before real projections arrive. They are not
 * modelled or sourced: every place they appear is labelled
 * "Speculative". Replace SPECULATIVE_UPLIFT and SPECULATIVE_OUTLOOK with
 * real values (e.g. DEW's 2022 SA climate projections guide, or
 * NARCliM 2.0) when they are supplied.
 * ------------------------------------------------------------------ */

type Scenario = 'today' | 'ssp245' | 'ssp585';
type Horizon = 2050 | 2090;
interface ScenarioSel {
  scenario: Scenario;
  year: Horizon;
}
const SCENARIO_LABEL: Record<Scenario, string> = { today: 'Today', ssp245: 'SSP2-4.5', ssp585: 'SSP5-8.5' };
const SCENARIO_NOTE: Record<Scenario, string> = {
  today: 'The supplied layers as they are.',
  ssp245: 'Middle of the road emissions.',
  ssp585: 'High emissions.',
};
/** SPECULATIVE multipliers on the flood and heat indexes. */
const SPECULATIVE_UPLIFT: Record<Exclude<Scenario, 'today'>, Record<Horizon, { heat: number; flood: number }>> = {
  ssp245: { 2050: { heat: 1.08, flood: 1.1 }, 2090: { heat: 1.15, flood: 1.2 } },
  ssp585: { 2050: { heat: 1.12, flood: 1.15 }, 2090: { heat: 1.3, flood: 1.4 } },
};
/** SPECULATIVE LGA-wide outlook lines. */
const SPECULATIVE_OUTLOOK: Record<Exclude<Scenario, 'today'>, Record<Horizon, [string, string][]>> = {
  ssp245: {
    2050: [['Warming', '+1.0 °C'], ['Days over 35 °C', '+4 a year'], ['Annual rainfall', '−5%'], ['Sea level', '+0.2 m']],
    2090: [['Warming', '+1.8 °C'], ['Days over 35 °C', '+8 a year'], ['Annual rainfall', '−9%'], ['Sea level', '+0.5 m']],
  },
  ssp585: {
    2050: [['Warming', '+1.4 °C'], ['Days over 35 °C', '+6 a year'], ['Annual rainfall', '−7%'], ['Sea level', '+0.25 m']],
    2090: [['Warming', '+3.5 °C'], ['Days over 35 °C', '+17 a year'], ['Annual rainfall', '−18%'], ['Sea level', '+0.8 m']],
  },
};
const TODAY: ScenarioSel = { scenario: 'today', year: 2050 };
/** The scenario the whole tool is showing, set from the map controls. */
const ScenarioContext = React.createContext<{ sel: ScenarioSel; set: (v: ScenarioSel) => void }>({
  sel: TODAY,
  set: () => {},
});
const SCENARIO_OPTIONS: { value: string; label: string; sel: ScenarioSel }[] = [
  { value: 'today', label: 'Today', sel: TODAY },
  { value: 'ssp245-2050', label: 'SSP2-4.5 · 2050', sel: { scenario: 'ssp245', year: 2050 } },
  { value: 'ssp245-2090', label: 'SSP2-4.5 · 2090', sel: { scenario: 'ssp245', year: 2090 } },
  { value: 'ssp585-2050', label: 'SSP5-8.5 · 2050', sel: { scenario: 'ssp585', year: 2050 } },
  { value: 'ssp585-2090', label: 'SSP5-8.5 · 2090', sel: { scenario: 'ssp585', year: 2090 } },
];
const scenarioKey = (sel: ScenarioSel) => (sel.scenario === 'today' ? 'today' : `${sel.scenario}-${sel.year}`);
const scenarioName = (sel: ScenarioSel) => `${SCENARIO_LABEL[sel.scenario]}, ${sel.year}`;

/** The speculative multiplier for one index under a scenario (1 = no change). */
function scenarioFactor(def: IndexDef, sel: ScenarioSel | undefined): number {
  if (!sel || sel.scenario === 'today') return 1;
  const u = SPECULATIVE_UPLIFT[sel.scenario][sel.year];
  if (def.group === 'Flood' || def.id === 'bflood') return u.flood;
  if (def.group === 'Heat') return u.heat;
  return 1;
}
/** Shares can't pass 100%, and the UHI scale tops out at category 4. */
function applyScenario(def: IndexDef, v: number | null, sel: ScenarioSel | undefined): number | null {
  if (v === null) return null;
  const x = v * scenarioFactor(def, sel);
  return def.id === 'uhi' ? Math.min(x, 4) : def.format === pct ? Math.min(x, 1) : x;
}

function rankSuburbs(def: IndexDef, sel?: ScenarioSel): { s: Suburb; v: number | null; rank: number | null }[] {
  const rows = SUBURBS.map((s) => ({ s, v: applyScenario(def, def.value(s), sel) }));
  const ranked = rows.filter((r) => r.v !== null).sort((a, b) => b.v! - a.v!);
  return [
    ...ranked.map((r, i) => ({ ...r, rank: i + 1 })),
    ...rows.filter((r) => r.v === null).map((r) => ({ ...r, rank: null })),
  ];
}
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** Light-to-colour ramp for shading suburbs on the map by an index. */
function shadeFor(def: IndexDef, sel?: ScenarioSel): Record<string, string> {
  const rows = rankSuburbs(def, sel).filter((r) => r.v !== null);
  const lo = Math.min(...rows.map((r) => r.v!));
  const hi = Math.max(...rows.map((r) => r.v!));
  return Object.fromEntries(rows.map((r) => [r.s.id, lerpHex('#EEF2F2', def.color, hi > lo ? (r.v! - lo) / (hi - lo) : 1)]));
}

function IndexPicker({ value, onChange }: { value: IndexId; onChange: (v: IndexId) => void }) {
  const groups = [...new Set(INDEXES.map((d) => d.group))];
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as IndexId)}
      aria-label="Index"
      className="w-full rounded-[3px] border border-line bg-white px-2 py-1.5 text-base text-ink hover:border-ink-3"
    >
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {INDEXES.filter((d) => d.group === g).map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/* ------------------------------------------------------------------ *
 * Priority mix
 *
 * The person using the tool sets the weights; the inputs are measured.
 * Each input is ranked across the SA1s that have a value (0 lowest,
 * 1 highest), then the ranks are averaged with the chosen weights.
 * ------------------------------------------------------------------ */

type PriorityKey = 'flood' | 'heat' | 'svi' | 'density';
type PriorityWeights = Record<PriorityKey, number>;
const PRIORITY_INPUTS: { id: PriorityKey; label: string; how: string; field: 'flood' | 'uhi' | 'svi' | 'density' }[] = [
  { id: 'flood', label: 'Flood', how: 'Share of the area in the 1 in 100 extent', field: 'flood' },
  { id: 'heat', label: 'Urban heat', how: 'Average UHI category of its heat cells', field: 'uhi' },
  { id: 'svi', label: 'Social vulnerability', how: 'Average SVI of its heat cells', field: 'svi' },
  { id: 'density', label: 'Dwelling density', how: 'Its Density 21 value', field: 'density' },
];
const EQUAL_WEIGHTS: PriorityWeights = { flood: 5, heat: 5, svi: 5, density: 5 };
const SA1_IND = sa1IndicatorsData.bySa1 as Record<
  string,
  { flood: number | null; uhi: number | null; svi: number | null; cells: number; density: number | null }
>;
/** Rank of every SA1's value on one input, 0 (lowest) to 1 (highest), ties averaged. */
const PRIORITY_RANK: Record<PriorityKey, Map<string, number>> = Object.fromEntries(
  PRIORITY_INPUTS.map(({ id, field }) => {
    const vals = Object.entries(SA1_IND)
      .filter(([, v]) => v[field] !== null)
      .map(([code, v]) => ({ code, v: v[field] as number }))
      .sort((a, b) => a.v - b.v);
    const out = new Map<string, number>();
    let i = 0;
    while (i < vals.length) {
      let j = i;
      while (j + 1 < vals.length && vals[j + 1].v === vals[i].v) j++;
      const r = vals.length > 1 ? (i + j) / 2 / (vals.length - 1) : 0.5;
      for (let k = i; k <= j; k++) out.set(vals[k].code, r);
      i = j + 1;
    }
    return [id, out];
  }),
) as Record<PriorityKey, Map<string, number>>;

interface PriorityScore {
  score: number | null;
  missing: PriorityKey[];
}
function priorityScores(w: PriorityWeights): Map<string, PriorityScore> {
  const out = new Map<string, PriorityScore>();
  for (const a of SA1S) {
    let sum = 0;
    let wsum = 0;
    const missing: PriorityKey[] = [];
    for (const { id } of PRIORITY_INPUTS) {
      if (w[id] <= 0) continue;
      const r = PRIORITY_RANK[id].get(a.id);
      if (r === undefined) {
        missing.push(id);
        continue;
      }
      sum += r * w[id];
      wsum += w[id];
    }
    out.set(a.id, { score: wsum > 0 ? sum / wsum : null, missing });
  }
  return out;
}
/** Five steps, lower (blue) to higher (red). */
const PRIORITY_COLORS = ['#2C7BB6', '#ABD9E9', '#FFFFBF', '#FDAE61', '#D7191C'];
const priorityColor = (score: number) => PRIORITY_COLORS[Math.min(4, Math.floor(score * 5))];

const PriorityContext = React.createContext<{ w: PriorityWeights; setW: (w: PriorityWeights) => void }>({
  w: EQUAL_WEIGHTS,
  setW: () => {},
});

function RoadFindings() {
  const { by, set } = React.useContext(RoadColourContext);
  const total = majorRoadsData.totalKm;
  const inFlood = majorRoadsData.kmInFlood as Record<'1in5' | '1in20' | '1in100', number>;
  const byRole = majorRoadsData.kmByRole as Record<string, number>;
  const worst = Object.entries(majorRoadsData.kmIn1in100ByRoad as Record<string, number>).slice(0, 8);
  return (
    <>
      <FigureStrip>
        <Figure label="Classified roads" value={`${Math.round(total)} km`} />
        <Figure label="In 1 in 100 extent" value={`${Math.round(inFlood['1in100'])} km`} sub={`${pct(inFlood['1in100'] / total)} of it`} />
      </FigureStrip>

      <Section title="Colour roads by">
        <div className="flex gap-1.5">
          {(
            [
              ['role', 'Road role'],
              ['flood', 'Flood exposure'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => set(id)}
              aria-pressed={by === id}
              className={`flex-1 rounded-[3px] border px-2 py-1.5 text-base transition-colors ${by === id ? 'border-accent font-semibold text-ink' : 'border-line text-ink-2 hover:border-ink-3'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Most road in the 1 in 100 extent">
        {worst.map(([name, kmv]) => (
          <div key={name} className="flex items-center gap-3 py-1">
            <span className="w-[120px] shrink-0 truncate text-base text-ink-2" title={roadName(name)}>
              {roadName(name)}
            </span>
            <span className="h-[4px] flex-1 rounded-full bg-line">
              <span className="block h-full rounded-full" style={{ width: `${(kmv / worst[0][1]) * 100}%`, background: '#EAB308' }} />
            </span>
            <span className="num w-14 shrink-0 text-right text-base font-medium text-ink">{kmv.toFixed(1)} km</span>
          </div>
        ))}
        <p className="mt-1.5 text-sm text-ink-3">Long-term flood runs. Divided roads count each carriageway.</p>
      </Section>

      <Section title="Length by role">
        {ROAD_ROLES.filter((r) => byRole[r.role]).map((r) => (
          <div key={r.role} className="flex items-center gap-3 py-1">
            <span className="w-[120px] shrink-0 truncate text-base text-ink-2">{r.label}</span>
            <span className="h-[4px] flex-1 rounded-full bg-line">
              <span className="block h-full rounded-full" style={{ width: `${(byRole[r.role] / total) * 100}%`, background: r.color }} />
            </span>
            <span className="num w-14 shrink-0 text-right text-base font-medium text-ink">{byRole[r.role].toFixed(1)} km</span>
          </div>
        ))}
      </Section>
    </>
  );
}

function PriorityFindings() {
  const { w, setW } = React.useContext(PriorityContext);
  const total = PRIORITY_INPUTS.reduce((n, i) => n + w[i.id], 0);
  const scores = priorityScores(w);
  const bySuburb = SUBURBS.map((sub) => {
    const vals = SA1S.filter((a) => a.parentId === sub.id)
      .map((a) => scores.get(a.id)?.score)
      .filter((v): v is number => v !== null && v !== undefined);
    return { sub, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0 };
  }).sort((a, b) => b.avg - a.avg);
  const top = [...scores.entries()]
    .filter(([, v]) => v.score !== null)
    .sort((a, b) => b[1].score! - a[1].score!)
    .slice(0, 5);
  const isEqual = PRIORITY_INPUTS.every((i) => w[i.id] === EQUAL_WEIGHTS[i.id]);

  return (
    <>
      <Section
        title="Your weights"
        right={
          !isEqual && (
            <button onClick={() => setW(EQUAL_WEIGHTS)} className="text-sm font-medium text-accent hover:text-ink">
              Reset to equal
            </button>
          )
        }
      >
        <div className="space-y-3">
          {PRIORITY_INPUTS.map((i) => (
            <label key={i.id} className="block">
              <span className="flex items-baseline justify-between">
                <span className="text-base font-medium text-ink">{i.label}</span>
                <span className="num text-base text-ink-2">{total ? Math.round((w[i.id] / total) * 100) : 0}%</span>
              </span>
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={w[i.id]}
                onChange={(e) => setW({ ...w, [i.id]: Number(e.target.value) })}
                className="mt-1 w-full"
                aria-label={`${i.label} weight`}
              />
              <span className="block text-sm text-ink-3">{i.how}</span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="Suburbs, by average score">
        {bySuburb.map((r) => (
          <BarRow key={r.sub.id} label={r.sub.name} n={Math.round(r.avg * 100)} max={100} color={priorityColor(r.avg)} />
        ))}
      </Section>

      <Section title="Highest scoring areas">
        <dl className="divide-y divide-line">
          {top.map(([code, v]) => {
            const a = SA1S.find((x) => x.id === code)!;
            return (
              <div key={code} className="flex items-baseline justify-between gap-3 py-1.5">
                <dt className="min-w-0 truncate text-base text-ink-2">
                  {SUBURB_BY_ID[a.parentId]?.name} <span className="num text-sm text-ink-3">SA1 {code}</span>
                </dt>
                <dd className="num text-base font-semibold text-ink">{Math.round(v.score! * 100)}</dd>
              </div>
            );
          })}
        </dl>
      </Section>
    </>
  );
}

/** Several register rows filed under one name (one site with many
 *  buildings, e.g. an aged care facility) as one line. Opens the list of
 *  them on the right, where each has its own profile. */
function BuildingGroupRow({
  name,
  items,
  onOpen,
  active,
  right,
}: {
  name: string;
  items: RealAsset[];
  onOpen: (ids: string[]) => void;
  active?: boolean;
  right?: React.ReactNode;
}) {
  const types = [...new Set(items.map((b) => b.buildingType ?? 'Not yet classified'))];
  const value = items.reduce((n, b) => n + b.insuredValue, 0);
  return (
    <button
      onClick={() => onOpen(items.map((b) => b.id))}
      aria-current={active || undefined}
      className={`flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left transition-colors ${active ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
      style={active ? { boxShadow: `inset 2px 0 0 ${ACCENT}` } : undefined}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-lg font-medium text-ink">{name}</span>
        <span className="num mt-0.5 block truncate text-sm text-ink-3">
          {items.length} buildings · {types.length === 1 ? types[0] : `${types.length} types`}
        </span>
      </span>
      {right ?? (value > 0 && <span className="num shrink-0 pt-[1px] text-base text-ink-2">{formatMoney(value)}</span>)}
    </button>
  );
}

type PlaceFilter = 'all' | 'flood' | 'heat4';
const PLACE_FILTERS: { id: PlaceFilter; label: string; hint?: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'flood', label: 'In a flood extent', hint: 'Inside at least one mapped flood extent.' },
  { id: 'heat4', label: 'Heat category 4', hint: "In the heat grid's highest category." },
];

function PlaceTab({
  selectedId,
  setSelectedId,
  onOpenBuilding,
  onOpenBuildings,
  activeIds,
  indexId,
  setIndexId,
}: PlaceTabProps) {
  const { sel: scenario } = React.useContext(ScenarioContext);
  const [filter, setFilter] = useState<PlaceFilter>('all');
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    setFilter('all');
    setShowAll(false);
  }, [selectedId]);

  const profiles = hazardProfiles();
  const inFlood = (b: RealAsset) => (profiles.get(b.id)?.flood.length ?? 0) > 0;
  const inHeat4 = (b: RealAsset) => profiles.get(b.id)?.heat?.uhiCat === 4;

  if (!selectedId || !SUBURB_BY_ID[selectedId]) {
    return (
      <div className="px-3 py-4">
        <Section title="Compare suburbs">
          <IndexPicker value={indexId} onChange={setIndexId} />
          {scenario.scenario !== 'today' && (
            <p className="mt-2 text-sm font-medium text-[#92400E]">
              Showing {scenarioName(scenario)}, speculative. Change it in the map's Scenario control.
            </p>
          )}
          <p className="mb-3 mt-1.5 text-sm leading-[1.5] text-ink-3">
            {INDEX_BY_ID[indexId].how} Shaded on the map, darker is higher.
          </p>
          {(() => {
            const def = INDEX_BY_ID[indexId];
            const rows = rankSuburbs(def, scenario);
            const max = Math.max(...rows.map((r) => r.v ?? 0));
            return rows.map((r) => (
              <button
                key={r.s.id}
                onClick={() => setSelectedId(r.s.id)}
                className="flex w-full items-center gap-3 py-1.5 text-left hover:opacity-80"
              >
                <span className="num w-4 shrink-0 text-sm text-ink-3">{r.rank ?? '–'}</span>
                <span className="w-[104px] shrink-0 truncate text-base text-ink-2">{r.s.name}</span>
                <span className="h-[4px] flex-1 rounded-full bg-line">
                  <span
                    className="block h-full rounded-full"
                    style={{ width: `${max && r.v ? (r.v / max) * 100 : 0}%`, background: def.color }}
                  />
                </span>
                <span className="num w-10 shrink-0 text-right text-base font-medium text-ink">
                  {r.v === null ? 'n/a' : def.format(r.v)}
                </span>
              </button>
            ));
          })()}
        </Section>

        <section className="mt-6">
        <PanelHeading>Suburbs</PanelHeading>
        <div className="grid grid-cols-2 gap-2">
          {SUBURBS.map((s) => {
            const bs = REAL_BUILDINGS_BY_SUBURB[s.id] ?? [];
            return (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className="flex min-h-[78px] flex-col justify-between rounded-[4px] border border-line bg-white p-2.5 text-left transition-colors hover:border-ink-3"
              >
                <span className="text-base font-semibold leading-tight text-ink">{s.name}</span>
                <span className="num mt-2 text-sm leading-[1.4] text-ink-3">
                  {bs.length} buildings
                  <br />
                  {bs.filter(inFlood).length} in a flood extent
                </span>
              </button>
            );
          })}
        </div>
        </section>
      </div>
    );
  }

  const s = SUBURB_BY_ID[selectedId];
  const buildings = REAL_BUILDINGS_BY_SUBURB[s.id] ?? [];
  const insured = buildings.reduce((n, b) => n + b.insuredValue, 0);
  const pick = { all: () => true, flood: inFlood, heat4: inHeat4 } as const;
  const counts: Record<PlaceFilter, number> = {
    all: buildings.length,
    flood: buildings.filter(inFlood).length,
    heat4: buildings.filter(inHeat4).length,
  };
  const active: PlaceFilter = counts[filter] > 0 ? filter : 'all';

  // Same-named register rows (one site, many buildings) collapse into one
  // line, largest total value first.
  const groups = new Map<string, RealAsset[]>();
  for (const b of buildings.filter(pick[active])) groups.set(b.name, [...(groups.get(b.name) ?? []), b]);
  const rows = [...groups.entries()]
    .map(([name, items]) => ({ name, items, value: items.reduce((n, b) => n + b.insuredValue, 0) }))
    .sort((a, b) => b.value - a.value);
  const shown = showAll ? rows : rows.slice(0, 10);
  const hint = PLACE_FILTERS.find((f) => f.id === active)?.hint;

  return (
    <div className="px-3 py-4">
      <BackBar onBack={() => setSelectedId(null)} parent={`Suburbs · SA2 ${s.sa2}`} title={s.name} />
      <FigureStrip>
        <Figure label="Buildings" value={buildings.length} />
        <Figure label="Insured value" value={formatMoney(insured)} />
      </FigureStrip>

      <Section title="Indexes" right={<span className="text-sm text-ink-3">Rank of 8 suburbs</span>}>
        <dl className="divide-y divide-line">
          {INDEXES.map((def) => {
            const row = rankSuburbs(def, scenario).find((r) => r.s.id === s.id)!;
            return (
              <div key={def.id} className="flex items-baseline gap-3 py-1.5">
                <dt className="min-w-0 flex-1 truncate text-base text-ink-2" title={def.how}>
                  {def.short}
                </dt>
                <dd className="num w-12 shrink-0 text-right text-base font-medium text-ink">
                  {row.v === null ? 'n/a' : def.format(row.v)}
                </dd>
                <dd className="num w-9 shrink-0 text-right text-sm text-ink-3">{row.rank ? ordinal(row.rank) : ''}</dd>
              </div>
            );
          })}
        </dl>
      </Section>

      <section className="mt-6">
        <PanelHeading>Buildings</PanelHeading>
        {buildings.length === 0 ? (
          <p className="text-base text-ink-3">No register buildings are mapped inside this SA2.</p>
        ) : (
          <>
            <div className="flex gap-4 border-b border-line" role="tablist">
              {PLACE_FILTERS.map((f) => {
                const on = active === f.id;
                const n = counts[f.id];
                return (
                  <button
                    key={f.id}
                    role="tab"
                    aria-selected={on}
                    disabled={n === 0}
                    onClick={() => {
                      setFilter(f.id);
                      setShowAll(false);
                    }}
                    className={`-mb-px whitespace-nowrap border-b-2 pb-2 text-base transition-colors disabled:cursor-default disabled:opacity-40 ${on ? 'border-accent font-semibold text-ink' : 'border-transparent text-ink-3 hover:text-ink'}`}
                  >
                    {f.label} <span className="num font-normal text-ink-3">{n}</span>
                  </button>
                );
              })}
            </div>
            <p className="mb-3 mt-2 min-h-[16px] text-sm text-ink-3">{hint ?? 'Highest insured value first.'}</p>
            <BuildingList>
              {shown.map((r) =>
                r.items.length === 1 ? (
                  <BuildingRow
                    key={r.name}
                    b={r.items[0]}
                    onOpen={onOpenBuilding}
                    active={activeIds.length === 1 && activeIds[0] === r.items[0].id}
                    hideSuburb
                  />
                ) : (
                  <BuildingGroupRow
                    key={r.name}
                    name={r.name}
                    items={r.items}
                    onOpen={onOpenBuildings}
                    active={activeIds.length > 1 && r.items.some((b) => b.id === activeIds[0])}
                  />
                ),
              )}
            </BuildingList>
            {rows.length > 10 && (
              <button onClick={() => setShowAll((v) => !v)} className="mt-2 text-base font-medium text-accent hover:text-ink">
                {showAll ? 'Show fewer' : `Show all ${rows.length}`}
              </button>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shared bits
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Right panel shell
 * ------------------------------------------------------------------ */

function RightPanelShell({
  accent,
  eyebrow,
  title,
  onClose,
  children,
}: {
  accent: string;
  eyebrow: string;
  title: string;
  onClose?: () => void;
  children: React.ReactNode;
}) {
  return (
    <aside
      className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-white"
      style={{ borderTop: `3px solid ${accent}` }}
    >
      <header className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-ink-3">{eyebrow}</div>
          <div className="mt-0.5 text-2xl font-semibold leading-tight text-ink">{title}</div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="-mr-1 mt-[1px] shrink-0 rounded-[3px] p-1 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            aria-label="Close"
          >
            <IconClose />
          </button>
        )}
      </header>
      <div className="thin-scroll flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * Blueprint panel
 *
 * What a preset turned on and why, nothing scored. Each included layer
 * gets its own real note and source, the same text the plain layer info
 * panel would show for it, just gathered in one place.
 * ------------------------------------------------------------------ */

function BlueprintPanel({
  blueprint,
  onClose,
  onFocus,
  onOpenBuilding,
}: {
  blueprint: Blueprint;
  onClose: () => void;
  onFocus: (suburbId: string | null, buildingIds: string[] | null) => void;
  onOpenBuilding: (id: string) => void;
}) {
  const [tab, setTab] = useState<'overview' | 'by-sa2'>('overview');
  const [showExposed, setShowExposed] = useState(false);
  const [saSel, setSaSel] = useState<string | null>(null);
  useEffect(() => {
    setTab('overview');
    setSaSel(null);
  }, [blueprint.id]);

  const floodLayers = blueprint.layers.filter((id) => id in FLOOD_RETURN_PERIOD_BY_LAYER);
  const isFlood = floodLayers.length > 0;
  const isHeat = blueprint.id === 'heat';
  const hasExposure = isFlood || isHeat;

  const exposedToFlood = useMemo(
    () => (isFlood ? buildingsInFlood(floodLayers) : null),
    [blueprint.id],
  );
  const exposedFloodIds = useMemo(
    () => new Set((exposedToFlood ?? []).map((b) => b.id)),
    [exposedToFlood],
  );
  const heatData = useMemo(() => (isHeat ? buildingsByHeatCategory() : null), [blueprint.id]);
  const mappedTotal = REAL_BUILDINGS.filter((b) => BUILDING_LOCATION[b.id]).length;

  // Per real SA2, how many of ITS real buildings fall inside this
  // blueprint's hazard, most-affected first. Sorting by the real count
  // itself isn't a threshold, nothing is marked as "the worst".
  const sa2Rows = useMemo(() => {
    if (!hasExposure) return [];
    return SUBURBS.map((s) => {
      const buildings = REAL_BUILDINGS_BY_SUBURB[s.id] ?? [];
      const count = isFlood
        ? buildings.filter((b) => exposedFloodIds.has(b.id)).length
        : buildings.filter((b) => heatData!.byBuildingId.has(b.id)).length;
      return { s, buildings, count };
    }).sort((a, b) => b.count - a.count);
  }, [hasExposure, isFlood, exposedFloodIds, heatData]);

  const selectedRow = useMemo(
    () => (saSel ? sa2Rows.find((r) => r.s.id === saSel) ?? null : null),
    [saSel, sa2Rows],
  );
  // The buildings this preset's hazard actually touches inside the
  // drilled-into SA2, not every building there: for flood that's the
  // ones inside the extent, for heat every mapped building counts.
  const shownBuildings = useMemo(() => {
    if (!selectedRow) return null;
    return isFlood ? selectedRow.buildings.filter((b) => exposedFloodIds.has(b.id)) : selectedRow.buildings;
  }, [selectedRow, isFlood, exposedFloodIds]);

  // Tells the map which real buildings to label at their actual
  // location, so drilling into a SA2 here shows the same buildings on
  // the map, not just as cards in this panel.
  useEffect(() => {
    onFocus(saSel, shownBuildings ? shownBuildings.map((b) => b.id) : null);
    return () => onFocus(null, null);
  }, [saSel, shownBuildings, onFocus]);

  return (
    <RightPanelShell accent={blueprint.accent} eyebrow="Blueprint" title={blueprint.title} onClose={onClose}>
      <div className="px-2.5 py-2">
        <p className="mb-3 text-md leading-[1.55] text-ink-2">{blueprint.description}</p>

        {hasExposure && (
          <div className="mb-3">
            <Segmented
              value={tab}
              onChange={setTab}
              accent={blueprint.accent}
              options={[
                { value: 'overview' as const, label: 'Overview' },
                { value: 'by-sa2' as const, label: 'By SA2' },
              ]}
            />
          </div>
        )}

        {(!hasExposure || tab === 'overview') && (
          <>
            {exposedToFlood && (
              <>
                <PanelHeading>Buildings inside this flood extent</PanelHeading>
                <div className="mb-3 rounded-[3px] border border-line bg-white px-3 py-2.5">
                  <div className="num text-stat font-semibold leading-none text-ink">
                    {exposedToFlood.length} <span className="text-base font-normal text-ink-3">of {mappedTotal} mapped</span>
                  </div>
                  <div className="mt-1 text-xs leading-[1.5] text-ink-3">
                    Buildings whose geocoded point falls inside at least one of the
                    mapped flood polygons this preset turns on. A point either sits
                    inside a mapped extent or it doesn't, no severity is implied.
                  </div>
                  {exposedToFlood.length > 0 && (
                    <button
                      onClick={() => setShowExposed((v) => !v)}
                      className="mt-2 text-sm font-medium text-accent underline decoration-dotted hover:text-ink"
                    >
                      {showExposed ? 'Hide the list' : 'List them'}
                    </button>
                  )}
                </div>
                {showExposed && (
                  <div className="mb-3">
                    <BuildingList>
                      {exposedToFlood.map((b) => (
                        <BuildingRow key={b.id} b={b} onOpen={onOpenBuilding} />
                      ))}
                    </BuildingList>
                  </div>
                )}
              </>
            )}

            {heatData && (
              <>
                <PanelHeading>Buildings by UHI category</PanelHeading>
                <div className="mb-3 rounded-[3px] border border-line bg-white px-3 py-2.5">
                  <div className="space-y-1.5">
                    {[...heatData.byCategory.keys()]
                      .sort((a, c) => c - a)
                      .map((cat) => {
                        const list = heatData.byCategory.get(cat)!;
                        return (
                          <div key={cat} className="flex items-center gap-2">
                            <span className="w-[80px] shrink-0 text-sm text-ink-2">Category {cat}</span>
                            <span className="h-[6px] flex-1 overflow-hidden rounded-[3px] bg-surface-2">
                              <span
                                className="block h-full rounded-[3px] bg-accent"
                                style={{ width: `${(list.length / mappedTotal) * 100}%` }}
                              />
                            </span>
                            <span className="num w-7 shrink-0 text-right text-sm font-semibold text-ink">
                              {list.length}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                  <div className="mt-2 text-xs leading-[1.5] text-ink-3">
                    Counts are the heat grid cell each building's geocoded point
                    falls inside, against {mappedTotal} mapped buildings. No category
                    is marked as the one that counts as "in danger": that line hasn't
                    been agreed by council.
                  </div>
                </div>
              </>
            )}
          </>
        )}

        {hasExposure && tab === 'by-sa2' && (
          <>
            {!saSel ? (
              <>
                <PanelHeading>SA2s, most affected first</PanelHeading>
                <div className="-mx-2.5 divide-y divide-line border-y border-line">
                  {sa2Rows.map(({ s, buildings, count }) => (
                    <button
                      key={s.id}
                      onClick={() => setSaSel(s.id)}
                      className="flex w-full items-center justify-between gap-3 px-2.5 py-2.5 text-left transition-colors hover:bg-surface-2"
                    >
                      <span>
                        <span className="block text-lg font-medium text-ink">{s.name}</span>
                        <span className="num mt-[2px] block text-xs text-ink-3">SA2 {s.sa2}</span>
                      </span>
                      <span className="text-right">
                        <span className="num block text-xl font-semibold text-ink">{count}</span>
                        <span className="block text-2xs text-ink-3">of {buildings.length}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : selectedRow && shownBuildings ? (
              <div>
                <button
                  onClick={() => setSaSel(null)}
                  className="mb-2 flex items-center gap-[3px] text-sm text-ink-3 transition-colors hover:text-accent"
                >
                  <IconChevron size={13} className="rotate-180" />
                  All SA2s
                </button>
                <div className="mb-2">
                  <div className="text-xl font-semibold text-ink">{selectedRow.s.name}</div>
                  <div className="num text-sm text-ink-3">
                    {selectedRow.count} of {selectedRow.buildings.length} buildings{' '}
                    {isFlood ? 'inside this extent' : 'matched to a heat cell'}, labelled on the map
                  </div>
                </div>
                <div>
                  {shownBuildings.length > 0 && (
                    <BuildingList>
                      {shownBuildings.map((b) => (
                        <BuildingRow key={b.id} b={b} onOpen={onOpenBuilding} />
                      ))}
                    </BuildingList>
                  )}
                  {shownBuildings.length === 0 && (
                    <p className="text-base text-ink-3">
                      No buildings here {isFlood ? 'fall inside this extent' : 'matched a heat cell'}.
                    </p>
                  )}
                </div>
              </div>
            ) : null}
          </>
        )}

        <PanelHeading>Layers this turns on</PanelHeading>
        <div className="divide-y divide-line rounded-[4px] border border-line">
          {blueprint.layers.map((id) => {
            const l = LAYER_BY_ID[id];
            return (
              <details key={id} className="group px-3 py-2.5">
                <summary className="flex cursor-pointer list-none items-center gap-2.5 [&::-webkit-details-marker]:hidden">
                  <LayerGlyph l={l} />
                  <span className="flex-1 text-base font-medium text-ink">{l.name}</span>
                  <IconChevron size={12} className="text-ink-3 transition-transform group-open:rotate-90" />
                </summary>
                <p className="mt-2 text-base leading-[1.55] text-ink-2">{l.note}</p>
                <p className="mt-1 text-sm leading-[1.5] text-ink-3">{l.source}</p>
              </details>
            );
          })}
        </div>
      </div>
    </RightPanelShell>
  );
}

/* ------------------------------------------------------------------ *
 * Layer info panel
 *
 * Checking a layer opens its description here, so what the layer is and
 * where it came from is one click away rather than a hover tooltip.
 */

function countBySuburb(list: RealAsset[]): { id: string; name: string; n: number }[] {
  const m = new Map<string, number>();
  for (const b of list) {
    const sid = BUILDING_SUBURB_ID[b.id];
    if (sid) m.set(sid, (m.get(sid) ?? 0) + 1);
  }
  return [...m.entries()]
    .map(([id, n]) => ({ id, name: SUBURB_BY_ID[id]?.name ?? id, n }))
    .sort((a, b) => b.n - a.n);
}

/** What a layer says about council's buildings, worked out from the
 *  layer's own data: counts, where they are, and which buildings stand
 *  out. The method note sits below this, folded away. */
function LayerFindings({ layer, onOpenBuilding }: { layer: LayerDef; onOpenBuilding: (id: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const profiles = hazardProfiles();
  const mapped = MAPPED_BUILDINGS.length;
  const color = layer.hi ?? ACCENT;

  if (layer.id in FLOOD_RETURN_PERIOD_BY_LAYER) {
    const id = layer.id as FloodLayerId;
    const inside = MAPPED_BUILDINGS.filter((b) => profiles.get(b.id)!.flood.includes(id)).sort(
      (a, b) => b.insuredValue - a.insuredValue,
    );
    const value = inside.reduce((n, b) => n + b.insuredValue, 0);
    const bySuburb = countBySuburb(inside);
    const shown = showAll ? inside : inside.slice(0, 6);
    return (
      <>
        <FigureStrip>
          <Figure label="Buildings inside" value={inside.length} sub={`of ${mapped} mapped`} />
          <Figure label="Insured value inside" value={formatMoney(value)} />
        </FigureStrip>
        {bySuburb.length > 0 && (
          <Section title="By suburb">
            {bySuburb.map((r) => (
              <BarRow key={r.id} label={r.name} n={r.n} max={bySuburb[0].n} color={color} />
            ))}
          </Section>
        )}
        {inside.length > 0 && (
          <Section title="Buildings inside" right={<span className="text-sm text-ink-3">Highest value first</span>}>
            <BuildingList>
              {shown.map((b) => (
                <BuildingRow key={b.id} b={b} onOpen={onOpenBuilding} />
              ))}
            </BuildingList>
            {inside.length > shown.length || showAll ? (
              <button onClick={() => setShowAll((v) => !v)} className="mt-2 text-base font-medium text-accent hover:text-ink">
                {showAll ? 'Show fewer' : `Show all ${inside.length}`}
              </button>
            ) : null}
          </Section>
        )}
        <Section title="Catchments in this layer">
          <p className="text-base leading-[1.55] text-ink-2">{floodCatchments(layer.id).join(', ')}</p>
        </Section>
      </>
    );
  }

  if (layer.id === 'heat-vuln') {
    const withHeat = MAPPED_BUILDINGS.filter((b) => profiles.get(b.id)!.heat);
    const byCat = [4, 3, 2].map((c) => ({ c, list: withHeat.filter((b) => profiles.get(b.id)!.heat!.uhiCat === c) }));
    const maxCat = Math.max(...byCat.map((r) => r.list.length));
    const cat4BySuburb = countBySuburb(byCat[0].list);
    const topSvi = [...withHeat].sort((a, b) => profiles.get(b.id)!.heat!.svi - profiles.get(a.id)!.heat!.svi).slice(0, 5);
    const cells = [4, 3, 2].map((c) => HEAT_VULNERABILITY.filter((x) => x.uhiCat === c).length);
    return (
      <>
        <FigureStrip>
          <Figure label="In category 4" value={byCat[0].list.length} sub={`of ${withHeat.length} on the grid`} />
          <Figure label="Value in category 4" value={formatMoney(byCat[0].list.reduce((n, b) => n + b.insuredValue, 0))} />
        </FigureStrip>
        <Section title="Buildings by UHI category">
          {byCat.map((r) => (
            <BarRow key={r.c} label={`Category ${r.c}`} n={r.list.length} max={maxCat} color={lerpHex(layer.lo!, layer.hi!, (r.c - 2) / 2)} />
          ))}
          <p className="mt-1.5 text-sm text-ink-3">
            Grid cells: {cells[0]} in category 4, {cells[1]} in 3, {cells[2]} in 2.
          </p>
        </Section>
        {cat4BySuburb.length > 0 && (
          <Section title="Category 4 buildings by suburb">
            {cat4BySuburb.map((r) => (
              <BarRow key={r.id} label={r.name} n={r.n} max={cat4BySuburb[0].n} color={color} />
            ))}
          </Section>
        )}
        <Section title="Highest social vulnerability">
          <BuildingList>
            {topSvi.map((b) => (
              <BuildingRow
                key={b.id}
                b={b}
                onOpen={onOpenBuilding}
                right={<span className="num block text-base font-medium text-ink">SVI {profiles.get(b.id)!.heat!.svi.toFixed(2)}</span>}
              />
            ))}
          </BuildingList>
        </Section>
      </>
    );
  }

  if (layer.id === 'dwelling-density') {
    const cats = Object.keys(DWELLING_DENSITY_COLOR);
    const sa1Counts = cats.map((c) => Object.values(DWELLING_BY_SA1).filter((d) => d.category === c).length);
    const bCounts = cats.map((c) => MAPPED_BUILDINGS.filter((b) => profiles.get(b.id)!.density?.category === c).length);
    return (
      <>
        <Section title="SA1s by density">
          {cats.map((c, i) => (
            <BarRow key={c} label={c} n={sa1Counts[i]} max={Math.max(...sa1Counts)} color={DWELLING_DENSITY_COLOR[c]} />
          ))}
          <p className="mt-1.5 text-sm text-ink-3">{SA1S.length - Object.keys(DWELLING_BY_SA1).length} SA1s have no value in the export.</p>
        </Section>
        <Section title="Council buildings by density">
          {cats.map((c, i) => (
            <BarRow key={c} label={c} n={bCounts[i]} max={Math.max(...bCounts)} color={DWELLING_DENSITY_COLOR[c]} />
          ))}
        </Section>
      </>
    );
  }

  if (layer.id === 'priority-mix') return <PriorityFindings />;
  if (layer.id === 'major-roads') return <RoadFindings />;

  if (layer.id === 'stormwater-pipes') {
    const total = stormwaterPipesData.totalKm;
    const inFlood = stormwaterPipesData.kmInFlood as Record<'1in5' | '1in20' | '1in100', number>;
    const rows = FLOOD_LAYER_IDS.map((id) => ({ id, km: inFlood[FLOOD_RETURN_PERIOD_BY_LAYER[id]] }));
    return (
      <>
        <FigureStrip>
          <Figure label="Network" value={`${Math.round(total)} km`} sub={`${stormwaterPipesData.pipes.toLocaleString('en-AU')} pipe lines`} />
          <Figure label="In 1 in 100 extent" value={`${Math.round(inFlood['1in100'])} km`} sub={`${pct(inFlood['1in100'] / total)} of the network`} />
        </FigureStrip>
        <Section title="Pipe length inside each flood extent">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 py-1">
              <span className="w-[108px] shrink-0 text-base text-ink-2">{FLOOD_SHORT[r.id]}</span>
              <span className="h-[4px] flex-1 rounded-full bg-line">
                <span className="block h-full rounded-full" style={{ width: `${(r.km / total) * 100}%`, background: PIPE_CLASSES.find((c) => c.label.includes(FLOOD_SHORT[r.id]))!.color }} />
              </span>
              <span className="num w-14 shrink-0 text-right text-base font-medium text-ink">{r.km.toFixed(1)} km</span>
            </div>
          ))}
          <p className="mt-1.5 text-sm leading-[1.5] text-ink-3">
            Long-term flood runs. Pipe size and capacity aren't in the export, so this shows where pipes sit, not how they
            perform.
          </p>
        </Section>
      </>
    );
  }

  if (PROXIMITY_SHAPES[layer.id]) {
    const d = distancesTo(layer.id);
    const sorted = MAPPED_BUILDINGS.filter((b) => Number.isFinite(d.get(b.id))).sort((a, b) => d.get(a.id)! - d.get(b.id)!);
    if (sorted.length === 0) return null;
    const median = d.get(sorted[Math.floor(sorted.length / 2)].id)!;
    return (
      <>
        <FigureStrip>
          <Figure label="Closest building" value={formatMetres(d.get(sorted[0].id)!)} />
          <Figure label="Median distance" value={formatMetres(median)} sub={`across ${sorted.length} buildings`} />
        </FigureStrip>
        <Section title="Closest council buildings">
          <BuildingList>
            {sorted.slice(0, 6).map((b) => (
              <BuildingRow
                key={b.id}
                b={b}
                onOpen={onOpenBuilding}
                right={<span className="num block text-base font-medium text-ink">{formatMetres(d.get(b.id)!)}</span>}
              />
            ))}
          </BuildingList>
        </Section>
      </>
    );
  }

  return null;
}

function LayerInfoPanel({
  layer,
  onClose,
  onOpenBuilding,
}: {
  layer: LayerDef;
  onClose: () => void;
  onOpenBuilding: (id: string) => void;
}) {
  return (
    <RightPanelShell accent={layer.hi ?? ACCENT} eyebrow={GROUP_LABEL[layer.group]} title={layer.name} onClose={onClose}>
      <div className="px-4 py-4">
        <LayerFindings key={layer.id} layer={layer} onOpenBuilding={onOpenBuilding} />
        <details className="group mt-6 border-t border-line pt-3">
          <summary className="flex cursor-pointer list-none items-center justify-between text-base font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
            About this data
            <IconChevron size={13} className="transition-transform group-open:rotate-90" />
          </summary>
          <p className="mt-2 text-base leading-[1.55] text-ink-2">{layer.note}</p>
          <dl className="mt-2 divide-y divide-line border-t border-line">
            <FactRow label="Unit" value={layer.unit} />
            <FactRow label="Source" value={layer.source} />
          </dl>
        </details>
      </div>
    </RightPanelShell>
  );
}

/* ------------------------------------------------------------------ *
 * Use case: The Queen Elizabeth Hospital
 *
 * One site looked at three ways, all measured at the centre of the
 * hospital's grounds as mapped in OpenStreetMap (Woodville Road,
 * Woodville South): the hazards there, the assets and access around it,
 * and a risk tolerance sheet the workshop fills in. The state obstetric
 * hospitals layer's point sits about 700 m east of the hospital, so it
 * isn't used for the location. Tolerances start blank.
 * ------------------------------------------------------------------ */

const TQEH = { lat: tqehSiteData.centre[0], lng: tqehSiteData.centre[1], label: 'The Queen Elizabeth Hospital' };
const TQEH_SITE = tqehSiteData.ring as LatLngTuple[];

const floodShapeCache = new Map<FloodLayerId, Shape[]>();
function floodShapes(id: FloodLayerId): Shape[] {
  let hit = floodShapeCache.get(id);
  if (!hit) {
    hit = floodRingsFor(id).map(({ ring }) => toShape(ring, true));
    floodShapeCache.set(id, hit);
  }
  return hit;
}

interface TqehReading {
  /** Per extent: metres from the centre of the grounds to the extent
   *  (0 = the centre is inside), and the share of the grounds inside. */
  flood: { id: FloodLayerId; metres: number; share: number }[];
  heatHere: { uhiCat: number; svi: number } | null;
  nearestHeat: { uhiCat: number; svi: number; metres: number } | null;
  waterM: number;
  waterKind: 'watercourse' | 'waterbody';
  stationM: number;
  railM: number;
  pedM: number;
  /** Metres from the centre of the grounds to the nearest pipe. */
  pipeM: number;
  /** Nearest classified road to the centre of the grounds. */
  road: { name: string; roles: string[]; m: number } | null;
  /** Metres of pipe inside the grounds, and of that inside the 1 in 100 extent. */
  pipeInSiteM: number;
  pipeInSiteFloodM: number;
  suburb: Suburb | null;
  buildings: { b: RealAsset; metres: number }[];
}

/** Points 8 m apart covering the hospital grounds. */
const TQEH_SITE_POINTS: LatLngTuple[] = (() => {
  const box = bboxOf(TQEH_SITE);
  const dLat = 8 / 111_320;
  const dLng = 8 / (111_320 * Math.cos((TQEH.lat * Math.PI) / 180));
  const pts: LatLngTuple[] = [];
  for (let la = box.latLo + dLat / 2; la < box.latHi; la += dLat)
    for (let ln = box.lngLo + dLng / 2; ln < box.lngHi; ln += dLng) if (pointInRing(la, ln, TQEH_SITE)) pts.push([la, ln]);
  return pts;
})();
/** Share of the grounds inside a flood extent. */
function siteShareIn(id: FloodLayerId): number {
  const rings = floodRingsFor(id);
  const hit = TQEH_SITE_POINTS.filter(([la, ln]) => rings.some(({ ring, bbox }) => inBBox(la, ln, bbox) && pointInRing(la, ln, ring)));
  return TQEH_SITE_POINTS.length ? hit.length / TQEH_SITE_POINTS.length : 0;
}
/** How a flood extent relates to the site, in words. */
function floodAtSite(f: TqehReading['flood'][number]): string {
  if (f.share > 0) return `${pct(f.share)} of the grounds inside`;
  return `${formatMetres(f.metres)} outside the grounds' centre`;
}

/** Lines drawn from the hospital to the nearest station, water and heat
 *  cell while its case study is open, each labelled with its distance. */
interface CaseLink {
  to: LatLngTuple;
  label: string;
}
let tqehLinkCache: CaseLink[] | null = null;
function tqehLinks(): CaseLink[] {
  if (tqehLinkCache) return tqehLinkCache;
  const { lat, lng } = TQEH;
  const out: CaseLink[] = [];
  const st = nearestPointOn(lat, lng, PROXIMITY_SHAPES['train-stations']());
  if (st) out.push({ to: st.at, label: `Train station · ${formatMetres(st.m)}` });
  const wc = nearestPointOn(lat, lng, PROXIMITY_SHAPES['watercourses']());
  const wb = nearestPointOn(lat, lng, PROXIMITY_SHAPES['waterbodies']());
  const w = wc && (!wb || wc.m <= wb.m) ? { ...wc, kind: 'Watercourse' } : wb ? { ...wb, kind: 'Waterbody' } : null;
  if (w) out.push({ to: w.at, label: `${w.kind} · ${formatMetres(w.m)}` });
  let heat: { m: number; at: LatLngTuple; cat: number } | null = null;
  for (const { cell, rings } of HEAT_CELLS_WITH_BBOX) {
    const h = nearestPointOn(lat, lng, rings.map(({ ring }) => toShape(ring, true)));
    if (h && (!heat || h.m < heat.m)) heat = { ...h, cat: cell.uhiCat };
  }
  if (heat && heat.m > 0) out.push({ to: heat.at, label: `Heat cell, category ${heat.cat} · ${formatMetres(heat.m)}` });
  tqehLinkCache = out;
  return out;
}

/** Pipe length inside the hospital grounds, sampled every 2 m. */
function pipesInSite(): { pipeInSiteM: number; pipeInSiteFloodM: number } {
  const site = bboxOf(TQEH_SITE);
  const flood = floodRingsFor('flood-1in100-real');
  let inSite = 0;
  let inFlood = 0;
  for (const shape of PROXIMITY_SHAPES['stormwater-pipes']()) {
    const b = shape.bbox;
    if (b.latHi < site.latLo || b.latLo > site.latHi || b.lngHi < site.lngLo || b.lngLo > site.lngHi) continue;
    const pts = shape.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, c] = [pts[i], pts[i + 1]];
      const len = Math.hypot((c[1] - a[1]) * M_PER_DEG * Math.cos((a[0] * Math.PI) / 180), (c[0] - a[0]) * M_PER_DEG);
      const steps = Math.max(1, Math.round(len / 2));
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const la = a[0] + t * (c[0] - a[0]);
        const ln = a[1] + t * (c[1] - a[1]);
        if (!pointInRing(la, ln, TQEH_SITE)) continue;
        inSite += len / steps;
        if (flood.some(({ ring, bbox }) => inBBox(la, ln, bbox) && pointInRing(la, ln, ring))) inFlood += len / steps;
      }
    }
  }
  return { pipeInSiteM: inSite, pipeInSiteFloodM: inFlood };
}

/** Sizes the case study's map area can be drawn at. A display window
 *  only: no reading is measured against it. */
const TQEH_AREA_OPTIONS = [400, 600, 1000] as const;
type TqehRadius = (typeof TQEH_AREA_OPTIONS)[number];

function circleRing(lat: number, lng: number, m: number, n = 72): LatLngTuple[] {
  const dLat = m / 111_320;
  const dLng = m / (111_320 * Math.cos((lat * Math.PI) / 180));
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    return [lat + dLat * Math.sin(t), lng + dLng * Math.cos(t)] as LatLngTuple;
  });
}

/** Sutherland-Hodgman: a ring cut to a convex window (the circle). */
function clipRing(subject: LatLngTuple[], clip: LatLngTuple[]): LatLngTuple[] {
  let out = subject;
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    // Counter-clockwise window (circleRing runs that way in lat/lng).
    const inside = (p: LatLngTuple) => (b[1] - a[1]) * (p[0] - a[0]) - (b[0] - a[0]) * (p[1] - a[1]) >= 0;
    const cross = (p: LatLngTuple, q: LatLngTuple): LatLngTuple => {
      const x1 = p[1], y1 = p[0], x2 = q[1], y2 = q[0], x3 = a[1], y3 = a[0], x4 = b[1], y4 = b[0];
      const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      const t = d === 0 ? 0 : ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
      return [y1 + t * (y2 - y1), x1 + t * (x2 - x1)];
    };
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(cross(prev, cur));
      }
    }
  }
  return out;
}

/** What the case study can draw around the site, each cut to the area. */
type CaseLayer =
  | 'flood100'
  | 'flood20'
  | 'flood5'
  | 'heat4'
  | 'heat3'
  | 'heat2'
  | 'pipes'
  | 'roads'
  | 'buildings'
  | 'lines'
  | 'focus';
/** The heat grid's own categories, 2 (coolest in the grid) to 4 (hottest). */
const HEAT_CASE_KEYS = { heat4: 4, heat3: 3, heat2: 2 } as const;

interface CaseArea {
  radius: number;
  ring: LatLngTuple[];
  flood: Record<FloodLayerId, LatLngTuple[][]>;
  heat: { ring: LatLngTuple[]; cat: number; svi: number }[];
  pipes: Record<PipeClass, LatLngTuple[][]>;
  roads: { line: LatLngTuple[]; role: string; name: string | null }[];
  buildings: { lat: number; lng: number; names: string[]; ids: string[] }[];
}

const tqehAreaCache = new Map<number, CaseArea>();
/** Every local layer within \`radius\` metres of the hospital. */
function tqehArea(radius: number): CaseArea {
  const hit = tqehAreaCache.get(radius);
  if (hit) return hit;
  const ring = circleRing(TQEH.lat, TQEH.lng, radius);
  const box = bboxOf(ring);
  const touches = (b: RingBBox) => !(b.latHi < box.latLo || b.latLo > box.latHi || b.lngHi < box.lngLo || b.lngLo > box.lngHi);
  const kx = M_PER_DEG * Math.cos((TQEH.lat * Math.PI) / 180);
  const within = ([la, ln]: LatLngTuple) => Math.hypot((ln - TQEH.lng) * kx, (la - TQEH.lat) * M_PER_DEG) <= radius;

  const flood = Object.fromEntries(
    FLOOD_LAYER_IDS.map((id) => [
      id,
      floodRingsFor(id)
        .filter(({ bbox }) => touches(bbox))
        .map(({ ring: r }) => clipRing(r, ring))
        .filter((r) => r.length >= 3),
    ]),
  ) as Record<FloodLayerId, LatLngTuple[][]>;

  const heat = HEAT_CELLS_WITH_BBOX.flatMap(({ cell, rings }) =>
    rings
      .filter(({ bbox }) => touches(bbox))
      .map(({ ring: r }) => ({ ring: clipRing(r, ring), cat: cell.uhiCat, svi: cell.svi }))
      .filter((h) => h.ring.length >= 3),
  );

  // Pipes: the stretches inside the area, coloured by flood class.
  const pipes = pipeRuns(within);

  // Roads: the stretches inside the area, kept with their role.
  const roads: CaseArea['roads'] = [];
  for (const rd of ROADS) {
    let run: LatLngTuple[] = [];
    const flush = () => {
      if (run.length >= 2) roads.push({ line: run, role: rd.role, name: rd.name });
      run = [];
    };
    for (const pt of rd.line) {
      if (within(pt)) run.push(pt);
      else flush();
    }
    flush();
  }

  const byPoint = new Map<string, { lat: number; lng: number; names: string[]; ids: string[] }>();
  for (const b of MAPPED_BUILDINGS) {
    const loc = BUILDING_LOCATION[b.id];
    if (!within([loc.lat, loc.lng])) continue;
    const key = `${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}`;
    const g = byPoint.get(key) ?? { lat: loc.lat, lng: loc.lng, names: [], ids: [] };
    g.names.push(b.name);
    g.ids.push(b.id);
    byPoint.set(key, g);
  }

  const out: CaseArea = { radius, ring, flood, heat, pipes, roads, buildings: [...byPoint.values()] };
  tqehAreaCache.set(radius, out);
  return out;
}

/** Grounds area in hectares, from the OSM outline. */
function siteHectares(): number {
  const kx = M_PER_DEG * Math.cos((TQEH.lat * Math.PI) / 180);
  let a = 0;
  for (let i = 0; i < TQEH_SITE.length; i++) {
    const p = TQEH_SITE[i];
    const q = TQEH_SITE[(i + 1) % TQEH_SITE.length];
    a += (p[1] * kx) * (q[0] * M_PER_DEG) - (q[1] * kx) * (p[0] * M_PER_DEG);
  }
  return Math.abs(a) / 2 / 10_000;
}

let tqehCache: TqehReading | null = null;
function tqehReading(): TqehReading {
  if (tqehCache) return tqehCache;
  const { lat, lng } = TQEH;
  const near = (id: string) => nearestMetres(lat, lng, PROXIMITY_SHAPES[id]());
  let heatHere: TqehReading['heatHere'] = null;
  let nearestHeat: TqehReading['nearestHeat'] = null;
  for (const { cell, rings } of HEAT_CELLS_WITH_BBOX) {
    const m = Math.min(...rings.map(({ ring }) => nearestMetres(lat, lng, [toShape(ring, true)])));
    if (m === 0 && !heatHere) heatHere = { uhiCat: cell.uhiCat, svi: cell.svi };
    if (!nearestHeat || m < nearestHeat.metres) nearestHeat = { uhiCat: cell.uhiCat, svi: cell.svi, metres: m };
  }
  const wc = near('watercourses');
  const wb = near('waterbodies');
  const sa2 = SA2_BOUNDARIES.find((s) => pointInRing(lat, lng, s.ring));
  tqehCache = {
    flood: FLOOD_LAYER_IDS.map((id) => ({ id, metres: nearestMetres(lat, lng, floodShapes(id)), share: siteShareIn(id) })),
    heatHere,
    nearestHeat,
    waterM: Math.min(wc, wb),
    waterKind: wc <= wb ? 'watercourse' : 'waterbody',
    stationM: near('train-stations'),
    railM: near('railways'),
    pedM: near('pedestrian-network'),
    pipeM: near('stormwater-pipes'),
    road: (() => {
      let best: { name: string; roles: string[]; m: number } | null = null;
      for (const rd of ROADS) {
        const m = nearestMetres(lat, lng, [toShape(rd.line)]);
        if (!best || m < best.m) best = { name: roadName(rd.name), roles: roadRoles(rd.name), m };
      }
      return best;
    })(),
    ...pipesInSite(),
    suburb: sa2 ? SUBURB_BY_ID[SA2_CODE_TO_SUBURB_ID[sa2.code]] ?? null : null,
    buildings: MAPPED_BUILDINGS.map((b) => {
      const loc = BUILDING_LOCATION[b.id];
      return { b, metres: nearestMetres(lat, lng, [toShape([[loc.lat, loc.lng]])]) };
    }).sort((a, z) => a.metres - z.metres),
  };
  return tqehCache;
}

const TOLERANCE_KEY = 'cocs-tqeh-tolerance-v1';
const TOLERANCE_SAVED_EVENT = 'cocs-tolerance-saved';
type ToleranceSheet = Record<string, { tolerance: string; notes: string }>;
function loadTolerance(): ToleranceSheet {
  try {
    return JSON.parse(localStorage.getItem(TOLERANCE_KEY) ?? '{}') as ToleranceSheet;
  } catch {
    return {};
  }
}

function TabStrip<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="mb-4 flex gap-4 border-b border-line" role="tablist">
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={`-mb-px whitespace-nowrap border-b-2 pb-2 text-base transition-colors ${on ? 'border-accent font-semibold text-ink' : 'border-transparent text-ink-3 hover:text-ink'}`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** The case study as a standalone, printable HTML report: every reading
 *  from the three sections plus the tolerance sheet as filled in so far. */
function downloadTqehReport(r: TqehReading, sel: ScenarioSel) {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const row = (k: string, v: string) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  const sheet = loadTolerance();
  const groups: { name: string; n: number; metres: number }[] = [];
  for (const { b, metres } of r.buildings) {
    const g = groups.find((x) => x.name === b.name);
    if (g) g.n++;
    else groups.push({ name: b.name, n: 1, metres });
  }
  const heatRow = r.heatHere
    ? row('Heat cell', `UHI category ${r.heatHere.uhiCat}, SVI ${r.heatHere.svi.toFixed(2)}`)
    : r.nearestHeat
      ? row(
          'Nearest heat cell',
          `${formatMetres(r.nearestHeat.metres)} away, UHI category ${r.nearestHeat.uhiCat}, SVI ${r.nearestHeat.svi.toFixed(2)}`,
        )
      : '';
  const indexRows = r.suburb
    ? INDEXES.filter((d) => d.group !== 'Assets')
        .map((d) => {
          const x = rankSuburbs(d, sel).find((y) => y.s.id === r.suburb!.id)!;
          return row(d.label, x.v === null ? 'n/a' : `${d.format(x.v)} (${ordinal(x.rank!)} of 8)`);
        })
        .join('')
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>TQEH case study</title>
<style>body{font:14px/1.5 'Public Sans',system-ui,sans-serif;color:#14201F;max-width:760px;margin:40px auto;padding:0 20px}
h1{font-size:24px;margin:0}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid #E2E7E7;padding-bottom:4px}
.sub{color:#7E8D8C;margin:4px 0 0}table{width:100%;border-collapse:collapse}
th,td{text-align:left;vertical-align:top;padding:5px 8px 5px 0;border-bottom:1px solid #EEF2F2}
th{width:40%;font-weight:500;color:#4A5A59}.note{color:#7E8D8C;font-size:12px;margin-top:24px}</style></head><body>
<h1>The Queen Elizabeth Hospital</h1>
<p class="sub">Case study, CoCS Climate Risk Tolerance Tool. Woodville South${r.suburb ? ` (${esc(r.suburb.name)} SA2)` : ''}. Generated ${new Date().toLocaleDateString('en-AU')}.</p>
<h2>Hazard</h2><table>
${r.flood.map((f) => row(`Flood ${FLOOD_SHORT[f.id]}`, floodAtSite(f))).join('')}
${heatRow}
${row('Nearest water', `${formatMetres(r.waterM)} to a ${r.waterKind}`)}
</table>
${r.suburb ? `<h2>${esc(r.suburb.name)} indexes${sel.scenario === 'today' ? '' : `, ${esc(scenarioName(sel))} (speculative placeholder figures)`}</h2><table>${indexRows}</table>` : ''}
<h2>Assets and access</h2><table>
${row('Train station', formatMetres(r.stationM))}${row('Railway', formatMetres(r.railM))}${row('Pedestrian network', formatMetres(r.pedM))}${row('Stormwater pipe in the grounds', `${Math.round(r.pipeInSiteM)} m, of which ${Math.round(r.pipeInSiteFloodM)} m in the 1 in 100 extent`)}${row('Nearest stormwater pipe', `${formatMetres(r.pipeM)} from the centre`)}${r.road ? row('Nearest major road', `${r.road.name}, ${formatMetres(r.road.m)}`) : ''}${row('Local streets, pipe sizes, people', 'Waiting on council data')}
</table>
<h2>Nearest council buildings</h2><table>
${groups
  .slice(0, 10)
  .map((g) => row(g.n > 1 ? `${g.name} (${g.n} buildings)` : g.name, formatMetres(g.metres)))
  .join('')}
</table>
<h2>Risk tolerance</h2><table>
${CONSEQUENCE_CATEGORIES.map((c) => row(c.name, [sheet[c.name]?.tolerance || 'Not set', sheet[c.name]?.notes].filter(Boolean).join(' | '))).join('')}
</table>
<p class="note">Flood extents are long-term runs as labelled in the supplied files (River Torrens to 2050), not current conditions. Flood data is partial: 1 in 20 covers three catchments and 1 in 5 has no Trimmer data. Site from OpenStreetMap (amenity=hospital); readings at the centre of the grounds. Indexes are measured from the supplied layers, not scored.</p>
</body></html>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = 'tqeh-case-study.html';
  a.click();
  URL.revokeObjectURL(a.href);
}

/** The case studies available, each a site the map zooms to. */
const CASE_STUDIES = [
  {
    id: 'tqeh',
    name: 'The Queen Elizabeth Hospital',
    where: 'Woodville South · state hospital',
    point: TQEH,
    // Layers turned on when the case opens (and off when it closes).
    // None: the case draws its own local flood extent instead.
    layers: [] as string[],
  },
] as const;
type CaseId = (typeof CASE_STUDIES)[number]['id'];

function CasesTab({
  caseId,
  setCaseId,
  show,
  setShow,
  radius,
  setRadius,
  setView,
  onGuide,
}: {
  caseId: CaseId | null;
  setCaseId: (id: CaseId | null) => void;
  show: Set<CaseLayer>;
  setShow: (v: Set<CaseLayer>) => void;
  radius: TqehRadius;
  setRadius: (v: TqehRadius) => void;
  setView: (v: CaseView) => void;
  onGuide: () => void;
}) {
  const c = CASE_STUDIES.find((x) => x.id === caseId);
  if (!c) {
    const r = tqehReading();
    const inside = [...r.flood].sort((a, z) => z.share - a.share).find((f) => f.share > 0);
    return (
      <div className="px-3 py-4">
        <PanelHeading>Case studies</PanelHeading>
        <BuildingList>
          {CASE_STUDIES.map((x) => (
            <button
              key={x.id}
              onClick={() => setCaseId(x.id)}
              className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-surface-2"
            >
              <span className="min-w-0">
                <span className="block text-lg font-medium text-ink">{x.name}</span>
                <span className="mt-0.5 block text-sm text-ink-3">
                  {x.where}
                  {inside ? ` · ${pct(inside.share)} of grounds in the ${FLOOD_SHORT[inside.id]} flood extent` : ''}
                </span>
              </span>
              <IconChevron size={13} className="shrink-0 text-ink-3" />
            </button>
          ))}
        </BuildingList>
      </div>
    );
  }
  return (
    <CaseControls
      onBack={() => setCaseId(null)}
      name={c.name}
      show={show}
      setShow={setShow}
      radius={radius}
      setRadius={setRadius}
      setView={setView}
      onGuide={onGuide}
    />
  );
}

const CASE_LAYER_DEFS: { id: CaseLayer; label: string }[] = [
  { id: 'flood100', label: 'Flood 1 in 100 (long-term)' },
  { id: 'flood20', label: 'Flood 1 in 20 (long-term)' },
  { id: 'flood5', label: 'Flood 1 in 5 (long-term)' },
  { id: 'heat4', label: 'UHI category 4' },
  { id: 'heat3', label: 'UHI category 3' },
  { id: 'heat2', label: 'UHI category 2' },
  { id: 'pipes', label: 'Stormwater pipes' },
  { id: 'roads', label: 'Major roads' },
  { id: 'buildings', label: 'Council buildings' },
  { id: 'lines', label: 'Distance lines' },
];

/** The legend and switch drawing for each case layer, as on the map. */
function CaseGlyph({ id }: { id: CaseLayer }) {
  if (id === 'flood100' || id === 'flood20' || id === 'flood5') {
    const l = LAYER_BY_ID[{ flood100: 'flood-1in100-real', flood20: 'flood-1in20-real', flood5: 'flood-1in5-real' }[id]];
    return <LayerGlyph l={l} />;
  }
  if (id === 'heat4' || id === 'heat3' || id === 'heat2') {
    const def = LAYER_BY_ID['heat-vuln'];
    return (
      <svg width="18" height="12" viewBox="0 0 18 12" className="shrink-0" aria-hidden>
        <rect x="1.5" y="2" width="15" height="8" fill={lerpHex(def.lo!, def.hi!, (HEAT_CASE_KEYS[id] - 2) / 2)} stroke="#7F1D1D" strokeWidth="0.5" />
      </svg>
    );
  }
  if (id === 'pipes') return <LayerGlyph l={LAYER_BY_ID['stormwater-pipes']} />;
  if (id === 'roads') return <LayerGlyph l={LAYER_BY_ID['major-roads']} />;
  if (id === 'buildings') {
    return (
      <svg width="18" height="12" viewBox="0 0 18 12" className="shrink-0" aria-hidden>
        <circle cx="9" cy="6" r="4.5" fill={ACCENT} stroke="#fff" strokeWidth="1.2" />
      </svg>
    );
  }
  return (
    <svg width="18" height="12" viewBox="0 0 18 12" className="shrink-0" aria-hidden>
      <path d="M1.5 6 H13" stroke="#14201F" strokeWidth="1.6" strokeDasharray="3 2.5" />
      <circle cx="14.5" cy="6" r="2.5" fill="#14201F" />
    </svg>
  );
}

type CaseView = 'hazard' | 'assets' | 'tolerance';

/** A numbered step heading, so the case reads top to bottom in the order
 *  you use it. */
function StepHeading({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="mb-2.5 flex items-start gap-2.5">
      <span className="num mt-[1px] flex h-5 w-5 shrink-0 items-center justify-center rounded-[3px] bg-ink text-xs font-semibold text-white">
        {n}
      </span>
      <span className="min-w-0">
        <span className="block text-xl font-bold leading-tight text-ink">{title}</span>
        {hint && <span className="mt-0.5 block text-sm text-ink-3">{hint}</span>}
      </span>
    </div>
  );
}

function CaseSwitchRow({
  id,
  label,
  detail,
  on,
  onToggle,
  color,
}: {
  id: CaseLayer;
  label: string;
  detail: string;
  on: boolean;
  onToggle: () => void;
  color?: string;
}) {
  return (
    <button onClick={onToggle} aria-pressed={on} className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2">
      <CaseGlyph id={id} />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-base ${on ? 'font-medium text-ink' : 'text-ink-2'}`}>{label}</span>
      </span>
      <Switch on={on} color={color} />
    </button>
  );
}

/** Left panel for an open case, in the order it's used: set the area,
 *  choose what's drawn, then the report steps on the right. */
function CaseControls({
  onBack,
  name,
  show,
  setShow,
  radius,
  setRadius,
  setView,
  onGuide,
}: {
  onBack: () => void;
  name: string;
  show: Set<CaseLayer>;
  setShow: (v: Set<CaseLayer>) => void;
  radius: TqehRadius;
  setRadius: (v: TqehRadius) => void;
  setView: (v: CaseView) => void;
  onGuide: () => void;
}) {
  const r = tqehReading();
  const area = tqehArea(radius);
  const { sel: scenarioSel } = React.useContext(ScenarioContext);
  const share = (id: FloodLayerId) => r.flood.find((f) => f.id === id)!.share;
  const heatDetail = (cat: number) => {
    const n = area.heat.filter((h) => h.cat === cat).length;
    const nearest = r.nearestHeat && r.nearestHeat.uhiCat === cat && !r.heatHere ? `, nearest ${formatMetres(r.nearestHeat.metres)}` : '';
    return n ? `${n} cells within ${radius} m${nearest}` : `None within ${radius} m`;
  };
  const detail: Record<CaseLayer, string> = {
    flood100: `${pct(share('flood-1in100-real'))} of the grounds · long-term run`,
    flood20: `${pct(share('flood-1in20-real'))} of the grounds · long-term run`,
    flood5: `${pct(share('flood-1in5-real'))} of the grounds · long-term run`,
    heat4: heatDetail(4),
    heat3: heatDetail(3),
    heat2: heatDetail(2),
    pipes: `${Math.round(r.pipeInSiteM)} m in the grounds`,
    roads: r.road ? `${r.road.name}, ${formatMetres(r.road.m)}` : 'None nearby',
    buildings: `${area.buildings.reduce((n, g) => n + g.ids.length, 0)} within ${radius} m`,
    lines: 'To the nearest station, water and heat cell',
    focus: 'Fades the map outside the area',
  };
  const toggle = (id: CaseLayer) => {
    const next = new Set(show);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setShow(next);
  };
  // The group heading already says long-term, so the rows don't repeat it.
  const label = (id: CaseLayer) => CASE_LAYER_DEFS.find((d) => d.id === id)!.label.replace(' (long-term)', '');
  // Re-read the saved sheet whenever the report's Save is pressed.
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener(TOLERANCE_SAVED_EVENT, on);
    return () => window.removeEventListener(TOLERANCE_SAVED_EVENT, on);
  }, []);
  const sheet = typeof window === 'undefined' ? {} : loadTolerance();
  const setCount = CONSEQUENCE_CATEGORIES.filter((c) => sheet[c.name]?.tolerance.trim()).length;
  const group = (ids: CaseLayer[], color?: string) => (
    <div
      className="divide-y divide-line overflow-hidden rounded-[4px] border border-line"
      style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}
    >
      {ids.map((id) => (
        <CaseSwitchRow key={id} id={id} label={label(id)} detail={detail[id]} on={show.has(id)} onToggle={() => toggle(id)} color={color} />
      ))}
    </div>
  );
  const groupLabel = (text: string, color: string, first = false) => (
    <div className={`mb-1 ${first ? '' : 'mt-2.5'} flex items-center gap-1.5 text-sm font-semibold`} style={{ color }}>
      <span className="h-[8px] w-[8px] rounded-[2px]" style={{ background: color }} />
      {text}
    </div>
  );
  const linkBtn = 'flex-1 rounded-[3px] border border-line px-2 py-1.5 text-base font-medium text-ink hover:border-ink-3';

  return (
    <div className="px-3 py-4">
      <BackBar onBack={onBack} parent="Case studies" title={name} />
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-base leading-[1.5] text-ink-2">Work down the steps. The report opens on the right.</p>
        <button onClick={onGuide} className="shrink-0 text-base font-medium text-accent hover:text-ink">
          How this works
        </button>
      </div>

      <section className="mt-6" data-tour="case-area">
        <StepHeading n={1} title="Set the area" hint="How much of the surroundings to look at" />
        <div className="flex gap-1.5">
          {TQEH_AREA_OPTIONS.map((m) => (
            <button
              key={m}
              onClick={() => setRadius(m)}
              aria-pressed={radius === m}
              className={`num flex-1 rounded-[3px] border px-2 py-1.5 text-base transition-colors ${radius === m ? 'border-accent font-semibold text-ink' : 'border-line text-ink-2 hover:border-ink-3'}`}
            >
              {m < 1000 ? `${m} m` : `${m / 1000} km`}
            </button>
          ))}
        </div>
        <button
          onClick={() => toggle('focus')}
          aria-pressed={show.has('focus')}
          className="mt-2 flex w-full items-center gap-2.5 rounded-[4px] border border-line px-3 py-2 text-left hover:bg-surface-2"
        >
          <IconFocus size={16} className="shrink-0 text-ink-2" />
          <span className="min-w-0 flex-1">
            <span className={`block text-base ${show.has('focus') ? 'font-medium text-ink' : 'text-ink-2'}`}>Focus on this area</span>
          </span>
          <Switch on={show.has('focus')} />
        </button>
      </section>

      <section className="mt-6" data-tour="case-layers">
        <StepHeading n={2} title="Choose what's on the map" />
        <div className="mb-1 text-sm font-semibold text-ink-2">Hazards</div>
        {groupLabel('Flood', HAZARD_COLOR.flood, true)}
        {group(['flood100', 'flood20', 'flood5'], HAZARD_COLOR.flood)}
        {groupLabel('Heat', HAZARD_COLOR.heat)}
        {group(['heat4', 'heat3', 'heat2'], HAZARD_COLOR.heat)}
        <div className="mb-1 mt-3 text-sm font-semibold text-ink-2">Assets and infrastructure</div>
        {group(['roads', 'pipes', 'buildings'], HAZARD_COLOR.assets)}
        <div className="mb-1 mt-3 text-sm font-semibold text-ink-2">Measurements</div>
        {group(['lines'])}
      </section>

      <section className="mt-6" data-tour="case-report-steps">
        <StepHeading n={3} title="Read the report" hint="Opens that part of the report on the right" />
        <div className="flex gap-1.5">
          <button onClick={() => setView('hazard')} className={linkBtn}>
            Hazard
          </button>
          <button onClick={() => setView('assets')} className={linkBtn}>
            Assets
          </button>
        </div>
      </section>

      <section className="mt-6">
        <StepHeading n={4} title="Record risk tolerance" hint={`${setCount} of ${CONSEQUENCE_CATEGORIES.length} categories set`} />
        <button onClick={() => setView('tolerance')} className={`${linkBtn} w-full`}>
          Open the tolerance sheet
        </button>
      </section>

      <section className="mt-6">
        <StepHeading n={5} title="Download" hint="Every reading and the tolerance sheet, as one file" />
        <button
          onClick={() => downloadTqehReport(r, scenarioSel)}
          className="w-full rounded-[3px] bg-accent px-3 py-2 text-base font-semibold text-white hover:bg-[#005963]"
        >
          Download report
        </button>
      </section>

      <details className="group mt-6 border-t border-line pt-3">
        <summary className="flex cursor-pointer list-none items-center justify-between text-base font-medium text-ink-2 hover:text-ink [&::-webkit-details-marker]:hidden">
          About the site
          <IconChevron size={13} className="transition-transform group-open:rotate-90" />
        </summary>
        <dl className="mt-1 divide-y divide-line">
          <FactRow label="Address" value="Woodville Road, Woodville South" />
          {r.suburb && <FactRow label="SA2" value={r.suburb.name} />}
          <FactRow label="Grounds" value={`${siteHectares().toFixed(1)} ha`} />
          <FactRow label="Operator" value="State health service, not a council asset" />
          <FactRow label="Outline" value="OpenStreetMap (amenity=hospital)" />
        </dl>
      </details>
    </div>
  );
}

/** The case study guide: the five steps, pointed out where they are. */
const CASE_TOUR_STEPS: TourStep[] = [
  {
    selector: '[data-tour="case-area"]',
    placement: 'right',
    title: '1. Set the area',
    body: 'Pick how far around the hospital to look: 400 m, 600 m or 1 km. The map fits to it, and Focus fades everything outside.',
  },
  {
    selector: '[data-tour="case-layers"]',
    placement: 'right',
    title: "2. Choose what's on the map",
    body: 'Hazards first: flood extents and UHI categories 4, 3 and 2. Then assets and infrastructure (roads, pipes, council buildings), then the distance lines.',
  },
  {
    selector: '[data-tour="map"]',
    placement: 'top',
    title: 'The map',
    body: 'Only the chosen area is drawn. Hover a road or heat cell for its detail, or click a council building to open its profile.',
  },
  {
    selector: '[data-tour="case-glance"]',
    placement: 'left',
    title: '3. Read the report',
    body: 'The headline readings for the site. Below them, the Hazard and Assets tabs hold the detail.',
  },
  {
    selector: '[data-tour="case-tabs"]',
    placement: 'left',
    title: '4. Record risk tolerance',
    body: "The Risk tolerance tab lists council's seven consequence categories. Click one to record the tolerance agreed for this site.",
  },
  {
    selector: '[data-tour="case-download"]',
    placement: 'left',
    title: '5. Download',
    body: 'Saves every reading and the tolerance sheet as one report file you can print or share.',
  },
];

function TqehTab({
  showLayers,
  onOpenBuilding,
  onOpenBuildings,
  onOpenSuburb,
  view,
  setView,
}: {
  showLayers: (ids: string[]) => void;
  onOpenBuilding: (id: string) => void;
  onOpenBuildings: (ids: string[]) => void;
  onOpenSuburb: (id: string) => void;
  view: CaseView;
  setView: (v: CaseView) => void;
}) {
  const { sel: scenarioSel } = React.useContext(ScenarioContext);
  const r = tqehReading();
  const inside = [...r.flood].sort((a, z) => z.share - a.share).find((f) => f.share > 0);

  return (
    <div>
      <p className="text-base leading-[1.55] text-ink-2">
        Woodville South{r.suburb ? `, ${r.suburb.name} SA2` : ''}. A state hospital, not a council asset. Readings are
        measured at the centre of its grounds (outlined on the map).
      </p>

      {/* At a glance: the four readings people ask about first. */}
      <div data-tour="case-glance" className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[4px] border border-line bg-line">
        <Glance
          color={HAZARD_COLOR.flood}
          label="Flood"
          value={inside ? `${pct(inside.share)} of grounds` : 'Outside'}
          sub={inside ? `in the ${FLOOD_SHORT[inside.id]} extent` : 'every mapped extent'}
        />
        <Glance
          color={HAZARD_COLOR.heat}
          label="Urban heat"
          value={r.heatHere ? `Category ${r.heatHere.uhiCat}` : r.nearestHeat ? `Category ${r.nearestHeat.uhiCat}` : 'n/a'}
          sub={r.heatHere ? 'at the site' : r.nearestHeat ? `nearest cell, ${formatMetres(r.nearestHeat.metres)}` : 'no heat data'}
        />
        <Glance color={HAZARD_COLOR.water} label="Nearest water" value={formatMetres(r.waterM)} sub={`to a ${r.waterKind}`} />
        <Glance color={HAZARD_COLOR.assets} label="Train station" value={formatMetres(r.stationM)} sub="nearest" />
      </div>

      <div className="mt-6" data-tour="case-tabs">
        <TabStrip
          value={view}
          onChange={setView}
          tabs={[
            { id: 'hazard', label: 'Hazard' },
            { id: 'assets', label: 'Assets' },
            { id: 'tolerance', label: 'Risk tolerance' },
          ]}
        />
      </div>
      {view === 'hazard' && <TqehHazard r={r} showLayers={showLayers} onOpenSuburb={onOpenSuburb} />}
      {view === 'assets' && (
        <TqehAssets r={r} showLayers={showLayers} onOpenBuilding={onOpenBuilding} onOpenBuildings={onOpenBuildings} />
      )}
      {view === 'tolerance' && <TqehTolerance />}

      <div data-tour="case-download" className="mt-8 flex items-center justify-between gap-3 border-t border-line pt-3">
        <span className="text-sm leading-[1.45] text-ink-3">All readings and the tolerance sheet, as one file.</span>
        <button
          onClick={() => downloadTqehReport(r, scenarioSel)}
          className="shrink-0 rounded-[3px] border border-line px-2.5 py-1.5 text-base font-medium text-ink hover:border-ink-3"
        >
          Download report
        </button>
      </div>
    </div>
  );
}

function Glance({ label, value, sub, color }: { label: string; value: string; sub: string; color?: string }) {
  return (
    <div className="bg-white px-3 py-2.5" style={color ? { boxShadow: `inset 0 3px 0 ${color}` } : undefined}>
      <div className="text-sm font-medium" style={{ color: color ?? '#7E8D8C' }}>
        {label}
      </div>
      <div className="num mt-0.5 text-xl font-semibold leading-tight text-ink">{value}</div>
      <div className="mt-0.5 text-sm text-ink-3">{sub}</div>
    </div>
  );
}

function TqehHazard({
  r,
  showLayers,
  onOpenSuburb,
}: {
  r: TqehReading;
  showLayers: (ids: string[]) => void;
  onOpenSuburb: (id: string) => void;
}) {
  const { sel: scenario } = React.useContext(ScenarioContext);
  return (
    <>
      <Section title="Flood" color={HAZARD_COLOR.flood}>
        <dl className="divide-y divide-line">
          {r.flood.map((f) => (
            <div key={f.id} className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className="text-base text-ink-2">{FLOOD_SHORT[f.id]}</dt>
              <dd className={`num text-right text-base ${f.share > 0 ? 'font-semibold text-ink' : 'text-ink-2'}`}>
                {floodAtSite(f)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-1.5 text-sm leading-[1.5] text-ink-3">
          Long-term runs (River Torrens to 2050), not current conditions. 1 in 20 covers three catchments; 1 in 5 has
          no Trimmer data yet.
        </p>
      </Section>

      <Section title="Heat" color={HAZARD_COLOR.heat}>
        <dl className="divide-y divide-line">
          {r.heatHere ? (
            <>
              <FactRow label="UHI category" value={`${r.heatHere.uhiCat} of 4, at the site`} />
              <FactRow label="SVI" value={r.heatHere.svi.toFixed(2)} />
            </>
          ) : r.nearestHeat ? (
            <>
              <FactRow label="At the site" value="Not covered by the heat grid" />
              <FactRow label="Nearest cell" value={`${formatMetres(r.nearestHeat.metres)} away`} />
              <FactRow label="UHI category" value={`${r.nearestHeat.uhiCat} of 4`} />
              <FactRow label="SVI" value={r.nearestHeat.svi.toFixed(2)} />
            </>
          ) : (
            <FactRow label="At the site" value="No heat data nearby" />
          )}
        </dl>
      </Section>

      <Section title="Water" color={HAZARD_COLOR.water}>
        <dl className="divide-y divide-line">
          <FactRow label="Nearest" value={`${formatMetres(r.waterM)} to a ${r.waterKind}`} />
        </dl>
      </Section>

      {r.suburb && (
        <Section
          title={`${r.suburb.name} compared`}
          right={
            <button onClick={() => onOpenSuburb(r.suburb!.id)} className="text-sm font-medium text-accent hover:text-ink">
              Open in Place
            </button>
          }
        >
          <p className="-mt-1 mb-1 text-sm text-ink-3">
            The hospital's suburb, ranked against the other seven.
            {scenario.scenario !== 'today' && (
              <span className="font-medium text-[#92400E]"> Showing {scenarioName(scenario)}, speculative.</span>
            )}
          </p>
          <dl className="divide-y divide-line">
            {INDEXES.filter((d) => d.group !== 'Assets').map((def) => {
              const row = rankSuburbs(def, scenario).find((x) => x.s.id === r.suburb!.id)!;
              return (
                <div key={def.id} className="flex items-baseline gap-3 py-1.5">
                  <dt className="min-w-0 flex-1 truncate text-base text-ink-2" title={def.how}>
                    {def.short}
                  </dt>
                  <dd className="num text-base font-medium text-ink">{row.v === null ? 'n/a' : def.format(row.v)}</dd>
                  <dd className="num w-9 text-right text-sm text-ink-3">{row.rank ? ordinal(row.rank) : ''}</dd>
                </div>
              );
            })}
          </dl>
        </Section>
      )}
    </>
  );
}

function TqehAssets({
  r,
  showLayers,
  onOpenBuilding,
  onOpenBuildings,
}: {
  r: TqehReading;
  showLayers: (ids: string[]) => void;
  onOpenBuilding: (id: string) => void;
  onOpenBuildings: (ids: string[]) => void;
}) {
  const [n, setN] = useState(6);
  // Same-named buildings (one site) as one row, at the closest one's distance.
  const groups: { name: string; items: RealAsset[]; metres: number }[] = [];
  for (const { b, metres } of r.buildings) {
    const g = groups.find((x) => x.name === b.name);
    if (g) g.items.push(b);
    else groups.push({ name: b.name, items: [b], metres });
  }
  const shown = groups.slice(0, n);
  const dist = (m: number) => <span className="num shrink-0 pt-[1px] text-base font-medium text-ink">{formatMetres(m)}</span>;
  return (
    <>
      <Section title="Access" color={HAZARD_COLOR.assets}>
        <dl className="divide-y divide-line">
          <FactRow label="Train station" value={formatMetres(r.stationM)} />
          <FactRow label="Railway" value={formatMetres(r.railM)} />
          <FactRow label="Pedestrian route" value={formatMetres(r.pedM)} />
          {r.road && (
            <FactRow
              label="Major road"
              value={`${r.road.name}, ${formatMetres(r.road.m)}${r.road.roles.length ? ` (${r.road.roles.join(', ').toLowerCase()})` : ''}`}
            />
          )}
        </dl>
      </Section>

      <Section title="Stormwater" color={HAZARD_COLOR.assets}>
        <dl className="divide-y divide-line">
          <FactRow label="In the grounds" value={`${Math.round(r.pipeInSiteM)} m of pipe`} />
          <FactRow label="In flood extent" value={`${Math.round(r.pipeInSiteFloodM)} m in the 1 in 100 extent`} />
          <FactRow label="Nearest pipe" value={`${formatMetres(r.pipeM)} from the centre`} />
        </dl>
        <p className="mt-1.5 text-sm leading-[1.5] text-ink-3">Pipe size and capacity weren't in the export.</p>
      </Section>

      <Section title="Waiting on council">
        <p className="-mt-1 mb-1 text-sm text-ink-3">Shown here once council supplies the files.</p>
        <dl className="divide-y divide-line">
          <FactRow label="Local streets" value={<span className="text-ink-2">Council's full road register</span>} />
          <FactRow label="Stormwater" value={<span className="text-ink-2">Pipe sizes, pits and hydraulics</span>} />
          <FactRow label="People" value={<span className="text-ink-2">Building usage and foot traffic</span>} />
        </dl>
      </Section>

      <Section title="Nearest council buildings" color={HAZARD_COLOR.assets}>
        <BuildingList>
          {shown.map((g) =>
            g.items.length === 1 ? (
              <BuildingRow key={g.name} b={g.items[0]} onOpen={onOpenBuilding} right={dist(g.metres)} />
            ) : (
              <BuildingGroupRow key={g.name} name={g.name} items={g.items} onOpen={onOpenBuildings} right={dist(g.metres)} />
            ),
          )}
        </BuildingList>
        {n < groups.length && n < 24 && (
          <button onClick={() => setN((v) => v + 6)} className="mt-2 text-base font-medium text-accent hover:text-ink">
            Show more
          </button>
        )}
      </Section>
    </>
  );
}

function TqehTolerance() {
  // What's saved, and the edits in progress; Save makes them one.
  const [saved, setSaved] = useState<ToleranceSheet>(() => (typeof window === 'undefined' ? {} : loadTolerance()));
  const [draft, setDraft] = useState<ToleranceSheet>(saved);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const val = (sh: ToleranceSheet, name: string, field: 'tolerance' | 'notes') => sh[name]?.[field] ?? '';
  const dirty = CONSEQUENCE_CATEGORIES.some(
    (c) => val(draft, c.name, 'tolerance') !== val(saved, c.name, 'tolerance') || val(draft, c.name, 'notes') !== val(saved, c.name, 'notes'),
  );
  const update = (name: string, field: 'tolerance' | 'notes', v: string) => {
    setDraft((prev) => ({ ...prev, [name]: { ...(prev[name] ?? { tolerance: '', notes: '' }), [field]: v } }));
    setSavedAt(null);
  };
  const save = () => {
    try {
      localStorage.setItem(TOLERANCE_KEY, JSON.stringify(draft));
    } catch {
      // Storage blocked: kept for this session only.
    }
    setSaved(draft);
    setSavedAt(new Date());
    window.dispatchEvent(new Event(TOLERANCE_SAVED_EVENT));
  };
  const filled = CONSEQUENCE_CATEGORIES.filter((c) => val(saved, c.name, 'tolerance').trim()).length;

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="num text-sm text-ink-3">
          {filled} of {CONSEQUENCE_CATEGORIES.length} set
          {dirty ? ' · unsaved changes' : savedAt ? ` · saved ${savedAt.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}` : ''}
        </span>
        <div className="flex items-center gap-2">
          {dirty && (
            <button onClick={() => setDraft(saved)} className="text-sm text-ink-3 hover:text-ink">
              Discard
            </button>
          )}
          <button
            onClick={save}
            disabled={!dirty}
            className="rounded-[3px] bg-accent px-3 py-1.5 text-base font-semibold text-white hover:bg-[#005963] disabled:cursor-default disabled:bg-line disabled:text-ink-3"
          >
            Save
          </button>
        </div>
      </div>
      <div className="divide-y divide-line rounded-[4px] border border-line">
        {CONSEQUENCE_CATEGORIES.map((c) => {
          const isOpen = open === c.name;
          const value = val(draft, c.name, 'tolerance').trim();
          return (
            <div key={c.name}>
              <button
                onClick={() => setOpen(isOpen ? null : c.name)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-medium text-ink">{c.name}</span>
                  <span className={`mt-0.5 block truncate text-sm ${value ? 'text-ink-2' : 'text-ink-3'}`}>{value || 'Not set'}</span>
                </span>
                <IconChevron size={12} className={`shrink-0 text-ink-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
              </button>
              {isOpen && (
                <div className="px-3 pb-3">
                  <label className="block text-sm text-ink-2">
                    Tolerance
                    <input
                      autoFocus
                      value={val(draft, c.name, 'tolerance')}
                      onChange={(e) => update(c.name, 'tolerance', e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && dirty) save();
                      }}
                      placeholder="Not set"
                      className="mt-1 block w-full rounded-[3px] border border-line px-2 py-1.5 text-base text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
                    />
                  </label>
                  <label className="mt-2 block text-sm text-ink-2">
                    Notes
                    <textarea
                      value={val(draft, c.name, 'notes')}
                      onChange={(e) => update(c.name, 'notes', e.target.value)}
                      rows={2}
                      className="mt-1 block w-full resize-y rounded-[3px] border border-line px-2 py-1.5 text-base text-ink focus:border-accent focus:outline-none"
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Flood event scenarios
 *
 * The three return periods are real, mapped flood scenarios. Picking one
 * shows only that event's extent and what sits inside it: council
 * buildings, classified roads, stormwater pipes and the share of the
 * council area, each counted exactly for that extent (segMask records
 * every extent a road or pipe stretch is in).
 * ------------------------------------------------------------------ */

type FloodEvent = 'none' | '1in100' | '1in20' | '1in5';
const FLOOD_EVENTS: { id: Exclude<FloodEvent, 'none'>; label: string; layer: FloodLayerId; bit: number }[] = [
  { id: '1in100', label: '1 in 100', layer: 'flood-1in100-real', bit: 1 },
  { id: '1in20', label: '1 in 20', layer: 'flood-1in20-real', bit: 2 },
  { id: '1in5', label: '1 in 5', layer: 'flood-1in5-real', bit: 4 },
];
const EVENT_COLOR = '#C2410C';
/** What each event's supplied files cover, so counts aren't misread. */
const EVENT_COVERAGE: Record<Exclude<FloodEvent, 'none'>, string> = {
  '1in100': 'Long-term run. Every catchment supplied.',
  '1in20': 'Long-term run. Only River Torrens, TRDA and Trimmer supplied, so smaller than the full picture.',
  '1in5': 'Long-term run. Trimmer not supplied.',
};

/** Stretches of each line inside / outside the event, from its segMask. */
function splitByMask(lines: LatLngTuple[][], masks: string[], bit: number) {
  const inside: LatLngTuple[][] = [];
  const outside: LatLngTuple[][] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const mask = masks[li] ?? '';
    let run: LatLngTuple[] = [];
    let runIn: boolean | null = null;
    const flush = () => {
      if (runIn !== null && run.length >= 2) (runIn ? inside : outside).push(run);
      run = [];
      runIn = null;
    };
    for (let i = 0; i < line.length - 1; i++) {
      const isIn = (Number(mask[i] ?? 0) & bit) !== 0;
      if (isIn !== runIn) {
        flush();
        runIn = isIn;
        run = [line[i]];
      }
      run.push(line[i + 1]);
    }
    flush();
  }
  return { inside, outside };
}

interface EventView {
  roads: { inside: LatLngTuple[][]; outside: LatLngTuple[][] };
  pipes: { inside: LatLngTuple[][]; outside: LatLngTuple[][] };
  buildings: RealAsset[];
  insured: number;
  roadKm: number;
  pipeKm: number;
  areaShare: number;
}
const eventCache = new Map<FloodEvent, EventView>();
function eventView(e: Exclude<FloodEvent, 'none'>): EventView {
  const hit = eventCache.get(e);
  if (hit) return hit;
  const ev = FLOOD_EVENTS.find((x) => x.id === e)!;
  const profiles = hazardProfiles();
  const buildings = MAPPED_BUILDINGS.filter((b) => profiles.get(b.id)!.flood.includes(ev.layer));
  const areaTotal = SA2_BOUNDARIES.reduce((n, s) => n + s.areaSqKm, 0);
  const areaIn = SA2_BOUNDARIES.reduce((n, s) => n + (SA2_IND[s.code]?.floodShare[e] ?? 0) * s.areaSqKm, 0);
  const out: EventView = {
    roads: splitByMask(
      ROADS.map((r) => r.line),
      ROADS.map((r) => r.segMask),
      ev.bit,
    ),
    pipes: splitByMask(stormwaterPipesData.lines as LatLngTuple[][], (stormwaterPipesData as { segMask?: string[] }).segMask ?? [], ev.bit),
    buildings,
    insured: buildings.reduce((n, b) => n + b.insuredValue, 0),
    roadKm: (majorRoadsData.kmInFlood as Record<string, number>)[e] ?? 0,
    pipeKm: (stormwaterPipesData.kmInFlood as Record<string, number>)[e] ?? 0,
    areaShare: areaTotal ? areaIn / areaTotal : 0,
  };
  eventCache.set(e, out);
  return out;
}

/* Heat categories as the second hazard scenario: the grid's own classes. */
type HeatEvent = 'none' | '4' | '3' | '2';
const HEAT_EVENTS: { id: Exclude<HeatEvent, 'none'>; label: string; cat: number }[] = [
  { id: '4', label: 'UHI 4', cat: 4 },
  { id: '3', label: 'UHI 3', cat: 3 },
  { id: '2', label: 'UHI 2', cat: 2 },
];
function ringAreaM2(ring: LatLngTuple[]): number {
  const kx = M_PER_DEG * Math.cos((ring[0][0] * Math.PI) / 180);
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[1] * kx * (q[0] * M_PER_DEG) - q[1] * kx * (p[0] * M_PER_DEG);
  }
  return Math.abs(a) / 2;
}
interface HeatView {
  cells: HeatVulnCell[];
  buildings: RealAsset[];
  insured: number;
  areaKm2: number;
  sviAvg: number;
  gridKm2: number;
}
const heatViewCache = new Map<string, HeatView>();
/** Heat cells of one category inside the LGA, and the council buildings in them. */
function heatView(e: Exclude<HeatEvent, 'none'>): HeatView {
  const hit = heatViewCache.get(e);
  if (hit) return hit;
  const cat = Number(e);
  const centreIn = (c: HeatVulnCell) => {
    const b = bboxOf(c.rings[0]);
    return pointInRing((b.latLo + b.latHi) / 2, (b.lngLo + b.lngHi) / 2, LGA_BOUNDARY.ring);
  };
  const inLga = HEAT_VULNERABILITY.filter(centreIn);
  const cells = inLga.filter((c) => c.uhiCat === cat);
  const profiles = hazardProfiles();
  const buildings = MAPPED_BUILDINGS.filter((b) => profiles.get(b.id)!.heat?.uhiCat === cat);
  const area = (cs: HeatVulnCell[]) => cs.reduce((n, c) => n + c.rings.reduce((m, r) => m + ringAreaM2(r), 0), 0) / 1e6;
  const out: HeatView = {
    cells,
    buildings,
    insured: buildings.reduce((n, b) => n + b.insuredValue, 0),
    areaKm2: area(cells),
    sviAvg: cells.length ? cells.reduce((n, c) => n + c.svi, 0) / cells.length : 0,
    gridKm2: area(inLga),
  };
  heatViewCache.set(e, out);
  return out;
}

/* ------------------------------------------------------------------ *
 * Inspect a point
 *
 * Click anywhere and read that spot from every dataset: which flood
 * extents it's in, its heat cell, its SA2 and SA1, and the nearest
 * road, pipe, water, station and council building. Lookups only.
 * ------------------------------------------------------------------ */

interface ProbeReading {
  lat: number;
  lng: number;
  inLga: boolean;
  suburb: Suburb | null;
  sa1: string | null;
  density: { category: string; value: number } | null;
  floods: FloodLayerId[];
  nearestFloodM: number;
  heat: { uhiCat: number; svi: number } | null;
  nearestHeat: { uhiCat: number; m: number } | null;
  road: { name: string; roles: string[]; m: number } | null;
  pipeM: number;
  waterM: number;
  stationM: number;
  building: { b: RealAsset; m: number } | null;
}

function probeAt(lat: number, lng: number): ProbeReading {
  const inLga = pointInRing(lat, lng, LGA_BOUNDARY.ring);
  const sa2 = SA2_BOUNDARIES.find((s) => pointInRing(lat, lng, s.ring));
  const sa1 = SA1S_WITH_BBOX.find(({ a, bbox }) => inBBox(lat, lng, bbox) && pointInRing(lat, lng, a.path));
  const floods = FLOOD_LAYER_IDS.filter((id) =>
    floodRingsFor(id).some(({ ring, bbox }) => inBBox(lat, lng, bbox) && pointInRing(lat, lng, ring)),
  );
  const nearestFloodM = floods.length ? 0 : nearestMetres(lat, lng, floodShapes('flood-1in100-real'));
  let heat: ProbeReading['heat'] = null;
  let nearestHeat: ProbeReading['nearestHeat'] = null;
  for (const { cell, rings } of HEAT_CELLS_WITH_BBOX) {
    if (rings.some(({ ring, bbox }) => inBBox(lat, lng, bbox) && pointInRing(lat, lng, ring))) {
      heat = { uhiCat: cell.uhiCat, svi: cell.svi };
      break;
    }
  }
  if (!heat) {
    for (const { cell, rings } of HEAT_CELLS_WITH_BBOX) {
      const m = nearestMetres(lat, lng, rings.map(({ ring }) => toShape(ring, true)));
      if (!nearestHeat || m < nearestHeat.m) nearestHeat = { uhiCat: cell.uhiCat, m };
    }
  }
  let road: ProbeReading['road'] = null;
  for (const rd of ROADS) {
    const m = nearestMetres(lat, lng, [toShape(rd.line)]);
    if (!road || m < road.m) road = { name: roadName(rd.name), roles: roadRoles(rd.name), m };
  }
  let building: ProbeReading['building'] = null;
  for (const b of MAPPED_BUILDINGS) {
    const loc = BUILDING_LOCATION[b.id];
    const m = nearestMetres(lat, lng, [toShape([[loc.lat, loc.lng]])]);
    if (!building || m < building.m) building = { b, m };
  }
  const near = (id: string) => nearestMetres(lat, lng, PROXIMITY_SHAPES[id]());
  const d = sa1 ? DWELLING_BY_SA1[sa1.a.id] : undefined;
  return {
    lat,
    lng,
    inLga,
    suburb: sa2 ? SUBURB_BY_ID[SA2_CODE_TO_SUBURB_ID[sa2.code]] ?? null : null,
    sa1: sa1?.a.id ?? null,
    density: d ? { category: d.category, value: d.value } : null,
    floods,
    nearestFloodM,
    heat,
    nearestHeat,
    road,
    pipeM: near('stormwater-pipes'),
    waterM: Math.min(near('watercourses'), near('waterbodies')),
    stationM: near('train-stations'),
    building,
  };
}

function ProbePanel({
  point,
  onClose,
  onOpenBuilding,
}: {
  point: { lat: number; lng: number };
  onClose: () => void;
  onOpenBuilding: (id: string) => void;
}) {
  const r = useMemo(() => probeAt(point.lat, point.lng), [point.lat, point.lng]);
  const mostFrequent = r.floods.length ? r.floods[0] : null;
  return (
    <RightPanelShell
      accent="#14201F"
      eyebrow="Inspect a point"
      title={r.suburb ? r.suburb.name : r.inLga ? 'Inside the council area' : 'Outside the council area'}
      onClose={onClose}
    >
      <div className="px-4 py-4">
        <p className="num text-sm text-ink-3">
          {r.lat.toFixed(5)}, {r.lng.toFixed(5)}
          {r.sa1 ? ` · SA1 ${r.sa1}` : ''}
        </p>
        {/* Each hazard on an equal footing, then the place, then what's near. */}
        <Section title="Hazards here">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[4px] border border-line bg-line">
            <Glance
              color={HAZARD_COLOR.flood}
              label="Flood"
              value={mostFrequent ? FLOOD_SHORT[mostFrequent] : 'Outside'}
              sub={mostFrequent ? `in: ${r.floods.map((f) => FLOOD_SHORT[f]).join(', ')}` : `${formatMetres(r.nearestFloodM)} to the 1 in 100`}
            />
            <Glance
              color={HAZARD_COLOR.heat}
              label="Urban heat"
              value={r.heat ? `Category ${r.heat.uhiCat}` : 'No cell here'}
              sub={r.heat ? 'of 2 to 4' : r.nearestHeat ? `nearest: cat. ${r.nearestHeat.uhiCat}, ${formatMetres(r.nearestHeat.m)}` : 'no heat data'}
            />
            <Glance
              color={HAZARD_COLOR.people}
              label="Social vulnerability"
              value={r.heat ? `SVI ${r.heat.svi.toFixed(2)}` : 'No cell here'}
              sub={r.heat ? 'of this heat cell' : 'SVI comes with the heat grid'}
            />
            <Glance color={HAZARD_COLOR.water} label="Water" value={formatMetres(r.waterM)} sub="to a watercourse or waterbody" />
          </div>
          <p className="mt-1.5 text-sm text-ink-3">Flood extents are long-term runs.</p>
        </Section>

        <Section title="The place">
          <dl className="divide-y divide-line">
            <FactRow label="Suburb (SA2)" value={r.suburb ? r.suburb.name : 'None'} />
            <FactRow label="Dwelling density" value={r.density ? `${r.density.category} (Density 21: ${r.density.value})` : 'No value'} />
          </dl>
        </Section>

        <Section title="Nearest assets" color={HAZARD_COLOR.assets}>
          <dl className="divide-y divide-line">
            {r.road && (
              <FactRow label="Major road" value={`${r.road.name}, ${formatMetres(r.road.m)}${r.road.roles.length ? ` (${r.road.roles[0].toLowerCase()})` : ''}`} />
            )}
            <FactRow label="Stormwater pipe" value={formatMetres(r.pipeM)} />
            <FactRow label="Train station" value={formatMetres(r.stationM)} />
            {r.building && (
              <FactRow
                label="Council building"
                value={
                  <button onClick={() => onOpenBuilding(r.building!.b.id)} className="text-left text-accent hover:text-ink">
                    {r.building.b.name}, {formatMetres(r.building.m)}
                  </button>
                }
              />
            )}
          </dl>
        </Section>
        <p className="mt-4 text-sm text-ink-3">Click anywhere else on the map to inspect another point.</p>
      </div>
    </RightPanelShell>
  );
}

/* ------------------------------------------------------------------ *
 * Tab. Help
 * ------------------------------------------------------------------ */

/** Council's own seven consequence categories and indicators, from Systems
 *  Cooperative's "Consequence category / Data end metrics" table (12 Oct
 *  2026). Reference only: the table gives real category and indicator
 *  names but no tolerance or threshold for any of them, and no rule for
 *  connecting a category to a specific layer or place, so none is shown
 *  here either. */
interface ConsequenceCategory {
  name: string;
  indicators: string;
}

const CONSEQUENCE_CATEGORIES: ConsequenceCategory[] = [
  { name: 'Financial Sustainability', indicators: 'Expenditure; % of annual budget; impact on budget' },
  {
    name: 'Core Service Delivery / Asset Management',
    indicators: 'Council facility impact duration; core service impact duration; BCP activation; impact on Civic Centre, Beverley Depot and MRF',
  },
  { name: 'Legislative / Regulatory', indicators: 'Compliance; disciplinary action; court costs' },
  { name: 'Reputation', indicators: 'Media impact and duration; local response; Net Promoter Score' },
  {
    name: 'Our People',
    indicators: 'WHS incident severity; staff turnover; volunteer numbers; staff culture; conduct breaches',
  },
  { name: 'Environment', indicators: 'Impact duration on environment; EPA Act 1993 classification' },
  {
    name: 'Community Wellbeing and Local Economy',
    indicators: 'Utilisation of facilities; number of people whose wellbeing or safety is compromised',
  },
];

/** The same table's explicit list of data it says the tool still needs,
 *  named by council and Systems Cooperative, not inferred here. */
const CONSEQUENCE_DATA_GAPS = [
  'Coastal flood: current conditions, and climate/development scenarios',
  'Road traffic: current conditions, and climate/development scenarios',
  'Active transport: current conditions, and climate/development scenarios',
  'Stormwater hydraulics',
  'Building usage (foot traffic)',
  'Asset values for buildings, roads, the stormwater system and trees',
];

function HelpTab() {
  const [open, setOpen] = useState<string | null>('quick');
  const section = (id: string, title: string, body: React.ReactNode) => (
    <Accordion
      key={id}
      title={title}
      open={open === id}
      onToggle={() => setOpen(open === id ? null : id)}
    >
      <div className="px-2.5 text-md leading-[1.6] text-ink-2">{body}</div>
    </Accordion>
  );

  return (
    <div>
      {section(
        'quick',
        'Quick start',
        <>
          <p>
            Switch on a layer in the Layers tab, or apply a Blueprint for a
            ready-made set. Click a suburb on the map, or pick
            one in Place, to see the council buildings inside it. Turn on
            building types in Assets to show buildings on the map, then click
            a dot to read its register detail.
          </p>
        </>,
      )}
      {section(
        'tabs',
        'What each tab does',
        <ul className="space-y-1.5">
          <li>
            <span className="font-semibold text-ink">Layers.</span> Hazard and infrastructure layers from council's GIS export.
            Opacity sliders at the top and on each layer.
          </li>
          <li>
            <span className="font-semibold text-ink">Assets.</span> The
            council buildings register, LGA-wide. Filter by ward, see condition
            and insured value, and choose which building types show on the map.
          </li>
          <li>
            <span className="font-semibold text-ink">Place.</span> The eight
            ABS SA2s, compared on measured indexes, with the council buildings
            filed inside each.
          </li>
          <li>
            <span className="font-semibold text-ink">Case studies.</span> Site reports, starting with The Queen Elizabeth Hospital:
            the hazards at the hospital, the assets and access
            around it, and a risk tolerance sheet for the workshop to fill in.
          </li>
          <li>
            <span className="font-semibold text-ink">Help.</span> This page.
          </li>
        </ul>,
      )}
      {section(
        'sources',
        'Where the data comes from',
        <ul className="space-y-1.5">
          <li>
            <span className="font-semibold text-ink">Boundaries.</span> ABS
            ASGS 2021 SA2 and SA1 boundaries, and council's LGA boundary from
            its own GIS export.
          </li>
          <li>
            <span className="font-semibold text-ink">Layers.</span> Council's
            GIS export: railways, train stations, watercourses, waterbodies,
            obstetric hospitals, the urban heat grid with its social
            vulnerability index, and flood contours for the catchments
            supplied so far.
          </li>
          <li>
            <span className="font-semibold text-ink">Buildings.</span>{' '}
            CCS_Buildings.xlsx, council's asset register export. Map positions
            come from geocoding each building's address. Dots marked "street
            level" sit somewhere along the road, not at the building.
          </li>
        </ul>,
      )}
      {section(
        'framework',
        "Council's consequence framework",
        <>
          <p className="mb-2">
            Council's own seven categories for what a hazard actually costs,
            from Systems Cooperative's data and metrics table (12 Oct 2026).
            Reference only, nothing here is scored or linked to the map: the
            table gives indicator names but no agreed tolerance for any
            of them yet.
          </p>
          <ul className="space-y-2">
            {CONSEQUENCE_CATEGORIES.map((c) => (
              <li key={c.name}>
                <span className="font-semibold text-ink">{c.name}.</span>{' '}
                <span className="text-ink-2">{c.indicators}</span>
              </li>
            ))}
          </ul>
          <p className="mb-1 mt-3 font-semibold text-ink">Data gaps the same table names</p>
          <ul className="list-disc space-y-1 pl-4">
            {CONSEQUENCE_DATA_GAPS.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </>,
      )}
      {section(
        'missing',
        'What is not shown',
        <>
          <p>
            Population, SEIFA, hazard scores, climate scenarios, planning
            capacity and ranking are not shown. No figures for them have
            been supplied, and the earlier demonstration values have been
            removed rather than kept on screen.
          </p>
          <p className="mt-1.5">
            No thresholds or tolerances have been set for any measure. Where
            one is needed it will be entered from council's own agreed values.
          </p>
          <p className="mt-1.5">
            Planning & Land Use is a held, empty category rather than a hidden
            one: council's roads, stormwater and development zone exports
            haven't been supplied yet, so there is nothing to show there.
          </p>
        </>,
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Source years
 *
 * The one piece of time this tool can state honestly: the year each checked
 * layer's own source file is dated to. No scenario or projection is shown,
 * because none is backed by a real series yet.
 * ------------------------------------------------------------------ */

function SourceYears({ snapshot }: { snapshot: string | null }) {
  return (
    <div className="flex h-[40px] shrink-0 items-center justify-between border-t border-line bg-white px-3">
      <span className="text-xs font-semibold text-ink-3">
        Source years
      </span>
      <span className="num text-base text-ink-2">{snapshot ?? 'No dated layer on the map'}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Icon rail
 * ------------------------------------------------------------------ */

/** Short labels under the rail icons. */
const RAIL_LABEL: Record<PanelTab, string> = {
  layers: 'Layers',
  assets: 'Assets',
  place: 'Place',
  cases: 'Cases',
  help: 'Help',
};

const TAB_META: Record<
  PanelTab,
  { title: string; subtitle: string; icon: (p: IconProps) => React.ReactElement }
> = {
  layers: {
    title: 'Layers',
    subtitle: 'Hazards, buildings and the network behind them',
    icon: IconLayers,
  },
  assets: {
    title: 'Assets',
    subtitle: 'The council buildings register, LGA-wide',
    icon: IconAssets,
  },
  place: {
    title: 'Place',
    subtitle: 'The eight SA2s, and the council buildings inside each',
    icon: IconPlace,
  },
  cases: {
    title: 'Case studies',
    subtitle: 'Site reports: hazard, assets and risk tolerance',
    icon: IconHospital,
  },
  help: {
    title: 'Help',
    subtitle: 'What this tool shows, where it comes from, and what is not shown',
    icon: IconHelp,
  },
};

function IconRail({
  tab,
  setTab,
  onHome,
}: {
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
  onHome: () => void;
}) {
  // Assets split out from Place: a real, LGA-wide register isn't a
  // suburb profile, it doesn't belong nested under one.
  const order: PanelTab[] = ['layers', 'assets', 'place', 'cases', 'help'];
  return (
    <nav data-tour="rail" className="flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-line bg-white py-3">
      <Tip label="Home" body="Back to the landing screen" side="right">
        <button
          onClick={onHome}
          className="flex h-11 w-[56px] items-center justify-center rounded-[3px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          aria-label="Home"
        >
          <IconHome size={21} />
        </button>
      </Tip>
      <div className="my-1.5 h-px w-8 bg-line" />
      {order.map((t) => {
        const meta = TAB_META[t];
        const Icon = meta.icon;
        const on = tab === t;
        const separator = t === 'help';
        return (
          <React.Fragment key={t}>
            {separator && <div className="my-1.5 h-px w-8 bg-line" />}
            <Tip label={meta.title} body={meta.subtitle}>
              <button
                data-tour={`rail-${t}`}
                onClick={() => setTab(t)}
                className={`flex w-[56px] flex-col items-center gap-1 rounded-[3px] py-1.5 transition-colors ${on ? 'bg-surface-2 text-accent' : 'text-ink-3 hover:bg-surface-2 hover:text-ink'}`}
                style={on ? { boxShadow: `inset 3px 0 0 ${ACCENT}` } : undefined}
                aria-label={meta.title}
                aria-current={on ? 'page' : undefined}
              >
                <Icon size={21} />
                <span className={`text-[10px] leading-none ${on ? 'font-semibold' : 'font-medium'}`}>{RAIL_LABEL[t]}</span>
              </button>
            </Tip>
          </React.Fragment>
        );
      })}
      <div className="mt-auto">
        <Tip label="Prepared by" body="Value Advisory Partners" side="right">
          <img src={vapLogo} alt="Value Advisory Partners" className="h-10 w-10 shrink-0 object-contain" />
        </Tip>
      </div>
    </nav>
  );
}

type AssetClass = 'building' | 'meter' | 'pump' | 'accessory';

interface RealAsset {
  id: string;
  name: string;
  assetClass: AssetClass;
  buildingType: string | null;
  buildingUse: string | null;
  suburb: string | null;
  ward: string | null;
  address: string | null;
  owner: string | null;
  maintainer: string | null;
  condition: string | null;
  criticality: string | null;
  riskConsequence: string | null;
  riskLikelihood: string | null;
  inherentRisk: string | null;
  insuredValue: number;
  componentCount: number;
}

const REAL_ASSETS = ccsBuildingsRaw as RealAsset[];
const REAL_BUILDINGS = REAL_ASSETS.filter((a) => a.assetClass === 'building');
const REAL_BUILDINGS_BY_ID = new Map(REAL_BUILDINGS.map((b) => [b.id, b]));

const ASSET_CLASS_LABEL: Record<AssetClass, string> = {
  building: 'Buildings',
  meter: 'Electricity meters',
  pump: 'Pump stations',
  accessory: 'Sports accessories',
};

const UNCLASSIFIED = '(not yet classified)';

/** Condition, criticality and risk are the register's own ratings, not
 *  ones this tool invented. Colour only encodes the ordering already in
 *  the data. */
const CONDITION_COLOR: Record<string, string> = {
  'Very Good Condition': '#166534',
  'Minor Defects Only': '#0891B2',
  'Maintenance Required': '#D97706',
  'Requires Renewal': '#DC2626',
  'Asset Unserviceable': '#7C2D12',
};
const NEUTRAL_TONE = '#9CA3AF';

/** Building Use groups, each holding the real Building Types that occur
 *  under it in the register, with a count and total insured value. */
interface TypeNode {
  key: string;
  label: string;
  count: number;
  insuredValue: number;
}
interface UseNode {
  key: string;
  label: string;
  count: number;
  insuredValue: number;
  types: TypeNode[];
}

function buildUseTree(rows: RealAsset[]): UseNode[] {
  const uses = new Map<string, Map<string, TypeNode>>();
  for (const r of rows) {
    const useKey = r.buildingUse ?? UNCLASSIFIED;
    const typeKey = r.buildingType ?? UNCLASSIFIED;
    if (!uses.has(useKey)) uses.set(useKey, new Map());
    const types = uses.get(useKey)!;
    if (!types.has(typeKey)) {
      types.set(typeKey, { key: typeKey, label: typeKey, count: 0, insuredValue: 0 });
    }
    const t = types.get(typeKey)!;
    t.count += 1;
    t.insuredValue += r.insuredValue;
  }
  const out: UseNode[] = [];
  for (const [useKey, types] of uses) {
    const typeList = [...types.values()].sort((a, b) => b.count - a.count);
    out.push({
      key: useKey,
      label: useKey,
      count: typeList.reduce((n, t) => n + t.count, 0),
      insuredValue: typeList.reduce((n, t) => n + t.insuredValue, 0),
      types: typeList,
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

const REAL_USE_TREE = buildUseTree(REAL_BUILDINGS);

/** The register's own Ward field, with buildings that have none kept as
 *  their own visible group rather than dropped or assigned a guess. */
const NO_WARD = '(no ward recorded)';
const REAL_WARDS = (() => {
  const counts = new Map<string, number>();
  for (const b of REAL_BUILDINGS) {
    const k = b.ward ?? NO_WARD;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => Number(a[0] === NO_WARD) - Number(b[0] === NO_WARD) || b[1] - a[1])
    .map(([key, count]) => ({ key, count }));
})();
const ALL_BUILDING_TYPES = new Set(
  REAL_BUILDINGS.map((b) => b.buildingType ?? UNCLASSIFIED),
);

/** Real building id to an approximate map position, geocoded from the
 *  register's own address field via OpenStreetMap Nominatim, not
 *  surveyed and not present in the source export. 'site' means the
 *  geocoder matched an actual building or named place; 'street' means it
 *  only matched the road, most register addresses carry no house number,
 *  so the point sits somewhere along that street, not at the building.
 *  Buildings with no usable address, or whose geocode fell outside the
 *  LGA, are absent here rather than guessed. */
const BUILDING_LOCATION = ccsBuildingsGeocoded as Record<
  string,
  { lat: number; lng: number; precision: 'site' | 'street' }
>;

/** Real buildings grouped by the SA2 their geocoded point actually falls
 *  inside, a spatial join against the real boundaries rather than a
 *  guess from the register's locality text, keyed by app suburb id for
 *  all eight, Beverley included. Only buildings with a geocoded
 *  position can appear here, the 171 without one are real too, they
 *  just cannot be placed in a suburb without inventing where. */
const REAL_BUILDINGS_BY_SUBURB: Record<string, RealAsset[]> = {};
for (const b of REAL_BUILDINGS) {
  const loc = BUILDING_LOCATION[b.id];
  if (!loc) continue;
  const hit = SA2_BOUNDARIES.find((s) => pointInRing(loc.lat, loc.lng, s.ring));
  if (!hit) continue;
  const suburbId = SA2_CODE_TO_SUBURB_ID[hit.code];
  if (!suburbId) continue;
  (REAL_BUILDINGS_BY_SUBURB[suburbId] ??= []).push(b);
}

/** The reverse of the above: which SA2 a mapped building sits in. */
const BUILDING_SUBURB_ID: Record<string, string> = {};
for (const [suburbId, list] of Object.entries(REAL_BUILDINGS_BY_SUBURB)) {
  for (const b of list) BUILDING_SUBURB_ID[b.id] = suburbId;
}

/* ------------------------------------------------------------------ *
 * Real asset exposure
 *
 * Whether a real building's geocoded point falls inside a real hazard
 * polygon, nothing more. No severity cutoff is applied: for flood, a
 * building either sits inside a mapped flood extent or it doesn't; for
 * heat, every mapped building is placed in its real UHI category and
 * the counts are shown by category, not collapsed into a judgement
 * about which categories count as "in danger". That line hasn't been
 * agreed by anyone, so it isn't drawn here.
 * ------------------------------------------------------------------ */

interface RingBBox {
  latLo: number;
  latHi: number;
  lngLo: number;
  lngHi: number;
}

function bboxOf(ring: LatLngTuple[]): RingBBox {
  let latLo = Infinity, latHi = -Infinity, lngLo = Infinity, lngHi = -Infinity;
  for (const [lat, lng] of ring) {
    if (lat < latLo) latLo = lat;
    if (lat > latHi) latHi = lat;
    if (lng < lngLo) lngLo = lng;
    if (lng > lngHi) lngHi = lng;
  }
  return { latLo, latHi, lngLo, lngHi };
}

function inBBox(lat: number, lng: number, b: RingBBox): boolean {
  return lat >= b.latLo && lat <= b.latHi && lng >= b.lngLo && lng <= b.lngHi;
}

const FLOOD_RETURN_PERIOD_BY_LAYER: Record<string, '1in5' | '1in20' | '1in100'> = {
  'flood-1in5-real': '1in5',
  'flood-1in20-real': '1in20',
  'flood-1in100-real': '1in100',
};

/** Every ring (across every catchment) for a flood layer, with its
 *  bounding box precomputed once so each building test can skip most
 *  rings cheaply before running the real point-in-polygon check. */
function floodRingsFor(layerId: string): { ring: LatLngTuple[]; bbox: RingBBox }[] {
  const rp = FLOOD_RETURN_PERIOD_BY_LAYER[layerId];
  if (!rp) return [];
  const catchments = floodContoursData.returnPeriods[rp];
  return catchments.flatMap((c) => (c.rings as LatLngTuple[][]).map((ring) => ({ ring, bbox: bboxOf(ring) })));
}

/** Real buildings (with a geocoded position) whose point falls inside at
 *  least one ring from the given flood layers. */
function buildingsInFlood(layerIds: string[]): RealAsset[] {
  const ringSets = layerIds.flatMap(floodRingsFor);
  return REAL_BUILDINGS.filter((b) => {
    const loc = BUILDING_LOCATION[b.id];
    if (!loc) return false;
    return ringSets.some(({ ring, bbox }) => inBBox(loc.lat, loc.lng, bbox) && pointInRing(loc.lat, loc.lng, ring));
  });
}

const HEAT_CELLS_WITH_BBOX = HEAT_VULNERABILITY.map((cell) => ({
  cell,
  rings: cell.rings.map((ring) => ({ ring, bbox: bboxOf(ring) })),
}));

/** Real buildings grouped by the real UHI category of the heat grid cell
 *  their geocoded point falls inside. Buildings whose point falls
 *  outside every cell, or that have no geocoded position, are not
 *  counted rather than guessed into a category. */
function buildingsByHeatCategory(): { byCategory: Map<number, RealAsset[]>; byBuildingId: Map<string, number> } {
  const byCategory = new Map<number, RealAsset[]>();
  const byBuildingId = new Map<string, number>();
  for (const b of REAL_BUILDINGS) {
    const loc = BUILDING_LOCATION[b.id];
    if (!loc) continue;
    for (const { cell, rings } of HEAT_CELLS_WITH_BBOX) {
      if (rings.some(({ ring, bbox }) => inBBox(loc.lat, loc.lng, bbox) && pointInRing(loc.lat, loc.lng, ring))) {
        const list = byCategory.get(cell.uhiCat) ?? [];
        list.push(b);
        byCategory.set(cell.uhiCat, list);
        byBuildingId.set(b.id, cell.uhiCat);
        break;
      }
    }
  }
  return { byCategory, byBuildingId };
}

/* ------------------------------------------------------------------ *
 * Hazard profile per building
 *
 * For each mapped building: the heat cell it sits in (UHI category and
 * SVI), which flood extents contain it, the dwelling density of its SA1,
 * and how far it is from the nearest watercourse or waterbody. Each one
 * is then ranked against every other mapped council building, so a
 * reading says "higher than 80% of council buildings" instead of
 * applying a cut-off nobody has agreed.
 * ------------------------------------------------------------------ */

const FLOOD_LAYER_IDS = ['flood-1in5-real', 'flood-1in20-real', 'flood-1in100-real'] as const;
type FloodLayerId = (typeof FLOOD_LAYER_IDS)[number];
const FLOOD_SHORT: Record<FloodLayerId, string> = {
  'flood-1in5-real': '1 in 5',
  'flood-1in20-real': '1 in 20',
  'flood-1in100-real': '1 in 100',
};
/** Catchments each flood layer was supplied for, straight from the data. */
function floodCatchments(layerId: string): string[] {
  const rp = FLOOD_RETURN_PERIOD_BY_LAYER[layerId];
  return rp ? floodContoursData.returnPeriods[rp].map((c) => c.catchment) : [];
}

const MAPPED_BUILDINGS = REAL_BUILDINGS.filter((b) => BUILDING_LOCATION[b.id]);

interface Shape {
  pts: LatLngTuple[];
  bbox: RingBBox;
  closed: boolean;
}
const toShape = (pts: LatLngTuple[], closed = false): Shape => ({ pts, bbox: bboxOf(pts), closed });

/** Metres from a point to a line or ring, on a local flat projection
 *  (accurate to well under a metre across the council area). */
const M_PER_DEG = 111_320;
function metresToShape(lat: number, lng: number, s: Shape): number {
  const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const p = s.pts;
  if (p.length === 1) return Math.hypot((p[0][1] - lng) * kx, (p[0][0] - lat) * M_PER_DEG);
  let best = Infinity;
  const n = s.closed ? p.length : p.length - 1;
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    const ax = (a[1] - lng) * kx, ay = (a[0] - lat) * M_PER_DEG;
    const dx = (b[1] - a[1]) * kx, dy = (b[0] - a[0]) * M_PER_DEG;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) best = d;
  }
  return best;
}

/** The nearest point on any of the shapes, and how far it is. */
function nearestPointOn(lat: number, lng: number, shapes: Shape[]): { m: number; at: LatLngTuple } | null {
  const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  let best: { m: number; at: LatLngTuple } | null = null;
  for (const s of shapes) {
    const bx = Math.max(s.bbox.lngLo - lng, 0, lng - s.bbox.lngHi) * kx;
    const by = Math.max(s.bbox.latLo - lat, 0, lat - s.bbox.latHi) * M_PER_DEG;
    if (best && Math.hypot(bx, by) >= best.m) continue;
    if (s.closed && inBBox(lat, lng, s.bbox) && pointInRing(lat, lng, s.pts)) return { m: 0, at: [lat, lng] };
    const p = s.pts;
    const n = p.length === 1 ? 1 : s.closed ? p.length : p.length - 1;
    for (let i = 0; i < n; i++) {
      const a = p[i];
      const b = p.length === 1 ? a : p[(i + 1) % p.length];
      const ax = (a[1] - lng) * kx, ay = (a[0] - lat) * M_PER_DEG;
      const dx = (b[1] - a[1]) * kx, dy = (b[0] - a[0]) * M_PER_DEG;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (!best || d < best.m) best = { m: d, at: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
    }
  }
  return best;
}

function nearestMetres(lat: number, lng: number, shapes: Shape[]): number {
  const kx = M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const s of shapes) {
    const bx = Math.max(s.bbox.lngLo - lng, 0, lng - s.bbox.lngHi) * kx;
    const by = Math.max(s.bbox.latLo - lat, 0, lat - s.bbox.latHi) * M_PER_DEG;
    if (Math.hypot(bx, by) >= best) continue;
    if (s.closed && inBBox(lat, lng, s.bbox) && pointInRing(lat, lng, s.pts)) return 0;
    const d = metresToShape(lat, lng, s);
    if (d < best) best = d;
  }
  return best;
}

let pipeShapeCache: Shape[] | null = null;

/** Pipe stretches by the most frequent flood extent they sit in, from
 *  segClass in stormwaterPipes.json. 3 = 1 in 5 ... 0 = outside. */
type PipeClass = '0' | '1' | '2' | '3';
const PIPE_CLASSES: { id: PipeClass; label: string; color: string }[] = [
  { id: '3', label: 'In the 1 in 5 extent', color: '#B91C1C' },
  { id: '2', label: 'In the 1 in 20 extent', color: '#EA580C' },
  { id: '1', label: 'In the 1 in 100 extent', color: '#EAB308' },
  { id: '0', label: 'Outside every extent', color: '#7DB3E8' },
];
/** Runs of consecutive same-class stretches, optionally only where both
 *  ends pass `keep` (used to cut the network to the TQEH area). */
function pipeRuns(keep?: (pt: LatLngTuple) => boolean): Record<PipeClass, LatLngTuple[][]> {
  const out: Record<PipeClass, LatLngTuple[][]> = { '0': [], '1': [], '2': [], '3': [] };
  const lines = stormwaterPipesData.lines as LatLngTuple[][];
  const classes = stormwaterPipesData.segClass as string[];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const cls = classes[li];
    let run: LatLngTuple[] = [];
    let runCls: PipeClass | null = null;
    const flush = () => {
      if (runCls && run.length >= 2) out[runCls].push(run);
      run = [];
      runCls = null;
    };
    for (let i = 0; i < line.length - 1; i++) {
      const c = cls[i] as PipeClass;
      if (keep && !(keep(line[i]) && keep(line[i + 1]))) {
        flush();
        continue;
      }
      if (c !== runCls) {
        flush();
        runCls = c;
        run = [line[i]];
      }
      run.push(line[i + 1]);
    }
    flush();
  }
  return out;
}
let pipeRunCache: Record<PipeClass, LatLngTuple[][]> | null = null;

/* Major roads ----------------------------------------------------------- */
interface RoadPiece {
  name: string | null;
  role: string;
  line: LatLngTuple[];
  segClass: string;
  /** Every extent each stretch is in: 1 = 1 in 100, 2 = 1 in 20, 4 = 1 in 5, summed. */
  segMask: string;
}
const ROADS = majorRoadsData.roads as unknown as RoadPiece[];
const ROAD_ROLES: { role: string; label: string; color: string; weight: number }[] = [
  { role: 'Priority Network', label: 'Priority Network', color: '#111827', weight: 4.2 },
  { role: 'Strategic Routes', label: 'Strategic route', color: '#4B5563', weight: 3.4 },
  { role: 'Peak Hour Routes', label: 'Peak hour route', color: '#8B95A1', weight: 2.8 },
  { role: 'High Frequency Corridor', label: 'Bus corridor, high frequency', color: '#7C3AED', weight: 2.6 },
  { role: 'Standard Frequency Corridor', label: 'Bus corridor, standard', color: '#B39DF0', weight: 2 },
];
const ROAD_ROLE = Object.fromEntries(ROAD_ROLES.map((r) => [r.role, r]));
const ROLE_LABEL: Record<string, string> = {
  ...Object.fromEntries(ROAD_ROLES.map((r) => [r.role, r.label])),
  'Freight Routes - Primary': 'Primary freight route',
  'Major Local Freight Routes': 'Local freight route',
};
/** "PORT ROAD" -> "Port Road", "SOUTH RD (PORT RD TO MANTON ST)" kept readable. */
function roadName(n: string | null): string {
  if (!n) return 'Unnamed road';
  return n.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase()).replace(/\bTo\b/g, 'to');
}
function roadRoles(n: string | null): string[] {
  const roles = (majorRoadsData.rolesByName as Record<string, string[]>)[n ?? ''] ?? [];
  return roles.map((r) => ROLE_LABEL[r] ?? r);
}
/** Stretches of a road piece by flood class, optionally cut to `keep`. */
function roadRunsByFlood(keep?: (pt: LatLngTuple) => boolean): Record<PipeClass, LatLngTuple[][]> {
  const out: Record<PipeClass, LatLngTuple[][]> = { '0': [], '1': [], '2': [], '3': [] };
  for (const r of ROADS) {
    let run: LatLngTuple[] = [];
    let cls: PipeClass | null = null;
    const flush = () => {
      if (cls && run.length >= 2) out[cls].push(run);
      run = [];
      cls = null;
    };
    for (let i = 0; i < r.line.length - 1; i++) {
      const c = r.segClass[i] as PipeClass;
      if (keep && !(keep(r.line[i]) && keep(r.line[i + 1]))) {
        flush();
        continue;
      }
      if (c !== cls) {
        flush();
        cls = c;
        run = [r.line[i]];
      }
      run.push(r.line[i + 1]);
    }
    flush();
  }
  return out;
}
/** How the road layer is coloured, chosen in its panel. */
type RoadColour = 'role' | 'flood';
const RoadColourContext = React.createContext<{ by: RoadColour; set: (v: RoadColour) => void }>({
  by: 'role',
  set: () => {},
});

/** Line and point layers a building's distance can be measured to. */
const PROXIMITY_SHAPES: Record<string, () => Shape[]> = {
  watercourses: () => WATERCOURSES.map((l) => toShape(l)),
  waterbodies: () => WATERBODIES.flatMap((poly) => poly.map((ring) => toShape(ring, true))),
  railways: () => RAILWAYS.map((l) => toShape(l)),
  'train-stations': () => TRAIN_STATIONS.map((p) => toShape([p])),
  'pedestrian-network': () => pedestrianNetworkData.segments.map((s) => toShape(s.line as LatLngTuple[])),
  'obstetric-hospitals': () => OBSTETRIC_HOSPITALS.map((p) => toShape([p])),
  'stormwater-pipes': () => (pipeShapeCache ??= (stormwaterPipesData.lines as LatLngTuple[][]).map((l) => toShape(l))),
  'major-roads': () => ROADS.map((r) => toShape(r.line)),
};

const distanceCache = new Map<string, Map<string, number>>();
/** Metres from every mapped building to the nearest feature of a layer. */
function distancesTo(layerId: string): Map<string, number> {
  const hit = distanceCache.get(layerId);
  if (hit) return hit;
  const shapes = PROXIMITY_SHAPES[layerId]?.() ?? [];
  const out = new Map<string, number>();
  if (shapes.length > 0) {
    for (const b of MAPPED_BUILDINGS) {
      const loc = BUILDING_LOCATION[b.id];
      out.set(b.id, nearestMetres(loc.lat, loc.lng, shapes));
    }
  }
  distanceCache.set(layerId, out);
  return out;
}

const DWELLING_BY_SA1 = dwellingDensityData.byCode as Record<string, { value: number; category: string }>;
const SA1S_WITH_BBOX = SA1S.map((a) => ({ a, bbox: bboxOf(a.path) }));

interface HazardProfile {
  heat: { uhiCat: number; svi: number } | null;
  /** Flood extents the building sits inside. */
  flood: FloodLayerId[];
  density: { category: string; value: number } | null;
  waterM: number;
  waterKind: 'watercourse' | 'waterbody';
}

let profileCache: Map<string, HazardProfile> | null = null;
function hazardProfiles(): Map<string, HazardProfile> {
  if (profileCache) return profileCache;
  const floodRings = Object.fromEntries(FLOOD_LAYER_IDS.map((id) => [id, floodRingsFor(id)])) as Record<
    FloodLayerId,
    ReturnType<typeof floodRingsFor>
  >;
  const toCourse = distancesTo('watercourses');
  const toBody = distancesTo('waterbodies');
  const out = new Map<string, HazardProfile>();
  for (const b of MAPPED_BUILDINGS) {
    const { lat, lng } = BUILDING_LOCATION[b.id];
    let heat: HazardProfile['heat'] = null;
    for (const { cell, rings } of HEAT_CELLS_WITH_BBOX) {
      if (rings.some(({ ring, bbox }) => inBBox(lat, lng, bbox) && pointInRing(lat, lng, ring))) {
        heat = { uhiCat: cell.uhiCat, svi: cell.svi };
        break;
      }
    }
    const flood = FLOOD_LAYER_IDS.filter((id) =>
      floodRings[id].some(({ ring, bbox }) => inBBox(lat, lng, bbox) && pointInRing(lat, lng, ring)),
    );
    const sa1 = SA1S_WITH_BBOX.find(({ a, bbox }) => inBBox(lat, lng, bbox) && pointInRing(lat, lng, a.path));
    const d = sa1 ? DWELLING_BY_SA1[sa1.a.id] : undefined;
    const c = toCourse.get(b.id) ?? Infinity;
    const w = toBody.get(b.id) ?? Infinity;
    out.set(b.id, {
      heat,
      flood,
      density: d ? { category: d.category, value: d.value } : null,
      waterM: Math.min(c, w),
      waterKind: c <= w ? 'watercourse' : 'waterbody',
    });
  }
  profileCache = out;
  return out;
}

/** The most frequent flood extent a building sits inside, as a score:
 *  3 = 1 in 5, 2 = 1 in 20, 1 = 1 in 100, 0 = outside every mapped one. */
function floodScore(p: HazardProfile): number {
  if (p.flood.includes('flood-1in5-real')) return 3;
  if (p.flood.includes('flood-1in20-real')) return 2;
  if (p.flood.includes('flood-1in100-real')) return 1;
  return 0;
}

interface HazardReading {
  key: 'flood' | 'heat' | 'svi' | 'water';
  label: string;
  value: string;
  /** Share of the other mapped buildings with strictly lower exposure. */
  share: number;
  color: string;
}

function formatMetres(m: number): string {
  if (!Number.isFinite(m)) return 'n/a';
  if (m === 0) return 'on the water';
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Each hazard reading for one building, with where it sits among every
 *  other mapped council building. Null when the building isn't mapped. */
function hazardReadings(id: string): HazardReading[] | null {
  const all = hazardProfiles();
  const p = all.get(id);
  if (!p) return null;
  const others = [...all.entries()].filter(([k]) => k !== id).map(([, v]) => v);
  const share = (score: (x: HazardProfile) => number | null) => {
    const mine = score(p);
    if (mine === null) return null;
    const pool = others.map(score).filter((v): v is number => v !== null);
    return pool.length ? pool.filter((v) => v < mine).length / pool.length : 0;
  };
  const out: HazardReading[] = [];
  const fs = floodScore(p);
  out.push({
    key: 'flood',
    label: 'Flood',
    value: fs === 0 ? 'Outside every mapped extent' : `Inside the ${['', '1 in 100', '1 in 20', '1 in 5'][fs]} extent`,
    share: share(floodScore)!,
    color: HAZARD_COLOR.flood,
  });
  if (p.heat) {
    out.push({
      key: 'heat',
      label: 'Urban heat',
      value: `UHI category ${p.heat.uhiCat} of 4`,
      share: share((x) => x.heat?.uhiCat ?? null)!,
      color: HAZARD_COLOR.heat,
    });
    out.push({
      key: 'svi',
      label: 'Social vulnerability',
      value: `SVI ${p.heat.svi.toFixed(2)}`,
      share: share((x) => x.heat?.svi ?? null)!,
      color: HAZARD_COLOR.people,
    });
  }
  out.push({
    key: 'water',
    label: 'Nearest water',
    value: `${formatMetres(p.waterM)} to a ${p.waterKind}`,
    share: share((x) => -x.waterM)!,
    color: HAZARD_COLOR.water,
  });
  return out;
}


/* ------------------------------------------------------------------ *
 * Consequence framework
 *
 * Council's own draft categorisation of what a hazard actually costs,
 * from project correspondence between Value Advisory Partners and The
 * Systems Cooperative (Sam Culley, Sept 2026), not authored here. Seven
 * categories, each with the metrics council itself proposed to measure
 * it by. Two things are deliberately absent: a tolerance or threshold
 * per category, and a verdict on any specific asset. Both were still
 * being workshopped at the time this was shared, "it would be good to
 * fill out that last column this week" in Sam's own words, so a number
 * here would be invented, not sourced. The category and metric names are
 * real, the thresholds are not, and the difference is shown rather than
 * hidden. */




function formatMoney(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1000) return `$${Math.round(v / 1000)}k`;
  return `$${v}`;
}

const FLOOD_BY_SCORE = ['', '1 in 100', '1 in 20', '1 in 5'];

/** A label on the left, its value on the right. The one way facts are
 *  laid out anywhere in the app. */
function FactRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5">
      <dt className="w-[92px] shrink-0 text-base text-ink-3">{label}</dt>
      <dd className="min-w-0 flex-1 text-base leading-[1.45] text-ink">{value}</dd>
    </div>
  );
}

/** One headline figure in a two-up strip. */
function Figure({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 px-3">
      <div className="text-sm text-ink-3">{label}</div>
      <div className="num mt-1 truncate text-stat font-semibold leading-none text-ink">{value}</div>
      {sub && <div className="num mt-1 text-sm text-ink-3">{sub}</div>}
    </div>
  );
}

function FigureStrip({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 divide-x divide-line rounded-[4px] border border-line py-3">{children}</div>;
}

/** A labelled count with a bar against the largest count in its group. */
function BarRow({ label, n, max, color, onClick }: { label: string; n: number; max: number; color: string; onClick?: () => void }) {
  const inner = (
    <>
      <span className="w-[108px] shrink-0 truncate text-left text-base text-ink-2">{label}</span>
      <span className="h-[4px] flex-1 rounded-full bg-line">
        <span className="block h-full rounded-full" style={{ width: `${max ? (n / max) * 100 : 0}%`, background: color }} />
      </span>
      <span className="num w-8 shrink-0 text-right text-base font-medium text-ink">{n}</span>
    </>
  );
  return onClick ? (
    <button onClick={onClick} className="flex w-full items-center gap-3 py-1 hover:opacity-80">
      {inner}
    </button>
  ) : (
    <div className="flex items-center gap-3 py-1">{inner}</div>
  );
}

function Section({
  title,
  right,
  children,
  color,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <section className="mt-6 first:mt-0">
      <PanelHeading right={right} color={color}>
        {title}
      </PanelHeading>
      {children}
    </section>
  );
}

/** One building as one line: name, type and place, insured value, and
 *  the flood and heat bands it sits in. Opens the full profile on the
 *  right, so every building list in the app reads and behaves the same. */
function BuildingRow({
  b,
  onOpen,
  active,
  right,
  hideSuburb,
}: {
  b: RealAsset;
  onOpen: (id: string) => void;
  active?: boolean;
  right?: React.ReactNode;
  /** In a list already scoped to one suburb, repeating it is noise. */
  hideSuburb?: boolean;
}) {
  const p = hazardProfiles().get(b.id);
  const tags: string[] = [];
  if (p) {
    const fs = floodScore(p);
    if (fs > 0) tags.push(`Flood ${FLOOD_BY_SCORE[fs]}`);
    if (p.heat) tags.push(`UHI ${p.heat.uhiCat}`);
  }
  return (
    <button
      onClick={() => onOpen(b.id)}
      aria-current={active || undefined}
      className={`flex w-full items-start justify-between gap-3 px-3 py-2.5 text-left transition-colors ${active ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
      style={active ? { boxShadow: `inset 2px 0 0 ${ACCENT}` } : undefined}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-lg font-medium text-ink">{b.name}</span>
        <span className="num mt-0.5 block truncate text-sm text-ink-3">
          {[b.buildingType ?? 'Not yet classified', !hideSuburb && b.suburb, ...tags, !p && 'not mapped']
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <span className="shrink-0 pt-[1px] text-right">
        {right ?? (b.insuredValue > 0 && <span className="num block text-base text-ink-2">{formatMoney(b.insuredValue)}</span>)}
      </span>
    </button>
  );
}

function BuildingList({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-line overflow-hidden rounded-[4px] border border-line">{children}</div>;
}

const READING_VERB: Record<HazardReading['key'], string> = {
  flood: 'More exposed than',
  heat: 'Hotter than',
  svi: 'Higher than',
  water: 'Closer than',
};
const READING_NOUN: Record<HazardReading['key'], string> = {
  flood: 'flood',
  heat: 'urban heat',
  svi: 'social vulnerability',
  water: 'proximity to water',
};

/** The full profile for one building: hazards first, ranked against
 *  every other mapped council building, then the register's own record. */
function BuildingProfile({ b }: { b: RealAsset }) {
  const loc = BUILDING_LOCATION[b.id];
  const readings = hazardReadings(b.id);
  const p = hazardProfiles().get(b.id);
  const ranked = readings ? [...readings].sort((x, y) => y.share - x.share) : [];
  const top = ranked[0];
  const bottom = ranked[ranked.length - 1];
  const others = MAPPED_BUILDINGS.length - 1;

  return (
    <>
      <FigureStrip>
        <Figure label="Insured value" value={b.insuredValue > 0 ? formatMoney(b.insuredValue) : 'None'} />
        <Figure label="Inherent risk" value={<span className="text-xl">{b.inherentRisk ?? 'Not rated'}</span>} sub={b.condition ?? 'Condition not rated'} />
      </FigureStrip>

      {readings && p ? (
        <Section title="Hazard profile">
          {top && bottom && top.share !== bottom.share && (
            <p className="mb-4 text-base leading-[1.55] text-ink-2">
              Compared with the other {others} mapped council buildings, its greatest exposure is{' '}
              <span className="font-semibold text-ink">{READING_NOUN[top.key]}</span> and its least is{' '}
              <span className="font-semibold text-ink">{READING_NOUN[bottom.key]}</span>.
            </p>
          )}
          <div className="space-y-4">
            {readings.map((r) => (
              <div key={r.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-base text-ink-3">{r.label}</span>
                  <span className="text-right text-base font-medium text-ink">{r.value}</span>
                </div>
                <div className="mt-1.5 h-[4px] rounded-full bg-line">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(r.share * 100, 1.5)}%`, background: r.color }} />
                </div>
                <div className="num mt-1 text-sm text-ink-3">
                  {READING_VERB[r.key]} {Math.round(r.share * 100)}% of council buildings
                </div>
              </div>
            ))}
          </div>
          <dl className="mt-4 divide-y divide-line border-t border-line">
            {!p.heat && <FactRow label="Urban heat" value="Outside the heat grid's coverage" />}
            {p.flood.length > 1 && <FactRow label="Flood extents" value={p.flood.map((f) => FLOOD_SHORT[f]).join(', ')} />}
            <FactRow
              label="Dwelling density"
              value={p.density ? `${p.density.category} (Density 21: ${p.density.value})` : 'No value for its SA1'}
            />
          </dl>
          <p className="mt-3 text-sm leading-[1.5] text-ink-3">
            Flood extents are long-term runs (River Torrens to 2050), not current conditions. Data is partial: 1 in 20 covers three catchments and 1 in 5 has no Trimmer data yet.
            {loc?.precision === 'street' && ' This building is placed at street level, so readings are for a point on its street.'}
          </p>
        </Section>
      ) : (
        <Section title="Hazard profile">
          <p className="text-base leading-[1.55] text-ink-3">
            Not on the map: no address in the register resolved to a location, so it can't be checked against the hazard layers.
          </p>
        </Section>
      )}

      <Section title="Register">
        <dl className="divide-y divide-line">
          <FactRow label="Condition" value={b.condition ?? 'Not rated'} />
          <FactRow label="Criticality" value={b.criticality ?? 'Not rated'} />
          {(b.riskConsequence || b.riskLikelihood) && (
            <FactRow label="Risk basis" value={`${b.riskConsequence ?? 'Unrated'} consequence, ${b.riskLikelihood ?? 'unrated'} likelihood`} />
          )}
          {b.address && <FactRow label="Address" value={b.address} />}
          {b.ward && <FactRow label="Ward" value={b.ward} />}
          {b.owner && <FactRow label="Owner" value={b.owner} />}
          {b.maintainer && <FactRow label="Maintainer" value={b.maintainer} />}
          <FactRow label="Components" value={<span className="num">{b.componentCount}</span>} />
        </dl>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Building panel
 *
 * Opened by clicking a map dot, a building in any list, or a building
 * picked in search. A dot can hold several buildings geocoded to the same
 * spot: that shows the list first, and each opens its own profile.
 * ------------------------------------------------------------------ */

function BuildingPointPanel({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [focus, setFocus] = useState<string | null>(null);
  const idKey = ids.join(',');
  useEffect(() => setFocus(null), [idKey]);
  const buildings = ids.map((id) => REAL_BUILDINGS_BY_ID.get(id)).filter((b): b is RealAsset => !!b);

  if (buildings.length === 0) {
    return (
      <RightPanelShell accent={ACCENT} eyebrow="Map selection" title="No detail" onClose={onClose}>
        <div className="px-4 py-4 text-base text-ink-2">No register detail found for this point.</div>
      </RightPanelShell>
    );
  }

  const one = buildings.length === 1 ? buildings[0] : buildings.find((b) => b.id === focus) ?? null;
  if (one) {
    return (
      <RightPanelShell accent={ACCENT} eyebrow={one.buildingType ?? 'Building'} title={one.name} onClose={onClose}>
        <div className="px-4 py-4">
          {buildings.length > 1 && (
            <button
              onClick={() => setFocus(null)}
              className="mb-3 flex items-center gap-1 text-base text-ink-2 hover:text-ink"
            >
              <IconChevron size={13} className="rotate-180" />
              All {buildings.length} buildings at this point
            </button>
          )}
          <BuildingProfile b={one} />
        </div>
      </RightPanelShell>
    );
  }

  const total = buildings.reduce((n, b) => n + b.insuredValue, 0);
  const oneName = buildings.every((b) => b.name === buildings[0].name);
  return (
    <RightPanelShell
      accent={ACCENT}
      eyebrow={oneName ? `${buildings.length} buildings` : 'Map point'}
      title={oneName ? buildings[0].name : `${buildings.length} buildings here`}
      onClose={onClose}
    >
      <div className="px-4 py-4">
        <FigureStrip>
          <Figure label="Buildings" value={buildings.length} />
          <Figure label="Insured value" value={formatMoney(total)} />
        </FigureStrip>
        <Section title="Buildings">
          <BuildingList>
            {[...buildings]
              .sort((a, b) => b.insuredValue - a.insuredValue)
              .map((b) => (
                <BuildingRow key={b.id} b={b} onOpen={setFocus} />
              ))}
          </BuildingList>
        </Section>
      </div>
    </RightPanelShell>
  );
}

/* ------------------------------------------------------------------ *
 * Asset category toggles
 *
 * One control surface for "what real buildings show, on the map and in
 * Portfolio's register", living in Layers next to the hazard and
 * vulnerability toggles it needs to be compared against. Portfolio no
 * longer carries its own copy of this control, a category picked here
 * is picked everywhere, so nothing needs re-picking by switching tabs.
 * ------------------------------------------------------------------ */

interface AssetTypeTogglesProps {
  offTypes: Set<string>;
  setOffTypes: (updater: (prev: Set<string>) => Set<string>) => void;
}

/** A real step change, the browser crossfades the old DOM state into the
 *  new one natively (a plain white background underneath means that
 *  crossfade reads as a whiteout, without drawing one by hand). Falls
 *  back to an instant, un-animated swap wherever the API isn't there
 *  flushSync forces React to commit inside the callback synchronously,
 *  which the browser needs to capture the "after" state correctly. */
function withViewTransition(update: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => void };
  if (typeof doc.startViewTransition === 'function') {
    doc.startViewTransition(() => flushSync(update));
  } else {
    update();
  }
}

function AssetTypeToggles({ offTypes, setOffTypes }: AssetTypeTogglesProps) {
  // Plain settings, not something to explore: every type listed at once,
  // grouped under its category as a static heading (not a drill-down),
  // since this only exists to declutter the map, browsing the register
  // by category is a different job and lives in List buildings instead.
  const [showOther, setShowOther] = useState(false);

  const toggleType = useCallback(
    (key: string) => {
      setOffTypes((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [setOffTypes],
  );

  const toggleUse = useCallback(
    (use: UseNode) => {
      setOffTypes((prev) => {
        const next = new Set(prev);
        const allOff = use.types.every((t) => next.has(t.key));
        for (const t of use.types) {
          if (allOff) next.delete(t.key);
          else next.add(t.key);
        }
        return next;
      });
    },
    [setOffTypes],
  );

  const otherClasses: AssetClass[] = ['meter', 'pump', 'accessory'];
  const otherCounts = otherClasses.map((c) => ({
    c,
    count: REAL_ASSETS.filter((a) => a.assetClass === c).length,
  }));

  const onCount = ALL_BUILDING_TYPES.size - offTypes.size;

  return (
    <div>
      {/* What the switches control, and the two bulk actions, as real buttons. */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-sm text-ink-2">
          <span className="num font-semibold text-ink">{onCount}</span> of{' '}
          <span className="num">{ALL_BUILDING_TYPES.size}</span> types on the map
        </span>
        <div className="flex gap-1.5">
          <button
            onClick={() => setOffTypes(() => new Set())}
            disabled={offTypes.size === 0}
            className="rounded-[3px] border border-line px-2 py-1 text-xs font-medium text-ink hover:border-ink-3 disabled:cursor-default disabled:text-ink-3 disabled:hover:border-line"
          >
            Show all
          </button>
          <button
            onClick={() => setOffTypes(() => new Set(ALL_BUILDING_TYPES))}
            disabled={onCount === 0}
            className="rounded-[3px] border border-line px-2 py-1 text-xs font-medium text-ink hover:border-ink-3 disabled:cursor-default disabled:text-ink-3 disabled:hover:border-line"
          >
            Hide all
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {REAL_USE_TREE.map((use) => {
          const isUnclassified = use.key === UNCLASSIFIED;
          const usedOn = use.types.filter((t) => !offTypes.has(t.key)).length;
          return (
            <div key={use.key} className="rounded-[4px] border border-line">
              {/* Category row: its switch turns the whole group on or off. */}
              <button
                onClick={() => toggleUse(use)}
                aria-pressed={usedOn > 0}
                className="flex w-full items-center justify-between gap-2 rounded-t-[3px] border-b border-line bg-surface-2 px-3 py-2 text-left"
              >
                <span className="flex min-w-0 items-center gap-1.5 text-base font-semibold text-ink">
                  {isUnclassified ? 'Not yet classified' : use.label}
                  {isUnclassified && (
                    <Tip
                      label="Not yet classified"
                      body="11 buildings in council's own register, all under the AMSCouncilOwnedProps or AMSPumpStations classes, carry no Building Type value on any of their component rows, Corporate Building, Shed, Clubroom or otherwise. That is a gap in the source register, not something dropped or guessed here."
                      side="top"
                    >
                      <span className="cursor-help text-ink-3">(i)</span>
                    </Tip>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="num text-xs text-ink-3">
                    {usedOn === use.types.length ? 'All on' : usedOn === 0 ? 'Off' : `${usedOn} of ${use.types.length} on`}
                  </span>
                  <Switch on={usedOn > 0} />
                </span>
              </button>
              <div className="divide-y divide-line">
                {use.types.map((t) => {
                  const on = !offTypes.has(t.key);
                  return (
                    <button
                      key={t.key}
                      onClick={() => toggleType(t.key)}
                      aria-pressed={on}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left last:rounded-b-[3px] hover:bg-surface-2"
                    >
                      <span className={`min-w-0 truncate text-base ${on ? 'text-ink' : 'text-ink-3'}`}>
                        {t.label === UNCLASSIFIED ? 'Not yet classified' : t.label}
                        <span className="num ml-1.5 text-xs text-ink-3">{t.count}</span>
                      </span>
                      <Switch on={on} />
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <button
        onClick={() => setShowOther(!showOther)}
        className="mt-2 flex items-center gap-1 text-xs text-ink-3 hover:text-ink"
      >
        <IconChevron size={12} className={`transition-transform ${showOther ? 'rotate-90' : ''}`} />
        Other registered assets, not buildings ({otherCounts.reduce((n, o) => n + o.count, 0)})
      </button>
      {showOther && (
        <div className="fade-up mt-1 rounded-[3px] border border-line bg-surface-2 px-2 py-1.5">
          <p className="mb-1 text-2xs leading-[1.45] text-ink-3">
            In the same export, not classed as buildings, so kept
            out of the toggle list above rather than folded in.
          </p>
          {otherCounts.filter((o) => o.count > 0).map((o) => (
            <div key={o.c} className="flex items-center justify-between py-[2px]">
              <span className="text-xs text-ink-2">{ASSET_CLASS_LABEL[o.c]}</span>
              <span className="num text-xs font-semibold text-ink">{o.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** How this section reads. Content for a header tooltip rather than a
 *  paragraph sitting in the flow, so the panel opens on numbers and
 *  controls, not prose. */
const BUILDINGS_REGISTER_EXPLAINER =
  'Physical buildings from CCS_Buildings.xlsx, council’s own asset register, one row per building rather than per fitout or meter. Categories can be turned on and off below, the same toggle the map markers use. Map positions are geocoded from the register’s address field via OpenStreetMap, approximate, not surveyed. Buildings with no usable address are listed here but not mapped.';

/* ------------------------------------------------------------------ *
 * Real buildings register
 *
 * The Assets tab's whole content: a browse and inspect view over the
 * real, LGA-wide register, with its own building-type toggles for the
 * map built in. Used to live nested under Place, as a sibling of the
 * suburb picker, which stopped making sense once it was a standalone,
 * suburb-independent dataset in its own right, not a suburb profile.
 * ------------------------------------------------------------------ */

interface RealBuildingsRegisterProps {
  offTypes: Set<string>;
  setOffTypes: (updater: (prev: Set<string>) => Set<string>) => void;
  onOpenBuilding: (id: string) => void;
  activeBuildingId: string | null;
}

function formatRegisterDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function RealBuildingsRegister({
  offTypes,
  setOffTypes,
  onOpenBuilding,
  activeBuildingId,
}: RealBuildingsRegisterProps) {
  // Same step pattern as AssetTypeToggles below it: exactly one of
  // "manage types" or "browse the list" showing at a time, not two
  // independent accordions that can both be open and push each other
  // down the page.
  const [view, setView] = useState<'types' | 'list' | 'condition' | 'about' | null>(null);
  const selectView = (v: typeof view) => withViewTransition(() => setView(v));
  // Browsing by category lives here, not in Manage types: that's a map
  // declutter control, this is exploring the register itself. null means
  // "haven't picked a scope yet", 'all' means every building, otherwise
  // a REAL_USE_TREE key.
  const [listScope, setListScope] = useState<string | null>(null);
  const selectListScope = (v: string | null) => withViewTransition(() => setListScope(v));

  // Ward scope: null is the whole LGA. Re-scopes the headline figures and
  // the list below; the map's building-type toggles are unaffected.
  const [ward, setWard] = useState<string | null>(null);
  const scoped = useMemo(
    () => (ward === null ? REAL_BUILDINGS : REAL_BUILDINGS.filter((b) => (b.ward ?? NO_WARD) === ward)),
    [ward],
  );
  const scopedTree = useMemo(() => buildUseTree(scoped), [scoped]);

  const totalInsured = scoped.reduce((n, b) => n + b.insuredValue, 0);
  const preciseCount = scoped.filter((b) => BUILDING_LOCATION[b.id]?.precision === 'site').length;
  const approxCount = scoped.filter((b) => BUILDING_LOCATION[b.id]?.precision === 'street').length;
  const mappedCount = preciseCount + approxCount;
  const onCount = ALL_BUILDING_TYPES.size - offTypes.size;
  const typeCount = new Set(scoped.map((b) => b.buildingType ?? UNCLASSIFIED)).size;

  // The register's own condition ratings, in the order the data already
  // implies (best to worst), plus an explicit not-rated row so the
  // counts always add up to the buildings in scope.
  const conditionRows = [
    ...Object.keys(CONDITION_COLOR).map((label) => ({
      label,
      color: CONDITION_COLOR[label],
      n: scoped.filter((b) => b.condition === label).length,
    })),
    { label: 'Not rated', color: NEUTRAL_TONE, n: scoped.filter((b) => !b.condition).length },
  ].filter((r) => r.n > 0);

  return (
    <div>
      <div style={{ viewTransitionName: 'buildings-register-step' } as React.CSSProperties}>
        {view === null && (
          <>
      {/* Home: one Overview section (scope picker + its headline), then
          one Explore section of tiles. Sub-views replace both and lead
          with their own back bar. */}
      <div className="mb-6">
        <PanelHeading
          right={
            <select
              value={ward ?? ''}
              onChange={(e) => {
                setWard(e.target.value === '' ? null : e.target.value);
                setListScope(null);
              }}
              aria-label="Ward"
              className="rounded-[3px] border border-line bg-white py-1 pl-2 pr-1 text-sm text-ink hover:border-ink-3"
            >
              <option value="">Whole LGA ({REAL_BUILDINGS.length})</option>
              {REAL_WARDS.map((w) => (
                <option key={w.key} value={w.key}>
                  {w.key === NO_WARD ? 'No ward' : w.key} ({w.count})
                </option>
              ))}
            </select>
          }
        >
          Overview
        </PanelHeading>
        <div className="grid grid-cols-2 divide-x divide-line rounded-[4px] border border-line py-3">
          <div className="px-3">
            <div className="text-xs text-ink-3">Buildings</div>
            <div className="num mt-1 text-stat-lg font-semibold leading-none text-ink">{scoped.length}</div>
            <div className="mt-1 text-xs text-ink-3">{typeCount} types</div>
          </div>
          <div className="px-3">
            <div className="text-xs text-ink-3">Insured value</div>
            <div className="num mt-1 text-stat-lg font-semibold leading-none text-ink">
              ${(totalInsured / 1e6).toFixed(1)}M
            </div>
            <div className="mt-1 text-xs text-ink-3">
              {scoped.filter((b) => b.insuredValue > 0).length} valued
            </div>
          </div>
        </div>
      </div>

            <PanelHeading
              right={
                <Tip label="How this reads" body={BUILDINGS_REGISTER_EXPLAINER} side="left">
                  <span className="cursor-help text-sm text-ink-3 underline decoration-dotted">how read</span>
                </Tip>
              }
            >
              Explore the register
            </PanelHeading>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  {
                    id: 'types' as const,
                    title: 'Building types',
                    color: '#006E78',
                    icon: IconAssets,
                    sub: <span className="num">{onCount} of {ALL_BUILDING_TYPES.size} on the map</span>,
                  },
                  {
                    id: 'list' as const,
                    title: 'Browse buildings',
                    color: '#2563EB',
                    icon: IconList,
                    sub: <span className="num">{scoped.length} to browse</span>,
                  },
                  {
                    id: 'condition' as const,
                    title: 'Condition',
                    color: '#D97706',
                    icon: IconGauge,
                    // The register's own rating mix, in its own colours.
                    sub: (
                      <span className="mt-0.5 flex h-[6px] w-full overflow-hidden rounded-[3px] bg-surface-2">
                        {conditionRows.map((r) => (
                          <span key={r.label} style={{ width: `${(r.n / scoped.length) * 100}%`, background: r.color }} />
                        ))}
                      </span>
                    ),
                  },
                  {
                    id: 'about' as const,
                    title: 'Data sources',
                    color: '#7C3AED',
                    icon: IconInfo,
                    sub: <span>Updated {formatRegisterDate(ccsRegisterDates.lastModified)}</span>,
                  },
                ]
              ).map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    onClick={() => selectView(t.id)}
                    className="flex flex-col rounded-[4px] border border-line bg-white p-2.5 text-left transition-all hover:border-ink-3"
                  >
                    <span
                      className="flex h-6 items-center"
                      style={{ color: t.color }}
                    >
                      <Icon size={17} />
                    </span>
                    <span className="mt-2.5 text-base font-semibold leading-tight text-ink">{t.title}</span>
                    <span className="mt-1 block text-xs text-ink-3">{t.sub}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {view === 'condition' && (
          <div>
            <BackBar onBack={() => selectView(null)} parent={`Assets · ${ward === null ? 'Whole LGA' : ward === NO_WARD ? 'No ward' : ward}`} title={view ? ASSET_VIEW_TITLE[view] : ''} />
            <div className="rounded-[4px] border border-line p-3">
              <div className="mb-2.5 text-xs text-ink-3">As rated in the register, for {scoped.length} buildings</div>
              <div className="space-y-2.5">
                {conditionRows.map((r) => (
                  <div key={r.label} className="flex items-center gap-2">
                    <span className="h-[8px] w-[8px] shrink-0 rounded-[2px]" style={{ background: r.color }} />
                    <span className="w-[112px] shrink-0 truncate text-sm text-ink-2">{r.label}</span>
                    <span className="h-[6px] flex-1 overflow-hidden rounded-[3px] bg-surface-2">
                      <span
                        className="block h-full rounded-[3px]"
                        style={{ width: `${(r.n / scoped.length) * 100}%`, background: r.color }}
                      />
                    </span>
                    <span className="num w-7 shrink-0 text-right text-sm font-semibold text-ink">{r.n}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {view === 'about' && (
          <div>
            <BackBar onBack={() => selectView(null)} parent={`Assets · ${ward === null ? 'Whole LGA' : ward === NO_WARD ? 'No ward' : ward}`} title={view ? ASSET_VIEW_TITLE[view] : ''} />
            <p className="mb-4 text-sm leading-[1.5] text-ink-2">
              Council's asset register (<span className="num">CCS_Buildings.xlsx</span>), one row per building, not per
              fitout or meter.
            </p>
            <PanelHeading>Register dates</PanelHeading>
            <div className="mb-4 space-y-1 rounded-[4px] border border-line px-3 py-2.5 text-base leading-[1.5] text-ink-2">
              <div>
                Last modified{' '}
                <span className="num font-semibold text-ink">{formatRegisterDate(ccsRegisterDates.lastModified)}</span>
              </div>
              <div>
                Condition inspection dates are recorded on only{' '}
                <span className="num font-semibold text-ink">
                  {ccsRegisterDates.conditionInspection.componentRowsRecorded}
                </span>{' '}
                register rows ({formatRegisterDate(ccsRegisterDates.conditionInspection.earliest)} to{' '}
                {formatRegisterDate(ccsRegisterDates.conditionInspection.latest)}), so most ratings above have no
                date attached and can't be read as current.
              </div>
            </div>
            <PanelHeading
              right={
                <Tip
                  label="Map coverage"
                  body={`${preciseCount} geocoded to an actual building or named place. ${approxCount} only matched the street they sit on, most register addresses have no house number, so the point is somewhere along that road, not at the building. ${scoped.length - mappedCount} have no address the geocoder could resolve, and are not on the map at all.`}
                  side="left"
                >
                  <span className="num cursor-help text-base text-ink-3 underline decoration-dotted">
                    {mappedCount} of {scoped.length} on map
                  </span>
                </Tip>
              }
            >
              Map coverage
            </PanelHeading>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[4px] border border-line px-3 py-2.5 text-sm text-ink-3">
              <span className="flex items-center gap-1.5">
                <span className="h-[10px] w-[10px] rounded-full border border-white" style={{ background: ACCENT }} />
                {preciseCount} precise
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-[10px] w-[10px] rounded-full border-2" style={{ borderColor: ACCENT, background: '#fff' }} />
                {approxCount} street-level only
              </span>
              <span>{scoped.length - mappedCount} not mapped</span>
            </div>
          </div>
        )}

        {view === 'types' && (
          <div>
            <BackBar onBack={() => selectView(null)} parent={`Assets · ${ward === null ? 'Whole LGA' : ward === NO_WARD ? 'No ward' : ward}`} title={view ? ASSET_VIEW_TITLE[view] : ''} />
            <AssetTypeToggles offTypes={offTypes} setOffTypes={setOffTypes} />
          </div>
        )}

        {view === 'list' && (
          <div>
            <BackBar onBack={() => selectView(null)} parent={`Assets · ${ward === null ? 'Whole LGA' : ward === NO_WARD ? 'No ward' : ward}`} title={view ? ASSET_VIEW_TITLE[view] : ''} />

            <div style={{ viewTransitionName: 'buildings-list-scope' } as React.CSSProperties}>
              {listScope === null && (
                <div className="space-y-1">
                  <button
                    onClick={() => selectListScope('all')}
                    className="flex w-full items-center justify-between rounded-[3px] border border-line bg-white px-2 py-1.5 text-left transition-colors hover:border-accent"
                  >
                    <span className="text-sm font-medium text-ink">
                      All {scoped.length} buildings
                    </span>
                    <span className="num text-2xs text-ink-3">
                      ${(totalInsured / 1e6).toFixed(1)}M
                    </span>
                  </button>
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {scopedTree.map((use) => {
                      const isUnclassified = use.key === UNCLASSIFIED;
                      return (
                        <button
                          key={use.key}
                          onClick={() => selectListScope(use.key)}
                          className="flex items-center gap-1 rounded-[3px] border border-line bg-white px-1.5 py-1 text-left transition-colors hover:border-accent"
                        >
                          <span className="text-sm font-medium text-ink">
                            {isUnclassified ? 'Not yet classified' : use.label}
                          </span>
                          <span className="num text-2xs text-ink-3">{use.count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {listScope !== null && (() => {
                const use = listScope === 'all' ? null : scopedTree.find((u) => u.key === listScope);
                // Match on the real buildingUse field directly, the same
                // grouping buildUseTree used, not on buildingType alone:
                // the same type name can recur under a different use.
                const buildings = use
                  ? scoped.filter((b) => (b.buildingUse ?? UNCLASSIFIED) === use.key)
                  : scoped;
                const label = use ? (use.key === UNCLASSIFIED ? 'Not yet classified' : use.label) : 'All buildings';
                const insured = buildings.reduce((n, b) => n + b.insuredValue, 0);
                return (
                  <div>
                    <button
                      onClick={() => selectListScope(null)}
                      className="mb-1.5 flex items-center gap-[3px] text-xs text-ink-3 transition-colors hover:text-accent"
                    >
                      <IconChevron size={12} className="rotate-180" />
                      All categories
                    </button>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-sm font-medium text-ink">
                        {label}, {buildings.length}
                      </span>
                      <span className="num text-2xs text-ink-3">
                        ${(insured / 1e6).toFixed(1)}M
                      </span>
                    </div>
                    <BuildingList>
                      {buildings.map((b) => (
                        <BuildingRow key={b.id} b={b} onOpen={onOpenBuilding} active={activeBuildingId === b.id} />
                      ))}
                    </BuildingList>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Four real UI regions, each carrying a data-tour attribute, walked in
 *  this order. Not a modal describing the tool, an actual spotlight over
 *  the real rail, panel, map and info button as the person lands on them,
 *  so "how do I use this" gets answered by the interface itself. */
interface TourStep {
  selector: string;
  placement: 'right' | 'top' | 'left';
  title: string;
  body: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    selector: '[data-tour="rail"]',
    placement: 'right',
    title: 'Five tabs',
    body: 'Layers to put data on the map, Assets for the council buildings register, Place to compare suburbs, Cases for site reports, and Help.',
  },
  {
    selector: '[data-tour="left-panel"]',
    placement: 'right',
    title: 'Turn on layers',
    body: 'Apply a Blueprint for a ready-made set, or open a category and switch layers on one at a time. Each layer opens its findings on the right.',
  },
  {
    selector: '[data-tour="map"]',
    placement: 'top',
    title: 'Explore the map',
    body: 'Click a suburb for its buildings, or a building dot for its profile. The legend in the bottom left explains whatever is on.',
  },
  {
    selector: '[data-tour="flood-dock"]',
    placement: 'top',
    title: 'Try a flood event',
    body: 'Pick 1 in 100, 1 in 20 or 1 in 5 to see that flood and what it reaches: council buildings, roads, pipes and the share of the council area.',
  },
  {
    selector: '[data-tour="map-settings"]',
    placement: 'left',
    title: 'Map settings',
    body: 'Basemap, boundaries and the speculative climate scenario. Inspect a point lets you click anywhere and read that spot from every layer. Minimise this card when it is in the way.',
  },
  {
    selector: '[data-tour="rail-cases"]',
    placement: 'right',
    title: 'Case studies',
    body: 'Worked site reports, starting with The Queen Elizabeth Hospital. Each one has its own short guide.',
  },
  {
    selector: '[data-tour="info"]',
    placement: 'left',
    title: 'Come back anytime',
    body: 'This button restarts the guide whenever you need it.',
  },
];

/* ------------------------------------------------------------------ *
 * Search
 *
 * One box for the three things a person looks for by name: a suburb, a
 * layer, or a building (by name or address). Picking a result takes you
 * to it, the right tab, the map moved there, instead of leaving you to
 * work out which tab holds it.
 * ------------------------------------------------------------------ */

type SearchKind = 'suburb' | 'layer' | 'building';

interface SearchHit {
  kind: SearchKind;
  id: string;
  label: string;
  meta: string;
}

const SEARCH_KIND: Record<SearchKind, { label: string; color: string }> = {
  suburb: { label: 'Suburb', color: '#006E78' },
  layer: { label: 'Layer', color: '#2563EB' },
  building: { label: 'Building', color: '#B45309' },
};

function searchAll(query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  // Matches at the start of a name rank above matches in the middle.
  const rank = (text: string) => {
    const t = text.toLowerCase();
    if (t.startsWith(q)) return 0;
    if (t.includes(` ${q}`)) return 1;
    if (t.includes(q)) return 2;
    return -1;
  };
  const byRank = <T,>(items: T[], text: (x: T) => string) =>
    items
      .map((x) => ({ x, r: rank(text(x)) }))
      .filter((m) => m.r >= 0)
      .sort((a, b) => a.r - b.r)
      .map((m) => m.x);

  const suburbs = byRank(SUBURBS, (s) => s.name).map<SearchHit>((s) => ({
    kind: 'suburb',
    id: s.id,
    label: s.name,
    meta: `SA2 ${s.sa2}`,
  }));
  const layers = byRank(
    LAYERS.filter((l) => WORKSHOP_LAYER_IDS.has(l.id)),
    (l) => l.name,
  ).map<SearchHit>((l) => ({ kind: 'layer', id: l.id, label: l.name, meta: GROUP_LABEL[l.group] }));
  const buildings = byRank(
    REAL_BUILDINGS.filter((b) => BUILDING_SUBURB_ID[b.id]),
    (b) => `${b.name} ${b.address ?? ''}`,
  )
    .slice(0, 8)
    .map<SearchHit>((b) => ({
      kind: 'building',
      id: b.id,
      label: b.name,
      meta: [b.buildingType, b.address, SUBURB_BY_ID[BUILDING_SUBURB_ID[b.id]]?.name].filter(Boolean).join(' · '),
    }));
  return [...suburbs, ...layers, ...buildings];
}

function SearchPalette({ onPick, onClose }: { onPick: (hit: SearchHit) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const hits = useMemo(() => searchAll(query), [query]);
  useEffect(() => setActive(0), [query]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && hits[active]) onPick(hits[active]);
  };

  return (
    <div
      className="fixed inset-0 z-[2100] flex items-start justify-center bg-ink/25 px-4 pt-[12vh] backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="fade-up w-full max-w-[480px] overflow-hidden rounded-[4px] border border-line bg-white shadow-[0_4px_14px_rgba(20,32,31,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2.5">
          <IconSearch size={16} className="shrink-0 text-ink-3" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search suburbs, layers or buildings"
            className="flex-1 bg-transparent text-lg text-ink outline-none placeholder:text-ink-3"
          />
          <span className="num rounded-[4px] border border-line px-1.5 py-[1px] text-2xs text-ink-3">Esc</span>
        </div>

        <div className="thin-scroll max-h-[360px] overflow-y-auto py-1">
          {query.trim() === '' && (
            <div className="px-3 py-3 text-sm text-ink-3">
              Type a suburb such as <span className="font-semibold text-ink-2">Henley Beach</span>, a layer such as{' '}
              <span className="font-semibold text-ink-2">Flood</span>, or a building name or street.
            </div>
          )}
          {query.trim() !== '' && hits.length === 0 && (
            <div className="px-3 py-3 text-sm text-ink-3">No match for "{query.trim()}".</div>
          )}
          {hits.map((h, i) => {
            const kind = SEARCH_KIND[h.kind];
            return (
              <button
                key={`${h.kind}-${h.id}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(h)}
                className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${i === active ? 'bg-surface-2' : ''}`}
              >
                <span
                  className="w-[62px] shrink-0 text-2xs font-semibold"
                  style={{ color: kind.color }}
                >
                  {kind.label}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-medium text-ink">{h.label}</span>
                  {h.meta && <span className="block truncate text-xs text-ink-3">{h.meta}</span>}
                </span>
                {i === active && <IconChevron size={13} className="shrink-0 text-ink-3" />}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-line bg-surface-2 px-3 py-1.5 text-2xs text-ink-3">
          <span><span className="num font-semibold">↑↓</span> move</span>
          <span><span className="num font-semibold">Enter</span> open</span>
          <span className="ml-auto">Press <span className="num font-semibold">/</span> anywhere to search</span>
        </div>
      </div>
    </div>
  );
}

/** The tool's actual first screen, shown on every load, not a popup that
 *  depends on remembering whether this browser has seen it before. Two
 *  explicit choices rather than a silent auto-start, so landing here is
 *  never ambiguous about whether anything happened. */
function LandingScreen({ onGuide, onSkip, onCases }: { onGuide: () => void; onSkip: () => void; onCases: () => void }) {
  return (
    <div className="fixed inset-0 z-[2000] flex flex-col items-center justify-center bg-white px-6">
      <div className="flex w-full max-w-[400px] flex-col items-center text-center">
        <img
          src={vapLogo}
          alt="Value Advisory Partners"
          className="landing-in h-16 w-16 object-contain"
          style={{ animationDelay: '0ms' }}
        />
        <div className="landing-in mt-6 h-px w-10 bg-line" style={{ animationDelay: '80ms' }} />
        <div
          className="landing-in mt-6 text-display font-semibold leading-tight text-ink"
          style={{ animationDelay: '140ms' }}
        >
          CoCS Climate Risk Tolerance Tool
        </div>
        <div
          className="landing-in num mt-2 text-xs font-semibold text-ink-3"
          style={{ animationDelay: '200ms' }}
        >
          City of Charles Sturt
        </div>
        <p className="landing-in mt-4 text-md leading-[1.65] text-ink-2" style={{ animationDelay: '260ms' }}>
          This tool puts council's hazard, infrastructure and asset
          information on one working map, instead of leaving each in its
          own separate system.
        </p>
        <div
          className="landing-in mt-7 flex w-full max-w-[260px] flex-col gap-2.5"
          style={{ animationDelay: '340ms' }}
        >
          <button
            onClick={onGuide}
            className="w-full rounded-[3px] bg-accent px-3 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#005963]"
          >
            Take the guide
          </button>
          <button
            onClick={onSkip}
            className="w-full rounded-[3px] border border-line px-3 py-2.5 text-sm font-semibold text-ink-2 transition-colors hover:border-accent hover:text-accent"
          >
            View the tool
          </button>
          <button
            onClick={onCases}
            className="w-full rounded-[3px] border border-line px-3 py-2.5 text-sm font-semibold text-ink-2 transition-colors hover:border-accent hover:text-accent"
          >
            View case studies
          </button>
        </div>
      </div>
      <div className="landing-in absolute bottom-6 text-xs text-ink-3" style={{ animationDelay: '420ms' }}>
        Prepared by Value Advisory Partners
      </div>
    </div>
  );
}

/** A real product-tour spotlight, not a text modal: dims everything
 *  except the live DOM element each step points at, recomputing its
 *  position on every step and on resize so the highlight always sits on
 *  the actual rail, panel, map or button, not a guess at where it is. */
function GuideTour({ onDone, steps = TOUR_STEPS }: { onDone: () => void; steps?: TourStep[] }) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const measure = () => {
      const el = document.querySelector(steps[step].selector);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    const t = window.setTimeout(measure, 250);
    window.addEventListener('resize', measure);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', measure);
    };
  }, [step, steps]);

  const s = steps[step];
  const pad = 6;
  const calloutWidth = 260;

  let calloutStyle: React.CSSProperties = { top: '40%', left: 'calc(50% - 130px)' };
  if (rect) {
    if (s.placement === 'right') {
      calloutStyle = { top: rect.top, left: rect.right + 16 };
    } else if (s.placement === 'left') {
      calloutStyle = { top: rect.top, left: Math.max(16, rect.left - calloutWidth - 16) };
    } else {
      calloutStyle = {
        top: Math.max(16, rect.top - 150),
        left: Math.min(Math.max(16, rect.left), window.innerWidth - calloutWidth - 16),
      };
    }
  }

  return (
    <div className="fixed inset-0 z-[2000]">
      <div className="fixed inset-0" onClick={(e) => e.stopPropagation()} />
      {rect && (
        <div
          className="pointer-events-none fixed rounded-[4px] transition-all duration-200"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            boxShadow: '0 0 0 9999px rgba(20,32,31,0.62)',
            outline: `2px solid ${ACCENT}`,
            outlineOffset: 1,
          }}
        />
      )}
      <div
        className="fixed rounded-[4px] border border-line bg-white p-3 shadow-[0_2px_8px_rgba(20,32,31,0.25)] transition-all duration-200"
        style={{ width: calloutWidth, ...calloutStyle }}
      >
        <div className="num mb-1 text-xs text-ink-3">Step {step + 1} of {steps.length}</div>
        <div className="text-base font-semibold text-ink">{s.title}</div>
        <p className="mt-1 text-sm leading-[1.5] text-ink-2">{s.body}</p>
        <div className="mt-3 flex items-center justify-between">
          <button onClick={onDone} className="text-xs text-ink-3 transition-colors hover:text-ink">
            Skip
          </button>
          <div className="flex gap-1.5">
            {step > 0 && (
              <button
                onClick={() => setStep((v) => v - 1)}
                className="rounded-[3px] border border-line px-2 py-1 text-xs font-medium text-ink-2 transition-colors hover:border-accent hover:text-accent"
              >
                Back
              </button>
            )}
            <button
              onClick={() => (step < steps.length - 1 ? setStep((v) => v + 1) : onDone())}
              className="rounded-[3px] bg-accent px-2 py-1 text-xs font-semibold text-white transition-colors hover:bg-[#005963]"
            >
              {step < steps.length - 1 ? 'Next' : 'Done'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Root
 * ------------------------------------------------------------------ */

export default function App() {
  const [panelTab, setPanelTab] = useState<PanelTab>('layers');
  // Index Place compares suburbs on; it also shades the map there.
  const [indexId, setIndexId] = useState<IndexId>('flood100');
  // SPECULATIVE scenario for the suburb comparison; 'today' is the data as supplied.
  const [scenario, setScenario] = useState<ScenarioSel>({ scenario: 'today', year: 2050 });
  // Weights for the Priority mix layer, set by whoever is using the tool.
  const [priorityW, setPriorityW] = useState<PriorityWeights>(EQUAL_WEIGHTS);
  const priorityCtx = useMemo(() => ({ w: priorityW, setW: setPriorityW }), [priorityW]);
  const [roadBy, setRoadBy] = useState<RoadColour>('role');
  // Flood event scenario shown on the map, and the inspect-a-point tool.
  const [floodEvent, setFloodEvent] = useState<FloodEvent>('none');
  const [heatEvent, setHeatEvent] = useState<HeatEvent>('none');
  const [probeMode, setProbeMode] = useState(false);
  const [probePoint, setProbePoint] = useState<{ lat: number; lng: number } | null>(null);
  const probeModeRef = useRef(false);
  probeModeRef.current = probeMode;
  const roadCtx = useMemo(() => ({ by: roadBy, set: setRoadBy }), [roadBy]);
  // The case study open in the Case studies tab, if any, and what its
  // left-panel controls have switched on around the site.
  const [caseId, setCaseId] = useState<CaseId | null>(null);
  const [caseShow, setCaseShow] = useState<Set<CaseLayer>>(() => new Set<CaseLayer>(['flood100', 'lines', 'focus']));
  const [caseRadius, setCaseRadius] = useState<TqehRadius>(600);
  const [caseView, setCaseView] = useState<CaseView>('hazard');
  const [checkedLayers, setCheckedLayers] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [overlayOpacity, setOverlayOpacity] = useState(0.85);
  const [layerOpacity, setLayerOpacityState] = useState<Record<string, number>>({});
  const [hoveredSuburb, setHoveredSuburb] = useState<string | null>(null);
  const [boundsMode, setBoundsMode] = useState<BoundsMode>('sa2');
  // An explicit choice every time the tool loads, rather than a silently
  // auto-triggered popup gated on remembering a past visit: 'landing'
  // shows first and always, so the orientation is never skipped just
  // because some earlier visit set a flag.
  const [screen, setScreen] = useState<'landing' | 'tour' | 'caseTour' | null>('landing');
  const [searchOpen, setSearchOpen] = useState(false);
  // A building picked from search, labelled on its own once Place opens
  // its suburb, rather than every building in that suburb.
  const [searchFocusId, setSearchFocusId] = useState<string | null>(null);
  const [flyTarget, setFlyTarget] = useState<{ lat: number; lng: number; zoom: number; key: number } | null>(null);
  // Turning a layer on opens its description on the right. Cleared when
  // that same layer is unchecked.
  const [layerInfoId, setLayerInfoId] = useState<string | null>(null);
  const [activeBlueprint, setActiveBlueprint] = useState<BlueprintId | null>(null);
  // Which SA2 a Blueprint's "By SA2" drill-down is showing, and the exact
  // real buildings it's showing for it, so the map can label those same
  // buildings at their real location rather than just listing them here.
  const [blueprintFocus, setBlueprintFocus] = useState<{ suburbId: string; buildingIds: string[] | null } | null>(null);
  const handleBlueprintFocus = useCallback((suburbId: string | null, buildingIds: string[] | null) => {
    setBlueprintFocus(suburbId ? { suburbId, buildingIds } : null);
  }, []);
  // Building types switched off on the MAP, shared by the map and the
  // Assets tab's type toggles. Starts with everything off, opt-in.
  const [buildingOffTypes, setBuildingOffTypes] = useState<Set<string>>(
    () => new Set(ALL_BUILDING_TYPES),
  );
  // Which map point (a lat/lng key, possibly several buildings stacked on
  // it) is open on the right. Clicking the same dot again closes it.
  const [selectedBuildingKey, setSelectedBuildingKey] = useState<string | null>(null);
  const [selectedBuildingIds, setSelectedBuildingIds] = useState<string[]>([]);
  const handleSelectBuildingPoint = useCallback((key: string, ids: string[]) => {
    setSelectedBuildingKey((cur) => (cur === key ? null : key));
    setSelectedBuildingIds(ids);
  }, []);
  // Any building row, search result or ranked list opens that one
  // building's profile on the right, ringed on the map if it's mapped.
  const openBuilding = useCallback((id: string) => {
    const loc = BUILDING_LOCATION[id];
    setSelectedBuildingKey(loc ? `${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}` : `id:${id}`);
    setSelectedBuildingIds([id]);
  }, []);
  // A same-named group: ringed on the map when they share one point.
  const openBuildings = useCallback(
    (ids: string[]) => {
      if (ids.length === 1) return openBuilding(ids[0]);
      const keys = new Set(
        ids.map((id) => {
          const loc = BUILDING_LOCATION[id];
          return loc ? `${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}` : `id:${id}`;
        }),
      );
      setSelectedBuildingKey(keys.size === 1 ? [...keys][0] : `group:${ids[0]}`);
      setSelectedBuildingIds(ids);
    },
    [openBuilding],
  );
  const activeBuildingId =selectedBuildingKey && selectedBuildingIds.length === 1 ? selectedBuildingIds[0] : null;

  // A building opened from anywhere sits on top of a Blueprint or layer
  // panel; closing it goes back to whichever was open underneath.
  // An open case study shows its report on the right; a building opened
  // from that report sits on top of it.
  const rightPanelMode: 'probe' | 'blueprint' | 'building' | 'layer' | 'case' | null = probeMode && probePoint
    ? 'probe'
    : selectedBuildingKey
    ? 'building'
    : panelTab === 'cases' && caseId
      ? 'case'
      : activeBlueprint
      ? 'blueprint'
      : panelTab === 'layers' && layerInfoId
        ? 'layer'
        : null;

  // Years the checked layers' own source files state. Layers whose source
  // states no year contribute nothing here.
  const snapshot = useMemo(() => {
    const years = [
      ...new Set(
        [...checkedLayers]
          .map((id) => LAYER_BY_ID[id]?.vintage)
          .filter((y): y is number => y !== undefined),
      ),
    ].sort();
    return years.length > 0 ? years.join(', ') : null;
  }, [checkedLayers]);

  // Turning a layer on opens its description on the right; turning the same
  // one back off closes it again.
  const toggleLayer = useCallback((id: string) => {
    setActiveBlueprint(null);
    const isOn = checkedLayers.has(id);
    setCheckedLayers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (isOn) {
      setLayerInfoId((cur) => (cur === id ? null : cur));
    } else {
      setLayerInfoId(id);
      // The layer just turned on should be what the right panel shows.
      setSelectedBuildingKey(null);
    }
  }, [checkedLayers]);

  const setLayerOpacity = useCallback((id: string, v: number) => {
    setLayerOpacityState((prev) => ({ ...prev, [id]: v }));
  }, []);

  // Turn a set of layers on (the TQEH tab's "show on map" buttons),
  // keeping whatever else is already on.
  const showLayers = useCallback((ids: string[]) => {
    setActiveBlueprint(null);
    setCheckedLayers((prev) => new Set([...prev, ...ids]));
  }, []);

  const clearAllLayers = useCallback(() => {
    setCheckedLayers(new Set());
    setLayerInfoId(null);
    setActiveBlueprint(null);
  }, []);

  // Turning a blueprint back off releases exactly the layers it turned on;
  // anything hand-picked separately stays untouched.
  const applyBlueprint = useCallback(
    (id: BlueprintId) => {
      if (activeBlueprint === id) {
        const bp = BLUEPRINT_BY_ID[id];
        setCheckedLayers((prev) => {
          const next = new Set(prev);
          for (const l of bp.layers) next.delete(l);
          return next;
        });
        setActiveBlueprint(null);
        return;
      }
      setCheckedLayers(new Set(BLUEPRINT_BY_ID[id].layers));
      setActiveBlueprint(id);
      setLayerInfoId(null);
      setSelectedBuildingKey(null);
    },
    [activeBlueprint],
  );

  // Clicking a suburb opens its Place profile, the same as picking it there.
  const handleSelectSuburb = useCallback((id: string) => {
    // While inspecting, a click reads the point instead of opening a suburb.
    if (probeModeRef.current) return;
    setSelectedId(id);
    setPanelTab('place');
  }, []);

  const handleSearchPick = useCallback(
    (hit: SearchHit) => {
      setSearchOpen(false);
      setScreen(null);
      if (hit.kind === 'suburb') {
        const s = SUBURB_BY_ID[hit.id];
        setSearchFocusId(null);
        handleSelectSuburb(hit.id);
        if (s) setFlyTarget({ lat: s.centroid[0], lng: s.centroid[1], zoom: 14, key: Date.now() });
      } else if (hit.kind === 'layer') {
        if (!checkedLayers.has(hit.id)) toggleLayer(hit.id);
        else setLayerInfoId(hit.id);
        setPanelTab('layers');
      } else {
        const suburbId = BUILDING_SUBURB_ID[hit.id];
        const loc = BUILDING_LOCATION[hit.id];
        setSearchFocusId(hit.id);
        if (suburbId) handleSelectSuburb(suburbId);
        if (loc) setFlyTarget({ lat: loc.lat, lng: loc.lng, zoom: 16, key: Date.now() });
        openBuilding(hit.id);
      }
    },
    [checkedLayers, toggleLayer, handleSelectSuburb, openBuilding],
  );

  // '/' or Ctrl/Cmd+K opens search from anywhere, unless the person is
  // already typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const meta = TAB_META[panelTab];

  // Opening a case study zooms the map to its site.
  // Layers a case turned on that weren't on already, so closing the
  // case releases exactly those and leaves the rest alone.
  const caseAddedRef = useRef<string[]>([]);
  const openCase = useCallback((id: CaseId | null) => {
    setCaseId(id);
    if (id) {
      setFloodEvent('none');
      setHeatEvent('none');
    }
    const c = CASE_STUDIES.find((x) => x.id === id);
    if (c) {
      setActiveBlueprint(null);
      setLayerInfoId(null);
      setSelectedBuildingKey(null);
      setCheckedLayers((prev) => {
        const layers: readonly string[] = c.layers;
        caseAddedRef.current = [...new Set([...caseAddedRef.current, ...layers.filter((l) => !prev.has(l))])];
        return new Set([...prev, ...layers]);
      });
    } else {
      const added = caseAddedRef.current;
      caseAddedRef.current = [];
      setCheckedLayers((prev) => {
        const next = new Set(prev);
        for (const l of added) next.delete(l);
        return next;
      });
    }
  }, []);
  const highlight = useMemo(() => {
    const c = CASE_STUDIES.find((x) => x.id === caseId);
    return panelTab === 'cases' && c ? { ...c.point, links: tqehLinks(), area: tqehArea(caseRadius), show: caseShow } : null;
  }, [panelTab, caseId, caseRadius, caseShow]);

  // Place's suburb comparison shades the map while it's showing.
  const suburbShade = useMemo<SuburbShade | null>(() => {
    if (panelTab !== 'place' || selectedId) return null;
    const def = INDEX_BY_ID[indexId];
    const rows = rankSuburbs(def, scenario).filter((r) => r.v !== null);
    if (rows.length === 0) return null;
    const spec = scenario.scenario !== 'today';
    return {
      label: spec ? `${def.short}, ${SCENARIO_LABEL[scenario.scenario]} ${scenario.year} (speculative)` : def.short,
      color: def.color,
      colors: shadeFor(def, scenario),
      text: Object.fromEntries(rows.map((r) => [r.s.id, `${def.short} ${def.format(r.v!)} (${ordinal(r.rank!)} of 8)`])),
      lo: def.format(rows[rows.length - 1].v!),
      hi: def.format(rows[0].v!),
    };
  }, [panelTab, selectedId, indexId, scenario]);

  // What the map should label at its real location: a Blueprint's
  // drilled-into SA2 takes priority (and its exact filtered buildings),
  // otherwise Place's selected SA2 labels every real building inside it.
  const focusSuburbId = blueprintFocus?.suburbId ?? (panelTab === 'place' ? selectedId : null);
  const searchFocusActive =
    !!searchFocusId && panelTab === 'place' && selectedId === BUILDING_SUBURB_ID[searchFocusId];
  const focusBuildingIds = blueprintFocus
    ? blueprintFocus.buildingIds
    : searchFocusActive
      ? [searchFocusId!]
      : null;

  const scenarioCtx = useMemo(() => ({ sel: scenario, set: setScenario }), [scenario]);

  return (
    <ScenarioContext.Provider value={scenarioCtx}>
    <PriorityContext.Provider value={priorityCtx}>
    <RoadColourContext.Provider value={roadCtx}>
    <div className="flex h-full w-full overflow-hidden bg-surface-2 text-ink">
      <IconRail tab={panelTab} setTab={setPanelTab} onHome={() => setScreen('landing')} />

      <section data-tour="left-panel" className="relative flex w-80 shrink-0 flex-col border-r border-line bg-white">
        <header className="flex items-start justify-between gap-2 border-b border-line px-2.5 py-2">
          <div className="min-w-0">
            <div className="text-2xl font-semibold leading-tight text-ink">{meta.title}</div>
            <div className="mt-[2px] text-sm leading-tight text-ink-3">{meta.subtitle}</div>
          </div>
          <button
            data-tour="info"
            onClick={() => setScreen('tour')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-accent"
            aria-label="Take the guide"
            title="Take the guide"
          >
            <IconInfo size={17} />
          </button>
        </header>

        <div className="border-b border-line px-2.5 py-2">
          <button
            onClick={() => setSearchOpen(true)}
            className="flex w-full items-center gap-2 rounded-[3px] border border-line bg-surface-2 px-2.5 py-1.5 text-left text-base text-ink-3 transition-colors hover:border-accent hover:text-ink-2"
          >
            <IconSearch size={14} className="shrink-0" />
            <span className="flex-1">Search suburbs, layers, buildings</span>
            <span className="num rounded-[4px] border border-line bg-white px-1.5 text-2xs">/</span>
          </button>
        </div>

        <div className="thin-scroll flex-1 overflow-y-auto">
          {panelTab === 'layers' && (
            <LayersTab
              checkedLayers={checkedLayers}
              toggleLayer={toggleLayer}
              overlayOpacity={overlayOpacity}
              setOverlayOpacity={setOverlayOpacity}
              layerOpacity={layerOpacity}
              setLayerOpacity={setLayerOpacity}
              clearAllLayers={clearAllLayers}
              activeBlueprint={activeBlueprint}
              applyBlueprint={applyBlueprint}
            />
          )}
          {panelTab === 'assets' && (
            <div className="px-3 py-4">
              <RealBuildingsRegister
                offTypes={buildingOffTypes}
                setOffTypes={setBuildingOffTypes}
                onOpenBuilding={openBuilding}
                activeBuildingId={activeBuildingId}
              />
            </div>
          )}
          {panelTab === 'place' && (
            <PlaceTab
              selectedId={selectedId}
              setSelectedId={setSelectedId}
              onOpenBuilding={openBuilding}
              onOpenBuildings={openBuildings}
              activeIds={selectedBuildingKey ? selectedBuildingIds : []}
              indexId={indexId}
              setIndexId={setIndexId}
            />
          )}
          {panelTab === 'cases' && (
            <CasesTab
              caseId={caseId}
              setCaseId={openCase}
              show={caseShow}
              setShow={setCaseShow}
              radius={caseRadius}
              setRadius={setCaseRadius}
              setView={setCaseView}
              onGuide={() => setScreen('caseTour')}
            />
          )}
          {panelTab === 'help' && <HelpTab />}
        </div>

        <footer className="border-t border-line px-2.5 py-1.5">
          <span className="text-xs text-ink-3">City of Charles Sturt</span>
        </footer>

        {screen === 'landing' && (
          <LandingScreen
            onGuide={() => setScreen('tour')}
            onSkip={() => setScreen(null)}
            onCases={() => {
              setScreen(null);
              setPanelTab('cases');
            }}
          />
        )}
        {screen === 'tour' && <GuideTour onDone={() => setScreen(null)} />}
        {screen === 'caseTour' && <GuideTour steps={CASE_TOUR_STEPS} onDone={() => setScreen(null)} />}
        {searchOpen && <SearchPalette onPick={handleSearchPick} onClose={() => setSearchOpen(false)} />}
      </section>

      <main data-tour="map" className="flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <MapView
            checkedLayers={checkedLayers}
            overlayOpacity={overlayOpacity}
            layerOpacity={layerOpacity}
            boundsMode={boundsMode}
            setBoundsMode={setBoundsMode}
            selectedId={selectedId}
            onSelectSuburb={handleSelectSuburb}
            hoveredSuburb={hoveredSuburb}
            setHoveredSuburb={setHoveredSuburb}
            rightPanelAccent={activeBlueprint ? BLUEPRINT_BY_ID[activeBlueprint].accent : ACCENT}
            showBuildings={buildingOffTypes.size < ALL_BUILDING_TYPES.size}
            buildingOffTypes={buildingOffTypes}
            selectedBuildingKey={selectedBuildingKey}
            onSelectBuildingPoint={handleSelectBuildingPoint}
            focusSuburbId={focusSuburbId}
            focusBuildingIds={focusBuildingIds}
            flyTarget={flyTarget}
            suburbShade={suburbShade}
            highlight={highlight}
            onOpenCase={() => {
              setPanelTab('cases');
              openCase('tqeh');
            }}
            floodEvent={floodEvent}
            setFloodEvent={setFloodEvent}
            heatEvent={heatEvent}
            setHeatEvent={setHeatEvent}
            probeMode={probeMode}
            setProbeMode={(v) => {
              setProbeMode(v);
              if (!v) setProbePoint(null);
            }}
            onProbe={(lat, lng) => setProbePoint({ lat, lng })}
            probePoint={probePoint}
            hideHazards={panelTab === 'cases' && !!caseId}
          />
        </div>

        <SourceYears snapshot={snapshot} />
      </main>

      {rightPanelMode === 'probe' && probePoint && (
        <ProbePanel
          point={probePoint}
          onClose={() => setProbePoint(null)}
          onOpenBuilding={(id) => {
            setProbeMode(false);
            setProbePoint(null);
            openBuilding(id);
          }}
        />
      )}
      {rightPanelMode === 'case' && caseId && (
        <RightPanelShell
          accent="#C8102E"
          eyebrow="Case study report"
          title={CASE_STUDIES.find((x) => x.id === caseId)!.name}
          onClose={() => openCase(null)}
        >
          <div className="px-4 py-4">
            <TqehTab
              showLayers={showLayers}
              onOpenBuilding={openBuilding}
              onOpenBuildings={openBuildings}
              onOpenSuburb={handleSelectSuburb}
              view={caseView}
              setView={setCaseView}
            />
          </div>
        </RightPanelShell>
      )}
      {rightPanelMode === 'blueprint' && activeBlueprint && (
        <BlueprintPanel
          blueprint={BLUEPRINT_BY_ID[activeBlueprint]}
          onClose={() => applyBlueprint(activeBlueprint)}
          onFocus={handleBlueprintFocus}
          onOpenBuilding={openBuilding}
        />
      )}
      {rightPanelMode === 'building' && (
        <BuildingPointPanel ids={selectedBuildingIds} onClose={() => setSelectedBuildingKey(null)} />
      )}
      {rightPanelMode === 'layer' && layerInfoId && (
        <LayerInfoPanel
          layer={LAYER_BY_ID[layerInfoId]}
          onClose={() => setLayerInfoId(null)}
          onOpenBuilding={openBuilding}
        />
      )}
    </div>
    </RoadColourContext.Provider>
    </PriorityContext.Provider>
    </ScenarioContext.Provider>
  );
}
