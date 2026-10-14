/*
 * CoCS Climate Risk Explorer
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
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
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

// UrbanHeatSocialVulnDay2022.shp + .dbf: a fine-grained grid, individual
// cells well under a hectare, each carrying a real Urban Heat Island
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


type PanelTab = 'layers' | 'assets' | 'place' | 'help';

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
    note: 'Real daytime Urban Heat Island category per grid cell, each cell under a hectare, with a Social Vulnerability Index attached (hover a cell). A fixed 2022 snapshot, not a time series.',
    source: 'Council GIS export, "UrbanHeatSocialVulnDay2022.shp/.dbf", reprojected from GDA2020 MGA Zone 54 and clipped to the LGA',
    vintage: 2022,
  },
  {
    id: 'flood-1in5-real',
    name: 'Flood 1 in 5 (8 of 9 catchments)',
    group: 'hazard',
    kind: 'vector',
    hi: '#1D4ED8',
    unit: 'flood polygons',
    note: 'Real 1 in 5 flood polygons for eight of the nine catchments. Trimmer is missing, so this is not the full picture. No depth is shown, the attribute tables were not supplied.',
    source: 'Council GIS export, flood contour polygons per catchment, 1 in 5 ARI, reprojected from GDA2020 MGA Zone 54',
  },
  {
    id: 'flood-1in20-real',
    name: 'Flood 1 in 20 (3 of 9 catchments)',
    group: 'hazard',
    kind: 'vector',
    hi: '#2563EB',
    unit: 'flood polygons',
    note: 'Real 1 in 20 flood polygons for TRDA, River Torrens and Trimmer only. Six catchments are missing, so this is not the full picture. No depth is shown, the attribute tables were not supplied.',
    source: 'Council GIS export, flood contour polygons per catchment, 1 in 20 ARI, reprojected from GDA2020 MGA Zone 54',
  },
  {
    id: 'flood-1in100-real',
    name: 'Flood 1 in 100 (8 of 9 catchments)',
    group: 'hazard',
    kind: 'vector',
    hi: '#1E3A8A',
    unit: 'flood polygons',
    note: 'Real 1 in 100 flood polygons for eight of the nine catchments. WC is missing, so this is not the full picture. No depth is shown, the attribute tables were not supplied.',
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
    note: 'Not a council asset, but a real state health facility inside the LGA, of the four in the statewide dataset only one point actually falls inside the boundary once checked against the real LGA shape rather than a loose bounding box.',
    source: 'Council GIS export, "Obstetric_Hospitals_2014.shp" (statewide, GDA2020 SA Lambert), reprojected and matched to the real LGA boundary',
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
    note: 'Real train station locations inside the LGA, from the same rail network export as the Railways layer.',
    source: 'Council GIS export, "Train Stations.shp"',
  },
  {
    id: 'pedestrian-network',
    name: 'Pedestrian Network',
    group: 'transport',
    kind: 'vector',
    hi: '#0D9488',
    unit: 'line features',
    note: 'Classified pedestrian routes from the statewide functional hierarchy export, clipped to the LGA. No hierarchy level is shown, the attribute table was not supplied, only the geometry.',
    source: 'Statewide GIS export, "FunctionalHierarchyPedestrian_GDA94.shp", clipped to the LGA boundary',
  },
];

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


const BEVERLEY_ID = 'beverley';

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

function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
  const [open, setOpen] = useState(false);
  const pos =
    side === 'left'
      ? 'right-full mr-1.5 top-0'
      : side === 'top'
        ? 'bottom-full mb-1.5 left-0'
        : 'left-full ml-1.5 top-0';
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          className={`fade-up pointer-events-none absolute ${pos} z-[1400] w-[240px] rounded-[6px] border border-[#233634] bg-[#10201F] px-2 py-1.5 text-[12px] leading-[1.45] text-[#D8E4E3] shadow-[0_6px_18px_rgba(0,0,0,0.28)]`}
        >
          <span className="block font-semibold tracking-[0.04em] text-white uppercase text-[11px] mb-1">
            {label}
          </span>
          <span className="block text-[#C2D2D1]">{body}</span>
          {source && (
            <span className="mt-1 block border-t border-[#25403E] pt-1 text-[11px] text-[#7E9997]">
              Source: {source}
            </span>
          )}
        </span>
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
        <span className="flex-1 text-[13.5px] font-semibold tracking-[0.01em] text-ink">
          {title}
        </span>
        {count && <span className="num text-[12px] text-ink-3">{count}</span>}
      </button>
      {open && <div className="pb-1.5">{children}</div>}
    </div>
  );
}

/** Square checkbox in the accent colour. */
function Check({ on }: { on: boolean }) {
  return (
    <span
      className="flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[4px] border transition-colors"
      style={{
        borderColor: on ? ACCENT : '#C9D3D2',
        background: on ? ACCENT : '#fff',
      }}
    >
      {on && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5 10 17.5 19 7" />
        </svg>
      )}
    </span>
  );
}

/** Segmented control. Used for basemap and bounds. */

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
    <div className="inline-flex items-center gap-[2px] rounded-[5px] border border-line bg-surface-2 p-[2px]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={`num rounded-[3.5px] ${dense ? 'px-1.5 py-[2px]' : 'px-2 py-[3px]'} text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35`}
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
function PanelHeading({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <span className="text-[13px] font-semibold uppercase tracking-[0.07em] text-ink-3">
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
  onZoomChange: (z: number) => void;
  showBuildings: boolean;
  buildingOffTypes: Set<string>;
  selectedBuildingKey: string | null;
  onSelectBuildingPoint: (key: string, ids: string[]) => void;
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
    onZoomChange,
    showBuildings,
    buildingOffTypes,
    selectedBuildingKey,
    onSelectBuildingPoint,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const LRef = useRef<typeof import('leaflet') | null>(null);
  const builtRef = useRef<LeafletLayer[]>([]);
  const hoverRef = useRef<LeafletLayer[]>([]);
  const [ready, setReady] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(MAP_ZOOM);
  const [basemap, setBasemap] = useState(BASEMAPS[0].id);
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
        onZoomChange(map.getZoom());
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

    if (checkedLayers.has('pedestrian-network')) {
      const c = LAYER_BY_ID['pedestrian-network'].hi!;
      for (const line of pedestrianNetworkData as LatLngTuple[][]) {
        haloLine(line, { color: c, weight: 2, opacity: vecAlpha('pedestrian-network'), dashArray: '1 3' });
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








    /* Boundary outlines sit above every fill so they stay legible. The
       real council LGA shape (from council's own GIS, not an ABS
       statistical approximation) draws as the bold outer edge; the 8
       SA2 shapes draw lighter, inside it, for the suburb divisions. */
    if (boundsMode === 'sa2') {
      for (const ring of SUBURBS.map((s) => s.path)) {
        push(
          L.polygon(ring, {
            fill: false,
            color: darkBase ? '#F2F7F6' : '#2B3C3A',
            weight: 0.7,
            opacity: darkBase ? 0.55 : 0.4,
            interactive: false,
          }),
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

    builtRef.current = added;
    return () => {
      for (const l of added) {
        if (map.hasLayer(l)) map.removeLayer(l);
      }
      builtRef.current = [];
    };
  }, [
    ready,
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
  ]);

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

      <div className="absolute left-3 top-3 z-[999]">
        <div className="rounded-[6px] border border-line bg-white/95 p-1 shadow-[0_2px_10px_rgba(20,32,31,0.1)] backdrop-blur">
          <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-3">
            Basemap
          </div>
          <Segmented
            dense
            value={basemap}
            onChange={setBasemap}
            options={BASEMAPS.map((b) => ({ value: b.id, label: b.name }))}
          />
        </div>
      </div>

      <div className="absolute right-3 top-3 z-[999]">
        <div className="rounded-[6px] border border-line bg-white/95 p-1 shadow-[0_2px_10px_rgba(20,32,31,0.1)] backdrop-blur">
          <div className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-3">
            Bounds
          </div>
          <Segmented
            dense
            value={boundsMode}
            onChange={(v) => setBoundsMode(v)}
            options={[
              { value: 'none' as BoundsMode, label: 'None' },
              { value: 'sa2' as BoundsMode, label: 'SA2' },
              { value: 'sa1' as BoundsMode, label: 'SA1' },
            ]}
          />
        </div>
      </div>

      {selected && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-[999] -translate-x-1/2">
          <div
            className="fade-up flex items-center gap-1.5 rounded-full border bg-white px-2.5 py-1 shadow-[0_2px_10px_rgba(20,32,31,0.12)]"
            style={{ borderColor: rightPanelAccent }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: rightPanelAccent }} />
            <span className="text-[13.5px] font-semibold text-ink">{selected.name}</span>
            <span className="num text-[12px] text-ink-3">{selected.sa2}</span>
          </div>
        </div>
      )}

      {hovered && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-[999] w-[240px]">
          <div className="fade-up rounded-[6px] border border-line bg-white/96 p-2 shadow-[0_2px_12px_rgba(20,32,31,0.12)] backdrop-blur">
            <div className="flex items-baseline justify-between">
              <span className="text-[13.5px] font-semibold text-ink">{hovered.name}</span>
              <span className="num text-[11.5px] text-ink-3">{hovered.sa2}</span>
            </div>
          </div>
        </div>
      )}

      <div className="absolute bottom-3 right-3 z-[999] flex flex-col gap-[3px]">
        <button
          onClick={() => mapRef.current?.zoomIn()}
          className="flex h-6 w-6 items-center justify-center rounded-[5px] border border-line bg-white/95 text-ink-2 shadow-[0_1px_5px_rgba(20,32,31,0.1)] transition-colors hover:border-accent hover:text-accent"
          aria-label="Zoom in"
        >
          <IconPlus />
        </button>
        <button
          onClick={() => mapRef.current?.zoomOut()}
          className="flex h-6 w-6 items-center justify-center rounded-[5px] border border-line bg-white/95 text-ink-2 shadow-[0_1px_5px_rgba(20,32,31,0.1)] transition-colors hover:border-accent hover:text-accent"
          aria-label="Zoom out"
        >
          <IconMinus />
        </button>
        <div className="num mt-[2px] rounded-[4px] border border-line bg-white/95 py-[1px] text-center text-[11.5px] text-ink-3">
          z{zoomLevel}
        </div>
      </div>
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
}

function LayersTab({
  checkedLayers,
  toggleLayer,
  overlayOpacity,
  setOverlayOpacity,
  layerOpacity,
  setLayerOpacity,
  clearAllLayers,
}: LayersTabProps) {
  const [hoverId, setHoverId] = useState<string | null>(null);
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
  const [activeTab, setActiveTab] = useState<LayersSection>('hazard');

  // Dwelling Density has no home in visibleLayers yet, it's the one of
  // the 8 workshop layers still waiting on its own attribute table (see
  // CoCS_DwellingDensity2021.shp in the project notes), so Vulnerability
  // stays in the list with a fixed count of 1 to hold its place rather
  // than disappearing as if it were never promised.
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
      on: 0,
      total: 1,
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
  ];
  const categories = allCategories.filter((c) => c.total > 0);

  const renderLayerList = (g: LayerGroup) => {
    // A heading here, not just the category card above, so which group
    // is showing stays clear once you've scrolled past the card grid.
    const heading = (
      <div className="px-2.5 pt-2">
        <PanelHeading>{GROUP_LABEL[g]}</PanelHeading>
      </div>
    );
    if (g === 'vulnerability') {
      return (
        <div className="pb-1.5">
          {heading}
          <div className="mx-2.5 flex items-center gap-1.5 rounded-[5px] border border-dashed border-line px-2 py-1.5 opacity-70">
            <span className="h-[9px] w-[9px] shrink-0 rounded-[2px] bg-[#D8CFF0]" />
            <span className="flex-1 truncate text-[12px] text-ink-3">Dwelling Density</span>
            <span className="text-[10.5px] text-ink-3">needs attribute data</span>
          </div>
        </div>
      );
    }
    const layers = visibleLayers.filter((l) => l.group === g);
    return (
      <div className="pb-1.5">
        {heading}
        {layers.map((l) => {
          const checked = checkedLayers.has(l.id);
          const showSlider = checked || hoverId === l.id;
          const op = layerOpacity[l.id] ?? 1;
          return (
            <div
              key={l.id}
              onMouseEnter={() => setHoverId(l.id)}
              onMouseLeave={() => setHoverId(null)}
              className={`px-2.5 py-[5px] transition-colors ${checked ? 'bg-accent-soft/45' : 'hover:bg-surface-2'}`}
            >
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => toggleLayer(l.id)}
                  className="flex flex-1 items-center gap-1.5 text-left"
                >
                  <Check on={checked} />
                  <span
                    className="h-[9px] w-[9px] shrink-0 rounded-[2px]"
                    style={{
                      background:
                        l.kind === 'vector'
                          ? l.hi
                          : `linear-gradient(135deg, ${l.lo}, ${l.hi})`,
                    }}
                  />
                  <span
                    className={`flex-1 truncate text-[12px] ${checked ? 'font-semibold text-ink' : 'text-ink-2'}`}
                  >
                    {l.name}
                  </span>
                </button>
                <Tip label={l.name} body={l.note} source={l.source} side="left">
                  <span className="flex h-[16px] w-[16px] cursor-help items-center justify-center rounded-full border border-line text-[10px] font-semibold text-ink-3 hover:border-accent hover:text-accent">
                    i
                  </span>
                </Tip>
              </div>
              {showSlider && (
                <div className="fade-up mt-[3px] flex items-center gap-1.5 pl-[22px]">
                  <input
                    type="range"
                    min={10}
                    max={100}
                    value={Math.round(op * 100)}
                    onChange={(e) =>
                      setLayerOpacity(l.id, Number(e.target.value) / 100)
                    }
                    className="h-3 flex-1"
                  />
                  <span className="num w-[32px] text-right text-[11.5px] text-ink-3">
                    {Math.round(op * 100)}%
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div>
      {/* One-click way back to nothing turned on, only shown once there
          is actually something to clear. No other control here undoes
          what the others switched on. */}
      {checkedLayers.size > 0 && (
        <div className="flex items-center justify-between border-b border-line bg-surface-2 px-2.5 py-1.5">
          <span className="text-[11px] text-ink-3">
            {checkedLayers.size} layer{checkedLayers.size === 1 ? '' : 's'} on
          </span>
          <button
            onClick={clearAllLayers}
            className="text-[11px] font-medium text-accent underline decoration-dotted hover:text-ink"
          >
            Clear all
          </button>
        </div>
      )}

      {/* Global opacity sits above everything it governs, the one
          control that applies regardless of which section is open. */}
      <div className="border-b border-line px-2.5 py-2.5">
        <PanelHeading
          right={
            <span className="num text-[12.5px] font-semibold text-accent">
              {Math.round(overlayOpacity * 100)}%
            </span>
          }
        >
          Global opacity
        </PanelHeading>
        <input
          type="range"
          min={10}
          max={100}
          value={Math.round(overlayOpacity * 100)}
          onChange={(e) => setOverlayOpacity(Number(e.target.value) / 100)}
          className="w-full"
        />
      </div>

      {/* Category cards: a colour and a live on/total count read faster than
          a label alone. */}
      <div className="border-b border-line px-2.5 py-2.5">
        <PanelHeading>Layer categories</PanelHeading>
        <div className="grid grid-cols-2 gap-1.5">
          {categories.map((c) => {
            const on = activeTab === c.value;
            return (
              <button
                key={c.value}
                onClick={() => setActiveTab(c.value)}
                className="rounded-[5px] border px-1.5 py-1.5 text-left transition-all"
                style={{
                  borderColor: on ? c.color : '#E2E7E7',
                  background: on ? withAlpha(c.color, 0.08) : '#fff',
                }}
              >
                <div className="flex items-center justify-between">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.color }} />
                  <span className="num text-[10.5px] text-ink-3">{c.on}/{c.total}</span>
                </div>
                <span
                  className="mt-1 block text-[12px] font-semibold leading-tight"
                  style={{ color: on ? c.color : '#14201F' }}
                >
                  {c.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {renderLayerList(activeTab)}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Tab 2. Place
 * ------------------------------------------------------------------ */

interface PlaceTabProps {
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
}

function PlaceTab({ selectedId, setSelectedId }: PlaceTabProps) {
  const [openAsset, setOpenAsset] = useState<string | null>(null);

  if (!selectedId || !SUBURB_BY_ID[selectedId]) {
    return (
      <div className="px-2.5 py-2.5">
        <p className="mb-3 text-[12.5px] leading-[1.6] text-ink-2">
          The eight ABS SA2s covering the LGA. Choose one to see the council
          buildings register filed inside it. Population, SEIFA and hazard
          scores are not shown, because no real figures for them have been
          supplied yet.
        </p>
        <PanelHeading>SA2s</PanelHeading>
        <div className="space-y-1.5">
          {SUBURBS.map((s) => {
            const bs = REAL_BUILDINGS_BY_SUBURB[s.id] ?? [];
            const value = bs.reduce((n, b) => n + b.insuredValue, 0);
            return (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className="flex w-full items-center justify-between rounded-[6px] border border-line bg-white px-3 py-2 text-left transition-colors hover:border-accent"
              >
                <span>
                  <span className="block text-[13px] font-medium text-ink">{s.name}</span>
                  <span className="num mt-[2px] block text-[11px] text-ink-3">SA2 {s.sa2}</span>
                </span>
                <span className="text-right">
                  <span className="num block text-[13px] font-semibold text-ink">{bs.length} buildings</span>
                  <span className="num block text-[11px] text-ink-3">${(value / 1e6).toFixed(1)}M insured</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const s = SUBURB_BY_ID[selectedId];
  const buildings = REAL_BUILDINGS_BY_SUBURB[s.id] ?? [];
  const insured = buildings.reduce((n, b) => n + b.insuredValue, 0);

  return (
    <div className="px-2.5 py-2.5">
      <button
        onClick={() => setSelectedId(null)}
        className="mb-2 flex items-center gap-[3px] text-[11.5px] text-ink-3 transition-colors hover:text-accent"
      >
        <IconChevron size={13} className="rotate-180" />
        All SA2s
      </button>
      <div className="mb-3">
        <div className="text-[15px] font-semibold text-ink">{s.name}</div>
        <div className="num text-[11.5px] text-ink-3">SA2 {s.sa2}</div>
      </div>
      <PanelHeading>At a glance</PanelHeading>
      <div className="mb-3 grid grid-cols-2 gap-2">
        <div className="rounded-[6px] border border-line bg-white px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">Buildings</div>
          <div className="num mt-1 text-[20px] font-semibold leading-none text-ink">{buildings.length}</div>
        </div>
        <div className="rounded-[6px] border border-line bg-white px-3 py-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">Insured value</div>
          <div className="num mt-1 text-[20px] font-semibold leading-none text-ink">${(insured / 1e6).toFixed(1)}M</div>
        </div>
      </div>
      <p className="mb-3 text-[11.5px] leading-[1.5] text-ink-3">
        Population, SEIFA and hazard scores for this SA2 are not shown, no
        real figures for them have been supplied yet.
      </p>
      <PanelHeading>Buildings in this SA2</PanelHeading>
      {buildings.length === 0 ? (
        <p className="text-[12px] text-ink-3">No register buildings geocode inside this SA2.</p>
      ) : (
        <div className="space-y-1.5">
          {buildings.map((b) => (
            <BuildingCard
              key={b.id}
              b={b}
              isOpen={openAsset === b.id}
              onToggle={() => setOpenAsset(openAsset === b.id ? null : b.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shared bits
 * ------------------------------------------------------------------ */

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-1 first:mt-0">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
        {label}
      </div>
      <div className="mt-[1px] text-[12px] leading-[1.5] text-ink-2">{value}</div>
    </div>
  );
}

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
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-white shadow-[-4px_0_18px_rgba(20,32,31,0.06)]">
      <header className="flex items-start gap-1.5 border-b border-line px-2.5 py-2">
        <span className="mt-[5px] h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-3">
            {eyebrow}
          </div>
          <div className="truncate text-[14px] font-semibold leading-tight" style={{ color: accent }}>
            {title}
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="mt-[2px] shrink-0 rounded-[4px] p-[3px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
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
 * Layer info panel
 *
 * Checking a layer opens its description here, so what the layer is and
 * where it came from is one click away rather than a hover tooltip.
 */

function LayerInfoPanel({
  layer,
  onClose,
}: {
  layer: LayerDef;
  onClose: () => void;
}) {
  return (
    <RightPanelShell accent={layer.hi ?? ACCENT} eyebrow="Layer" title={layer.name} onClose={onClose}>
      <div className="px-2.5 py-2">
        <p className="text-[12.5px] leading-[1.55] text-ink-2">{layer.note}</p>
        <div className="num mt-2 text-[11px] text-ink-3">
          Unit: {layer.unit} · {layer.source}
        </div>
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
      <div className="px-2.5 text-[12.5px] leading-[1.6] text-ink-2">{body}</div>
    </Accordion>
  );

  return (
    <div>
      {section(
        'quick',
        'Quick start',
        <>
          <p>
            Turn on a layer in the Layers tab. Click a suburb on the map, or
            pick one in Place, to see the council buildings inside it. Turn on
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
            <span className="font-semibold text-ink">Layers.</span> Real
            hazard and infrastructure layers from council's GIS export.
            Opacity sliders at the top and on each layer.
          </li>
          <li>
            <span className="font-semibold text-ink">Assets.</span> The real
            council buildings register, LGA-wide. Filter by ward, see condition
            and insured value, and choose which building types show on the map.
          </li>
          <li>
            <span className="font-semibold text-ink">Place.</span> The eight
            real ABS SA2s, with the council buildings filed inside each.
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
            table gives real indicator names but no agreed tolerance for any
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
            capacity and ranking are not shown. No real figures for them have
            been supplied, and the earlier demonstration values have been
            removed rather than kept on screen.
          </p>
          <p className="mt-1.5">
            No thresholds or tolerances have been set for any measure. Where
            one is needed it will be entered from council's own agreed values.
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
      <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-3">
        Source years
      </span>
      <span className="num text-[12px] text-ink-2">{snapshot ?? 'No dated layer on the map'}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Icon rail
 * ------------------------------------------------------------------ */

const TAB_META: Record<
  PanelTab,
  { title: string; subtitle: string; icon: (p: IconProps) => React.ReactElement }
> = {
  layers: {
    title: 'Layers',
    subtitle: 'Hazards, real buildings and the network behind them',
    icon: IconLayers,
  },
  assets: {
    title: 'Assets',
    subtitle: 'The real council buildings register, LGA-wide',
    icon: IconAssets,
  },
  place: {
    title: 'Place',
    subtitle: 'The eight SA2s, and the council buildings inside each',
    icon: IconPlace,
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
}: {
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
}) {
  // Assets split out from Place: a real, LGA-wide register isn't a
  // suburb profile, it doesn't belong nested under one.
  const order: PanelTab[] = ['layers', 'assets', 'place', 'help'];
  return (
    <nav className="flex w-14 shrink-0 flex-col items-center border-r border-line bg-white py-2">
      <div
        className="mb-2 flex h-6 w-6 items-center justify-center rounded-[5px] text-[12px] font-bold text-white"
        style={{ background: ACCENT }}
      >
        CS
      </div>
      {order.map((t) => {
        const meta = TAB_META[t];
        const Icon = meta.icon;
        const on = tab === t;
        const separator = t === 'help';
        return (
          <React.Fragment key={t}>
            {separator && <div className="my-1.5 h-px w-5 bg-line" />}
            <Tip label={meta.title} body={meta.subtitle}>
              <button
                onClick={() => setTab(t)}
                className="flex h-8 w-8 items-center justify-center rounded-[7px] transition-colors"
                style={{
                  background: on ? ACCENT : 'transparent',
                  color: on ? '#fff' : '#7E8D8C',
                }}
                aria-label={meta.title}
                aria-current={on ? 'page' : undefined}
              >
                <Icon size={18} />
              </button>
            </Tip>
          </React.Fragment>
        );
      })}
      <div className="mt-auto pb-1">
        <Tip label="Prepared by" body="Value Advisory Partners" side="right">
          <img
            src={vapLogo}
            alt="Value Advisory Partners"
            className="h-8 w-8 shrink-0 object-contain"
          />
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
const RISK_COLOR: Record<string, string> = {
  'Low Risk': '#059669',
  'Medium Risk': '#D97706',
  'High Risk': '#EA580C',
  'Extreme Risk': '#DC2626',
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




/** One real building, expandable to its full register detail. Shared
 *  between the LGA-wide register list and the per-suburb building lists
 *  in Place, so a building reads identically wherever it turns up. */
function BuildingCard({
  b,
  isOpen,
  onToggle,
}: {
  b: RealAsset;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const condColor = b.condition ? CONDITION_COLOR[b.condition] ?? NEUTRAL_TONE : NEUTRAL_TONE;
  const riskColor = b.inherentRisk ? RISK_COLOR[b.inherentRisk] ?? NEUTRAL_TONE : NEUTRAL_TONE;
  const loc = BUILDING_LOCATION[b.id];
  const located = !!loc;
  return (
    <div
      className={`rounded-[5px] border bg-white transition-colors ${isOpen ? 'border-accent' : 'border-line'}`}
    >
      <button onClick={onToggle} className="w-full px-2 py-1.5 text-left">
        <div className="flex items-start justify-between gap-1.5">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12px] font-semibold text-ink">{b.name}</span>
            <span className="num mt-[2px] block truncate text-[10.5px] text-ink-3">
              {b.buildingType ?? 'Not yet classified'}
              {b.suburb ? ` · ${b.suburb}` : ''}
              {!located && ' · not mapped'}
            </span>
          </span>
          {b.insuredValue > 0 && (
            <span className="num shrink-0 text-[11px] font-semibold text-ink-2">
              ${(b.insuredValue / 1000).toFixed(0)}k
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {b.condition && (
            <span className="rounded-[3px] px-1 text-[10.5px] font-medium" style={{ background: withAlpha(condColor, 0.12), color: condColor }}>
              {b.condition}
            </span>
          )}
          {b.inherentRisk && (
            <span className="rounded-[3px] px-1 text-[10.5px] font-medium" style={{ background: withAlpha(riskColor, 0.12), color: riskColor }}>
              {b.inherentRisk}
            </span>
          )}
        </div>
      </button>
      {isOpen && (
        <div className="fade-up border-t border-line px-2 py-1.5">
          {b.address && <DetailRow label="Address" value={`${b.address}${b.ward ? `, ${b.ward} ward` : ''}`} />}
          {b.owner && <DetailRow label="Asset owner" value={b.owner} />}
          {b.maintainer && <DetailRow label="Maintainer" value={b.maintainer} />}
          {b.criticality && <DetailRow label="Criticality" value={b.criticality} />}
          {(b.riskConsequence || b.riskLikelihood) && (
            <DetailRow label="Risk rating" value={`${b.riskConsequence ?? 'unrated'} consequence, ${b.riskLikelihood ?? 'unrated'} likelihood`} />
          )}
          <DetailRow label="Register components" value={`${b.componentCount} component ${b.componentCount === 1 ? 'row' : 'rows'} under this asset in the source export`} />
          <DetailRow
            label="Map position"
            value={
              !located
                ? 'Not shown on the map, no address in the register resolved to a location.'
                : loc!.precision === 'site'
                  ? 'Shown on the map, geocoded to the actual building or named place.'
                  : 'Shown on the map as a hollow marker, geocoded to the street only, the address had no number so this is not the building itself.'
            }
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Map point panel
 *
 * Clicking a building dot is as deliberate an act as loading a
 * blueprint or opening a suburb, so it gets the same right-panel
 * treatment instead of a hover tooltip being the only way to read one.
 * One point can hold several buildings that geocoded to the same spot,
 * so this shows every real building filed there plus the small amount
 * of aggregate reading the register itself supports (count, insured
 * value, condition and risk mix), nothing modelled or invented.
 * ------------------------------------------------------------------ */

function BuildingPointPanel({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const buildings = ids
    .map((id) => REAL_BUILDINGS_BY_ID.get(id))
    .filter((b): b is RealAsset => !!b);

  if (buildings.length === 0) {
    return (
      <RightPanelShell accent={ACCENT} eyebrow="Map selection" title="No detail" onClose={onClose}>
        <div className="px-2.5 py-2">
          <p className="text-[11.5px] leading-[1.55] text-ink-2">
            No register detail found for this point.
          </p>
        </div>
      </RightPanelShell>
    );
  }

  const single = buildings.length === 1;
  const totalInsured = buildings.reduce((n, b) => n + b.insuredValue, 0);
  const conditionCounts = new Map<string, number>();
  const riskCounts = new Map<string, number>();
  for (const b of buildings) {
    if (b.condition) conditionCounts.set(b.condition, (conditionCounts.get(b.condition) ?? 0) + 1);
    if (b.inherentRisk) riskCounts.set(b.inherentRisk, (riskCounts.get(b.inherentRisk) ?? 0) + 1);
  }

  return (
    <RightPanelShell
      accent={ACCENT}
      eyebrow="Map selection"
      title={single ? buildings[0].name : `${buildings.length} buildings here`}
      onClose={onClose}
    >
      <div className="px-2.5 py-2">
        {!single && (
          <>
            <PanelHeading>At this point</PanelHeading>
            <div className="mb-3 grid grid-cols-2 gap-1.5">
              <div className="rounded-[5px] border border-line bg-white px-2 py-1.5">
                <div className="text-[11px] uppercase tracking-[0.05em] text-ink-3">Buildings</div>
                <div className="num text-[16px] font-semibold text-ink">{buildings.length}</div>
              </div>
              <div className="rounded-[5px] border border-line bg-white px-2 py-1.5">
                <div className="text-[11px] uppercase tracking-[0.05em] text-ink-3">Insured value</div>
                <div className="num text-[16px] font-semibold text-ink">
                  ${(totalInsured / 1e6).toFixed(1)}M
                </div>
              </div>
            </div>
            {(conditionCounts.size > 0 || riskCounts.size > 0) && (
              <div className="mb-3 space-y-1">
                {conditionCounts.size > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {[...conditionCounts.entries()].map(([label, n]) => {
                      const c = CONDITION_COLOR[label] ?? NEUTRAL_TONE;
                      return (
                        <span
                          key={label}
                          className="rounded-[3px] px-1 text-[10.5px] font-medium"
                          style={{ background: withAlpha(c, 0.12), color: c }}
                        >
                          {n} {label}
                        </span>
                      );
                    })}
                  </div>
                )}
                {riskCounts.size > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {[...riskCounts.entries()].map(([label, n]) => {
                      const c = RISK_COLOR[label] ?? NEUTRAL_TONE;
                      return (
                        <span
                          key={label}
                          className="rounded-[3px] px-1 text-[10.5px] font-medium"
                          style={{ background: withAlpha(c, 0.12), color: c }}
                        >
                          {n} {label}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
        <PanelHeading>{single ? 'Register detail' : 'Each building'}</PanelHeading>
        <div className="space-y-1.5">
          {buildings.map((b) => (
            <BuildingCard
              key={b.id}
              b={b}
              isOpen={single || openId === b.id}
              onToggle={() => setOpenId((cur) => (cur === b.id ? null : b.id))}
            />
          ))}
        </div>
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
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] text-ink-3">
          {onCount} of {ALL_BUILDING_TYPES.size} types shown
        </span>
        <button
          onClick={() => setOffTypes(() => new Set())}
          className="text-[11px] text-ink-3 underline decoration-dotted hover:text-ink"
        >
          show all
        </button>
      </div>

      <div className="space-y-1.5">
        {REAL_USE_TREE.map((use) => {
          const isUnclassified = use.key === UNCLASSIFIED;
          return (
            <div key={use.key} className="rounded-[5px] border border-line bg-white p-1.5">
              <div className="mb-1 flex items-center justify-between">
                <span className="flex items-center gap-1 text-[11px] font-semibold text-ink-2">
                  {isUnclassified ? 'Not yet classified' : use.label}
                  {isUnclassified && (
                    <Tip
                      label="Not yet classified"
                      body="11 buildings in council's own register, all under the AMSCouncilOwnedProps or AMSPumpStations classes, carry no Building Type value on any of their component rows, Corporate Building, Shed, Clubroom or otherwise. That is a real gap in the source register, not something dropped or guessed here."
                      side="top"
                    >
                      <span className="cursor-help text-ink-3">(i)</span>
                    </Tip>
                  )}
                </span>
                <button
                  onClick={() => toggleUse(use)}
                  className="text-[10.5px] text-accent hover:underline"
                >
                  toggle all
                </button>
              </div>
              <div className="flex flex-wrap gap-1">
                {use.types.map((t) => {
                  const on = !offTypes.has(t.key);
                  return (
                    <button
                      key={t.key}
                      onClick={() => toggleType(t.key)}
                      className="flex items-center gap-1 rounded-[4px] border px-1.5 py-[3px] text-[11px] transition-colors"
                      style={
                        on
                          ? { borderColor: ACCENT, background: '#fff', color: '#14201F' }
                          : { borderColor: '#E2E7E7', background: '#EDF1F1', color: '#A8B5B4' }
                      }
                    >
                      <Check on={on} />
                      {t.label === UNCLASSIFIED ? 'Not yet classified' : t.label}
                      <span className="num text-[10px] opacity-70">{t.count}</span>
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
        className="mt-2 flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink"
      >
        <IconChevron size={12} className={`transition-transform ${showOther ? 'rotate-90' : ''}`} />
        Other registered assets, not buildings ({otherCounts.reduce((n, o) => n + o.count, 0)})
      </button>
      {showOther && (
        <div className="fade-up mt-1 rounded-[5px] border border-line bg-surface-2 px-2 py-1.5">
          <p className="mb-1 text-[10.5px] leading-[1.45] text-ink-3">
            Real, in the same export, not classed as buildings, so kept
            out of the toggle list above rather than folded in.
          </p>
          {otherCounts.filter((o) => o.count > 0).map((o) => (
            <div key={o.c} className="flex items-center justify-between py-[2px]">
              <span className="text-[11px] text-ink-2">{ASSET_CLASS_LABEL[o.c]}</span>
              <span className="num text-[11px] font-semibold text-ink">{o.count}</span>
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
  'Real physical buildings from CCS_Buildings.xlsx, council’s own asset register, one row per building rather than per fitout or meter. Categories can be turned on and off below, the same toggle the map markers use. Map positions are geocoded from the register’s address field via OpenStreetMap, approximate, not surveyed. Buildings with no usable address are listed here but not mapped.';

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
}

function formatRegisterDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function RealBuildingsRegister({
  offTypes,
  setOffTypes,
}: RealBuildingsRegisterProps) {
  // Same step pattern as AssetTypeToggles below it: exactly one of
  // "manage types" or "browse the list" showing at a time, not two
  // independent accordions that can both be open and push each other
  // down the page.
  const [view, setView] = useState<'types' | 'list' | null>(null);
  const selectView = (v: 'types' | 'list' | null) => withViewTransition(() => setView(v));
  const [openId, setOpenId] = useState<string | null>(null);
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
  const scopeLabel = ward === null ? 'Whole LGA' : ward === NO_WARD ? 'No ward recorded' : `${ward} ward`;

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
    <div className="mb-4 border-b border-line pb-4">
      <p className="mb-4 text-[12.5px] leading-[1.6] text-ink-2">
        Every real building from council's own asset register
        (<span className="num">{`CCS_Buildings.xlsx`}</span>), one row per
        building rather than per fitout or meter.
      </p>

      {/* Level 1, whose buildings: the register's own Ward field, so
          someone asking about their ward starts there, not in a list. */}
      <PanelHeading>Show</PanelHeading>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {[{ key: null as string | null, count: REAL_BUILDINGS.length }, ...REAL_WARDS].map((w) => {
          const on = ward === w.key;
          return (
            <button
              key={w.key ?? 'all'}
              onClick={() => {
                setWard(w.key);
                setListScope(null);
                setOpenId(null);
              }}
              aria-pressed={on}
              className={`flex items-center gap-1.5 rounded-[6px] border px-2 py-1 text-[12px] transition-colors ${on ? 'border-accent bg-accent-soft font-semibold text-accent' : 'border-line bg-white text-ink-2 hover:border-accent'}`}
            >
              {w.key === null ? 'Whole LGA' : w.key === NO_WARD ? 'No ward' : w.key}
              <span className="num text-[11px] text-ink-3">{w.count}</span>
            </button>
          );
        })}
      </div>

      {/* Level 1, the headline: what the register says about the scope
          above, purely read-only. */}
      <PanelHeading>{scopeLabel}</PanelHeading>
      <div className="mb-3 grid grid-cols-2 gap-2.5">
        <div className="rounded-[6px] border border-line bg-white px-3 py-2.5">
          <div className="text-[12px] font-medium uppercase tracking-[0.06em] text-ink-3">
            Buildings
          </div>
          <div className="num mt-1 text-[26px] font-semibold leading-none text-ink">
            {scoped.length}
          </div>
          <div className="mt-1 text-[12px] text-ink-3">{typeCount} types</div>
        </div>
        <div className="rounded-[6px] border border-line bg-white px-3 py-2.5">
          <div className="text-[12px] font-medium uppercase tracking-[0.06em] text-ink-3">
            Insured value
          </div>
          <div className="num mt-1 text-[26px] font-semibold leading-none text-ink">
            ${(totalInsured / 1e6).toFixed(1)}M
          </div>
          <div className="mt-1 text-[12px] text-ink-3">
            {scoped.filter((b) => b.insuredValue > 0).length} valued
          </div>
        </div>
      </div>

      <div className="mb-4 rounded-[6px] border border-line bg-white px-3 py-2.5">
        <div className="mb-1.5 text-[12px] font-medium uppercase tracking-[0.06em] text-ink-3">
          Condition, as rated in the register
        </div>
        <div className="space-y-1.5">
          {conditionRows.map((r) => (
            <div key={r.label} className="flex items-center gap-2">
              <span className="w-[116px] shrink-0 truncate text-[11.5px] text-ink-2">{r.label}</span>
              <span className="h-[6px] flex-1 overflow-hidden rounded-[3px] bg-surface-2">
                <span
                  className="block h-full rounded-[3px]"
                  style={{ width: `${(r.n / scoped.length) * 100}%`, background: r.color }}
                />
              </span>
              <span className="num w-7 shrink-0 text-right text-[11.5px] font-semibold text-ink">{r.n}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Browse and manage: the two things you can actually do here,
          grouped under their own heading so they read as actions, not
          more stats. One of two destinations at a time, not two
          independent accordions that can both be open and push each
          other down. */}
      <PanelHeading
        right={
          <Tip label="How this reads" body={BUILDINGS_REGISTER_EXPLAINER} side="left">
            <span className="cursor-help text-[12px] text-ink-3 underline decoration-dotted">
              how read
            </span>
          </Tip>
        }
      >
        Browse the register
      </PanelHeading>
      <div style={{ viewTransitionName: 'buildings-register-step' } as React.CSSProperties}>
        {view === null && (
          <div className="space-y-2">
            <button
              onClick={() => selectView('types')}
              className="flex w-full items-center justify-between rounded-[6px] border border-line bg-white px-3 py-2.5 text-left transition-colors hover:border-accent"
            >
              <span>
                <span className="block text-[13px] font-medium text-ink">
                  Manage building types
                </span>
                <span className="mt-[2px] block text-[11.5px] text-ink-3">
                  <span className="num font-semibold text-ink-2">{onCount}</span> of{' '}
                  {ALL_BUILDING_TYPES.size} types shown on the map
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[12px] text-accent">
                Manage
                <IconChevron size={13} />
              </span>
            </button>
            <button
              onClick={() => selectView('list')}
              className="flex w-full items-center justify-between rounded-[6px] border border-line bg-white px-3 py-2.5 text-left transition-colors hover:border-accent"
            >
              <span>
                <span className="block text-[13px] font-medium text-ink">
                  List {ward === null ? 'all ' : ''}{scoped.length} buildings
                </span>
                <span className="mt-[2px] block text-[11.5px] text-ink-3">
                  {ward === null ? 'Every real building' : `In ${scopeLabel}`}, by category or all at once
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[12px] text-accent">
                <span className="num">${(totalInsured / 1e6).toFixed(1)}M</span>
                <IconChevron size={13} />
              </span>
            </button>
          </div>
        )}

        {view === 'types' && (
          <div>
            <button
              onClick={() => selectView(null)}
              className="mb-1.5 flex items-center gap-[3px] text-[11.5px] text-ink-3 transition-colors hover:text-accent"
            >
              <IconChevron size={13} className="rotate-180" />
              Back
            </button>
            <AssetTypeToggles offTypes={offTypes} setOffTypes={setOffTypes} />
          </div>
        )}

        {view === 'list' && (
          <div>
            <button
              onClick={() => selectView(null)}
              className="mb-1.5 flex items-center gap-[3px] text-[11.5px] text-ink-3 transition-colors hover:text-accent"
            >
              <IconChevron size={13} className="rotate-180" />
              Back
            </button>

            <div style={{ viewTransitionName: 'buildings-list-scope' } as React.CSSProperties}>
              {listScope === null && (
                <div className="space-y-1">
                  <button
                    onClick={() => selectListScope('all')}
                    className="flex w-full items-center justify-between rounded-[5px] border border-line bg-white px-2 py-1.5 text-left transition-colors hover:border-accent"
                  >
                    <span className="text-[11.5px] font-medium text-ink">
                      All {scoped.length} buildings
                    </span>
                    <span className="num text-[10.5px] text-ink-3">
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
                          className="flex items-center gap-1 rounded-[5px] border border-line bg-white px-1.5 py-1 text-left transition-colors hover:border-accent"
                        >
                          <span className="text-[11.5px] font-medium text-ink">
                            {isUnclassified ? 'Not yet classified' : use.label}
                          </span>
                          <span className="num text-[10.5px] text-ink-3">{use.count}</span>
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
                      className="mb-1.5 flex items-center gap-[3px] text-[11px] text-ink-3 transition-colors hover:text-accent"
                    >
                      <IconChevron size={12} className="rotate-180" />
                      All categories
                    </button>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[11.5px] font-medium text-ink">
                        {label}, {buildings.length}
                      </span>
                      <span className="num text-[10.5px] text-ink-3">
                        ${(insured / 1e6).toFixed(1)}M
                      </span>
                    </div>
                    <div className="max-h-[300px] space-y-1 overflow-y-auto thin-scroll pr-0.5">
                      {buildings.map((b) => (
                        <BuildingCard
                          key={b.id}
                          b={b}
                          isOpen={openId === b.id}
                          onToggle={() => setOpenId(openId === b.id ? null : b.id)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>

      {/* Level 3, provenance: how far the map dots can be trusted. Last
          because it qualifies the figures above rather than answering
          a question of its own. */}
      <div className="mt-4">
        <PanelHeading>Register dates</PanelHeading>
        <div className="mb-4 space-y-1 rounded-[6px] border border-line bg-white px-3 py-2.5 text-[12px] leading-[1.5] text-ink-2">
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
              <span className="num cursor-help text-[12px] text-ink-3 underline decoration-dotted">
                {mappedCount} of {scoped.length} on map
              </span>
            </Tip>
          }
        >
          Map coverage
        </PanelHeading>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-[6px] border border-dashed border-line bg-surface-2 px-3 py-2 text-[11.5px] text-ink-3">
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
    </div>
  );
}

function InfoSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-[1000] flex items-start justify-center bg-ink/20 p-4" onClick={onClose}>
      <div
        className="thin-scroll max-h-full w-full max-w-[420px] overflow-y-auto rounded-[8px] border border-line bg-white p-4 shadow-[0_8px_30px_rgba(20,32,31,0.2)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[15px] font-semibold text-ink">About this tool</span>
          <button onClick={onClose} className="rounded-[4px] p-[3px] text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close">
            <IconClose />
          </button>
        </div>
        <p className="text-[12.5px] leading-[1.6] text-ink-2">
          A climate risk explorer for City of Charles Sturt. It shows council's
          own GIS layers and asset register on one map. Where a figure has not
          been supplied, the tool shows nothing for it rather than an estimate.
        </p>
        <p className="mt-2 text-[12.5px] leading-[1.6] text-ink-2">
          Sources and what is not shown are on the Help tab.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Root
 * ------------------------------------------------------------------ */

export default function App() {
  const [panelTab, setPanelTab] = useState<PanelTab>('layers');
  const [checkedLayers, setCheckedLayers] = useState<Set<string>>(
    () => new Set(['heat-vuln']),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(MAP_ZOOM);
  const [overlayOpacity, setOverlayOpacity] = useState(0.85);
  const [layerOpacity, setLayerOpacityState] = useState<Record<string, number>>({});
  const [hoveredSuburb, setHoveredSuburb] = useState<string | null>(null);
  const [boundsMode, setBoundsMode] = useState<BoundsMode>('sa2');
  const [showInfo, setShowInfo] = useState(false);
  // Turning a layer on opens its description on the right. Cleared when
  // that same layer is unchecked.
  const [layerInfoId, setLayerInfoId] = useState<string | null>(null);
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

  const rightPanelMode: 'building' | 'layer' | null = selectedBuildingKey
    ? 'building'
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
    }
  }, [checkedLayers]);

  const setLayerOpacity = useCallback((id: string, v: number) => {
    setLayerOpacityState((prev) => ({ ...prev, [id]: v }));
  }, []);

  const clearAllLayers = useCallback(() => {
    setCheckedLayers(new Set());
    setLayerInfoId(null);
  }, []);

  // Clicking a suburb opens its Place profile, the same as picking it there.
  const handleSelectSuburb = useCallback((id: string) => {
    setSelectedId(id);
    setPanelTab('place');
  }, []);

  const meta = TAB_META[panelTab];

  return (
    <div className="flex h-full w-full overflow-hidden bg-surface-2 text-ink">
      <IconRail tab={panelTab} setTab={setPanelTab} />

      <section className="relative flex w-80 shrink-0 flex-col border-r border-line bg-white">
        <header className="flex items-start justify-between gap-2 border-b border-line px-2.5 py-2">
          <div className="min-w-0">
            <div className="text-[17px] font-semibold leading-tight text-ink">{meta.title}</div>
            <div className="mt-[2px] text-[11.5px] leading-tight text-ink-3">{meta.subtitle}</div>
          </div>
          <button
            onClick={() => setShowInfo(true)}
            className="mt-[2px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-line text-[11.5px] font-semibold text-ink-3 transition-colors hover:border-accent hover:text-accent"
            aria-label="About this tool"
          >
            i
          </button>
        </header>

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
            />
          )}
          {panelTab === 'assets' && (
            <div className="px-2.5 py-2.5">
              <RealBuildingsRegister offTypes={buildingOffTypes} setOffTypes={setBuildingOffTypes} />
            </div>
          )}
          {panelTab === 'place' && <PlaceTab selectedId={selectedId} setSelectedId={setSelectedId} />}
          {panelTab === 'help' && <HelpTab />}
        </div>

        <footer className="flex items-center justify-between border-t border-line px-2.5 py-1.5">
          <span className="text-[11px] uppercase tracking-[0.08em] text-ink-3">City of Charles Sturt</span>
          <span className="num text-[11px] text-ink-3">
            {SA2_BOUNDARIES.length} SA2 · {SA1S.length} SA1 · z{zoom}
          </span>
        </footer>

        {showInfo && <InfoSheet onClose={() => setShowInfo(false)} />}
      </section>

      <main className="flex min-w-0 flex-1 flex-col">
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
            rightPanelAccent={ACCENT}
            onZoomChange={setZoom}
            showBuildings={buildingOffTypes.size < ALL_BUILDING_TYPES.size}
            buildingOffTypes={buildingOffTypes}
            selectedBuildingKey={selectedBuildingKey}
            onSelectBuildingPoint={handleSelectBuildingPoint}
          />
        </div>

        <SourceYears snapshot={snapshot} />
      </main>

      {rightPanelMode === 'building' && (
        <BuildingPointPanel ids={selectedBuildingIds} onClose={() => setSelectedBuildingKey(null)} />
      )}
      {rightPanelMode === 'layer' && layerInfoId && (
        <LayerInfoPanel layer={LAYER_BY_ID[layerInfoId]} onClose={() => setLayerInfoId(null)} />
      )}
    </div>
  );
}
