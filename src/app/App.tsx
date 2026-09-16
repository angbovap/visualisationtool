/*
 * CoCS Climate Risk Explorer
 * Decision-support surface for City of Charles Sturt council staff.
 *
 * The tool answers four questions in the order staff tend to ask them:
 *   1. Where is the hazard?            (Layers)
 *   2. Who and what sits inside it?    (Place)
 *   3. How do two measures compare?    (Analysis)
 *   4. What has been costed already?   (Insights)
 *
 * Deliberately it draws no conclusions. Every panel exposes the inputs,
 * thresholds and provenance behind a number so staff reach their own
 * judgement rather than inheriting one from the software.
 *
 * All figures here are indicative demonstration values shaped to the real
 * geography. They are not council records and are labelled as such in-app.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Map as LeafletMap, Layer as LeafletLayer } from 'leaflet';

// Real asset register export. See "Real buildings register" below for the
// column mapping and why the raw file needed collapsing before use.
import ccsBuildingsRaw from '@/data/ccsBuildings.json';

// Real ABS ASGS 2021 digital boundaries for the Charles Sturt SA3 (which
// this council area maps to exactly, one LGA to one SA3). Fetched from
// geo.abs.gov.au, not hand-drawn. See "Real SA1 / SA2 boundaries" below.
import sa2BoundaryData from '@/data/sa2Boundaries.json';
import sa1BoundaryData from '@/data/sa1Boundaries.json';

// Approximate positions for real buildings, geocoded from the register's
// own address field via OpenStreetMap Nominatim (free, no key, one-time
// batch at their 1 request/second limit). Not part of the source export.
// See BUILDING_LOCATION below for why most of these are street-level.
import ccsBuildingsGeocoded from '@/data/ccsBuildingsGeocoded.json';
import vapLogo from '@/assets/vaplogo.png';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

type HazardId = 'heat' | 'flooding' | 'coastal' | 'drought';

type PanelTab = 'layers' | 'place' | 'analysis' | 'help';

type LayerGroup =
  | 'hazard'
  | 'vulnerability'
  | 'transport'
  | 'infrastructure'
  | 'planning';

type LayerKind = 'choropleth' | 'canvas' | 'vector';

type BlueprintId =
  | 'flood-risk'
  | 'heat-vuln'
  | 'population'
  | 'infrastructure'
  | 'land-use'
  | 'transport';

type Scenario = 'ssp245' | 'ssp585';

type BoundsMode = 'none' | 'sa2' | 'sa1';

type PlanMetric = 'count' | 'growth' | 'density' | 'gap';

type AssetCategory =
  | 'road'
  | 'stormwater'
  | 'open-space'
  | 'building'
  | 'service'
  | 'coastal';

type Significance = 'local' | 'district' | 'state';

/** Latitude / longitude pair in the order Leaflet expects. */
type LatLngTuple = [number, number];

interface ScenarioPair {
  ssp245: number;
  ssp585: number;
}

interface Asset {
  name: string;
  hazards: HazardId[];
  /** Replacement or indicative capital value, pre-formatted for display. */
  value?: string;
  /** Precise point location, not the containing SA2 centroid. */
  position: { lat: number; lng: number };
  category: AssetCategory;
  /** Who actually turns up and uses it. */
  users: string;
  /** What the asset is for, which is what makes a service loss consequential. */
  purpose: string;
  /** Reactive maintenance events in the last five years, the consequence trigger. */
  repairs5yr: number;
  significance: Significance;
}

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
  pop2021: number;
  pop2041: ScenarioPair;
  densityPerKm2: number;
  seifa: number;
  heatScore: number;
  floodScore: number;
  coastalScore: number;
  droughtScore: number;
  treeCanopy: number;
  greenSpace: number;
  employmentScore: number;
  assets: Asset[];
}

type RegionFamily =
  | 'amber'
  | 'blue'
  | 'cyan'
  | 'teal'
  | 'emerald'
  | 'rose'
  | 'violet'
  | 'indigo';

// SA1Area is declared further down, next to the real boundary data it is
// built from (see "SA1 sub-areas").

interface PlanningRow {
  dwellings2021: number;
  dwellings2031: ScenarioPair;
  dwellings2041: ScenarioPair;
  totalHa: number;
  residentialHa: number;
  zonedGrossDensity: number;
  zoningLabel: string;
}

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
}

interface Blueprint {
  id: BlueprintId;
  title: string;
  accent: string;
  description: string;
  layers: string[];
  /** Suburb ranking metric driving the panel's bar chart. */
  rank: string;
  watch: string[];
  steps?: number[];
}

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const ACCENT = '#006E78';

const HAZARD_COLOR: Record<HazardId, string> = {
  heat: '#DC2626',
  flooding: '#2563EB',
  coastal: '#0EA5E9',
  drought: '#D97706',
};

const HAZARD_LABEL: Record<HazardId, string> = {
  heat: 'Heat',
  flooding: 'Flood / stormwater',
  coastal: 'Coastal',
  drought: 'Drought',
};

const BLUEPRINT_ACCENT: Record<BlueprintId, string> = {
  'flood-risk': '#2563EB',
  'heat-vuln': '#D97706',
  population: '#006E78',
  infrastructure: '#7C3AED',
  'land-use': '#059669',
  transport: '#0891B2',
};

/** Fill families for SA1 sub-areas, one per parent SA2. */
const FAMILY_COLOR: Record<RegionFamily, string> = {
  amber: '#F59E0B',
  blue: '#3B82F6',
  cyan: '#06B6D4',
  teal: '#14B8A6',
  emerald: '#10B981',
  rose: '#F43F5E',
  violet: '#8B5CF6',
  indigo: '#6366F1',
};

const CATEGORY_LABEL: Record<AssetCategory, string> = {
  road: 'Road',
  stormwater: 'Stormwater',
  'open-space': 'Open space',
  building: 'Building',
  service: 'Community service',
  coastal: 'Coastal structure',
};

const SIGNIFICANCE_LABEL: Record<Significance, string> = {
  local: 'Local',
  district: 'District',
  state: 'State',
};

const SCENARIO_LABEL: Record<Scenario, string> = {
  ssp245: 'SSP2-4.5',
  ssp585: 'SSP5-8.5',
};

const SCENARIO_NOTE: Record<Scenario, string> = {
  ssp245: 'Middle of the road emissions. Warming near 2.7C by 2100.',
  ssp585: 'High emissions. Warming near 4.4C by 2100.',
};

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
    id: 'flood-100',
    name: 'Flood 1:100yr',
    group: 'hazard',
    kind: 'choropleth',
    lo: '#DBEAFE',
    hi: '#1D4ED8',
    unit: 'share of area inundated',
    note: 'Modelled extent of a 1 percent annual exceedance probability event. Depth is not shown, only extent.',
    source: 'Stormwater flood mapping, catchment model outputs',
  },
  {
    id: 'flood-20',
    name: 'Flood 1:20yr',
    group: 'hazard',
    kind: 'choropleth',
    lo: '#DBEAFE',
    hi: '#2563EB',
    unit: 'share of area inundated',
    note: 'A 5 percent annual exceedance event. Closer to the frequency that drives repeat service calls.',
    source: 'Stormwater flood mapping, catchment model outputs',
  },
  {
    id: 'flood-5',
    name: 'Flood 1:5yr',
    group: 'hazard',
    kind: 'choropleth',
    lo: '#E0F2FE',
    hi: '#3B82F6',
    unit: 'share of area inundated',
    note: 'Nuisance flooding. Useful for spotting streets that flood often rather than severely.',
    source: 'Stormwater flood mapping, catchment model outputs',
  },
  {
    id: 'sea-2050',
    name: 'Sea Rise 2050',
    group: 'hazard',
    kind: 'choropleth',
    lo: '#CFFAFE',
    hi: '#0369A1',
    unit: 'share of area below threshold',
    note: 'Land below the 2050 still-water level for the selected scenario. Storm surge sits on top of this.',
    source: 'State coastal inundation mapping',
  },
  {
    id: 'heat-vuln',
    name: 'Heat Vulnerability',
    group: 'hazard',
    kind: 'canvas',
    lo: '#FEF3C7',
    hi: '#B91C1C',
    unit: 'index 0 to 100',
    note: 'Surface temperature combined with canopy deficit and residents over 75. Exposure and sensitivity together, not temperature alone.',
    source: 'Thermal imagery, canopy audit, census age structure',
    steps: [2021, 2031, 2036, 2041],
  },
  {
    id: 'watercourses',
    name: 'Watercourses',
    group: 'hazard',
    kind: 'vector',
    hi: '#0EA5E9',
    unit: 'line features',
    note: 'Creeks, drains and the Port River edge. The receiving system for everything upstream.',
    source: 'Hydrology line network',
  },
  {
    id: 'coastal-erosion',
    name: 'Coastal Erosion',
    group: 'hazard',
    kind: 'choropleth',
    lo: '#FFE4E6',
    hi: '#9F1239',
    unit: 'metres of recession by 2050',
    note: 'Shoreline recession allowance. Only meaningful for the coastal SA2s.',
    source: 'Coastal process assessment',
  },
  {
    id: 'pop-2021',
    name: 'Population 2021',
    group: 'vulnerability',
    kind: 'choropleth',
    lo: '#EDE9FE',
    hi: '#4C1D95',
    unit: 'usual residents',
    note: 'Census usual resident count. The denominator behind every per-person figure in this tool.',
    source: 'Census 2021, usual residence',
  },
  {
    id: 'pop-2041',
    name: 'Population 2041',
    group: 'vulnerability',
    kind: 'choropleth',
    lo: '#EDE9FE',
    hi: '#5B21B6',
    unit: 'projected residents',
    note: 'Projected residents under the selected scenario. Interpolated linearly between census years.',
    source: 'State population projections, scenario adjusted',
    steps: [2021, 2031, 2041],
  },
  {
    id: 'pop-change',
    name: 'Pop. Change',
    group: 'vulnerability',
    kind: 'choropleth',
    lo: '#FEF9C3',
    hi: '#166534',
    unit: 'percent change from 2021',
    note: 'Growth relative to the 2021 base. Read this beside the hazard layers to see where growth is being directed into exposure.',
    source: 'Derived from projections',
    steps: [2021, 2031, 2041],
  },
  {
    id: 'seifa',
    name: 'SEIFA Disadvantage',
    group: 'vulnerability',
    kind: 'choropleth',
    lo: '#FFE4E6',
    hi: '#881337',
    unit: 'decile, 1 most disadvantaged',
    note: 'Index of relative socio-economic disadvantage. Darker means more disadvantaged, because that is the direction that matters for response capacity.',
    source: 'SEIFA IRSD, SA1 aggregated',
  },
  {
    id: 'employment',
    name: 'Employment Access',
    group: 'vulnerability',
    kind: 'choropleth',
    lo: '#E3F1F2',
    hi: '#00434A',
    unit: 'jobs reachable in 30 min',
    note: 'Jobs reachable within 30 minutes by public transport in the morning peak. Separates commuter road demand from recreational demand.',
    source: 'Journey to work, network accessibility model',
    steps: [2021, 2031, 2041],
  },
  {
    id: 'tree-canopy',
    name: 'Tree Canopy',
    group: 'vulnerability',
    kind: 'canvas',
    lo: '#F0FDF4',
    hi: '#14532D',
    unit: 'percent cover',
    note: 'Canopy cover across all land tenures. Private land dominates the total, which limits what council can move on its own.',
    source: 'Canopy cover audit, aerial classification',
  },
  {
    id: 'sw-pipes',
    name: 'SW Pipes',
    group: 'infrastructure',
    kind: 'vector',
    hi: '#2563EB',
    unit: 'pipe network',
    note: 'Stormwater mains. Capacity here decides whether surface flooding is brief or sustained.',
    source: 'Stormwater asset register',
  },
  {
    id: 'roads',
    name: 'Roads',
    group: 'transport',
    kind: 'vector',
    hi: '#475569',
    unit: 'road network',
    note: 'Council road network. Hover a road asset in Place to see whether it carries commuters, freight or local trips.',
    source: 'Road asset register',
  },
  {
    id: 'pt-stops',
    name: 'PT Stops',
    group: 'transport',
    kind: 'vector',
    hi: '#0891B2',
    unit: 'stops',
    note: 'Bus and tram stops. Stops without shade are a heat exposure point for people with no alternative.',
    source: 'Public transport stop register',
  },
  {
    id: 'railways',
    name: 'Railways',
    group: 'transport',
    kind: 'vector',
    hi: '#334155',
    unit: 'rail corridor',
    note: 'Passenger rail corridors and level crossings.',
    source: 'Rail network',
  },
  {
    id: 'pt-freq',
    name: 'PT Freq.',
    group: 'transport',
    kind: 'vector',
    hi: '#0EA5E9',
    unit: 'services per hour',
    note: 'Service frequency in the interpeak. Low frequency plus low car ownership is a mobility dependency.',
    source: 'Timetable extract',
  },
  {
    id: 'cycling',
    name: 'Cycling',
    group: 'transport',
    kind: 'vector',
    hi: '#059669',
    unit: 'cycle network',
    note: 'On-road and separated cycling routes, including the coastal path.',
    source: 'Cycling network',
  },
  {
    id: 'industrial',
    name: 'Industrial',
    group: 'planning',
    kind: 'vector',
    hi: '#B45309',
    unit: 'industrial land',
    note: 'Employment land. Hard surfaced, low canopy, and a runoff source for everything downstream.',
    source: 'Land use classification',
  },
  {
    id: 'zoning',
    name: 'Zoning',
    group: 'planning',
    kind: 'vector',
    hi: '#9333EA',
    unit: 'planning zones',
    note: 'Planning and Design Code zones. Sets the dwelling ceiling that growth has to fit inside.',
    source: 'Planning and Design Code',
  },
  {
    id: 'heritage',
    name: 'Heritage Points',
    group: 'planning',
    kind: 'vector',
    hi: '#A16207',
    unit: 'heritage items',
    note: 'Local and state heritage items. Constrains the retrofit options available on a site.',
    source: 'Heritage register',
  },
  {
    id: 'res-pipeline',
    name: 'Res. Pipeline',
    group: 'planning',
    kind: 'vector',
    hi: '#DB2777',
    unit: 'approved dwellings',
    note: 'Approved and under-construction dwellings. The growth already committed, before any new policy.',
    source: 'Development application register',
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

/* ------------------------------------------------------------------ *
 * Blueprints
 *
 * A blueprint is a curated layer set plus the reading notes that go with
 * it. The notes point at tensions in the data. They stop short of telling
 * anyone what to do about them.
 * ------------------------------------------------------------------ */

const BLUEPRINTS: Blueprint[] = [
  {
    id: 'flood-risk',
    title: 'Flood Risk',
    accent: BLUEPRINT_ACCENT['flood-risk'],
    description:
      'Modelled inundation at three return periods against the drainage network and the buildings inside it. Frequent nuisance flooding and rare severe flooding are different problems, so both are on.',
    layers: ['flood-100', 'flood-20', 'watercourses', 'sw-pipes'],
    rank: 'floodScore',
    steps: [2021, 2041],
    watch: [
      'West Lakes and Flinders Park carry the highest modelled extent, but their disadvantage profiles differ sharply.',
      'The 1:5yr layer is the one that generates repeat service requests. Rank by nuisance as well as by severity.',
      'Pipe capacity was sized for a catchment with far less hard surface than it has now.',
      'Dwellings in the residential pipeline are being approved inside the 1:100yr extent in two SA2s.',
    ],
  },
  {
    id: 'heat-vuln',
    title: 'Heat Vulnerability',
    accent: BLUEPRINT_ACCENT['heat-vuln'],
    description:
      'Surface heat against canopy deficit, age structure and disadvantage. This is a sensitivity picture, not a temperature map. Two places can be equally hot and not equally at risk.',
    layers: ['heat-vuln', 'tree-canopy', 'seifa', 'pt-stops'],
    rank: 'heatScore',
    steps: [2021, 2031, 2036, 2041],
    watch: [
      'Woodville - Cheltenham pairs the highest heat score with the third lowest SEIFA decile. Exposure and low response capacity coincide.',
      'Canopy sits mostly on private land, so council levers reach a minority of the deficit.',
      'Unshaded stops matter most where car ownership is lowest.',
      'Hindmarsh - Brompton has the lowest canopy in the LGA and the fastest dwelling growth.',
    ],
  },
  {
    id: 'population',
    title: 'Population & Growth',
    accent: BLUEPRINT_ACCENT.population,
    description:
      'Where people are now, where projections put them by 2041, and how much of that growth current zoning can absorb. Use the horizon buttons to step the projection.',
    layers: ['pop-2041', 'pop-change', 'res-pipeline', 'zoning'],
    rank: 'growth',
    steps: [2021, 2031, 2041],
    watch: [
      'Royal Park - Hendon - Albert Park carries the largest proportional growth on one of the lowest SEIFA deciles in the LGA.',
      'Capacity gap is zoned ceiling minus projected dwellings. A negative gap means zoning has to change or the projection will not land.',
      'Density and hazard exposure are being added in the same places, not different ones.',
      'Scenario choice moves the 2041 figure by up to 6 percent. It does not change the ranking.',
    ],
  },
  {
    id: 'infrastructure',
    title: 'Infrastructure',
    accent: BLUEPRINT_ACCENT.infrastructure,
    description:
      'The council asset portfolio against hazard extent. Answers the portfolio question, which assets carry the most exposure, before the single-site question.',
    layers: ['sw-pipes', 'roads', 'flood-20'],
    rank: 'assets',
    watch: [
      'Reactive repair counts are shown per asset. Ten or more interventions in five years is where renewal usually beats maintenance.',
      'The highest-value exposed assets are not in the highest-hazard suburbs. Value and hazard rank differently.',
      'State significant assets carry consequences beyond the LGA boundary and beyond council budgets.',
      'Road purpose changes the consequence of losing it. A commuter spine and a recreational path fail differently.',
    ],
  },
  {
    id: 'land-use',
    title: 'Land Use & Planning',
    accent: BLUEPRINT_ACCENT['land-use'],
    description:
      'Zoning, industrial land and heritage against the hazard layers. Shows where the planning framework and the risk picture disagree.',
    layers: ['zoning', 'industrial', 'heritage', 'flood-100'],
    rank: 'zonedGrossDensity',
    watch: [
      'Hindmarsh - Brompton is zoned to 55 dwellings per hectare, the highest ceiling in the LGA, on the lowest canopy.',
      'Industrial land is the largest single contributor of runoff into the drainage network.',
      'Heritage listing narrows retrofit options on exactly the older stock that performs worst in heat.',
      'Zoned capacity is a ceiling, not a forecast. Take-up has run well below it.',
    ],
  },
  {
    id: 'transport',
    title: 'Transport Access',
    accent: BLUEPRINT_ACCENT.transport,
    description:
      'Network, service frequency and reachable jobs. Purpose matters here. A road carrying the morning commute fails differently from one carrying weekend recreation.',
    layers: ['pt-stops', 'pt-freq', 'railways', 'cycling', 'employment'],
    rank: 'employmentScore',
    steps: [2021, 2031, 2041],
    watch: [
      'Hindmarsh - Brompton reaches the most jobs in 30 minutes, well ahead of the rest of the LGA.',
      'Low frequency plus low car ownership is a dependency, and it shows up in evacuation planning.',
      'The coastal path is recreational, and it is also the only continuous north to south cycling link.',
      'Level crossings on the rail corridor are pinch points during flood response.',
    ],
  },
];

const BLUEPRINT_BY_ID: Record<string, Blueprint> = Object.fromEntries(
  BLUEPRINTS.map((b) => [b.id, b]),
);

/* ------------------------------------------------------------------ *
 * Real SA1 / SA2 boundaries
 *
 * The City of Charles Sturt maps exactly onto one ABS SA3, "Charles
 * Sturt" (code 40401), which in turn contains exactly eight SA2s and 257
 * SA1s under ASGS 2021. Fetched directly from the ABS's own ArcGIS
 * service (geo.abs.gov.au, ASGS2021/SA2 and ASGS2021/SA1 layers) rather
 * than traced or estimated, so the shapes here are the same ones the ABS
 * publishes, not an approximation of them.
 *
 * That lookup also corrected two things this tool had wrong. "West
 * Beach" was carried as a Charles Sturt SA2 with five attached assets;
 * the real West Beach SA2 (404031109) sits in West Torrens, a different
 * council, and has been removed along with everything that depended on
 * it. "Beverley" (404011090) is a real Charles Sturt SA2 that had no
 * entry at all. Its boundary is drawn like every other SA2, but it
 * carries no population, hazard or asset data, because none has been
 * sourced for it, and it is excluded from every chart, ranking and
 * profile that the other seven appear in until that changes.
 * ------------------------------------------------------------------ */

interface RealBoundary {
  code: string;
  name?: string;
  sa2Code?: string;
  areaSqKm: number;
  ring: LatLngTuple[];
}

const SA2_BOUNDARIES = sa2BoundaryData as RealBoundary[];
const SA1_BOUNDARIES = sa1BoundaryData as RealBoundary[];

const SA2_BOUNDARY_BY_CODE: Record<string, RealBoundary> = Object.fromEntries(
  SA2_BOUNDARIES.map((b) => [b.code, b]),
);

const BEVERLEY_SA2_CODE = '404011090';
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
 * Suburb data
 *
 * The seven SA2s below carry indicative demonstration attributes, shaped
 * to the real geography now used for their boundary, but not sourced
 * from council or ABS records. Scores run 1 to 5 and are relative within
 * the LGA, not absolute. SEIFA is a national decile where 1 is most
 * disadvantaged.
 *
 * Assets carry more than a location. `purpose` and `users` are recorded
 * because the consequence of losing an asset depends on what it does and
 * who depends on it, and `repairs5yr` is the reactive intervention count
 * that turns a maintenance conversation into a renewal one.
 * ------------------------------------------------------------------ */

type SuburbSeed = Omit<Suburb, 'path' | 'centroid' | 'span'>;

const SUBURB_SEED: SuburbSeed[] = [
  {
    id: 'woodville-cheltenham',
    name: 'Woodville - Cheltenham',
    sa2: '404011097',
    pop2021: 18420,
    pop2041: { ssp245: 23140, ssp585: 24460 },
    densityPerKm2: 2180,
    seifa: 3,
    heatScore: 5,
    floodScore: 3,
    coastalScore: 1,
    droughtScore: 3,
    treeCanopy: 12,
    greenSpace: 8,
    employmentScore: 4,
    assets: [
      {
        name: 'Woodville Road corridor',
        hazards: ['heat', 'flooding'],
        value: '$14.2M',
        position: { lat: -34.851, lng: 138.558 },
        category: 'road',
        users: 'Commuters, freight bound for the Port, one bus route',
        purpose:
          'Arterial commuter and freight spine. Not a local access street, so a closure redistributes traffic across the whole northern grid.',
        repairs5yr: 11,
        significance: 'district',
      },
      {
        name: 'Cheltenham Park Reserve',
        hazards: ['heat', 'drought'],
        value: '$3.8M',
        position: { lat: -34.844, lng: 138.566 },
        category: 'open-space',
        users: 'Sports clubs, dog walkers, informal weekend use',
        purpose:
          'District open space and the only large shaded refuge in the northern SA2s.',
        repairs5yr: 4,
        significance: 'district',
      },
      {
        name: 'Woodville Community Centre',
        hazards: ['heat'],
        value: '$6.5M',
        position: { lat: -34.85, lng: 138.564 },
        category: 'service',
        users: 'Older residents, English language classes, emergency relief clients',
        purpose:
          'Nominated heatwave refuge with backup cooling. Loss of power here removes the refuge, not just the building.',
        repairs5yr: 3,
        significance: 'local',
      },
      {
        name: 'Cheltenham trunk drain',
        hazards: ['flooding'],
        value: '$9.1M',
        position: { lat: -34.845, lng: 138.556 },
        category: 'stormwater',
        users: 'The whole upstream northern catchment',
        purpose:
          'Trunk outfall carrying the northern catchment to the Port River. Single point of failure for everything above it.',
        repairs5yr: 13,
        significance: 'district',
      },
      {
        name: 'Woodville operations depot',
        hazards: ['heat', 'flooding'],
        value: '$4.4M',
        position: { lat: -34.847, lng: 138.57 },
        category: 'building',
        users: 'Field crews and contractors',
        purpose:
          'Plant and materials depot, and the staging point for storm response. If it floods, response capacity floods with it.',
        repairs5yr: 8,
        significance: 'local',
      },
    ],
  },
  {
    id: 'west-lakes',
    name: 'West Lakes',
    sa2: '404011096',
    pop2021: 12960,
    pop2041: { ssp245: 15080, ssp585: 15640 },
    densityPerKm2: 1620,
    seifa: 7,
    heatScore: 3,
    floodScore: 4,
    coastalScore: 4,
    droughtScore: 2,
    treeCanopy: 19,
    greenSpace: 22,
    employmentScore: 3,
    assets: [
      {
        name: 'West Lakes Boulevard',
        hazards: ['flooding', 'coastal'],
        value: '$10.6M',
        position: { lat: -34.855, lng: 138.499 },
        category: 'road',
        users: 'Commuters, shopping centre traffic, weekend lake circuit walkers',
        purpose:
          'Distributor road and the only continuous circuit around the lake. Mixed commuter and recreational purpose.',
        repairs5yr: 6,
        significance: 'district',
      },
      {
        name: 'Lake edge revetment',
        hazards: ['coastal', 'flooding'],
        value: '$22.4M',
        position: { lat: -34.849, lng: 138.496 },
        category: 'coastal',
        users: 'Adjacent residents, rowing and sailing clubs',
        purpose:
          'Retains the engineered lake and protects roughly 900 lakeside properties. Failure is not gradual.',
        repairs5yr: 9,
        significance: 'district',
      },
      {
        name: 'West Lakes Library',
        hazards: ['heat'],
        value: '$5.2M',
        position: { lat: -34.853, lng: 138.505 },
        category: 'service',
        users: 'Students, older residents, job seekers',
        purpose:
          'Branch library and air-conditioned public space with no entry cost, which is what makes it a heat refuge.',
        repairs5yr: 2,
        significance: 'local',
      },
      {
        name: 'Lake outlet control gate',
        hazards: ['flooding', 'coastal'],
        value: '$7.8M',
        position: { lat: -34.846, lng: 138.493 },
        category: 'stormwater',
        users: 'The entire lake catchment',
        purpose:
          'Controls lake level and tidal exchange. First control to be overtopped when surge and rainfall coincide.',
        repairs5yr: 12,
        significance: 'district',
      },
      {
        name: 'Bower Road reserve',
        hazards: ['heat', 'drought'],
        value: '$1.9M',
        position: { lat: -34.857, lng: 138.506 },
        category: 'open-space',
        users: 'Local families, playgroups',
        purpose:
          'Neighbourhood park providing walkable shade for the surrounding blocks.',
        repairs5yr: 3,
        significance: 'local',
      },
    ],
  },
  {
    id: 'seaton-grange',
    name: 'Seaton - Grange',
    sa2: '404011095',
    pop2021: 14310,
    pop2041: { ssp245: 17260, ssp585: 17980 },
    densityPerKm2: 1870,
    seifa: 4,
    heatScore: 4,
    floodScore: 3,
    coastalScore: 2,
    droughtScore: 3,
    treeCanopy: 15,
    greenSpace: 12,
    employmentScore: 3,
    assets: [
      {
        name: 'Seaton High School',
        hazards: ['heat'],
        value: '$18.9M',
        position: { lat: -34.889, lng: 138.516 },
        category: 'service',
        users: 'Students and staff, community sport after hours',
        purpose:
          'Secondary school and a designated assembly point during emergencies. Not council owned, but council response plans depend on it.',
        repairs5yr: 5,
        significance: 'district',
      },
      {
        name: 'Grange Road',
        hazards: ['heat', 'flooding'],
        value: '$12.3M',
        position: { lat: -34.894, lng: 138.51 },
        category: 'road',
        users: 'Commuters heading east to the city, bus corridor passengers',
        purpose:
          'Primary east to west commuter link carrying the bus corridor. Recreational traffic is a minority here.',
        repairs5yr: 10,
        significance: 'district',
      },
      {
        name: 'Seaton Park drain',
        hazards: ['flooding'],
        value: '$6.2M',
        position: { lat: -34.888, lng: 138.508 },
        category: 'stormwater',
        users: 'Upstream residential catchment',
        purpose:
          'Piped former watercourse. Surcharges into streets above the 1:20yr event, which is why the call volume is high.',
        repairs5yr: 14,
        significance: 'local',
      },
      {
        name: 'Grange Golf Course edge',
        hazards: ['drought', 'heat'],
        position: { lat: -34.893, lng: 138.505 },
        category: 'open-space',
        users: 'Members, and walkers on the adjacent public track',
        purpose:
          'Privately held open space that functions as the local canopy reserve. Council has no direct control over it.',
        repairs5yr: 1,
        significance: 'local',
      },
      {
        name: 'Seaton Recreation Centre',
        hazards: ['heat'],
        value: '$7.4M',
        position: { lat: -34.89, lng: 138.519 },
        category: 'building',
        users: 'Sporting clubs, school carnivals, holiday programs',
        purpose:
          'Indoor courts that open as a cooling centre on extreme heat days.',
        repairs5yr: 6,
        significance: 'local',
      },
    ],
  },
  {
    id: 'henley-beach',
    name: 'Henley Beach',
    sa2: '404011092',
    pop2021: 11240,
    pop2041: { ssp245: 13010, ssp585: 13420 },
    densityPerKm2: 1740,
    seifa: 8,
    heatScore: 3,
    floodScore: 3,
    coastalScore: 4,
    droughtScore: 2,
    treeCanopy: 17,
    greenSpace: 16,
    employmentScore: 3,
    assets: [
      {
        name: 'Henley Beach Esplanade',
        hazards: ['coastal', 'flooding'],
        value: '$16.8M',
        position: { lat: -34.926, lng: 138.502 },
        category: 'road',
        users: 'Visitors from across the LGA and beyond, cafes, summer event traffic',
        purpose:
          'Foreshore road and the frontage for the entire retail strip. Its purpose is destination access, not through movement.',
        repairs5yr: 7,
        significance: 'state',
      },
      {
        name: 'Henley Beach seawall',
        hazards: ['coastal'],
        value: '$28.5M',
        position: { lat: -34.927, lng: 138.5 },
        category: 'coastal',
        users: 'Beach users, adjacent property owners, the retail strip',
        purpose:
          'Primary erosion defence for the retail strip and the dune system behind it.',
        repairs5yr: 11,
        significance: 'state',
      },
      {
        name: 'Henley Square',
        hazards: ['heat', 'coastal'],
        value: '$9.3M',
        position: { lat: -34.925, lng: 138.501 },
        category: 'open-space',
        users: 'Regional visitors, events, adjacent businesses',
        purpose:
          'Regional destination public space and the most recognised civic place in the LGA.',
        repairs5yr: 4,
        significance: 'state',
      },
      {
        name: 'Henley jetty',
        hazards: ['coastal'],
        value: '$6.1M',
        position: { lat: -34.925, lng: 138.498 },
        category: 'coastal',
        users: 'Anglers, walkers, visitors',
        purpose:
          'Recreational jetty with heritage value. Purely recreational purpose, high symbolic consequence.',
        repairs5yr: 5,
        significance: 'state',
      },
      {
        name: 'Henley Beach Primary',
        hazards: ['heat'],
        value: '$11.2M',
        position: { lat: -34.929, lng: 138.51 },
        category: 'service',
        users: 'Students and families, out of hours care',
        purpose:
          'Primary school with limited shade over the yard and no alternative site nearby.',
        repairs5yr: 2,
        significance: 'local',
      },
    ],
  },
  {
    id: 'royal-park-hendon',
    name: 'Royal Park - Hendon - Albert Park',
    sa2: '404011094',
    pop2021: 9870,
    pop2041: { ssp245: 15340, ssp585: 16120 },
    densityPerKm2: 1490,
    seifa: 3,
    heatScore: 4,
    floodScore: 3,
    coastalScore: 2,
    droughtScore: 3,
    treeCanopy: 11,
    greenSpace: 9,
    employmentScore: 3,
    assets: [
      {
        name: 'Royal Park Community Centre',
        hazards: ['heat'],
        value: '$4.8M',
        position: { lat: -34.884, lng: 138.554 },
        category: 'service',
        users: 'New arrivals, older residents, emergency relief clients',
        purpose:
          'Settlement services and a heatwave refuge inside the lowest SEIFA pocket in the LGA.',
        repairs5yr: 5,
        significance: 'local',
      },
      {
        name: 'Hendon industrial drain',
        hazards: ['flooding'],
        value: '$7.3M',
        position: { lat: -34.889, lng: 138.548 },
        category: 'stormwater',
        users: 'The industrial catchment and everything downstream of it',
        purpose:
          'Carries industrial runoff. A water quality asset and a flood asset at the same time, with different thresholds for each.',
        repairs5yr: 15,
        significance: 'district',
      },
      {
        name: 'Old Port Road',
        hazards: ['heat', 'flooding'],
        value: '$13.7M',
        position: { lat: -34.89, lng: 138.556 },
        category: 'road',
        users: 'Commuters, freight to the Port, tram-adjacent traffic',
        purpose:
          'Major commuter and freight corridor. Local access is incidental to its function.',
        repairs5yr: 12,
        significance: 'state',
      },
      {
        name: 'Royal Park Reserve',
        hazards: ['heat', 'drought'],
        value: '$2.6M',
        position: { lat: -34.883, lng: 138.549 },
        category: 'open-space',
        users: 'Local families, junior sport',
        purpose:
          'Neighbourhood reserve, and the only shade within walking distance for roughly 2,000 residents.',
        repairs5yr: 4,
        significance: 'local',
      },
      {
        name: 'Hendon renewal precinct',
        hazards: ['heat', 'flooding'],
        value: '$41.0M',
        position: { lat: -34.887, lng: 138.558 },
        category: 'building',
        users: 'Social housing tenants, incoming private buyers',
        purpose:
          'Renewal precinct adding dwellings on the lowest SEIFA decile. Growth and disadvantage are being layered on the same ground.',
        repairs5yr: 2,
        significance: 'district',
      },
    ],
  },
  {
    id: 'hindmarsh-brompton',
    name: 'Hindmarsh - Brompton',
    sa2: '404011093',
    pop2021: 10480,
    pop2041: { ssp245: 15180, ssp585: 15980 },
    densityPerKm2: 2640,
    seifa: 5,
    heatScore: 5,
    floodScore: 4,
    coastalScore: 1,
    droughtScore: 3,
    treeCanopy: 9,
    greenSpace: 7,
    employmentScore: 5,
    assets: [
      {
        name: 'Port Road corridor',
        hazards: ['heat', 'flooding'],
        value: '$21.5M',
        position: { lat: -34.918, lng: 138.577 },
        category: 'road',
        users: 'Commuters, tram passengers, freight',
        purpose:
          'Principal arterial and tram corridor into the city. The busiest commuter purpose in the LGA.',
        repairs5yr: 8,
        significance: 'state',
      },
      {
        name: 'Hindmarsh stadium precinct',
        hazards: ['heat'],
        value: '$34.0M',
        position: { lat: -34.916, lng: 138.572 },
        category: 'service',
        users: 'Event crowds, state league clubs, touring fixtures',
        purpose:
          'State significant event venue holding large evening crowds through summer, which is a heat exposure question not just a facility one.',
        repairs5yr: 3,
        significance: 'state',
      },
      {
        name: 'Brompton stormwater main',
        hazards: ['flooding'],
        value: '$11.4M',
        position: { lat: -34.923, lng: 138.583 },
        category: 'stormwater',
        users: 'The dense inner catchment',
        purpose:
          'Undersized main sitting under the highest zoned density in the LGA. Capacity and zoning are pointed in opposite directions.',
        repairs5yr: 17,
        significance: 'district',
      },
      {
        name: 'Brompton Green',
        hazards: ['heat', 'drought'],
        value: '$1.4M',
        position: { lat: -34.924, lng: 138.578 },
        category: 'open-space',
        users: 'Apartment residents with no private garden',
        purpose:
          'The only public green inside a precinct zoned to 55 dwellings per hectare.',
        repairs5yr: 2,
        significance: 'local',
      },
      {
        name: 'Bowden rail interchange',
        hazards: ['heat', 'flooding'],
        value: '$9.8M',
        position: { lat: -34.911, lng: 138.573 },
        category: 'service',
        users: 'Rail commuters, apartment residents, event crowds',
        purpose:
          'Rail and tram interchange, and the evacuation route for the precinct. Commuter purpose on weekdays, event purpose at night.',
        repairs5yr: 6,
        significance: 'district',
      },
      {
        name: 'Hindmarsh heritage row',
        hazards: ['heat'],
        value: '$6.7M',
        position: { lat: -34.921, lng: 138.585 },
        category: 'building',
        users: 'Residents of the listed cottages',
        purpose:
          'Listed nineteenth century stock. Performs worst in heat and carries the tightest retrofit constraints.',
        repairs5yr: 7,
        significance: 'local',
      },
    ],
  },
  {
    id: 'flinders-park',
    name: 'Flinders Park',
    sa2: '404011091',
    pop2021: 8930,
    pop2041: { ssp245: 10740, ssp585: 11120 },
    densityPerKm2: 1930,
    seifa: 6,
    heatScore: 4,
    floodScore: 4,
    coastalScore: 1,
    droughtScore: 3,
    treeCanopy: 14,
    greenSpace: 18,
    employmentScore: 3,
    assets: [
      {
        name: 'Priceline Stadium',
        hazards: ['heat', 'flooding'],
        value: '$26.3M',
        position: { lat: -34.933, lng: 138.556 },
        category: 'service',
        users: 'Netball clubs, state competitions, school carnivals',
        purpose:
          'State level netball venue and the largest indoor space in the LGA, which makes it the default large-scale refuge.',
        repairs5yr: 4,
        significance: 'state',
      },
      {
        name: 'River Torrens linear park',
        hazards: ['flooding', 'heat'],
        value: '$8.9M',
        position: { lat: -34.931, lng: 138.55 },
        category: 'open-space',
        users: 'Walkers, and cycle commuters using it as a route to the city',
        purpose:
          'Linear park that doubles as the main east to west commuter cycling route. Recreational and commuter purpose at once.',
        repairs5yr: 6,
        significance: 'district',
      },
      {
        name: 'Findon Road',
        hazards: ['flooding', 'heat'],
        value: '$12.1M',
        position: { lat: -34.937, lng: 138.549 },
        category: 'road',
        users: 'Commuters, school traffic, bus route passengers',
        purpose:
          'Distributor road that floods at the Torrens crossing, severing the north to south link when it does.',
        repairs5yr: 11,
        significance: 'district',
      },
      {
        name: 'Flinders Park Primary',
        hazards: ['heat'],
        value: '$9.6M',
        position: { lat: -34.936, lng: 138.556 },
        category: 'service',
        users: 'Students and families, community meetings, polling',
        purpose:
          'Primary school that also serves as a neighbourhood meeting place.',
        repairs5yr: 2,
        significance: 'local',
      },
      {
        name: 'Torrens flood levee',
        hazards: ['flooding'],
        value: '$14.8M',
        position: { lat: -34.93, lng: 138.552 },
        category: 'stormwater',
        users: 'Everything downstream of the crossing',
        purpose:
          'Levee protecting roughly 400 properties from a 1:100yr Torrens event. Binary consequence, it holds or it does not.',
        repairs5yr: 9,
        significance: 'district',
      },
    ],
  },
];

const SUBURBS: Suburb[] = SUBURB_SEED.map((s) => {
  const boundary = SA2_BOUNDARY_BY_CODE[s.sa2];
  if (!boundary) {
    throw new Error(`No ABS boundary found for SA2 code ${s.sa2} (${s.name})`);
  }
  const { centroid, span } = ringBBox(boundary.ring);
  return { ...s, path: boundary.ring, centroid, span };
});

const SUBURB_BY_ID: Record<string, Suburb> = Object.fromEntries(
  SUBURBS.map((s) => [s.id, s]),
);

const SA2_CODE_TO_SUBURB_ID: Record<string, string> = Object.fromEntries(
  SUBURBS.map((s) => [s.sa2, s.id]),
);
SA2_CODE_TO_SUBURB_ID[BEVERLEY_SA2_CODE] = BEVERLEY_ID;

/* ------------------------------------------------------------------ *
 * SA1 sub-areas
 *
 * All 257 real ASGS 2021 SA1s inside the eight SA2s above, one polygon
 * per SA1, no invented shape or count standing in for them. An earlier
 * version of this tool modelled exactly four synthetic quadrants per
 * SA2, 32 in total, with population and hazard figures made up to fit
 * that grid. Real SA1s number 257 and range from 14 to 46 per SA2, so
 * that model could not be patched, it had to go.
 *
 * No demographic value here is real either, because none has been
 * sourced at SA1 resolution for any of the eight SA2s, Beverley
 * included. SA1 polygons are coloured only by which parent SA2 they sit
 * inside, `family`, which is a fact about the real geometry, not a
 * measurement. Selecting one still opens its parent SA2's profile, real
 * data or the explicit absence of it.
 * ------------------------------------------------------------------ */

interface SA1Area {
  /** Real SA1 code, e.g. "40401109501". */
  id: string;
  /** App suburb id of the parent SA2, or BEVERLEY_ID. */
  parentId: string;
  path: LatLngTuple[];
  centroid: LatLngTuple;
  family: RegionFamily;
}

/** One tint per real SA2, purely to tell adjoining SA1s apart on the map. */
const SA1_FAMILY: Record<string, RegionFamily> = {
  'woodville-cheltenham': 'amber',
  'west-lakes': 'blue',
  'seaton-grange': 'cyan',
  'henley-beach': 'teal',
  [BEVERLEY_ID]: 'emerald',
  'royal-park-hendon': 'rose',
  'hindmarsh-brompton': 'violet',
  'flinders-park': 'indigo',
};

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
    family: SA1_FAMILY[parentId],
  };
});

const SA1_BY_PARENT: Record<string, SA1Area[]> = {};
for (const a of SA1S) {
  (SA1_BY_PARENT[a.parentId] ??= []).push(a);
}

/* ------------------------------------------------------------------ *
 * Dwelling and planning data
 *
 * Zoned capacity is residential hectares multiplied by the zoned gross
 * density. It is a ceiling under the current code, not a forecast, and
 * historic take-up has run well below it.
 * ------------------------------------------------------------------ */

const PLANNING: Record<string, PlanningRow> = {
  'woodville-cheltenham': {
    dwellings2021: 7980,
    dwellings2031: { ssp245: 8940, ssp585: 9120 },
    dwellings2041: { ssp245: 10120, ssp585: 10680 },
    totalHa: 845,
    residentialHa: 380,
    zonedGrossDensity: 32,
    zoningLabel: 'General Neighbourhood / Urban Corridor',
  },
  'west-lakes': {
    dwellings2021: 5620,
    dwellings2031: { ssp245: 6080, ssp585: 6180 },
    dwellings2041: { ssp245: 6540, ssp585: 6780 },
    totalHa: 800,
    residentialHa: 260,
    zonedGrossDensity: 28,
    zoningLabel: 'General Neighbourhood / Waterfront',
  },
  'seaton-grange': {
    dwellings2021: 6240,
    dwellings2031: { ssp245: 6980, ssp585: 7100 },
    dwellings2041: { ssp245: 7620, ssp585: 7930 },
    totalHa: 765,
    residentialHa: 240,
    zonedGrossDensity: 35,
    zoningLabel: 'General Neighbourhood / Suburban Activity',
  },
  'henley-beach': {
    dwellings2021: 4960,
    dwellings2031: { ssp245: 5320, ssp585: 5400 },
    dwellings2041: { ssp245: 5740, ssp585: 5920 },
    totalHa: 646,
    residentialHa: 200,
    zonedGrossDensity: 30,
    zoningLabel: 'Established Neighbourhood / Business Neighbourhood',
  },
  'royal-park-hendon': {
    dwellings2021: 4210,
    dwellings2031: { ssp245: 5140, ssp585: 5290 },
    dwellings2041: { ssp245: 6280, ssp585: 6610 },
    totalHa: 588,
    residentialHa: 160,
    zonedGrossDensity: 40,
    zoningLabel: 'Urban Renewal Neighbourhood',
  },
  'hindmarsh-brompton': {
    dwellings2021: 4830,
    dwellings2031: { ssp245: 6050, ssp585: 6240 },
    dwellings2041: { ssp245: 7460, ssp585: 7860 },
    totalHa: 430,
    residentialHa: 140,
    zonedGrossDensity: 55,
    zoningLabel: 'Urban Renewal / Strategic Innovation',
  },
  'flinders-park': {
    dwellings2021: 3840,
    dwellings2031: { ssp245: 4180, ssp585: 4230 },
    dwellings2041: { ssp245: 4620, ssp585: 4780 },
    totalHa: 400,
    residentialHa: 190,
    zonedGrossDensity: 26,
    zoningLabel: 'General Neighbourhood',
  },
};


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

/** Blend two hex colours. `t` is clamped, so callers can pass raw ratios. */
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

const fmtInt = (n: number) => Math.round(n).toLocaleString('en-AU');

const fmtPct = (n: number, dp = 1) => `${n.toFixed(dp)}%`;

const fmtSigned = (n: number, dp = 1) =>
  `${n >= 0 ? '+' : ''}${n.toFixed(dp)}%`;

const fmtMoney = (m: number) =>
  m >= 1 ? `$${m.toFixed(1)}M` : `$${Math.round(m * 1000)}k`;

/* ------------------------------------------------------------------ *
 * Projection helpers
 * ------------------------------------------------------------------ */

/** Linear interpolation of population between the 2021 base and 2041. */
function popAt(s: Suburb, year: number, sc: Scenario): number {
  const t = clamp((year - 2021) / 20, 0, 1);
  return Math.round(lerp(s.pop2021, s.pop2041[sc], t));
}

/** Dwellings, anchored on the 2021, 2031 and 2041 rows rather than a straight line. */
function dwellingsAt(id: string, year: number, sc: Scenario): number {
  const p = PLANNING[id];
  if (year <= 2021) return p.dwellings2021;
  if (year <= 2031) {
    return Math.round(
      lerp(p.dwellings2021, p.dwellings2031[sc], (year - 2021) / 10),
    );
  }
  return Math.round(
    lerp(p.dwellings2031[sc], p.dwellings2041[sc], clamp((year - 2031) / 10, 0, 1)),
  );
}

/** Ceiling implied by the current zoning, not a forecast of take-up. */
function zonedCapacity(id: string): number {
  const p = PLANNING[id];
  return Math.round(p.residentialHa * p.zonedGrossDensity);
}

/** Positive means headroom under the zoning. Negative means the code has to move. */
function capacityGap(id: string, year: number, sc: Scenario): number {
  return zonedCapacity(id) - dwellingsAt(id, year, sc);
}

function cagr(from: number, to: number, years: number): number {
  if (from <= 0 || years <= 0) return 0;
  return (Math.pow(to / from, 1 / years) - 1) * 100;
}

function growthPct(s: Suburb, sc: Scenario): number {
  return (s.pop2041[sc] / s.pop2021 - 1) * 100;
}

/* ------------------------------------------------------------------ *
 * Layer value resolution
 *
 * Every choropleth reduces to a raw value in the layer's own unit plus a
 * 0 to 1 position within the LGA range. The raw value is what gets shown,
 * the normalised value is what gets coloured.
 * ------------------------------------------------------------------ */

function rawLayerValue(
  layerId: string,
  s: Suburb,
  year: number,
  sc: Scenario,
): number {
  switch (layerId) {
    case 'flood-100':
      return s.floodScore * 5.5;
    case 'flood-20':
      return s.floodScore * 3.2;
    case 'flood-5':
      return s.floodScore * 1.4;
    case 'sea-2050':
      return s.coastalScore * (sc === 'ssp585' ? 4.2 : 3.1);
    case 'coastal-erosion':
      return s.coastalScore * (sc === 'ssp585' ? 9.5 : 7.0);
    case 'heat-vuln': {
      const base =
        s.heatScore * 13 + (22 - s.treeCanopy) * 0.9 + (10 - s.seifa) * 1.6;
      const drift =
        1 + ((year - 2021) / 20) * (sc === 'ssp585' ? 0.22 : 0.13);
      return clamp(base * drift, 0, 100);
    }
    case 'pop-2021':
      return s.pop2021;
    case 'pop-2041':
      return popAt(s, year, sc);
    case 'pop-change':
      return (popAt(s, year, sc) / s.pop2021 - 1) * 100;
    case 'seifa':
      return s.seifa;
    case 'employment':
      return Math.round(
        (s.employmentScore * 11000 + 8000) * (1 + (year - 2021) * 0.006),
      );
    case 'tree-canopy':
      return s.treeCanopy;
    default:
      return 0;
  }
}

function formatLayerValue(layerId: string, raw: number): string {
  switch (layerId) {
    case 'flood-100':
    case 'flood-20':
    case 'flood-5':
    case 'sea-2050':
    case 'tree-canopy':
      return fmtPct(raw, 1);
    case 'pop-change':
      return fmtSigned(raw, 1);
    case 'coastal-erosion':
      return `${raw.toFixed(1)}m`;
    case 'heat-vuln':
      return raw.toFixed(0);
    case 'seifa':
      return `${raw.toFixed(0)} / 10`;
    default:
      return fmtInt(raw);
  }
}

/** Min and max across the SA2s carrying data, so the ramp always uses its full range. */
function layerExtent(
  layerId: string,
  year: number,
  sc: Scenario,
): [number, number] {
  const vals = SUBURBS.map((s) => rawLayerValue(layerId, s, year, sc));
  return [Math.min(...vals), Math.max(...vals)];
}

function normLayerValue(
  layerId: string,
  s: Suburb,
  year: number,
  sc: Scenario,
): number {
  // SEIFA runs the other way. A low decile is more disadvantage, which is
  // the end of the scale that should read as darker.
  if (layerId === 'seifa') return (10 - s.seifa) / 9;
  const raw = rawLayerValue(layerId, s, year, sc);
  const [lo, hi] = layerExtent(layerId, year, sc);
  if (hi - lo < 1e-9) return 0.5;
  return clamp((raw - lo) / (hi - lo), 0, 1);
}

function choroplethColor(layerId: string, value: number): string {
  const def = LAYER_BY_ID[layerId];
  if (!def || !def.lo || !def.hi) return '#CBD5D4';
  return lerpHex(def.lo, def.hi, value);
}

/** Every checked layer that paints a surface, in catalogue order. Any
 *  number of these stack on the map at once, each governed by its own
 *  opacity slider, rather than only the first one checked winning. */
function activeSurfaceLayers(checked: Set<string>): LayerDef[] {
  return LAYERS.filter((l) => l.kind !== 'vector' && checked.has(l.id));
}

/* ------------------------------------------------------------------ *
 * Timeline steps
 *
 * Steps belong to the dataset, not to the slider. A dataset with no time
 * series says so rather than offering years it cannot answer.
 * ------------------------------------------------------------------ */

function yearStepsFor(
  blueprint: BlueprintId | null,
  surfaceLayerId: string | null,
): number[] {
  if (blueprint) {
    const bp = BLUEPRINT_BY_ID[blueprint];
    if (bp?.steps) return bp.steps;
  }
  if (surfaceLayerId) {
    const def = LAYER_BY_ID[surfaceLayerId];
    if (def?.steps) return def.steps;
  }
  return [];
}

/** Snap to the nearest valid step when the active dataset changes under us. */
function snapYear(year: number, steps: number[]): number {
  if (steps.length === 0) return year;
  return steps.reduce((best, s) =>
    Math.abs(s - year) < Math.abs(best - year) ? s : best,
  );
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

const IconAnalysis = ({ size = 17, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M4 20V10" />
    <path d="M10 20V4" />
    <path d="M16 20v-7" />
    <path d="M22 20H2" />
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

const IconHeat = ({ size = 14, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
  </svg>
);

const IconFlood = ({ size = 14, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M12 3s5 5.6 5 9a5 5 0 0 1-10 0c0-3.4 5-9 5-9Z" />
  </svg>
);

const IconCoastal = ({ size = 14, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M2 8.5c2.5-2 4.5 2 7 0s4.5-2 7 0 4.5 2 6 0" />
    <path d="M2 14c2.5-2 4.5 2 7 0s4.5-2 7 0 4.5 2 6 0" />
    <path d="M2 19.5c2.5-2 4.5 2 7 0s4.5-2 7 0 4.5 2 6 0" />
  </svg>
);

const IconDrought = ({ size = 14, className }: IconProps) => (
  <svg {...svgBase(size)} className={className}>
    <path d="M12 21V9" />
    <path d="M12 13 7.5 9.5" />
    <path d="M12 15.5 16.5 12" />
    <path d="M8.5 5.5a3.5 3.5 0 0 1 7 0" />
  </svg>
);

const HAZARD_ICON: Record<
  HazardId,
  (p: IconProps) => React.ReactElement
> = {
  heat: IconHeat,
  flooding: IconFlood,
  coastal: IconCoastal,
  drought: IconDrought,
};

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

/** Label plus value, value always in the mono face. */
function Stat({
  label,
  value,
  sub,
  tone = 'default',
  tip,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'default' | 'accent' | 'warn';
  tip?: { label: string; body: string; source?: string };
}) {
  const color =
    tone === 'accent'
      ? 'text-accent'
      : tone === 'warn'
        ? 'text-[#B45309]'
        : 'text-ink';
  const inner = (
    <div className="rounded-[5px] border border-line bg-white px-2 py-1.5">
      <div className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-ink-3">
        {label}
      </div>
      <div className={`num mt-0.5 text-[18px] font-semibold leading-none ${color}`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-[11.5px] leading-tight text-ink-3">{sub}</div>}
    </div>
  );
  if (!tip) return inner;
  return (
    <Tip label={tip.label} body={tip.body} source={tip.source} side="top">
      <span className="block w-full">{inner}</span>
    </Tip>
  );
}

/** Horizontal proportion bar used through the ranking and comparison views. */
function MiniBar({
  value,
  color = ACCENT,
  height = 4,
  track = '#EDF1F1',
}: {
  value: number;
  color?: string;
  height?: number;
  track?: string;
}) {
  return (
    <div
      className="w-full overflow-hidden rounded-full"
      style={{ height, background: track }}
    >
      <div
        className="h-full rounded-full transition-[width] duration-300"
        style={{ width: `${clamp(value, 0, 1) * 100}%`, background: color }}
      />
    </div>
  );
}

function HazardChip({ hazard, small }: { hazard: HazardId; small?: boolean }) {
  const Icon = HAZARD_ICON[hazard];
  const c = HAZARD_COLOR[hazard];
  return (
    <span
      className={`inline-flex items-center gap-[3px] rounded-[3px] px-1 ${small ? 'py-0' : 'py-[1px]'} text-[11.5px] font-medium`}
      style={{ background: withAlpha(c, 0.1), color: c }}
    >
      <Icon size={12} />
      {HAZARD_LABEL[hazard]}
    </span>
  );
}

/** Score expressed as five pips. Reads faster than a number at this size. */
function ScorePips({ score, color }: { score: number; color: string }) {
  return (
    <span className="inline-flex items-center gap-[2px]">
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className="h-[9px] w-[4px] rounded-[1px]"
          style={{ background: i <= score ? color : '#E4E9E9' }}
        />
      ))}
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

/** Segmented control. Used for scenario, bounds, metric and horizon. */
/** A row of tabs one level below the icon rail, so a panel with several
 *  distinct sections shows exactly one at a time instead of stacking all
 *  of them. Wraps onto more than one line rather than shrinking to fit,
 *  since a 320px panel and six section names do not both fit on one
 *  row. An optional count badge lets a tab say how much is inside it
 *  without opening it. */
function SubTabStrip<T extends string>({
  tabs,
  value,
  onChange,
  accent = ACCENT,
}: {
  tabs: { value: T; label: string; count?: string }[];
  value: T;
  onChange: (v: T) => void;
  accent?: string;
}) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-line px-2.5 py-2">
      {tabs.map((t) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            onClick={() => onChange(t.value)}
            className="flex items-center gap-1 rounded-[5px] border px-2 py-1 text-left transition-colors"
            style={
              on
                ? { borderColor: accent, background: accent, color: '#fff' }
                : { borderColor: '#E2E7E7', background: '#fff', color: '#4A5A59' }
            }
          >
            <span className="text-[11.5px] font-medium">{t.label}</span>
            {t.count && (
              <span className="num text-[10px] opacity-80">{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

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
function PanelHeading({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-1.5 flex items-center justify-between">
      <span className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
        {children}
      </span>
      {right}
    </div>
  );
}

/** Standing reminder that these figures are indicative, not council records. */
function DemoDataNote({ className = '' }: { className?: string }) {
  return (
    <div
      className={`rounded-[5px] border border-dashed border-[#D8C9A8] bg-[#FDF9EF] px-2 py-1.5 text-[11.5px] leading-[1.5] text-[#7A6634] ${className}`}
    >
      <span className="font-semibold">Indicative data.</span> Values are
      demonstration figures shaped to the real geography, not council records.
      Confirm against the source system before any figure leaves this tool.
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

interface HoveredAsset {
  asset: Asset;
  suburbId: string;
}

interface MapViewProps {
  checkedLayers: Set<string>;
  overlayOpacity: number;
  layerOpacity: Record<string, number>;
  year: number;
  sc: Scenario;
  boundsMode: BoundsMode;
  setBoundsMode: (b: BoundsMode) => void;
  selectedId: string | null;
  onSelectSuburb: (id: string) => void;
  hoveredSuburb: string | null;
  setHoveredSuburb: (id: string | null) => void;
  hoveredAsset: HoveredAsset | null;
  compare: boolean;
  compareA: string;
  compareB: string;
  /** Tint for the selected-suburb pill. Plain teal normally, the active
   *  blueprint's colour when the right panel is showing one. The map no
   *  longer needs to know the panel is open for layout purposes, it is a
   *  true flex sibling now, not an overlay it has to dodge. */
  rightPanelAccent: string;
  onZoomChange: (z: number) => void;
  showBuildings: boolean;
  buildingOffTypes: Set<string>;
}

/** Deterministic value in 0 to 1 from a pair of integers, for canvas texture. */
function hashUnit(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function suburbAt(lat: number, lng: number): Suburb | null {
  for (const s of SUBURBS) {
    if (
      lat >= s.centroid[0] - s.span[0] &&
      lat <= s.centroid[0] + s.span[0] &&
      lng >= s.centroid[1] - s.span[1] &&
      lng <= s.centroid[1] + s.span[1]
    ) {
      return s;
    }
  }
  return null;
}

function MapView(props: MapViewProps) {
  const {
    checkedLayers,
    overlayOpacity,
    layerOpacity,
    year,
    sc,
    boundsMode,
    setBoundsMode,
    selectedId,
    onSelectSuburb,
    hoveredSuburb,
    setHoveredSuburb,
    hoveredAsset,
    compare,
    compareA,
    compareB,
    rightPanelAccent,
    onZoomChange,
    showBuildings,
    buildingOffTypes,
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
  const activeSurfaces = useMemo(
    () => activeSurfaceLayers(checkedLayers),
    [checkedLayers],
  );

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
      map.attributionControl.setPrefix('Indicative demonstration data');
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

  /* -- Canvas tile layer for the grid-rendered hazard surfaces ---- */
  const makeCanvasLayer = useCallback(
    (def: LayerDef, opacity: number): LeafletLayer | null => {
      const L = LRef.current;
      const map = mapRef.current;
      if (!L || !map) return null;
      const CellGrid = L.GridLayer.extend({
        createTile(this: any, coords: any) {
          const tile = document.createElement('canvas');
          const size = this.getTileSize();
          tile.width = size.x;
          tile.height = size.y;
          const ctx = tile.getContext('2d');
          if (!ctx) return tile;
          const cell = 14;
          const origin = coords.scaleBy(size);
          for (let py = 0; py < size.y; py += cell) {
            for (let px = 0; px < size.x; px += cell) {
              const pt = L.point(
                origin.x + px + cell / 2,
                origin.y + py + cell / 2,
              );
              const ll = map.unproject(pt, coords.z);
              const s = suburbAt(ll.lat, ll.lng);
              if (!s) continue;
              const base = normLayerValue(def.id, s, year, sc);
              // A little deterministic variation stops the grid reading as a
              // single flat polygon, which it is not.
              const jitter =
                (hashUnit(origin.x + px, origin.y + py) - 0.5) * 0.26;
              const v = clamp(base + jitter, 0, 1);
              ctx.fillStyle = choroplethColor(def.id, v);
              ctx.globalAlpha = opacity * (0.55 + v * 0.45);
              ctx.fillRect(px, py, cell - 1.2, cell - 1.2);
            }
          }
          return tile;
        },
      });
      // GridLayer.extend is typed as a zero-argument constructor, so the
      // options object has to go through an untyped call.
      const layer = new (CellGrid as any)({
        tileSize: 256,
        opacity: 1,
      }) as LeafletLayer;
      (layer as any).setZIndex(200);
      return layer;
    },
    [year, sc],
  );

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

    /* Surfaces. Any number of checked layers stack, each at its own
       opacity slider, so any combination can be read against any other.
       Compare mode is the one fixed case, exactly the two chosen
       measures, B dropped to 40 percent so both stay readable. */
    const surfaces: { id: string; alpha: number }[] = compare
      ? [
          { id: compareA, alpha: 1 },
          { id: compareB, alpha: 0.4 },
        ]
      : activeSurfaces.map((l) => ({ id: l.id, alpha: 1 }));

    // A canvas layer (heat vulnerability, tree canopy) still colours the
    // SA2 polygon underneath it at the same value, the per-cell texture is
    // extra grain drawn on top, not a replacement for a visible fill.
    // Compare mode keeps both measures on plain polygons only, a canvas
    // grid cannot stay legible underneath a second surface at 40 percent.
    const canvasSurfaces = surfaces.filter(
      (s) => LAYER_BY_ID[s.id]?.kind === 'canvas' && !sa1Mode && !compare,
    );
    const polySurfaces = surfaces;

    for (const cs of canvasSurfaces) {
      const layer = makeCanvasLayer(
        LAYER_BY_ID[cs.id],
        opacityFor(cs.id) * cs.alpha * 0.55,
      );
      if (layer) push(layer);
    }

    /* Base polygons. These are also the click and hover targets, so they
       exist even when no surface layer is on. */
    const primary = polySurfaces[0];
    // Every other checked surface stacks as a translucent fill above the
    // first, same mechanism compare mode already used for its second
    // measure, just no longer capped at exactly one extra layer.
    const additionalSurfaces = polySurfaces.slice(1);

    if (sa1Mode) {
      // No layer is modelled at SA1 resolution, so SA1 fill never varies by
      // the active layer, only by which real SA2 the polygon sits inside.
      // Saying nothing here would look like an oversight; the legend below
      // states this plainly instead.
      for (const a of SA1S) {
        const isSel = selectedId === a.parentId;
        push(
          L.polygon(a.path, {
            color: isSel ? ACCENT : darkBase ? '#EAF2F1' : '#40514F',
            weight: isSel ? 1.6 : 0.5,
            opacity: 0.85,
            fillColor: FAMILY_COLOR[a.family],
            fillOpacity: overlayOpacity * 0.42,
            interactive: true,
          })
            .on('mouseover', () => setHoveredSuburb(a.parentId))
            .on('mouseout', () => setHoveredSuburb(null))
            .on('click', () => onSelectSuburb(a.parentId)),
        );
      }
    } else {
      for (const s of SUBURBS) {
        const isSel = selectedId === s.id;
        const norm = primary ? normLayerValue(primary.id, s, year, sc) : null;
        push(
          L.polygon(s.path, {
            color: isSel ? ACCENT : darkBase ? '#EAF2F1' : '#40514F',
            weight: isSel ? 1.8 : boundsMode === 'none' ? 0 : 0.7,
            opacity: boundsMode === 'none' && !isSel ? 0 : 0.8,
            fillColor:
              norm !== null ? choroplethColor(primary.id, norm) : '#9FB0AE',
            fillOpacity:
              norm !== null
                ? opacityFor(primary.id) * primary.alpha * 0.78
                : overlayOpacity * 0.14,
            interactive: true,
          })
            .on('mouseover', () => setHoveredSuburb(s.id))
            .on('mouseout', () => setHoveredSuburb(null))
            .on('click', () => onSelectSuburb(s.id)),
        );
      }

      // Beverley is a real Charles Sturt SA2 with no attribute data, drawn
      // from the same ABS boundary as the other seven so the SA2 count and
      // shape stay correct. It never carries a choropleth fill, there is
      // nothing sourced to colour it with.
      const beverley = SA2_BOUNDARY_BY_CODE[BEVERLEY_SA2_CODE];
      if (beverley) {
        const isSel = selectedId === BEVERLEY_ID;
        push(
          L.polygon(beverley.ring, {
            color: isSel ? ACCENT : darkBase ? '#EAF2F1' : '#40514F',
            weight: isSel ? 1.8 : boundsMode === 'none' ? 0 : 0.7,
            opacity: boundsMode === 'none' && !isSel ? 0 : 0.8,
            fillColor: '#9FB0AE',
            fillOpacity: overlayOpacity * 0.14,
            dashArray: isSel ? undefined : '4 3',
            interactive: true,
          })
            .on('mouseover', () => setHoveredSuburb(BEVERLEY_ID))
            .on('mouseout', () => setHoveredSuburb(null))
            .on('click', () => onSelectSuburb(BEVERLEY_ID)),
        );
      }
    }

    /* Every additional checked surface stacks over the first, in compare
       mode that's exactly the second measure at 40 percent, otherwise it
       is however many other layers are checked, each at its own slider,
       so any combination of hazard, vulnerability or other layers reads
       against any other rather than only the first one checked winning. */
    if (!sa1Mode) {
      for (const extra of additionalSurfaces) {
        for (const s of SUBURBS) {
          const norm = normLayerValue(extra.id, s, year, sc);
          push(
            L.polygon(s.path, {
              stroke: false,
              fillColor: choroplethColor(extra.id, norm),
              // Compare mode's 40 percent alpha is untouched, that
              // behaviour already exists. General stacking outside
              // compare mode has every extra layer at alpha 1, so it
              // gets its own dampener, otherwise three or four checked
              // layers would just paint over each other solid.
              fillOpacity: opacityFor(extra.id) * extra.alpha * (compare ? 1 : 0.65),
              interactive: false,
            }),
          );
        }
      }
    }

    /* Vector overlays. Each is a schematic rendering of the network, drawn
       from the SA2 geometry so the shape stays honest about its resolution. */
    const vecAlpha = (id: string) => opacityFor(id);

    if (checkedLayers.has('watercourses')) {
      const c = LAYER_BY_ID['watercourses'].hi!;
      push(
        L.polyline(
          [
            [-34.9, 138.49],
            [-34.905, 138.53],
            [-34.93, 138.552],
            [-34.925, 138.585],
          ] as LatLngTuple[],
          { color: c, weight: 2.4, opacity: vecAlpha('watercourses') },
        ),
      );
      push(
        L.polyline(
          [
            [-34.83, 138.545],
            [-34.855, 138.555],
            [-34.872, 138.535],
            [-34.885, 138.505],
          ] as LatLngTuple[],
          {
            color: c,
            weight: 1.6,
            opacity: vecAlpha('watercourses'),
            dashArray: '4 3',
          },
        ),
      );
    }

    if (checkedLayers.has('roads')) {
      const c = LAYER_BY_ID['roads'].hi!;
      for (const s of SUBURBS) {
        const [lat, lng] = s.centroid;
        const [dLat, dLng] = s.span;
        push(
          L.polyline(
            [
              [lat, lng - dLng],
              [lat, lng + dLng],
            ] as LatLngTuple[],
            { color: c, weight: 1.3, opacity: vecAlpha('roads') * 0.75 },
          ),
        );
        push(
          L.polyline(
            [
              [lat - dLat, lng],
              [lat + dLat, lng],
            ] as LatLngTuple[],
            { color: c, weight: 1.3, opacity: vecAlpha('roads') * 0.75 },
          ),
        );
      }
    }

    if (checkedLayers.has('sw-pipes')) {
      const c = LAYER_BY_ID['sw-pipes'].hi!;
      for (const s of SUBURBS) {
        const [lat, lng] = s.centroid;
        const [dLat, dLng] = s.span;
        push(
          L.polyline(
            [
              [lat - dLat * 0.6, lng - dLng * 0.8],
              [lat + dLat * 0.2, lng - dLng * 0.1],
              [lat + dLat * 0.7, lng + dLng * 0.7],
            ] as LatLngTuple[],
            {
              color: c,
              weight: 1.1,
              opacity: vecAlpha('sw-pipes') * 0.8,
              dashArray: '3 2',
            },
          ),
        );
      }
    }

    if (checkedLayers.has('railways')) {
      const c = LAYER_BY_ID['railways'].hi!;
      push(
        L.polyline(
          [
            [-34.913, 138.573],
            [-34.888, 138.55],
            [-34.855, 138.535],
            [-34.83, 138.52],
          ] as LatLngTuple[],
          { color: c, weight: 2.2, opacity: vecAlpha('railways') },
        ),
      );
      push(
        L.polyline(
          [
            [-34.913, 138.573],
            [-34.888, 138.55],
            [-34.855, 138.535],
            [-34.83, 138.52],
          ] as LatLngTuple[],
          {
            color: '#fff',
            weight: 1,
            opacity: vecAlpha('railways'),
            dashArray: '2 5',
          },
        ),
      );
    }

    if (checkedLayers.has('cycling')) {
      const c = LAYER_BY_ID['cycling'].hi!;
      push(
        L.polyline(
          [
            [-34.962, 138.503],
            [-34.928, 138.499],
            [-34.895, 138.496],
            [-34.86, 138.492],
          ] as LatLngTuple[],
          { color: c, weight: 1.8, opacity: vecAlpha('cycling') },
        ),
      );
      push(
        L.polyline(
          [
            [-34.932, 138.545],
            [-34.928, 138.565],
            [-34.92, 138.585],
          ] as LatLngTuple[],
          {
            color: c,
            weight: 1.4,
            opacity: vecAlpha('cycling'),
            dashArray: '5 3',
          },
        ),
      );
    }

    if (checkedLayers.has('pt-stops')) {
      const c = LAYER_BY_ID['pt-stops'].hi!;
      for (const s of SUBURBS) {
        for (let i = 0; i < 6; i++) {
          const lat =
            s.centroid[0] + (hashUnit(i, s.pop2021) - 0.5) * s.span[0] * 1.7;
          const lng =
            s.centroid[1] + (hashUnit(s.pop2021, i) - 0.5) * s.span[1] * 1.7;
          push(
            L.circleMarker([lat, lng] as LatLngTuple, {
              radius: 2.6,
              color: '#fff',
              weight: 1,
              fillColor: c,
              fillOpacity: vecAlpha('pt-stops'),
            }),
          );
        }
      }
    }

    if (checkedLayers.has('pt-freq')) {
      const c = LAYER_BY_ID['pt-freq'].hi!;
      for (const s of SUBURBS) {
        push(
          L.circle(s.centroid, {
            radius: 240 + s.employmentScore * 130,
            stroke: false,
            fillColor: c,
            fillOpacity: vecAlpha('pt-freq') * 0.28,
          }),
        );
      }
    }

    if (checkedLayers.has('industrial')) {
      const c = LAYER_BY_ID['industrial'].hi!;
      for (const id of ['royal-park-hendon', 'hindmarsh-brompton', 'woodville-cheltenham']) {
        const s = SUBURB_BY_ID[id];
        push(
          L.rectangle(
            [
              [s.centroid[0] - s.span[0] * 0.5, s.centroid[1] - s.span[1] * 0.85],
              [s.centroid[0] + s.span[0] * 0.1, s.centroid[1] - s.span[1] * 0.1],
            ],
            {
              color: c,
              weight: 0.8,
              fillColor: c,
              fillOpacity: vecAlpha('industrial') * 0.3,
            },
          ),
        );
      }
    }

    if (checkedLayers.has('zoning')) {
      const c = LAYER_BY_ID['zoning'].hi!;
      for (const s of SUBURBS) {
        const d = PLANNING[s.id].zonedGrossDensity;
        push(
          L.rectangle(
            [
              [s.centroid[0] - s.span[0] * 0.45, s.centroid[1] - s.span[1] * 0.45],
              [s.centroid[0] + s.span[0] * 0.45, s.centroid[1] + s.span[1] * 0.45],
            ],
            {
              color: c,
              weight: 0.9,
              dashArray: '3 2',
              fillColor: c,
              fillOpacity: vecAlpha('zoning') * (d / 55) * 0.34,
            },
          ),
        );
      }
    }

    if (checkedLayers.has('heritage')) {
      const c = LAYER_BY_ID['heritage'].hi!;
      for (const s of SUBURBS) {
        const n = s.id === 'hindmarsh-brompton' ? 9 : 4;
        for (let i = 0; i < n; i++) {
          const lat =
            s.centroid[0] + (hashUnit(i * 3, s.seifa) - 0.5) * s.span[0] * 1.5;
          const lng =
            s.centroid[1] + (hashUnit(s.seifa, i * 3) - 0.5) * s.span[1] * 1.5;
          push(
            L.circleMarker([lat, lng] as LatLngTuple, {
              radius: 2,
              stroke: false,
              fillColor: c,
              fillOpacity: vecAlpha('heritage'),
            }),
          );
        }
      }
    }

    if (checkedLayers.has('res-pipeline')) {
      const c = LAYER_BY_ID['res-pipeline'].hi!;
      for (const s of SUBURBS) {
        const committed = dwellingsAt(s.id, 2031, sc) - PLANNING[s.id].dwellings2021;
        push(
          L.circle(s.centroid, {
            radius: 160 + committed * 0.12,
            color: c,
            weight: 1,
            fillColor: c,
            fillOpacity: vecAlpha('res-pipeline') * 0.2,
          }),
        );
      }
    }

    /* Boundary outlines sit above every fill so they stay legible. */
    if (boundsMode === 'sa2') {
      const outlineRings = [
        ...SUBURBS.map((s) => s.path),
        ...(SA2_BOUNDARY_BY_CODE[BEVERLEY_SA2_CODE]
          ? [SA2_BOUNDARY_BY_CODE[BEVERLEY_SA2_CODE].ring]
          : []),
      ];
      for (const ring of outlineRings) {
        push(
          L.polygon(ring, {
            fill: false,
            color: darkBase ? '#F2F7F6' : '#2B3C3A',
            weight: 0.9,
            opacity: darkBase ? 0.75 : 0.55,
            interactive: false,
          }),
        );
      }
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
        { lat: number; lng: number; precision: 'site' | 'street'; names: string[] }
      >();
      for (const b of REAL_BUILDINGS) {
        const loc = BUILDING_LOCATION[b.id];
        if (!loc) continue;
        const typeKey = b.buildingType ?? UNCLASSIFIED;
        if (buildingOffTypes.has(typeKey)) continue;
        const key = `${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}`;
        const bucket = byPoint.get(key);
        if (bucket) bucket.names.push(b.name);
        else byPoint.set(key, { lat: loc.lat, lng: loc.lng, precision: loc.precision, names: [b.name] });
      }
      for (const { lat, lng, precision, names } of byPoint.values()) {
        const siteLevel = precision === 'site';
        const count = names.length;
        // Radius grows with count so a 29-building cluster reads as
        // visibly bigger than a single building, not just a darker dot.
        const radius = (siteLevel ? 5 : 4) + (count > 1 ? Math.min(9, Math.log2(count) * 3) : 0);
        const label =
          count === 1
            ? `${names[0]}${siteLevel ? '' : ' — street-level estimate, not the building'}`
            : `${count} buildings here${siteLevel ? '' : ', street-level estimate'}: ${names.slice(0, 4).join(', ')}${count > 4 ? `, +${count - 4} more` : ''}`;
        push(
          L.circleMarker([lat, lng] as LatLngTuple, {
            radius,
            color: siteLevel ? '#fff' : ACCENT,
            weight: siteLevel ? 1.2 : 1.6,
            fillColor: siteLevel ? ACCENT : '#fff',
            fillOpacity: siteLevel ? 0.95 : 0.5,
            interactive: true,
          }).bindTooltip(label, { direction: 'top', offset: [0, -3] }),
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
    year,
    sc,
    boundsMode,
    sa1Mode,
    selectedId,
    activeSurfaces,
    compare,
    compareA,
    compareB,
    makeCanvasLayer,
    onSelectSuburb,
    setHoveredSuburb,
    darkBase,
    showBuildings,
    buildingOffTypes,
  ]);

  /* -- Hover. Kept separate so it never rebuilds the stack. -------- */
  useEffect(() => {
    const L = LRef.current;
    const map = mapRef.current;
    if (!ready || !L || !map) return;
    const added: LeafletLayer[] = [];

    if (hoveredSuburb && !hoveredAsset) {
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

    if (hoveredAsset) {
      const { asset, suburbId } = hoveredAsset;
      const s = SUBURB_BY_ID[suburbId];
      const tone = HAZARD_COLOR[asset.hazards[0] ?? 'heat'];

      // A 120m circle on the asset itself. The SA2 polygon would be the
      // wrong answer here, the question is where the thing actually is.
      added.push(
        L.circle([asset.position.lat, asset.position.lng] as LatLngTuple, {
          radius: 120,
          color: tone,
          weight: 2,
          fillColor: tone,
          fillOpacity: 0.18,
          interactive: false,
        }).addTo(map),
      );
      added.push(
        L.circleMarker([asset.position.lat, asset.position.lng] as LatLngTuple, {
          radius: 3,
          color: '#fff',
          weight: 1.4,
          fillColor: tone,
          fillOpacity: 1,
          interactive: false,
        }).addTo(map),
      );

      // Heat assets also get a coarse exposure preview across the SA2, on a
      // 300m grid. It is a preview, not the modelled surface.
      if (asset.hazards.includes('heat') && s) {
        const dLat = 300 / 111320;
        const dLng = 300 / (111320 * Math.cos((s.centroid[0] * Math.PI) / 180));
        for (
          let lat = s.centroid[0] - s.span[0];
          lat <= s.centroid[0] + s.span[0];
          lat += dLat
        ) {
          for (
            let lng = s.centroid[1] - s.span[1];
            lng <= s.centroid[1] + s.span[1];
            lng += dLng
          ) {
            added.push(
              L.circleMarker([lat, lng] as LatLngTuple, {
                radius: 4,
                stroke: false,
                fillColor: '#DC2626',
                fillOpacity: 0.42,
                interactive: false,
              }).addTo(map),
            );
          }
        }
      }
    }

    hoverRef.current = added;
    return () => {
      for (const l of added) {
        if (map.hasLayer(l)) map.removeLayer(l);
      }
      hoverRef.current = [];
    };
  }, [ready, hoveredSuburb, hoveredAsset]);

  const selected = selectedId ? SUBURB_BY_ID[selectedId] : null;
  const hovered = hoveredSuburb ? SUBURB_BY_ID[hoveredSuburb] : null;

  const legendLayers = compare
    ? [compareA, compareB]
    : activeSurfaces.map((l) => l.id);

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

      {/* Boundary control. The right analysis panel is a flex sibling now,
          not an overlay, so the map's own width already makes room for
          it, this never needs to dodge anything. */}
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

      {/* Selected suburb pill. Beverley has no Suburb record (no attribute
          data has been sourced for it), so it gets its own pill straight
          off the real boundary rather than showing nothing. */}
      {(selected || selectedId === BEVERLEY_ID) && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-[999] -translate-x-1/2">
          <div
            className="fade-up flex items-center gap-1.5 rounded-full border px-2.5 py-1 shadow-[0_2px_10px_rgba(20,32,31,0.12)]"
            style={{
              background: '#fff',
              borderColor: rightPanelAccent,
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: rightPanelAccent }}
            />
            <span className="text-[13.5px] font-semibold text-ink">
              {selected ? selected.name : 'Beverley'}
            </span>
            <span className="num text-[12px] text-ink-3">
              {selected ? selected.sa2 : BEVERLEY_SA2_CODE}
            </span>
            {!selected && (
              <span className="rounded-[3px] bg-surface-2 px-1 text-[11px] text-ink-3">
                no data sourced
              </span>
            )}
          </div>
        </div>
      )}

      {/* Hover readout. The brief asked for as much on rollover as fits. */}
      {hovered && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-[999] w-[240px]">
          <div className="fade-up rounded-[6px] border border-line bg-white/96 p-2 shadow-[0_2px_12px_rgba(20,32,31,0.12)] backdrop-blur">
            <div className="flex items-baseline justify-between">
              <span className="text-[13.5px] font-semibold text-ink">
                {hovered.name}
              </span>
              <span className="num text-[11.5px] text-ink-3">{hovered.sa2}</span>
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1">
              <HoverRow
                label="Pop."
                value={fmtInt(popAt(hovered, year, sc))}
              />
              <HoverRow label="SEIFA" value={`${hovered.seifa}/10`} />
              <HoverRow label="Canopy" value={`${hovered.treeCanopy}%`} />
              <HoverRow
                label="Density"
                value={fmtInt(hovered.densityPerKm2)}
              />
            </div>
            {legendLayers.length > 0 && (
              <div className="mt-1.5 border-t border-line pt-1.5">
                {legendLayers.map((id) => (
                  <div
                    key={id}
                    className="flex items-center justify-between gap-2 py-[1px]"
                  >
                    <span className="truncate text-[11.5px] text-ink-2">
                      {LAYER_BY_ID[id].name}
                    </span>
                    <span className="num text-[12px] font-semibold text-ink">
                      {formatLayerValue(
                        id,
                        rawLayerValue(id, hovered, year, sc),
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-1.5 flex gap-1 border-t border-line pt-1.5">
              {(['heat', 'flooding', 'coastal', 'drought'] as HazardId[]).map(
                (h) => {
                  const score =
                    h === 'heat'
                      ? hovered.heatScore
                      : h === 'flooding'
                        ? hovered.floodScore
                        : h === 'coastal'
                          ? hovered.coastalScore
                          : hovered.droughtScore;
                  return (
                    <div key={h} className="flex-1">
                      <div className="text-[11px] uppercase tracking-[0.05em] text-ink-3">
                        {h === 'flooding' ? 'Flood' : h}
                      </div>
                      <div className="mt-[2px]">
                        <ScorePips score={score} color={HAZARD_COLOR[h]} />
                      </div>
                    </div>
                  );
                },
              )}
            </div>
          </div>
        </div>
      )}

      {/* SA1 mode never carries a choropleth, no layer is modelled at that
          resolution, so it gets its own legend rather than a ramp that
          would misstate what the fill actually shows. */}
      {sa1Mode && !hovered && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-[999] w-[230px]">
          <div className="rounded-[6px] border border-line bg-white/95 p-2 shadow-[0_2px_10px_rgba(20,32,31,0.1)] backdrop-blur">
            <div className="text-[12px] font-semibold text-ink">
              Real SA1 boundaries
            </div>
            <div className="mt-1 text-[11px] leading-[1.5] text-ink-3">
              257 ABS ASGS 2021 areas, tinted by which SA2 they sit inside.
              No layer is modelled at SA1 resolution, so fill colour carries
              no other value here.
            </div>
          </div>
        </div>
      )}

      {/* Ramp legend for whatever surface is painted, SA2 view only. */}
      {legendLayers.length > 0 && !hovered && !sa1Mode && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-[999] w-[220px]">
          <div className="rounded-[6px] border border-line bg-white/95 p-2 shadow-[0_2px_10px_rgba(20,32,31,0.1)] backdrop-blur">
            {legendLayers.map((id, i) => {
              const def = LAYER_BY_ID[id];
              const [lo, hi] = layerExtent(id, year, sc);
              return (
                <div key={id} className={i > 0 ? 'mt-2' : ''}>
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-ink">
                      {def.name}
                    </span>
                    {compare && (
                      <span className="num text-[11px] text-ink-3">
                        {i === 0 ? 'A' : 'B 40%'}
                      </span>
                    )}
                  </div>
                  <div
                    className="mt-1 h-[6px] w-full rounded-full"
                    style={{
                      background: `linear-gradient(90deg, ${def.lo ?? '#eee'}, ${def.hi ?? '#999'})`,
                    }}
                  />
                  <div className="num mt-[3px] flex justify-between text-[11px] text-ink-3">
                    <span>{formatLayerValue(id, lo)}</span>
                    <span>{formatLayerValue(id, hi)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Zoom. */}
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

function HoverRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-1">
      <span className="text-[11.5px] text-ink-3">{label}</span>
      <span className="num text-[12.5px] font-semibold text-ink">{value}</span>
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
  activeBlueprint: BlueprintId | null;
  applyBlueprint: (id: BlueprintId) => void;
  buildingOffTypes: Set<string>;
  setBuildingOffTypes: (updater: (prev: Set<string>) => Set<string>) => void;
}

function LayersTab({
  checkedLayers,
  toggleLayer,
  overlayOpacity,
  setOverlayOpacity,
  layerOpacity,
  setLayerOpacity,
  activeBlueprint,
  applyBlueprint,
  buildingOffTypes,
  setBuildingOffTypes,
}: LayersTabProps) {
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Ordered by how often a council user needs it: the hazard itself,
  // what it threatens (assets), who it threatens, then the supporting
  // network and policy layers behind those. No group is a generic
  // 'overlays' catch-all, each one names the actual category it holds.
  // One sub-tab visible at a time, not six accordions stacked, so
  // picking a category costs a tap, not a scroll past the other five.
  type LayersSection = LayerGroup | 'assets';
  const [activeTab, setActiveTab] = useState<LayersSection>('hazard');

  const groups: LayerGroup[] = [
    'hazard',
    'vulnerability',
    'transport',
    'infrastructure',
    'planning',
  ];
  const assetsOnCount = ALL_BUILDING_TYPES.size - buildingOffTypes.size;

  const categories: { value: LayersSection; label: string; color: string; on: number; total: number }[] = [
    {
      value: 'hazard',
      label: GROUP_LABEL.hazard,
      color: '#DC2626',
      on: LAYERS.filter((l) => l.group === 'hazard' && checkedLayers.has(l.id)).length,
      total: LAYERS.filter((l) => l.group === 'hazard').length,
    },
    {
      value: 'assets',
      label: 'Assets',
      color: ACCENT,
      on: assetsOnCount,
      total: ALL_BUILDING_TYPES.size,
    },
    {
      value: 'vulnerability',
      label: GROUP_LABEL.vulnerability,
      color: '#7C3AED',
      on: LAYERS.filter((l) => l.group === 'vulnerability' && checkedLayers.has(l.id)).length,
      total: LAYERS.filter((l) => l.group === 'vulnerability').length,
    },
    {
      value: 'transport',
      label: GROUP_LABEL.transport,
      color: '#0891B2',
      on: LAYERS.filter((l) => l.group === 'transport' && checkedLayers.has(l.id)).length,
      total: LAYERS.filter((l) => l.group === 'transport').length,
    },
    {
      value: 'infrastructure',
      label: GROUP_LABEL.infrastructure,
      color: '#2563EB',
      on: LAYERS.filter((l) => l.group === 'infrastructure' && checkedLayers.has(l.id)).length,
      total: LAYERS.filter((l) => l.group === 'infrastructure').length,
    },
    {
      value: 'planning',
      label: GROUP_LABEL.planning,
      color: '#059669',
      on: LAYERS.filter((l) => l.group === 'planning' && checkedLayers.has(l.id)).length,
      total: LAYERS.filter((l) => l.group === 'planning').length,
    },
  ];

  const renderLayerList = (g: LayerGroup) => {
    const layers = LAYERS.filter((l) => l.group === g);
    return (
      <div className="pb-1.5">
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
      {/* Global opacity sits above everything it governs, the one
          control that applies regardless of which section is open. */}
      <div className="border-b border-line px-2.5 py-2">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-semibold uppercase tracking-[0.07em] text-ink-3">
            Global opacity
          </span>
          <span className="num text-[12.5px] font-semibold text-accent">
            {Math.round(overlayOpacity * 100)}%
          </span>
        </div>
        <input
          type="range"
          min={10}
          max={100}
          value={Math.round(overlayOpacity * 100)}
          onChange={(e) => setOverlayOpacity(Number(e.target.value) / 100)}
          className="mt-1.5 w-full"
        />
      </div>

      {/* Category cards, not a row of plain tab buttons, a colour and a
          live on/total count read faster than a label alone, and the
          grid matches the Blueprint cards below rather than introducing
          a third visual language in the same panel. */}
      <div className="border-b border-line px-2.5 py-2">
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

      {activeTab === 'assets' ? (
        <div className="px-2.5 py-2">
          <AssetTypeToggles
            offTypes={buildingOffTypes}
            setOffTypes={setBuildingOffTypes}
          />
        </div>
      ) : (
        renderLayerList(activeTab)
      )}

      {/* Blueprints. Pinned below the sections rather than one of them,
          it is a quick action, not something to browse. */}
      <div className="border-t border-line px-2.5 py-2.5">
        <PanelHeading>Blueprints</PanelHeading>
        <div className="grid grid-cols-2 gap-1.5">
          {BLUEPRINTS.map((b) => {
            const on = activeBlueprint === b.id;
            return (
              <button
                key={b.id}
                onClick={() => applyBlueprint(b.id)}
                className="rounded-[5px] border px-1.5 py-1.5 text-left transition-all"
                style={{
                  borderColor: on ? b.accent : '#E2E7E7',
                  background: on ? withAlpha(b.accent, 0.08) : '#fff',
                }}
              >
                <span
                  className="mb-1 block h-1.5 w-1.5 rounded-full"
                  style={{ background: b.accent }}
                />
                <span
                  className="block text-[12.5px] font-semibold leading-tight"
                  style={{ color: on ? b.accent : '#14201F' }}
                >
                  {b.title}
                </span>
                <span className="num mt-[2px] block text-[11px] text-ink-3">
                  {b.layers.length} layers
                </span>
              </button>
            );
          })}
        </div>
        <DemoDataNote className="mt-2.5" />
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
  year: number;
  sc: Scenario;
  hoveredAsset: HoveredAsset | null;
  setHoveredAsset: (h: HoveredAsset | null) => void;
  buildingOffTypes: Set<string>;
  onManageCategories: () => void;
}

/** Top ranked suburb on a metric, used by the LGA overview cards. */
function topBy(
  fn: (s: Suburb) => number,
): { suburb: Suburb; value: number } {
  let best = SUBURBS[0];
  let bestV = fn(SUBURBS[0]);
  for (const s of SUBURBS) {
    const v = fn(s);
    if (v > bestV) {
      best = s;
      bestV = v;
    }
  }
  return { suburb: best, value: bestV };
}

function PlaceTab({
  selectedId,
  setSelectedId,
  year,
  sc,
  hoveredAsset,
  setHoveredAsset,
  buildingOffTypes,
  onManageCategories,
}: PlaceTabProps) {
  const [openAsset, setOpenAsset] = useState<string | null>(null);
  const [showRealBuildings, setShowRealBuildings] = useState(false);
  const [lgaTab, setLgaTab] = useState<'overview' | 'register'>('overview');
  const [placeTab, setPlaceTab] = useState<'overview' | 'demographics' | 'register'>('overview');

  if (!selectedId) {
    const cards = [
      {
        key: 'heat',
        label: 'Highest heat vulnerability',
        ...topBy((s) => rawLayerValue('heat-vuln', s, year, sc)),
        fmt: (v: number) => v.toFixed(0),
        unit: 'index',
        color: HAZARD_COLOR.heat,
      },
      {
        key: 'flood',
        label: 'Largest modelled flood extent',
        ...topBy((s) => s.floodScore),
        fmt: (v: number) => `${(v * 5.5).toFixed(1)}%`,
        unit: 'of area, 1:100yr',
        color: HAZARD_COLOR.flooding,
      },
      {
        key: 'coastal',
        label: 'Greatest coastal exposure',
        ...topBy((s) => s.coastalScore),
        fmt: (v: number) => `${v}/5`,
        unit: 'relative score',
        color: HAZARD_COLOR.coastal,
      },
      {
        key: 'growth',
        label: 'Fastest projected growth',
        ...topBy((s) => growthPct(s, sc)),
        fmt: (v: number) => fmtSigned(v, 0),
        unit: 'to 2041',
        color: ACCENT,
      },
      {
        key: 'seifa',
        label: 'Most disadvantaged',
        ...topBy((s) => 10 - s.seifa),
        fmt: (v: number) => `${10 - v}/10`,
        unit: 'SEIFA decile',
        color: '#9F1239',
      },
      {
        key: 'canopy',
        label: 'Lowest tree canopy',
        ...topBy((s) => 40 - s.treeCanopy),
        fmt: (v: number) => `${40 - v}%`,
        unit: 'canopy cover',
        color: '#166534',
      },
      {
        key: 'assets',
        label: 'Most exposed assets',
        ...topBy((s) => s.assets.filter((a) => a.hazards.length > 1).length),
        fmt: (v: number) => `${v}`,
        unit: 'multi-hazard assets',
        color: '#7C3AED',
      },
      {
        key: 'repairs',
        label: 'Most reactive repairs',
        ...topBy((s) =>
          s.assets.reduce((n, a) => Math.max(n, a.repairs5yr), 0),
        ),
        fmt: (v: number) => `${v}`,
        unit: 'in 5 years, worst asset',
        color: '#B45309',
      },
    ];

    return (
      <div>
        <SubTabStrip
          tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'register', label: 'Buildings register', count: `${REAL_BUILDINGS.length}` },
          ]}
          value={lgaTab}
          onChange={setLgaTab}
        />
        {lgaTab === 'overview' ? (
          <div className="px-2.5 py-2.5">
            <p className="mb-2 text-[12.5px] leading-[1.55] text-ink-2">
              No suburb selected. The cards below name the leading SA2 on each
              measure. Selecting one, here or on the map, opens its full profile.
              Leading is not the same as most urgent, the measures are not weighted
              against each other.
            </p>
            <div className="space-y-1">
              {cards.map((c) => (
                <button
                  key={c.key}
                  onClick={() => setSelectedId(c.suburb.id)}
                  className="flex w-full items-center gap-2 rounded-[5px] border border-line bg-white px-2 py-1.5 text-left transition-colors hover:border-accent"
                >
                  <span
                    className="h-6 w-[2.5px] shrink-0 rounded-full"
                    style={{ background: c.color }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11.5px] uppercase tracking-[0.05em] text-ink-3">
                      {c.label}
                    </span>
                    <span className="block truncate text-[13.5px] font-semibold text-ink">
                      {c.suburb.name}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="num block text-[16px] font-semibold leading-none text-ink">
                      {c.fmt(c.value)}
                    </span>
                    <span className="mt-[2px] block text-[11px] text-ink-3">
                      {c.unit}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <DemoDataNote className="mt-2.5" />
          </div>
        ) : (
          <div className="px-2.5 py-2.5">
            <RealBuildingsRegister
              offTypes={buildingOffTypes}
              onManageCategories={onManageCategories}
            />
          </div>
        )}
      </div>
    );
  }

  const s = SUBURB_BY_ID[selectedId];

  // Beverley is a real Charles Sturt SA2, drawn on the map from the same
  // ABS boundary as the other seven, but nothing here has sourced any
  // population, hazard or asset data for it. Saying so plainly beats
  // either hiding the boundary or filling the gap with a guess.
  if (!s) {
    const boundary = SA2_BOUNDARY_BY_CODE[BEVERLEY_SA2_CODE];
    return (
      <div className="px-2.5 py-2.5">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[17px] font-semibold leading-tight text-ink">
              Beverley
            </div>
            <div className="num mt-[2px] text-[12px] text-ink-3">
              SA2 {BEVERLEY_SA2_CODE} · {boundary?.areaSqKm.toFixed(2)} km2
            </div>
          </div>
          <button
            onClick={() => setSelectedId(null)}
            className="shrink-0 rounded-[4px] border border-line px-1.5 py-[2px] text-[11.5px] text-ink-3 transition-colors hover:border-accent hover:text-accent"
          >
            Clear
          </button>
        </div>
        <div className="rounded-[6px] border border-dashed border-line bg-surface-2 px-2.5 py-3 text-[12.5px] leading-[1.6] text-ink-2">
          Beverley is a real Charles Sturt SA2, its boundary here is the
          exact ABS ASGS 2021 shape. No population, hazard score or
          demographic figure has been sourced for it, so it carries none
          of the indicative figures shown for the other seven SA2s rather
          than a guessed one, and it is left out of Analysis for the same
          reason.
        </div>


        {(() => {
          const buildings = REAL_BUILDINGS_BY_SUBURB[BEVERLEY_ID] ?? [];
          if (buildings.length === 0) return null;
          const value = buildings.reduce((n, b) => n + b.insuredValue, 0);
          return (
            <div className="mt-2.5">
              <PanelHeading
                right={<span className="num text-[11px] text-ink-3">${(value / 1e6).toFixed(1)}M</span>}
              >
                Real buildings here, {buildings.length}
              </PanelHeading>
              <p className="mb-1.5 text-[11px] leading-[1.5] text-ink-3">
                Population and hazard data have not been sourced for
                Beverley, but its real buildings have, geocoded from the
                register and spatially matched to this exact boundary.
                Council's Beverley works precinct accounts for most of
                these.
              </p>
              <div className="max-h-[280px] space-y-1 overflow-y-auto thin-scroll pr-0.5">
                {buildings.map((b) => (
                  <BuildingCard
                    key={b.id}
                    b={b}
                    isOpen={openAsset === b.id}
                    onToggle={() => setOpenAsset(openAsset === b.id ? null : b.id)}
                  />
                ))}
              </div>
            </div>
          );
        })()}

        <DemoDataNote className="mt-2.5" />
      </div>
    );
  }

  const plan = PLANNING[s.id];
  const pop = popAt(s, year, sc);
  const proj = s.pop2041[sc];
  const delta = growthPct(s, sc);

  const realBuildings = REAL_BUILDINGS_BY_SUBURB[s.id] ?? [];
  const realBuildingsValue = realBuildings.reduce((n, b) => n + b.insuredValue, 0);

  return (
    <div>
      <div className="flex items-start justify-between gap-2 px-2.5 pt-2.5">
        <div className="min-w-0">
          <div className="truncate text-[17px] font-semibold leading-tight text-ink">
            {s.name}
          </div>
          <div className="num mt-[2px] text-[12px] text-ink-3">
            SA2 {s.sa2} · {plan.totalHa} ha
          </div>
        </div>
        <button
          onClick={() => setSelectedId(null)}
          className="shrink-0 rounded-[4px] border border-line px-1.5 py-[2px] text-[11.5px] text-ink-3 transition-colors hover:border-accent hover:text-accent"
        >
          Clear
        </button>
      </div>

      <div className="mt-2">
        <SubTabStrip
          tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'demographics', label: 'Demographics' },
            { value: 'register', label: 'Register', count: `${realBuildings.length + s.assets.length}` },
          ]}
          value={placeTab}
          onChange={setPlaceTab}
        />
      </div>

      {placeTab === 'overview' && (
        <div className="px-2.5 py-2.5">
          {/* Population and the projection it is heading toward. */}
          <div className="rounded-[6px] border border-line bg-white p-2">
            <div className="flex items-end justify-between">
              <div>
                <div className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-ink-3">
                  Population {year}
                </div>
                <div className="num mt-0.5 text-[28px] font-semibold leading-none text-ink">
                  {fmtInt(pop)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[11.5px] text-ink-3">
                  2041 {SCENARIO_LABEL[sc]}
                </div>
                <div className="num text-[16px] font-semibold text-accent">
                  {fmtInt(proj)}
                </div>
                <div className="num text-[12px] text-ink-3">{fmtSigned(delta, 1)}</div>
              </div>
            </div>
            <div className="mt-1.5">
              <MiniBar value={pop / proj} color={ACCENT} height={3} />
            </div>
            <div className="num mt-1 flex justify-between text-[11px] text-ink-3">
              <span>2021 {fmtInt(s.pop2021)}</span>
              <span>2041 {fmtInt(proj)}</span>
            </div>
          </div>

          <div className="mt-2.5 rounded-[5px] border border-dashed border-line bg-surface-2 px-2 py-1.5 text-[11px] leading-[1.5] text-ink-3">
            Risk scores and how this place maps onto council's consequence
            framework are in the analysis panel on the right.
          </div>
        </div>
      )}

      {placeTab === 'demographics' && (
        <div className="px-2.5 py-2.5">
          <div className="grid grid-cols-2 gap-1.5">
            <Stat
              label="SEIFA"
              value={`${s.seifa} / 10`}
              sub="1 is most disadvantaged"
              tip={{
                label: 'SEIFA IRSD',
                body: 'Index of relative socio-economic disadvantage, aggregated from SA1. It describes capacity to respond, not the hazard itself.',
                source: 'SEIFA IRSD',
              }}
            />
            <Stat
              label="Tree canopy"
              value={`${s.treeCanopy}%`}
              sub={`LGA average 14.8%`}
              tip={{
                label: 'Tree canopy',
                body: 'Cover across all tenures. Most of it sits on private land, which limits how much of the deficit council can close directly.',
                source: 'Canopy audit',
              }}
            />
            <Stat label="Green space" value={`${s.greenSpace}%`} sub="of land area" />
            <Stat
              label="Density"
              value={fmtInt(s.densityPerKm2)}
              sub="persons per km2"
            />
          </div>
        </div>
      )}

      {placeTab === 'register' && (
        <div className="px-2.5 py-2.5">
          {realBuildings.length > 0 && (
            <div className="mb-2.5">
              <button
                onClick={() => setShowRealBuildings(!showRealBuildings)}
                className="flex w-full items-center justify-between rounded-[5px] border border-line bg-white px-2 py-1.5 text-left transition-colors hover:border-accent"
              >
                <span className="flex items-center gap-1.5">
                  <IconChevron size={13} className={`text-ink-3 transition-transform ${showRealBuildings ? 'rotate-90' : ''}`} />
                  <span className="text-[12.5px] font-medium text-ink">
                    Real buildings here, {realBuildings.length}
                  </span>
                </span>
                <span className="num text-[11px] text-ink-3">${(realBuildingsValue / 1e6).toFixed(1)}M</span>
              </button>
              {showRealBuildings && (
                <div className="fade-up mt-1 max-h-[280px] space-y-1 overflow-y-auto thin-scroll pr-0.5">
                  {realBuildings.map((b) => (
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
          )}

          <PanelHeading
            right={
              <span className="num text-[11px] text-ink-3">
                {s.assets.length} listed
              </span>
            }
          >
            Illustrative key assets (demo)
          </PanelHeading>
          <div className="space-y-1">
            {s.assets.map((a) => {
              const isOpen = openAsset === a.name;
              const flagged = a.repairs5yr >= 10;
              return (
                <div
                  key={a.name}
                  onMouseEnter={() => setHoveredAsset({ asset: a, suburbId: s.id })}
                  onMouseLeave={() => setHoveredAsset(null)}
                  className={`rounded-[5px] border bg-white transition-colors ${
                    hoveredAsset?.asset.name === a.name
                      ? 'border-accent'
                      : 'border-line'
                  }`}
                >
                  <button
                    onClick={() => setOpenAsset(isOpen ? null : a.name)}
                    className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left"
                  >
                    <IconChevron
                      size={13}
                      className={`mt-[3px] shrink-0 text-ink-3 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] font-semibold leading-tight text-ink">
                        {a.name}
                      </span>
                      <span className="mt-[3px] flex flex-wrap items-center gap-1">
                        <span className="rounded-[3px] bg-surface-2 px-1 text-[11px] text-ink-2">
                          {CATEGORY_LABEL[a.category]}
                        </span>
                        <span className="rounded-[3px] bg-surface-2 px-1 text-[11px] text-ink-2">
                          {SIGNIFICANCE_LABEL[a.significance]}
                        </span>
                        {a.hazards.map((h) => (
                          <HazardChip key={h} hazard={h} small />
                        ))}
                      </span>
                    </span>
                    {a.value && (
                      <span className="num shrink-0 text-[12.5px] font-semibold text-ink-2">
                        {a.value}
                      </span>
                    )}
                  </button>
                  {isOpen && (
                    <div className="fade-up border-t border-line px-2 py-1.5">
                      <DetailRow label="Purpose" value={a.purpose} />
                      <DetailRow label="Who uses it" value={a.users} />
                      <div className="mt-1.5 flex items-center justify-between rounded-[4px] bg-surface-2 px-1.5 py-1">
                        <span className="text-[11.5px] text-ink-2">
                          Reactive repairs, 5 years
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span
                            className="num text-[14.5px] font-semibold"
                            style={{ color: flagged ? '#B45309' : '#14201F' }}
                          >
                            {a.repairs5yr}
                          </span>
                          {flagged && (
                            <span className="rounded-[3px] bg-[#FEF3C7] px-1 text-[11px] font-medium text-[#92400E]">
                              over threshold
                            </span>
                          )}
                        </span>
                      </div>
                      <div className="num mt-1 text-[11px] leading-tight text-ink-3">
                        Threshold applied here is 10 interventions in 5 years, the
                        point at which renewal is usually assessed against
                        continued maintenance. The threshold is a convention, not a
                        rule.
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-2 rounded-[5px] border border-line bg-surface-2 px-2 py-1.5 text-[11.5px] leading-[1.5] text-ink-2">
            Hovering an asset draws a 120m radius at its actual location. Heat
            exposed assets also show a coarse 300m grid preview across the SA2.
          </div>
          <DemoDataNote className="mt-2" />
        </div>
      )}
    </div>
  );
}

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
 * Tab 3. Analysis
 *
 * Two measures, across the seven SA2s carrying data, no ranking imposed. The table carries both
 * raw values so the reader can see what the bars are made of.
 * ------------------------------------------------------------------ */

const COMPARABLE = LAYERS.filter((l) => l.kind !== 'vector');

interface AnalysisTabProps {
  compareA: string;
  compareB: string;
  setCompareA: (id: string) => void;
  setCompareB: (id: string) => void;
}

function LayerSelect({
  value,
  onChange,
  accent,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  accent: string;
  label: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5">
        <span
          className="h-2 w-2 rounded-[2px]"
          style={{ background: accent }}
        />
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-ink-3">
          {label}
        </span>
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-[5px] border border-line bg-white px-1.5 py-[4px] text-[12.5px] text-ink outline-none transition-colors focus:border-accent"
      >
        {(['hazard', 'vulnerability'] as LayerGroup[]).map((g) => (
          <optgroup key={g} label={GROUP_LABEL[g]}>
            {COMPARABLE.filter((l) => l.group === g).map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function AnalysisTab({
  compareA,
  compareB,
  setCompareA,
  setCompareB,
}: AnalysisTabProps) {
  const defA = LAYER_BY_ID[compareA];
  const defB = LAYER_BY_ID[compareB];
  const colA = defA.hi ?? ACCENT;
  const colB = defB.hi ?? '#B45309';

  return (
    <div className="px-2.5 py-2.5">
      <div className="grid grid-cols-1 gap-2">
        <LayerSelect
          label="Layer A"
          value={compareA}
          onChange={setCompareA}
          accent={colA}
        />
        <LayerSelect
          label="Layer B"
          value={compareB}
          onChange={setCompareB}
          accent={colB}
        />
      </div>

      <div className="mt-2.5 rounded-[5px] border border-dashed border-line bg-surface-2 px-2 py-1.5 text-[11px] leading-[1.5] text-ink-3">
        The chart and comparison table for these two layers are in the
        analysis panel on the right.
      </div>

      <div className="mt-2.5 space-y-1.5">
        <div className="rounded-[5px] border border-line bg-surface-2 px-2 py-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
            {defA.name}
          </div>
          <div className="mt-[2px] text-[11.5px] leading-[1.5] text-ink-2">
            {defA.note}
          </div>
          <div className="num mt-1 text-[11px] text-ink-3">
            Unit: {defA.unit} · {defA.source}
          </div>
        </div>
        <div className="rounded-[5px] border border-line bg-surface-2 px-2 py-1.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
            {defB.name}
          </div>
          <div className="mt-[2px] text-[11.5px] leading-[1.5] text-ink-2">
            {defB.note}
          </div>
          <div className="num mt-1 text-[11px] text-ink-3">
            Unit: {defB.unit} · {defB.source}
          </div>
        </div>
      </div>
      <DemoDataNote className="mt-2" />
    </div>
  );
}
/* ------------------------------------------------------------------ *
 * Right analysis panel, shared shell
 *
 * One consistent wrapper for whatever the right side is currently
 * showing, a blueprint, a place's risk profile, or a comparison result.
 * Only ever one of these renders at a time, and only when there is
 * something real to show, an empty analysis panel reserving space for
 * nothing is exactly the clutter this tool has been trying to remove.
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
 * Place analysis panel
 *
 * Risk scores, moved out of the left panel because a score is a
 * judgement about the data, not the data itself, plus a new synthesis
 * this tool did not have before: which of council's own real
 * consequence categories a place's numbers actually connect to, and
 * why. The connections are a small set of transparent rules, not a
 * hidden score, each one names the exact figure that triggered it, and
 * the category names themselves are real, from council's own framework.
 * ------------------------------------------------------------------ */

interface ConsequenceLink {
  categoryId: string;
  reason: string;
}

function consequenceLinksFor(s: Suburb, realBuildingValue: number): ConsequenceLink[] {
  const links: ConsequenceLink[] = [];
  if (s.heatScore >= 4) {
    links.push({
      categoryId: 'community-wellbeing',
      reason: `Heat score ${s.heatScore}/5, among the highest in the LGA.`,
    });
  }
  if (s.floodScore >= 4 || s.coastalScore >= 4) {
    links.push({
      categoryId: 'core-delivery',
      reason: `Flood score ${s.floodScore}/5, coastal score ${s.coastalScore}/5, both feed road and drainage asset condition.`,
    });
  }
  if (realBuildingValue > 0) {
    links.push({
      categoryId: 'financial',
      reason: `$${(realBuildingValue / 1e6).toFixed(1)}M in real council buildings insured value sits here.`,
    });
  }
  if (s.seifa <= 4) {
    links.push({
      categoryId: 'community-wellbeing',
      reason: `SEIFA decile ${s.seifa}/10, lower response capacity if a hazard event lands here.`,
    });
  }
  return links;
}

function PlaceAnalysisPanel({ selectedId }: { selectedId: string | null }) {
  const s = selectedId ? SUBURB_BY_ID[selectedId] : null;

  if (!s) {
    const boundary = selectedId === BEVERLEY_ID ? SA2_BOUNDARY_BY_CODE[BEVERLEY_SA2_CODE] : null;
    const buildingValue = selectedId
      ? (REAL_BUILDINGS_BY_SUBURB[selectedId] ?? []).reduce((n, b) => n + b.insuredValue, 0)
      : 0;
    return (
      <RightPanelShell accent={ACCENT} eyebrow="Analysis" title="No risk profile">
        <div className="px-2.5 py-2">
          <p className="text-[11.5px] leading-[1.55] text-ink-2">
            {boundary
              ? 'Beverley has no sourced hazard score, so there is nothing here to score against council’s consequence categories, only what its real data can support.'
              : 'Select a suburb to see its risk scores and how they connect to council’s consequence categories.'}
          </p>
          {buildingValue > 0 && (
            <div className="mt-2 rounded-[5px] border border-line bg-white px-2 py-1.5">
              <div className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">Financial</div>
              <div className="mt-1 text-[11.5px] text-ink-2">${(buildingValue / 1e6).toFixed(1)}M in real buildings insured value here.</div>
            </div>
          )}
        </div>
      </RightPanelShell>
    );
  }

  const risks: { id: HazardId; label: string; score: number }[] = [
    { id: 'heat', label: 'Heat', score: s.heatScore },
    { id: 'flooding', label: 'Flood', score: s.floodScore },
    { id: 'coastal', label: 'Coastal', score: s.coastalScore },
    { id: 'drought', label: 'Drought', score: s.droughtScore },
  ];
  const buildingValue = (REAL_BUILDINGS_BY_SUBURB[s.id] ?? []).reduce((n, b) => n + b.insuredValue, 0);
  const links = consequenceLinksFor(s, buildingValue);
  const linkedCategoryIds = new Set(links.map((l) => l.categoryId));

  return (
    <RightPanelShell accent={ACCENT} eyebrow="Analysis" title={s.name}>
      <div className="px-2.5 py-2">
        <PanelHeading
          right={
            <Tip
              label="Risk scores"
              body="Relative within this LGA on a 1 to 5 scale, not an absolute or cross-council measure. They combine modelled hazard extent with the sensitivity of what is inside it."
              side="left"
            >
              <span className="cursor-help text-[11px] text-ink-3 underline decoration-dotted">how read</span>
            </Tip>
          }
        >
          Risk scores
        </PanelHeading>
        <div className="mb-3 grid grid-cols-2 gap-1.5">
          {risks.map((r) => (
            <div key={r.id} className="rounded-[5px] border border-line bg-white px-2 py-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[11.5px] uppercase tracking-[0.05em] text-ink-3">{r.label}</span>
                <span className="num text-[14.5px] font-semibold" style={{ color: HAZARD_COLOR[r.id] }}>{r.score}</span>
              </div>
              <div className="mt-1">
                <ScorePips score={r.score} color={HAZARD_COLOR[r.id]} />
              </div>
            </div>
          ))}
        </div>

        <PanelHeading
          right={
            <Tip
              label="Consequence framework"
              body="Council's own draft categories (Value Advisory Partners / The Systems Cooperative, Sept 2026). A category lights up here when a real or modelled figure for this place plausibly connects to it, the connection is a transparent rule shown below the category, not a hidden score, and no tolerance has been set for any of them yet."
              side="left"
            >
              <span className="cursor-help text-[11px] text-ink-3 underline decoration-dotted">how read</span>
            </Tip>
          }
        >
          Consequence relevance
        </PanelHeading>
        <div className="space-y-1">
          {CONSEQUENCE_CATEGORIES.map((c) => {
            const link = links.find((l) => l.categoryId === c.id);
            const on = linkedCategoryIds.has(c.id);
            return (
              <div
                key={c.id}
                className={`rounded-[5px] border px-2 py-1.5 transition-colors ${on ? 'border-accent bg-accent-soft/40' : 'border-line bg-white opacity-60'}`}
              >
                <span className={`text-[11.5px] ${on ? 'font-semibold text-ink' : 'text-ink-3'}`}>{c.name}</span>
                {link && <div className="mt-[3px] text-[10.5px] leading-[1.45] text-ink-2">{link.reason}</div>}
              </div>
            );
          })}
        </div>
        <DemoDataNote className="mt-2.5" />
      </div>
    </RightPanelShell>
  );
}

/* ------------------------------------------------------------------ *
 * Analysis results panel
 *
 * The chart and comparison table moved out of the left Analysis tab,
 * which now only holds the two layer pickers, the config, not the
 * output. Same data, same interaction, just on the side of the screen
 * that is now reserved for what the numbers mean rather than what they
 * are.
 * ------------------------------------------------------------------ */

interface AnalysisResultsPanelProps {
  compareA: string;
  compareB: string;
  year: number;
  sc: Scenario;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  hoveredSuburb: string | null;
  setHoveredSuburb: (id: string | null) => void;
}

function AnalysisResultsPanel({
  compareA,
  compareB,
  year,
  sc,
  selectedId,
  setSelectedId,
  hoveredSuburb,
  setHoveredSuburb,
}: AnalysisResultsPanelProps) {
  const defA = LAYER_BY_ID[compareA];
  const defB = LAYER_BY_ID[compareB];
  const colA = defA.hi ?? ACCENT;
  const colB = defB.hi ?? '#B45309';

  const rows = useMemo(
    () =>
      SUBURBS.map((s) => ({
        s,
        rawA: rawLayerValue(compareA, s, year, sc),
        rawB: rawLayerValue(compareB, s, year, sc),
        normA: normLayerValue(compareA, s, year, sc),
        normB: normLayerValue(compareB, s, year, sc),
      })),
    [compareA, compareB, year, sc],
  );

  const chartH = 118;
  const barW = 7;
  const groupW = 30;

  return (
    <RightPanelShell accent={ACCENT} eyebrow="Analysis" title={`${defA.name} vs ${defB.name}`}>
      <div className="px-2.5 py-2">
        <p className="mb-2 text-[11.5px] leading-[1.5] text-ink-2">
          Bars are scaled within each measure separately, so heights compare
          across suburbs but not across the two measures. The map shows A at
          full opacity with B at 40 percent over it.
        </p>

        <div className="rounded-[6px] border border-line bg-white p-2">
          <svg width="100%" viewBox={`0 0 ${groupW * SUBURBS.length + 8} ${chartH + 30}`} className="overflow-visible">
            {[0, 0.25, 0.5, 0.75, 1].map((g) => (
              <line
                key={g}
                x1={0}
                x2={groupW * SUBURBS.length + 8}
                y1={chartH - g * chartH}
                y2={chartH - g * chartH}
                stroke="#EDF1F1"
                strokeWidth={1}
              />
            ))}
            {rows.map((r, i) => {
              const x = i * groupW + 6;
              const hA = Math.max(2, r.normA * chartH);
              const hB = Math.max(2, r.normB * chartH);
              const active = hoveredSuburb === r.s.id || selectedId === r.s.id;
              return (
                <g
                  key={r.s.id}
                  onMouseEnter={() => setHoveredSuburb(r.s.id)}
                  onMouseLeave={() => setHoveredSuburb(null)}
                  onClick={() => setSelectedId(r.s.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <rect x={x - 5} y={0} width={groupW - 2} height={chartH + 26} fill={active ? 'rgba(0,110,120,0.06)' : 'transparent'} />
                  <rect x={x} y={chartH - hA} width={barW} height={hA} rx={1.5} fill={colA} opacity={active ? 1 : 0.86} />
                  <rect x={x + barW + 2} y={chartH - hB} width={barW} height={hB} rx={1.5} fill={colB} opacity={active ? 1 : 0.86} />
                  <text x={x + barW} y={chartH + 10} textAnchor="middle" fontSize={12} fontFamily="JetBrains Mono, monospace" fill={active ? '#14201F' : '#7E8D8C'}>
                    {r.s.name.split('-')[0].slice(0, 8)}
                  </text>
                  <text x={x + barW} y={chartH + 19} textAnchor="middle" fontSize={12} fontFamily="JetBrains Mono, monospace" fill="#A8B5B4">
                    {r.s.sa2.slice(-4)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        <div className="mt-2 overflow-hidden rounded-[6px] border border-line bg-white">
          <div className="flex items-center gap-1.5 border-b border-line bg-surface-2 px-2 py-1">
            <span className="flex-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Suburb</span>
            <span className="num w-[64px] text-right text-[11px] font-semibold text-ink-3">A</span>
            <span className="num w-[64px] text-right text-[11px] font-semibold text-ink-3">B</span>
          </div>
          {rows.map((r) => {
            const active = hoveredSuburb === r.s.id || selectedId === r.s.id;
            return (
              <button
                key={r.s.id}
                onMouseEnter={() => setHoveredSuburb(r.s.id)}
                onMouseLeave={() => setHoveredSuburb(null)}
                onClick={() => setSelectedId(r.s.id)}
                className={`flex w-full items-center gap-1.5 border-b border-line px-2 py-1 text-left last:border-b-0 ${active ? 'bg-accent-soft/40' : 'hover:bg-surface-2'}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-ink">{r.s.name}</span>
                  <span className="mt-[3px] flex gap-[3px]">
                    <span className="w-1/2"><MiniBar value={r.normA} color={colA} height={3} /></span>
                    <span className="w-1/2"><MiniBar value={r.normB} color={colB} height={3} /></span>
                  </span>
                </span>
                <span className="num w-[64px] shrink-0 text-right text-[12.5px] font-semibold text-ink">
                  {formatLayerValue(compareA, r.rawA)}
                </span>
                <span className="num w-[64px] shrink-0 text-right text-[12.5px] font-semibold text-ink">
                  {formatLayerValue(compareB, r.rawB)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </RightPanelShell>
  );
}



/* ------------------------------------------------------------------ *
 * Tab. Help
 * ------------------------------------------------------------------ */

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
            Turn on a hazard layer in Layers, or load a blueprint to get a
            curated set in one click. Click a suburb on the map to open its
            profile in Place.
          </p>
          <p className="mt-1.5">
            The timeline at the bottom steps the year. Steps only appear for
            datasets that have a time series. Everything else says so rather
            than interpolating a year it cannot support.
          </p>
          <p className="mt-1.5">
            Hover anything. Layer names, stat tiles and assets all carry a
            rollover with the definition, the source and the caveat.
          </p>
        </>,
      )}
      {section(
        'layout',
        'Data on the left, analysis on the right',
        <>
          <p>
            The left panel only ever holds data: layer definitions, a
            place's population and register entries, an asset's address
            and condition. Nothing there ranks, scores, or tells you what
            a number means, it is what was measured or recorded.
          </p>
          <p className="mt-1.5">
            Judgement lives on the right, in a panel that only opens when
            there is something to show, a suburb's risk scores and which
            of council's consequence categories they touch, or a
            comparison's chart and table. It closes and gives the map
            that width back the moment there is nothing to analyse.
          </p>
        </>,
      )}
      {section(
        'tabs',
        'What each tab does',
        <ul className="space-y-1.5">
          <li>
            <span className="font-semibold text-ink">Layers.</span> The full
            hazard, vulnerability and overlay catalogue, plus the real
            building toggles under Assets. Global opacity at the top,
            per-layer opacity on hover.
          </li>
          <li>
            <span className="font-semibold text-ink">Place.</span> One SA2 at
            a time, its population, demographics and real buildings
            register. Its risk scores and consequence relevance open on
            the right once selected.
          </li>
          <li>
            <span className="font-semibold text-ink">Analysis.</span> Pick
            two measures here, the comparison chart and table open on the
            right. Opening this tab also puts the map into compare mode.
          </li>
        </ul>,
      )}
      {section(
        'scale',
        'SA2 vs SA1 boundaries',
        <>
          <p>
            SA2 is the suburb scale, eight real ABS areas across the LGA.
            SA1 is finer and uneven, 257 real areas across those same eight,
            from 14 up to 46 per SA2 depending on how built-up it is. Both
            boundary sets are the exact ABS ASGS 2021 shapes, not a
            simplified stand-in for them.
          </p>
          <p className="mt-1.5">
            SA1 is the scale at which disadvantage and canopy actually vary,
            an SA2 average can sit well above or below what any one pocket
            inside it looks like. No hazard or demographic layer in this
            tool is modelled at SA1 resolution yet, so the SA1 view shows
            boundaries only, tinted by which SA2 each one belongs to.
            Nothing about that tint is a measurement.
          </p>
        </>,
      )}
      {section(
        'projection',
        'Projection bar',
        <>
          <p>
            The scenario toggle switches between SSP2-4.5 and SSP5-8.5. These
            are emissions pathways, not forecasts, and both are plausible.
          </p>
          <p className="mt-1.5">
            {SCENARIO_LABEL.ssp245}: {SCENARIO_NOTE.ssp245}
            <br />
            {SCENARIO_LABEL.ssp585}: {SCENARIO_NOTE.ssp585}
          </p>
          <p className="mt-1.5">
            Scenario choice moves the 2041 population figure by up to 6 percent
            across the LGA. It does not change which suburbs rank highest, so
            if a decision flips on the scenario, the difference is probably
            inside the noise.
          </p>
          <p className="mt-1.5">
            Year steps differ by dataset. Population and employment step 2021,
            2031, 2041. Heat vulnerability adds 2036. Flood modelling only has
            2021 and 2041. Changing the active dataset snaps the year to the
            nearest step it supports.
          </p>
        </>,
      )}
      {section(
        'consequence',
        'Consequence framework',
        <>
          <p>
            Council's own draft framework for what a hazard actually
            costs, seven categories, shared via project correspondence
            between Value Advisory Partners and The Systems Cooperative
            in September 2026. The category names and metrics below are
            real. The thresholds that would turn a metric into a pass or
            fail are not, they were still being workshopped when this was
            shared, so they show here as an open gap rather than a
            guessed number.
          </p>
          <div className="mt-2 space-y-1.5">
            {CONSEQUENCE_CATEGORIES.map((c) => (
              <div key={c.id} className="rounded-[5px] border border-line bg-white px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11.5px] font-semibold text-ink">{c.name}</span>
                  <span className="rounded-[3px] bg-[#FDF9EF] px-1 text-[9.5px] font-medium text-[#7A6634]">
                    tolerance not yet set
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.metrics.map((m) => (
                    <span key={m} className="rounded-[3px] bg-surface-2 px-1 text-[10.5px] text-ink-2">
                      {m}
                    </span>
                  ))}
                </div>
                {c.mapsToPrepare && (
                  <div className="mt-1.5 text-[10.5px] leading-[1.5] text-ink-3">
                    <span className="font-semibold text-ink-2">Maps to prepare: </span>
                    {c.mapsToPrepare.join(', ')}
                    {c.mapsToPrepare.some((m) => /road hierarchy|traffic|conditions|canopy/i.test(m)) && (
                      <span className="text-[#B45309]">
                        {' '}
                        — road hierarchy, traffic, condition and canopy are not yet in this tool,
                        real SA road hierarchy data exists at data.sa.gov.au and has not been pulled in yet.
                      </span>
                    )}
                  </div>
                )}
                {c.provocation && (
                  <div className="mt-1 text-[10.5px] leading-[1.5] text-ink-3">
                    <span className="font-semibold text-ink-2">Provocation for services: </span>
                    {c.provocation}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>,
      )}
      {section(
        'sources',
        'Data sources and thresholds',
        <>
          <DemoDataNote className="mb-2" />
          <p>
            Every layer carries its source on rollover. The consequence
            thresholds used in this tool are conventions, and they are visible
            rather than buried:
          </p>
          <ul className="mt-1.5 space-y-1">
            <li>
              <span className="font-semibold text-ink">Asset renewal.</span> Ten
              or more reactive interventions in five years flags an asset for
              renewal assessment against continued maintenance.
            </li>
            <li>
              <span className="font-semibold text-ink">Capacity gap.</span>
              {' '}Zoned ceiling minus projected dwellings. Negative means the
              projection cannot be delivered under the current code.
            </li>
            <li>
              <span className="font-semibold text-ink">Risk scores.</span> A 1
              to 5 scale, relative within this LGA only. Not comparable with
              another council's scores.
            </li>
            <li>
              <span className="font-semibold text-ink">SEIFA.</span> National
              decile. 1 is most disadvantaged, and the ramp darkens toward 1.
            </li>
          </ul>
          <p className="mt-1.5">
            No analytics are collected. Nothing you click here is recorded.
          </p>
        </>,
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Blueprint panel
 *
 * Overlays the right edge of the map whenever a blueprint is active. It
 * is a reading aid for the layer set, so it reports what the data shows
 * and names the tensions without resolving them.
 * ------------------------------------------------------------------ */

/** Asset values are stored pre-formatted. This reads them back as numbers. */
function assetValueM(a: Asset): number {
  if (!a.value) return 0;
  const n = parseFloat(a.value.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function exposedValueM(s: Suburb): number {
  return s.assets
    .filter((a) => a.hazards.length > 0)
    .reduce((n, a) => n + assetValueM(a), 0);
}

function rankValue(metric: string, s: Suburb, year: number, sc: Scenario): number {
  switch (metric) {
    case 'floodScore':
      return rawLayerValue('flood-100', s, year, sc);
    case 'heatScore':
      return rawLayerValue('heat-vuln', s, year, sc);
    case 'growth':
      return growthPct(s, sc);
    case 'assets':
      return exposedValueM(s);
    case 'zonedGrossDensity':
      return PLANNING[s.id].zonedGrossDensity;
    case 'employmentScore':
      return rawLayerValue('employment', s, year, sc);
    case 'pop-count':
      return dwellingsAt(s.id, year, sc);
    case 'pop-growth':
      return growthPct(s, sc);
    case 'pop-density':
      return s.densityPerKm2;
    case 'pop-gap':
      return capacityGap(s.id, year, sc);
    default:
      return 0;
  }
}

function rankLabel(metric: string, v: number): string {
  switch (metric) {
    case 'floodScore':
      return fmtPct(v, 1);
    case 'heatScore':
      return v.toFixed(0);
    case 'growth':
      return fmtSigned(v, 0);
    case 'assets':
      return `$${v.toFixed(1)}M`;
    case 'zonedGrossDensity':
      return `${v} du/ha`;
    case 'employmentScore':
    case 'pop-count':
    case 'pop-gap':
    case 'pop-density':
      return fmtInt(v);
    case 'pop-growth':
      return fmtSigned(v, 0);
    default:
      return String(v);
  }
}

const RANK_TITLE: Record<string, string> = {
  floodScore: 'Modelled 1:100yr extent',
  heatScore: 'Heat vulnerability index',
  growth: 'Projected growth to 2041',
  assets: 'Exposed asset value',
  zonedGrossDensity: 'Zoned gross density',
  employmentScore: 'Jobs reachable in 30 min',
  'pop-count': 'Dwellings at the selected horizon',
  'pop-growth': 'Population growth to 2041',
  'pop-density': 'Residents per km2',
  'pop-gap': 'Capacity gap under current zoning',
};

interface GlanceStat {
  label: string;
  value: string;
  sub: string;
}

function glanceFor(
  bp: Blueprint,
  year: number,
  sc: Scenario,
): GlanceStat[] {
  const allAssets = SUBURBS.flatMap((s) => s.assets);
  switch (bp.id) {
    case 'flood-risk': {
      const exposed = allAssets.filter((a) => a.hazards.includes('flooding'));
      const overThreshold = allAssets.filter(
        (a) => a.category === 'stormwater' && a.repairs5yr >= 10,
      );
      const worst = [...SUBURBS].sort((a, b) => b.floodScore - a.floodScore)[0];
      return [
        {
          label: 'Assets in extent',
          value: `${exposed.length}`,
          sub: `of ${allAssets.length} listed, $${exposed.reduce((n, a) => n + assetValueM(a), 0).toFixed(0)}M`,
        },
        {
          label: 'Drains over threshold',
          value: `${overThreshold.length}`,
          sub: '10 or more repairs in 5 years',
        },
        {
          label: 'Largest extent',
          value: fmtPct(rawLayerValue('flood-100', worst, year, sc), 1),
          sub: worst.name,
        },
      ];
    }
    case 'heat-vuln': {
      const avgCanopy =
        SUBURBS.reduce((n, s) => n + s.treeCanopy, 0) / SUBURBS.length;
      const lowestCanopy = [...SUBURBS].sort(
        (a, b) => a.treeCanopy - b.treeCanopy,
      )[0];
      const worst = [...SUBURBS].sort(
        (a, b) =>
          rawLayerValue('heat-vuln', b, year, sc) -
          rawLayerValue('heat-vuln', a, year, sc),
      )[0];
      return [
        {
          label: 'LGA canopy',
          value: fmtPct(avgCanopy, 1),
          sub: `mean across the ${SUBURBS.length} SA2s with data`,
        },
        {
          label: 'Lowest canopy',
          value: fmtPct(lowestCanopy.treeCanopy, 0),
          sub: lowestCanopy.name,
        },
        {
          label: `Peak index ${year}`,
          value: rawLayerValue('heat-vuln', worst, year, sc).toFixed(0),
          sub: worst.name,
        },
      ];
    }
    case 'population': {
      const now = SUBURBS.reduce((n, s) => n + popAt(s, year, sc), 0);
      const base = SUBURBS.reduce((n, s) => n + s.pop2021, 0);
      const gap = SUBURBS.reduce((n, s) => n + capacityGap(s.id, 2041, sc), 0);
      return [
        {
          label: `Residents ${year}`,
          value: fmtInt(now),
          sub: `${fmtSigned((now / base - 1) * 100, 1)} on 2021`,
        },
        {
          label: 'Zoned headroom 2041',
          value: fmtInt(gap),
          sub: 'dwellings under the current code',
        },
        {
          label: 'SA2s with no headroom',
          value: `${SUBURBS.filter((s) => capacityGap(s.id, 2041, sc) < 0).length}`,
          sub: 'zoning has to move or growth will not land',
        },
      ];
    }
    case 'infrastructure': {
      const exposed = allAssets.filter((a) => a.hazards.length > 0);
      const over = allAssets.filter((a) => a.repairs5yr >= 10);
      const state = allAssets.filter((a) => a.significance === 'state');
      return [
        {
          label: 'Exposed portfolio',
          value: `$${exposed.reduce((n, a) => n + assetValueM(a), 0).toFixed(0)}M`,
          sub: `${exposed.length} assets with at least one hazard`,
        },
        {
          label: 'Over repair threshold',
          value: `${over.length}`,
          sub: '10 or more interventions in 5 years',
        },
        {
          label: 'State significant',
          value: `${state.length}`,
          sub: 'consequences beyond the LGA boundary',
        },
      ];
    }
    case 'land-use': {
      const ceiling = SUBURBS.reduce((n, s) => n + zonedCapacity(s.id), 0);
      const built = SUBURBS.reduce((n, s) => n + PLANNING[s.id].dwellings2021, 0);
      const top = [...SUBURBS].sort(
        (a, b) =>
          PLANNING[b.id].zonedGrossDensity - PLANNING[a.id].zonedGrossDensity,
      )[0];
      return [
        {
          label: 'Zoned ceiling',
          value: fmtInt(ceiling),
          sub: 'dwellings permitted under the code',
        },
        {
          label: 'Take-up',
          value: fmtPct((built / ceiling) * 100, 0),
          sub: 'built against the ceiling today',
        },
        {
          label: 'Highest density zone',
          value: `${PLANNING[top.id].zonedGrossDensity} du/ha`,
          sub: top.name,
        },
      ];
    }
    case 'transport': {
      const vals = SUBURBS.map((s) => rawLayerValue('employment', s, year, sc));
      const best = [...SUBURBS].sort(
        (a, b) =>
          rawLayerValue('employment', b, year, sc) -
          rawLayerValue('employment', a, year, sc),
      );
      return [
        {
          label: 'Best access',
          value: fmtInt(Math.max(...vals)),
          sub: `jobs in 30 min, ${best[0].name}`,
        },
        {
          label: 'Weakest access',
          value: fmtInt(Math.min(...vals)),
          sub: `jobs in 30 min, ${best[best.length - 1].name}`,
        },
        {
          label: 'Spread',
          value: `${(Math.max(...vals) / Math.min(...vals)).toFixed(1)}x`,
          sub: 'between the best and weakest SA2',
        },
      ];
    }
    default:
      return [];
  }
}

interface BlueprintPanelProps {
  blueprint: Blueprint;
  onClose: () => void;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  setHoveredSuburb: (id: string | null) => void;
  year: number;
  sc: Scenario;
  planMetric: PlanMetric;
  setPlanMetric: (m: PlanMetric) => void;
  planYear: number;
  setPlanYear: (y: number) => void;
  onOpenQuadrant: () => void;
}

function BlueprintPanel({
  blueprint,
  onClose,
  selectedId,
  setSelectedId,
  setHoveredSuburb,
  year,
  sc,
  planMetric,
  setPlanMetric,
  planYear,
  setPlanYear,
  onOpenQuadrant,
}: BlueprintPanelProps) {
  const bp = blueprint;
  const isPop = bp.id === 'population';
  const selected = selectedId ? SUBURB_BY_ID[selectedId] : null;
  const glance = useMemo(() => glanceFor(bp, year, sc), [bp, year, sc]);

  // The population blueprint reranks on whichever metric the toggle is set
  // to, since the four metrics answer genuinely different questions.
  const rankKey = isPop ? "pop-" + planMetric : bp.rank;

  const ranked = useMemo(() => {
    const rows = SUBURBS.map((s) => ({
      s,
      v: rankValue(rankKey, s, isPop ? planYear : year, sc),
    }));
    rows.sort((a, b) => b.v - a.v);
    const max = Math.max(...rows.map((r) => Math.abs(r.v)), 1);
    return { rows, max };
  }, [rankKey, year, sc, isPop, planYear]);

  const plan = selected ? PLANNING[selected.id] : null;
  const [tab, setTab] = useState<'overview' | 'spotlight' | 'ranking'>('overview');

  // Picking a suburb, on the map or from Ranking, is a request to look at
  // it, not to keep browsing whatever tab happened to be open. Jump to
  // Spotlight so the click actually shows something instead of updating
  // a tab nobody is looking at.
  useEffect(() => {
    if (selectedId) setTab('spotlight');
  }, [selectedId]);

  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-white shadow-[-4px_0_18px_rgba(20,32,31,0.06)]">
      <header className="flex items-start gap-1.5 border-b border-line px-2.5 py-2">
        <span
          className="mt-[5px] h-2 w-2 shrink-0 rounded-full"
          style={{ background: bp.accent }}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">
            Blueprint
          </div>
          <div
            className="truncate text-[15px] font-semibold leading-tight"
            style={{ color: bp.accent }}
          >
            {bp.title}
          </div>
        </div>
        <button
          onClick={onClose}
          className="mt-[2px] shrink-0 rounded-[4px] p-[3px] text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          aria-label="Close blueprint"
        >
          <IconClose />
        </button>
      </header>

      <SubTabStrip
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'spotlight', label: 'Spotlight', count: selected ? '1' : undefined },
          { value: 'ranking', label: 'Ranking' },
        ]}
        value={tab}
        onChange={setTab}
        accent={bp.accent}
      />

      <div className="thin-scroll flex-1 overflow-y-auto">
        {tab === 'overview' && (
          <>
            <p className="border-b border-line px-2.5 py-2 text-[12px] leading-[1.55] text-ink-2">
              {bp.description}
            </p>

            {isPop && (
              <div className="border-b border-line px-2.5 py-2">
                <PanelHeading>Metric</PanelHeading>
                <Segmented
                  dense
                  accent={bp.accent}
                  value={planMetric}
                  onChange={setPlanMetric}
                  options={[
                    { value: 'count' as PlanMetric, label: 'Count' },
                    { value: 'growth' as PlanMetric, label: 'Growth' },
                    { value: 'density' as PlanMetric, label: 'Density' },
                    { value: 'gap' as PlanMetric, label: 'Gap' },
                  ]}
                />
                <div className="mt-2">
                  <PanelHeading>Horizon</PanelHeading>
                  <Segmented
                    dense
                    accent={bp.accent}
                    value={planYear}
                    onChange={setPlanYear}
                    options={[
                      { value: 2021, label: 'Baseline' },
                      { value: 2031, label: '2031' },
                      { value: 2041, label: '2041' },
                    ]}
                  />
                </div>
              </div>
            )}

            <div className="px-2.5 py-2">
              <PanelHeading>LGA at a glance</PanelHeading>
              <div className="space-y-1">
                {glance.map((g) => (
                  <div
                    key={g.label}
                    className="flex items-start justify-between gap-2 rounded-[5px] border border-line bg-white px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11.5px] uppercase tracking-[0.05em] text-ink-3">
                        {g.label}
                      </span>
                      <span className="mt-[2px] block text-[11px] leading-tight text-ink-3">
                        {g.sub}
                      </span>
                    </span>
                    <span
                      className="num shrink-0 text-[17px] font-semibold leading-none"
                      style={{ color: bp.accent }}
                    >
                      {g.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {tab === 'spotlight' && (!selected ? (
          <div className="px-2.5 py-3 text-center text-[12px] leading-[1.6] text-ink-3">
            Select a suburb on the map, or from Ranking, to see its detail
            here.
          </div>
        ) : (
          <div className="px-2.5 py-2">
            <PanelHeading
              right={
                <button
                  onClick={() => setSelectedId(null)}
                  className="text-[11px] text-ink-3 underline decoration-dotted hover:text-ink"
                >
                  clear
                </button>
              }
            >
              Spotlight
            </PanelHeading>
            <div className="text-[14px] font-semibold text-ink">
              {selected.name}
            </div>
            <div className="num text-[11.5px] text-ink-3">SA2 {selected.sa2}</div>

            {isPop && plan ? (
              <div className="mt-1.5">
                <div className="grid grid-cols-2 gap-1.5">
                  <Stat
                    label="Dwellings"
                    value={fmtInt(dwellingsAt(selected.id, planYear, sc))}
                    sub={`${planYear} ${SCENARIO_LABEL[sc]}`}
                  />
                  <Stat
                    label="Zoned max"
                    value={fmtInt(zonedCapacity(selected.id))}
                    sub={`${plan.zonedGrossDensity} du/ha ceiling`}
                  />
                  <Stat
                    label="Capacity gap"
                    value={fmtInt(capacityGap(selected.id, planYear, sc))}
                    tone={
                      capacityGap(selected.id, planYear, sc) < 0
                        ? 'warn'
                        : 'default'
                    }
                    sub="ceiling minus projected"
                  />
                  <Stat
                    label="CAGR"
                    value={fmtPct(
                      cagr(
                        plan.dwellings2021,
                        plan.dwellings2041[sc],
                        20,
                      ),
                      2,
                    )}
                    sub="dwellings, 2021 to 2041"
                  />
                </div>
                <div className="mt-1.5 rounded-[5px] border border-line bg-white px-2 py-1.5">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11.5px] uppercase tracking-[0.05em] text-ink-3">
                      Trajectory
                    </span>
                    <span className="num text-[11px] text-ink-3">
                      {fmtInt(selected.densityPerKm2)} per km2
                    </span>
                  </div>
                  <Sparkline
                    values={[
                      plan.dwellings2021,
                      plan.dwellings2031[sc],
                      plan.dwellings2041[sc],
                    ]}
                    labels={['2021', '2031', '2041']}
                    color={bp.accent}
                  />
                </div>
                <div className="mt-1.5 text-[11.5px] leading-[1.5] text-ink-3">
                  {plan.zoningLabel}. Zoned capacity is a ceiling, not a
                  forecast.
                </div>
              </div>
            ) : (
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                {relevantRisks(bp.id).map((r) => {
                  const score =
                    r === 'heat'
                      ? selected.heatScore
                      : r === 'flooding'
                        ? selected.floodScore
                        : r === 'coastal'
                          ? selected.coastalScore
                          : selected.droughtScore;
                  return (
                    <div
                      key={r}
                      className="rounded-[5px] border border-line bg-white px-2 py-1.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11.5px] uppercase tracking-[0.05em] text-ink-3">
                          {HAZARD_LABEL[r].split(' ')[0]}
                        </span>
                        <span
                          className="num text-[14.5px] font-semibold"
                          style={{ color: HAZARD_COLOR[r] }}
                        >
                          {score}
                        </span>
                      </div>
                      <div className="mt-1">
                        <ScorePips score={score} color={HAZARD_COLOR[r]} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-2">
              <PanelHeading>Related assets</PanelHeading>
              <div className="space-y-1">
                {relatedAssets(bp.id, selected).map((a) => (
                  <div
                    key={a.name}
                    className="rounded-[5px] border border-line bg-white px-2 py-1"
                  >
                    <div className="flex items-baseline justify-between gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
                        {a.name}
                      </span>
                      {a.value && (
                        <span className="num shrink-0 text-[11.5px] text-ink-3">
                          {a.value}
                        </span>
                      )}
                    </div>
                    <div className="mt-[3px] flex flex-wrap gap-1">
                      {a.hazards.map((h) => (
                        <HazardChip key={h} hazard={h} small />
                      ))}
                      {a.repairs5yr >= 10 && (
                        <span className="rounded-[3px] bg-[#FEF3C7] px-1 text-[11px] font-medium text-[#92400E]">
                          {a.repairs5yr} repairs
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}

        {tab === 'overview' && (
          <div className="border-t border-line px-2.5 py-2">
            <PanelHeading>Watch for</PanelHeading>
            <ol className="space-y-1.5">
              {bp.watch.map((w, i) => (
                <li key={i} className="flex gap-1.5">
                  <span
                    className="num mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                    style={{
                      background: withAlpha(bp.accent, 0.12),
                      color: bp.accent,
                    }}
                  >
                    {i + 1}
                  </span>
                  <span className="text-[11.5px] leading-[1.5] text-ink-2">{w}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {tab === 'ranking' && (
        <div className="px-2.5 py-2">
          <PanelHeading
            right={
              <span className="text-[11px] text-ink-3">
                {RANK_TITLE[rankKey]}
              </span>
            }
          >
            Suburb ranking
          </PanelHeading>
          <div className="space-y-[3px]">
            {ranked.rows.map((r, i) => {
              const on = selectedId === r.s.id;
              return (
                <button
                  key={r.s.id}
                  onClick={() => setSelectedId(r.s.id)}
                  onMouseEnter={() => setHoveredSuburb(r.s.id)}
                  onMouseLeave={() => setHoveredSuburb(null)}
                  className={`w-full rounded-[4px] px-1.5 py-1 text-left transition-colors ${on ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
                >
                  <div className="flex items-baseline gap-1.5">
                    <span className="num w-[13px] shrink-0 text-[11px] text-ink-3">
                      {i + 1}
                    </span>
                    <span
                      className={`min-w-0 flex-1 truncate text-[12px] ${on ? 'font-semibold text-ink' : 'text-ink-2'}`}
                    >
                      {r.s.name}
                    </span>
                    <span className="num shrink-0 text-[12px] font-semibold text-ink">
                      {rankLabel(rankKey, r.v)}
                    </span>
                  </div>
                  <div className="mt-[3px] pl-[15px]">
                    <MiniBar
                      value={r.v / ranked.max}
                      color={bp.accent}
                      height={3}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        )}
      </div>

      <footer className="border-t border-line px-2.5 py-2">
        {isPop && (
          <button
            onClick={onOpenQuadrant}
            className="mb-1.5 w-full rounded-[5px] border px-2 py-1.5 text-[12.5px] font-semibold transition-colors"
            style={{ borderColor: bp.accent, color: bp.accent }}
          >
            Density quadrant
          </button>
        )}
        <div className="text-[11px] leading-[1.45] text-ink-3">
          {SCENARIO_LABEL[sc]}. {SCENARIO_NOTE[sc]} Scenario changes the
          magnitude, not the ranking.
        </div>
      </footer>
    </aside>
  );
}

/** Hazards worth showing in the spotlight for a given blueprint. */
function relevantRisks(id: BlueprintId): HazardId[] {
  switch (id) {
    case 'flood-risk':
      return ['flooding', 'coastal'];
    case 'heat-vuln':
      return ['heat', 'drought'];
    case 'infrastructure':
      return ['flooding', 'heat'];
    case 'land-use':
      return ['flooding', 'heat'];
    case 'transport':
      return ['heat', 'flooding'];
    default:
      return ['heat', 'flooding'];
  }
}

function relatedAssets(id: BlueprintId, s: Suburb): Asset[] {
  const wanted = relevantRisks(id);
  const matches = s.assets.filter((a) =>
    a.hazards.some((h) => wanted.includes(h)),
  );
  return (matches.length ? matches : s.assets).slice(0, 4);
}

/** Three point trend line. Enough to show direction without implying precision. */
function Sparkline({
  values,
  labels,
  color,
}: {
  values: number[];
  labels: string[];
  color: string;
}) {
  const w = 200;
  const h = 34;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const range = hi - lo || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (w - 8) + 4;
    const y = h - 6 - ((v - lo) / range) * (h - 14);
    return [x, y] as const;
  });
  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <polyline
          points={pts.map((p) => p.join(',')).join(' ')}
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {pts.map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r={2.2} fill={color} />
        ))}
      </svg>
      <div className="num mt-[2px] flex justify-between text-[11px] text-ink-3">
        {values.map((v, i) => (
          <span key={i}>
            {labels[i]} {fmtInt(v)}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Density quadrant
 *
 * Zoned ceiling against projected growth. The quadrant labels describe
 * the position, not what to do about it.
 * ------------------------------------------------------------------ */

function PlanningQuadrant({
  onClose,
  sc,
  selectedId,
  setSelectedId,
}: {
  onClose: () => void;
  sc: Scenario;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
}) {
  const pts = SUBURBS.map((s) => ({
    s,
    x: PLANNING[s.id].zonedGrossDensity,
    y:
      (PLANNING[s.id].dwellings2041[sc] / PLANNING[s.id].dwellings2021 - 1) *
      100,
    gap: capacityGap(s.id, 2041, sc),
  }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const xMid = (Math.min(...xs) + Math.max(...xs)) / 2;
  const yMid = (Math.min(...ys) + Math.max(...ys)) / 2;
  const xLo = Math.min(...xs) - 4;
  const xHi = Math.max(...xs) + 4;
  const yLo = Math.min(...ys) - 4;
  const yHi = Math.max(...ys) + 4;

  const W = 620;
  const H = 400;
  const px = (v: number) => ((v - xLo) / (xHi - xLo)) * (W - 70) + 52;
  const py = (v: number) => H - 40 - ((v - yLo) / (yHi - yLo)) * (H - 70);

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-[#0C1918]/55 p-5 backdrop-blur-[2px]">
      <div className="fade-up flex max-h-full w-full max-w-[760px] flex-col overflow-hidden rounded-[8px] border border-line bg-white shadow-[0_18px_50px_rgba(12,25,24,0.3)]">
        <header className="flex items-start justify-between border-b border-line px-3 py-2">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">
              Population &amp; Growth
            </div>
            <div className="text-[17px] font-semibold text-ink">
              Density quadrant
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-[4px] p-1 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
            aria-label="Close quadrant"
          >
            <IconClose size={16} />
          </button>
        </header>
        <div className="thin-scroll flex-1 overflow-y-auto p-3">
          <p className="mb-2 text-[12.5px] leading-[1.55] text-ink-2">
            Zoned gross density on the horizontal axis against projected
            dwelling growth to 2041 on the vertical. Dividing lines sit at the
            midpoint of each range, so quadrant membership is relative to this
            LGA and to nothing else. A suburb high on growth and low on zoned
            density is being asked to absorb more than its code currently
            allows.
          </p>
          <svg width="100%" viewBox={`0 0 ${W} ${H}`}>
            <rect x={52} y={20} width={W - 70} height={H - 60} fill="#F9FBFB" />
            <line
              x1={px(xMid)}
              x2={px(xMid)}
              y1={20}
              y2={H - 40}
              stroke="#D3DCDB"
              strokeDasharray="4 3"
            />
            <line
              x1={52}
              x2={W - 18}
              y1={py(yMid)}
              y2={py(yMid)}
              stroke="#D3DCDB"
              strokeDasharray="4 3"
            />
            {[
              { x: 62, y: 34, t: 'Low ceiling, high growth' },
              { x: px(xMid) + 10, y: 34, t: 'High ceiling, high growth' },
              { x: 62, y: H - 50, t: 'Low ceiling, low growth' },
              { x: px(xMid) + 10, y: H - 50, t: 'High ceiling, low growth' },
            ].map((q) => (
              <text
                key={q.t}
                x={q.x}
                y={q.y}
                fontSize={12}
                fill="#A8B5B4"
                fontFamily="DM Sans, sans-serif"
              >
                {q.t}
              </text>
            ))}
            {pts.map((p) => {
              const on = selectedId === p.s.id;
              const tight = p.gap < 0;
              return (
                <g
                  key={p.s.id}
                  onClick={() => setSelectedId(p.s.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <circle
                    cx={px(p.x)}
                    cy={py(p.y)}
                    r={on ? 8 : 6}
                    fill={tight ? '#B45309' : ACCENT}
                    fillOpacity={on ? 1 : 0.82}
                    stroke="#fff"
                    strokeWidth={1.5}
                  />
                  <text
                    x={px(p.x) + 11}
                    y={py(p.y) + 3.5}
                    fontSize={12}
                    fontFamily="DM Sans, sans-serif"
                    fill={on ? '#14201F' : '#4A5A59'}
                    fontWeight={on ? 600 : 400}
                  >
                    {p.s.name}
                  </text>
                </g>
              );
            })}
            <text x={52} y={H - 14} fontSize={12} fill="#7E8D8C" fontFamily="JetBrains Mono, monospace">
              {xLo.toFixed(0)} du/ha
            </text>
            <text
              x={W - 18}
              y={H - 14}
              fontSize={12}
              textAnchor="end"
              fill="#7E8D8C"
              fontFamily="JetBrains Mono, monospace"
            >
              {xHi.toFixed(0)} du/ha
            </text>
            <text
              x={10}
              y={28}
              fontSize={12}
              fill="#7E8D8C"
              fontFamily="JetBrains Mono, monospace"
            >
              {yHi.toFixed(0)}%
            </text>
            <text
              x={10}
              y={H - 42}
              fontSize={12}
              fill="#7E8D8C"
              fontFamily="JetBrains Mono, monospace"
            >
              {yLo.toFixed(0)}%
            </text>
          </svg>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {pts
              .slice()
              .sort((a, b) => a.gap - b.gap)
              .map((p) => (
                <button
                  key={p.s.id}
                  onClick={() => setSelectedId(p.s.id)}
                  className={`flex items-center justify-between rounded-[5px] border px-2 py-1.5 text-left transition-colors ${
                    selectedId === p.s.id
                      ? 'border-accent bg-accent-soft/40'
                      : 'border-line hover:border-accent'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-ink">
                      {p.s.name}
                    </span>
                    <span className="num block text-[11px] text-ink-3">
                      {p.x} du/ha · {fmtSigned(p.y, 1)} dwellings
                    </span>
                  </span>
                  <span
                    className="num shrink-0 text-[14.5px] font-semibold"
                    style={{ color: p.gap < 0 ? '#B45309' : '#14201F' }}
                  >
                    {fmtInt(p.gap)}
                  </span>
                </button>
              ))}
          </div>
          <div className="mt-2 text-[11.5px] leading-[1.5] text-ink-3">
            The right hand figure is the capacity gap at 2041, the zoned
            ceiling minus projected dwellings. Amber marks a negative gap.
          </div>
          <DemoDataNote className="mt-2" />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Timeline bar
 * ------------------------------------------------------------------ */

function TimelineBar({
  sc,
  setSc,
  year,
  setYear,
  steps,
  datasetLabel,
}: {
  sc: Scenario;
  setSc: (s: Scenario) => void;
  year: number;
  setYear: (y: number) => void;
  steps: number[];
  datasetLabel: string;
}) {
  return (
    <div className="flex h-[62px] shrink-0 items-center justify-between border-t border-line bg-white px-3">
      <div className="flex items-center gap-2.5">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-3">
            Scenario
          </div>
          <div className="mt-1">
            <Segmented
              value={sc}
              onChange={setSc}
              options={[
                { value: 'ssp245' as Scenario, label: SCENARIO_LABEL.ssp245 },
                { value: 'ssp585' as Scenario, label: SCENARIO_LABEL.ssp585 },
              ]}
            />
          </div>
        </div>
        <div className="hidden max-w-[280px] border-l border-line pl-2.5 text-[11.5px] leading-[1.45] text-ink-3 lg:block">
          {SCENARIO_NOTE[sc]} Pathways, not forecasts. Both are plausible.
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        <div className="text-right">
          <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-ink-3">
            Active dataset
          </div>
          <div className="num mt-[2px] max-w-[200px] truncate text-[12.5px] text-ink-2">
            {datasetLabel}
          </div>
        </div>
        {steps.length > 0 ? (
          <div className="flex items-end gap-1.5">
            {steps.map((s) => {
              const on = s === year;
              return (
                <button
                  key={s}
                  onClick={() => setYear(s)}
                  className="group flex flex-col items-center"
                >
                  <span
                    className={`num rounded-[4px] border px-2 py-[3px] text-[13.5px] font-semibold transition-colors ${on ? '' : 'group-hover:border-accent group-hover:text-accent'}`}
                    style={
                      on
                        ? { borderColor: ACCENT, background: ACCENT, color: '#fff' }
                        : { borderColor: '#E2E7E7', color: '#4A5A59' }
                    }
                  >
                    {s}
                  </span>
                  <span
                    className="mt-[3px] h-[3px] w-[3px] rounded-full"
                    style={{ background: on ? ACCENT : '#DCE3E2' }}
                  />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="rounded-[5px] border border-dashed border-line px-2.5 py-[5px] text-[12px] text-[#A8B5B4]">
            No time-series data
          </div>
        )}
      </div>
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
  place: {
    title: 'Place',
    subtitle: 'SA2 profile, real buildings and the register at large',
    icon: IconPlace,
  },
  analysis: {
    title: 'Analysis',
    subtitle: 'Two measures across the seven SA2s with data',
    icon: IconAnalysis,
  },
  help: {
    title: 'Help',
    subtitle: 'How to read this tool, and what it will not tell you',
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
  const order: PanelTab[] = ['layers', 'place', 'analysis', 'help'];
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
 *  guess from the register's locality text. Keyed by app suburb id for
 *  the seven with attribute data, and by BEVERLEY_ID for the eighth,
 *  which has real buildings even though it has no demographic data.
 *  Only buildings with a geocoded position can appear here, the 171
 *  without one are real too, they just cannot be placed in a suburb
 *  without inventing where. */
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

interface ConsequenceCategory {
  id: string;
  name: string;
  metrics: string[];
  mapsToPrepare?: string[];
  provocation?: string;
}

const CONSEQUENCE_CATEGORIES: ConsequenceCategory[] = [
  {
    id: 'financial',
    name: 'Financial',
    metrics: ['Expenditure', '% of annual budget', 'Impact on budget'],
  },
  {
    id: 'core-delivery',
    name: 'Core delivery / Asset management',
    metrics: ['Compliance', 'Disciplinary action', 'Court costs'],
    mapsToPrepare: [
      'Average daily max temperature',
      'Days max temperature above 35C',
      'Road hierarchy',
      'Estimated road traffic',
      'Road conditions',
      'Road canopy cover ratio (road shaded)',
    ],
    provocation: 'Same as core hazard/asset maps, plus road function and active transport routes',
  },
  {
    id: 'legislative',
    name: 'Legislative',
    metrics: ['Media impact and duration', 'Local response', 'Net Promoter Score'],
  },
  {
    id: 'reputational',
    name: 'Reputational',
    metrics: [
      'WHS incident severity',
      'Staff turnover',
      'Volunteer numbers',
      'Staff culture',
      'Conduct breaches',
    ],
  },
  {
    id: 'key-state-services',
    name: 'Key state services / Our people',
    metrics: [
      'Council facility impact duration',
      'Core service impact duration',
      'BCP activation',
      'Impact on Civic Centre',
      'Impact on Beverley Depot',
      'Impact on MRF',
    ],
  },
  {
    id: 'environment',
    name: 'Environment',
    metrics: ['Impact duration on "environment"', 'EPA Act 1993 classification'],
  },
  {
    id: 'community-wellbeing',
    name: 'Community wellbeing, health and safety',
    metrics: [
      'Utilisation of facilities',
      'Number of people with wellbeing or safety compromised',
      'Building density',
    ],
  },
];


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

function AssetTypeToggles({ offTypes, setOffTypes }: AssetTypeTogglesProps) {
  const [openUse, setOpenUse] = useState<string | null>(null);
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
      <div className="flex flex-wrap gap-1">
        {REAL_USE_TREE.map((use) => {
          const offCount = use.types.filter((t) => offTypes.has(t.key)).length;
          const allOff = offCount === use.types.length;
          const isOpen = openUse === use.key;
          const isUnclassified = use.key === UNCLASSIFIED;
          const chip = (
            <button
              onClick={() => setOpenUse(isOpen ? null : use.key)}
              className="flex items-center gap-1 rounded-[5px] border px-1.5 py-1 text-left transition-colors"
              style={
                isOpen
                  ? { borderColor: ACCENT, background: withAlpha(ACCENT, 0.08) }
                  : allOff
                    ? { borderColor: '#E2E7E7', background: '#F6F8F8', opacity: 0.6 }
                    : { borderColor: '#E2E7E7', background: '#fff' }
              }
            >
              <span
                className="h-[7px] w-[7px] shrink-0 rounded-full"
                style={{ background: allOff ? '#C9D3D2' : ACCENT }}
              />
              <span className="text-[11.5px] font-medium text-ink">
                {isUnclassified ? 'Not yet classified' : use.label}
              </span>
              <span className="num text-[10.5px] text-ink-3">{use.count}</span>
            </button>
          );
          return (
            <span key={use.key}>
              {isUnclassified ? (
                <Tip
                  label="Not yet classified"
                  body="11 buildings in council's own register, all under the AMSCouncilOwnedProps or AMSPumpStations classes, carry no Building Type value on any of their component rows, Corporate Building, Shed, Clubroom or otherwise. That is a real gap in the source register, not something dropped or guessed here."
                  side="top"
                >
                  {chip}
                </Tip>
              ) : (
                chip
              )}
            </span>
          );
        })}
      </div>

      {openUse && (
        <div className="fade-up mt-1.5 rounded-[6px] border border-line bg-surface-2 p-1.5">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-semibold text-ink-2">
              {REAL_USE_TREE.find((u) => u.key === openUse)?.label}
            </span>
            <button
              onClick={() => toggleUse(REAL_USE_TREE.find((u) => u.key === openUse)!)}
              className="text-[10.5px] text-accent hover:underline"
            >
              toggle all
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {REAL_USE_TREE.find((u) => u.key === openUse)?.types.map((t) => {
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
      )}

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
  'Real physical buildings from CCS_Buildings.xlsx, council’s own asset register, one row per building rather than per fitout or meter. Categories are turned on and off in Layers, Assets, the same toggle the map markers below use. Map positions are geocoded from the register’s address field via OpenStreetMap, approximate, not surveyed. Buildings with no usable address are listed here but not mapped.';

/* ------------------------------------------------------------------ *
 * Real buildings register
 *
 * A browse and inspect view, not a control surface. It reads whichever
 * categories are switched on in Layers, Assets, it does not carry a
 * second copy of that toggle.
 * ------------------------------------------------------------------ */

interface RealBuildingsRegisterProps {
  offTypes: Set<string>;
  onManageCategories: () => void;
}

function RealBuildingsRegister({
  offTypes,
  onManageCategories,
}: RealBuildingsRegisterProps) {
  const [showList, setShowList] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const visibleTypes = useMemo(
    () => new Set([...ALL_BUILDING_TYPES].filter((t) => !offTypes.has(t))),
    [offTypes],
  );

  const visibleBuildings = useMemo(
    () =>
      REAL_BUILDINGS.filter((b) =>
        visibleTypes.has(b.buildingType ?? UNCLASSIFIED),
      ),
    [visibleTypes],
  );

  const totalInsured = REAL_BUILDINGS.reduce((n, b) => n + b.insuredValue, 0);
  const visibleInsured = visibleBuildings.reduce((n, b) => n + b.insuredValue, 0);
  const preciseCount = REAL_BUILDINGS.filter((b) => BUILDING_LOCATION[b.id]?.precision === 'site').length;
  const approxCount = REAL_BUILDINGS.filter((b) => BUILDING_LOCATION[b.id]?.precision === 'street').length;
  const mappedCount = preciseCount + approxCount;
  const visibleMapped = visibleBuildings.filter((b) => BUILDING_LOCATION[b.id]).length;
  const onCount = ALL_BUILDING_TYPES.size - offTypes.size;

  return (
    <div className="mb-3 border-b border-line pb-3">
      {/* Header: the headline numbers, always in view, no prose above them. */}
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-semibold text-ink">
            Buildings register
          </span>
          <Tip label="How this reads" body={BUILDINGS_REGISTER_EXPLAINER} side="right">
            <span className="flex h-[15px] w-[15px] cursor-help items-center justify-center rounded-full border border-line text-[10px] font-semibold text-ink-3 hover:border-accent hover:text-accent">
              i
            </span>
          </Tip>
        </div>
        <Tip
          label="Map coverage"
          body={`${preciseCount} geocoded to an actual building or named place. ${approxCount} only matched the street they sit on, most register addresses have no house number, so the point is somewhere along that road, not at the building. ${REAL_BUILDINGS.length - mappedCount} have no address the geocoder could resolve, and are not on the map at all.`}
          side="left"
        >
          <span className="num cursor-help text-[11px] text-ink-3 underline decoration-dotted">
            {mappedCount} of {REAL_BUILDINGS.length} on map
          </span>
        </Tip>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-1.5">
        <Stat label="Buildings" value={`${REAL_BUILDINGS.length}`} sub={`${ALL_BUILDING_TYPES.size} types`} />
        <Stat
          label="Insured value"
          value={`$${(totalInsured / 1e6).toFixed(1)}M`}
          sub={`${REAL_BUILDINGS.filter((b) => b.insuredValue > 0).length} valued`}
        />
      </div>

      <div className="mb-2 flex items-center gap-3 rounded-[5px] border border-dashed border-line bg-surface-2 px-2 py-1.5 text-[10.5px] text-ink-3">
        <span className="flex items-center gap-1">
          <span className="h-[9px] w-[9px] rounded-full border border-white" style={{ background: ACCENT }} />
          {preciseCount} precise
        </span>
        <span className="flex items-center gap-1">
          <span className="h-[9px] w-[9px] rounded-full border-2" style={{ borderColor: ACCENT, background: '#fff' }} />
          {approxCount} street-level only
        </span>
        <span>{REAL_BUILDINGS.length - mappedCount} not mapped</span>
      </div>

      {/* No toggle UI here, it lives in Layers so hazard and asset
          categories sit in one place. This just shows what is currently
          on and a one-click way to get to it. */}
      <button
        onClick={onManageCategories}
        className="mb-2.5 flex w-full items-center justify-between rounded-[5px] border border-line bg-white px-2 py-1.5 text-left transition-colors hover:border-accent"
      >
        <span className="text-[11.5px] text-ink-2">
          <span className="num font-semibold text-ink">{onCount}</span> of{' '}
          {ALL_BUILDING_TYPES.size} building types shown on the map
        </span>
        <span className="text-[11px] text-accent">Layers → Assets</span>
      </button>

      {/* The individual list is a deliberate browse area below the fold,
          not the answer to the question above. Closed by default so
          picking categories never has to compete with a long list. */}
      <button
        onClick={() => setShowList(!showList)}
        className="flex w-full items-center justify-between rounded-[5px] border border-line bg-white px-2 py-1.5 text-left transition-colors hover:border-accent"
      >
        <span className="flex items-center gap-1.5">
          <IconChevron size={12} className={`text-ink-3 transition-transform ${showList ? 'rotate-90' : ''}`} />
          <span className="text-[11.5px] font-medium text-ink">
            List {visibleBuildings.length} of {REAL_BUILDINGS.length} buildings
          </span>
        </span>
        <span className="num text-[10.5px] text-ink-3">
          ${(visibleInsured / 1e6).toFixed(1)}M · {visibleMapped} mapped
        </span>
      </button>

      {showList && (
        <div className="fade-up mt-1.5 max-h-[300px] space-y-1 overflow-y-auto thin-scroll pr-0.5">
          {visibleBuildings.length === 0 && (
            <div className="rounded-[5px] border border-dashed border-line px-2 py-3 text-center text-[11px] text-ink-3">
              No building types selected.
            </div>
          )}
          {visibleBuildings.map((b) => (
            <BuildingCard
              key={b.id}
              b={b}
              isOpen={openId === b.id}
              onToggle={() => setOpenId(openId === b.id ? null : b.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Framing sheet
 *
 * Staff described the same four questions over and over: what is the
 * hazard, who is exposed, what does it do to them, and which places are
 * worst. This sheet says which of those the tool answers and which it
 * does not, so nobody reads more into a colour than it carries.
 * ------------------------------------------------------------------ */

function InfoSheet({ onClose }: { onClose: () => void }) {
  const rows = [
    {
      k: 'Hazard',
      v: 'Where the modelled event happens. Flood extent, sea level, surface heat, coastal recession. Answered by the hazard layers.',
    },
    {
      k: 'Exposure',
      v: 'What sits inside the hazard. People, dwellings, and the asset portfolio. Answered by the vulnerability layers and the Place tab.',
    },
    {
      k: 'Sensitivity',
      v: 'How much harm the same event does. Disadvantage, age, canopy and mobility all change the answer. Partly answered, and only at SA1 for some measures.',
    },
    {
      k: 'Consequence',
      v: 'What it costs when it happens. Only partly answered. Repair counts and asset values are here, service disruption and health outcomes are not.',
    },
  ];
  return (
    <div className="absolute inset-0 z-[60] flex flex-col bg-white">
      <div className="flex items-start justify-between border-b border-line px-2.5 py-2">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-3">
            About this tool
          </div>
          <div className="text-[16px] font-semibold text-ink">
            What it answers
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-[4px] p-1 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          aria-label="Close"
        >
          <IconClose />
        </button>
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto px-2.5 py-2">
        <p className="text-[12.5px] leading-[1.55] text-ink-2">
          A risk picture needs four things. This tool holds two of them well,
          one partly, and one barely. Knowing which is which keeps the map
          honest.
        </p>
        <div className="mt-2 space-y-1.5">
          {rows.map((r) => (
            <div
              key={r.k}
              className="rounded-[5px] border border-line bg-white px-2 py-1.5"
            >
              <div className="text-[12px] font-semibold text-ink">{r.k}</div>
              <div className="mt-[2px] text-[11.5px] leading-[1.5] text-ink-2">
                {r.v}
              </div>
            </div>
          ))}
        </div>
        <PanelHeading>Scale</PanelHeading>
        <p className="text-[11.5px] leading-[1.55] text-ink-2">
          Geography is the easiest thing to get wrong here. An SA2 colour is an
          average across roughly 10,000 people. Switch the boundary control to
          SA1 before concluding anything about a pocket, and check whether the
          layer is actually modelled at that scale before reading variation
          into it.
        </p>
        <div className="mt-2">
          <PanelHeading>Whose assets</PanelHeading>
          <p className="text-[11.5px] leading-[1.55] text-ink-2">
            The asset list is the council portfolio plus the few third party
            sites council response plans depend on. Private property, which is
            where most of the canopy and most of the flood damage sits, is not
            in it. A portfolio view and a community view give different
            answers, and this tool leans toward the portfolio.
          </p>
        </div>
        <div className="mt-2">
          <PanelHeading>What it will not do</PanelHeading>
          <ul className="space-y-1 text-[11.5px] leading-[1.5] text-ink-2">
            <li>It does not rank suburbs into a single risk order.</li>
            <li>It does not weight one hazard against another.</li>
            <li>It does not recommend an action or a sequence.</li>
            <li>It records nothing about who used it or what they looked at.</li>
          </ul>
        </div>
        <DemoDataNote className="mt-2.5" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Root
 * ------------------------------------------------------------------ */

export default function App() {
  const [panelTab, setPanelTab] = useState<PanelTab>('layers');
  const [year, setYear] = useState(2021);
  const [sc, setSc] = useState<Scenario>('ssp245');
  const [checkedLayers, setCheckedLayers] = useState<Set<string>>(
    () => new Set(['heat-vuln']),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(MAP_ZOOM);
  const [compareA, setCompareA] = useState('heat-vuln');
  const [compareB, setCompareB] = useState('seifa');
  const [overlayOpacity, setOverlayOpacity] = useState(0.85);
  const [layerOpacity, setLayerOpacityState] = useState<Record<string, number>>(
    {},
  );
  const [hoveredSuburb, setHoveredSuburb] = useState<string | null>(null);
  const [hoveredAsset, setHoveredAsset] = useState<HoveredAsset | null>(null);
  const [activeBlueprint, setActiveBlueprint] = useState<BlueprintId | null>(
    null,
  );
  const [boundsMode, setBoundsMode] = useState<BoundsMode>('sa2');
  const [planMetric, setPlanMetric] = useState<PlanMetric>('count');
  const [planYear, setPlanYear] = useState(2041);
  const [showQuadrant, setShowQuadrant] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  // Building types switched off in Layers, Assets. Lifted to root so the
  // map and Place's buildings register both read the one state. Starts
  // with everything off, matching every other overlay in Layers, on the
  // map is opt-in, not a surprise on first load.
  const [buildingOffTypes, setBuildingOffTypes] = useState<Set<string>>(
    () => new Set(ALL_BUILDING_TYPES),
  );

  const showBlueprintPanel = !!activeBlueprint;
  const compare = panelTab === 'analysis';

  // One right panel at a time, and only when there is something real to
  // show in it, an empty analysis panel reserving screen width for
  // nothing is exactly the clutter this tool has spent this session
  // removing. A blueprint takes priority since choosing one is a
  // deliberate act; otherwise the panel follows whichever left tab is
  // open and has something to say.
  const rightPanelMode: 'blueprint' | 'place' | 'analysis' | null =
    showBlueprintPanel
      ? 'blueprint'
      : panelTab === 'place' && selectedId
        ? 'place'
        : panelTab === 'analysis'
          ? 'analysis'
          : null;
  const rightPanelAccent =
    rightPanelMode === 'blueprint' && activeBlueprint
      ? BLUEPRINT_ACCENT[activeBlueprint]
      : ACCENT;

  // Several layers can be stacked on the map at once now, but the
  // timeline only ever drives one dataset's year steps. The first
  // checked layer, by catalogue order, is the one it follows.
  const activeSurfaces = useMemo(
    () => activeSurfaceLayers(checkedLayers),
    [checkedLayers],
  );
  const surface = activeSurfaces[0] ?? null;

  const steps = useMemo(
    () => yearStepsFor(activeBlueprint, compare ? compareA : surface?.id ?? null),
    [activeBlueprint, compare, compareA, surface],
  );

  // When the active dataset changes the year may no longer be a step it
  // supports, so it snaps rather than silently interpolating.
  useEffect(() => {
    if (steps.length === 0) return;
    setYear((y) => (steps.includes(y) ? y : snapYear(y, steps)));
  }, [steps]);

  const toggleLayer = useCallback((id: string) => {
    setCheckedLayers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setLayerOpacity = useCallback((id: string, v: number) => {
    setLayerOpacityState((prev) => ({ ...prev, [id]: v }));
  }, []);

  const applyBlueprint = useCallback(
    (id: BlueprintId) => {
      if (activeBlueprint === id) {
        setActiveBlueprint(null);
        return;
      }
      const bp = BLUEPRINT_BY_ID[id];
      setCheckedLayers(new Set(bp.layers));
      setActiveBlueprint(id);
      if (id !== 'population') setShowQuadrant(false);
    },
    [activeBlueprint],
  );

  // Clicking a suburb normally opens its profile. While a blueprint panel is
  // open it only moves the spotlight, because the panel is the thing being
  // read and yanking the tab away would lose the reader's place.
  const handleSelectSuburb = useCallback(
    (id: string) => {
      setSelectedId(id);
      if (!showBlueprintPanel) setPanelTab('place');
    },
    [showBlueprintPanel],
  );

  const meta = TAB_META[panelTab];

  const datasetLabel = activeBlueprint
    ? BLUEPRINT_BY_ID[activeBlueprint].title
    : compare
      ? `${LAYER_BY_ID[compareA].name} vs ${LAYER_BY_ID[compareB].name}`
      : activeSurfaces.length > 0
        ? activeSurfaces.map((l) => l.name).join(' + ')
        : 'No surface layer';

  return (
    <div className="flex h-full w-full overflow-hidden bg-surface-2 text-ink">
      <IconRail tab={panelTab} setTab={setPanelTab} />

      {/* Left panel */}
      <section className="relative flex w-80 shrink-0 flex-col border-r border-line bg-white">
        <header className="flex items-start justify-between gap-2 border-b border-line px-2.5 py-2">
          <div className="min-w-0">
            <div className="text-[17px] font-semibold leading-tight text-ink">
              {meta.title}
            </div>
            <div className="mt-[2px] text-[11.5px] leading-tight text-ink-3">
              {meta.subtitle}
            </div>
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
              activeBlueprint={activeBlueprint}
              applyBlueprint={applyBlueprint}
              buildingOffTypes={buildingOffTypes}
              setBuildingOffTypes={setBuildingOffTypes}
            />
          )}
          {panelTab === 'place' && (
            <PlaceTab
              selectedId={selectedId}
              setSelectedId={setSelectedId}
              year={year}
              sc={sc}
              hoveredAsset={hoveredAsset}
              setHoveredAsset={setHoveredAsset}
              buildingOffTypes={buildingOffTypes}
              onManageCategories={() => setPanelTab('layers')}
            />
          )}
          {panelTab === 'analysis' && (
            <AnalysisTab
              compareA={compareA}
              compareB={compareB}
              setCompareA={setCompareA}
              setCompareB={setCompareB}
            />
          )}
          {panelTab === 'help' && <HelpTab />}
        </div>

        <footer className="flex items-center justify-between border-t border-line px-2.5 py-1.5">
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-[0.08em] text-ink-3">
              City of Charles Sturt
            </span>
            <Tip label="Prepared by" body="Value Advisory Partners" side="top">
              <img src={vapLogo} alt="Value Advisory Partners" className="h-[15px] w-[15px] shrink-0 opacity-70" />
            </Tip>
          </span>
          <span className="num text-[11px] text-ink-3">
            {SA2_BOUNDARIES.length} SA2 · {SA1S.length} SA1 · z{zoom}
          </span>
        </footer>

        {showInfo && <InfoSheet onClose={() => setShowInfo(false)} />}
      </section>

      {/* Map area. Pure data made visible, the map draws what is real or
          modelled, it does not judge any of it. */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <MapView
            checkedLayers={checkedLayers}
            overlayOpacity={overlayOpacity}
            layerOpacity={layerOpacity}
            year={year}
            sc={sc}
            boundsMode={boundsMode}
            setBoundsMode={setBoundsMode}
            selectedId={selectedId}
            onSelectSuburb={handleSelectSuburb}
            hoveredSuburb={hoveredSuburb}
            setHoveredSuburb={setHoveredSuburb}
            hoveredAsset={hoveredAsset}
            compare={compare}
            compareA={compareA}
            compareB={compareB}
            rightPanelAccent={rightPanelAccent}
            onZoomChange={setZoom}
            showBuildings={buildingOffTypes.size < ALL_BUILDING_TYPES.size}
            buildingOffTypes={buildingOffTypes}
          />

          {showQuadrant && (
            <PlanningQuadrant
              onClose={() => setShowQuadrant(false)}
              sc={sc}
              selectedId={selectedId}
              setSelectedId={setSelectedId}
            />
          )}
        </div>

        <TimelineBar
          sc={sc}
          setSc={setSc}
          year={year}
          setYear={setYear}
          steps={steps}
          datasetLabel={datasetLabel}
        />
      </main>

      {/* Analysis and consequence, the other half of the split: whatever
          this data means, ranks as, or costs, lives here, never mixed
          into the data panel on the left. A true layout column, not an
          overlay floating on the map, so it only ever takes real screen
          width when it is showing something, and the map reclaims that
          width the moment it closes. */}
      {rightPanelMode === 'blueprint' && activeBlueprint && (
        <BlueprintPanel
          blueprint={BLUEPRINT_BY_ID[activeBlueprint]}
          onClose={() => setActiveBlueprint(null)}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          setHoveredSuburb={setHoveredSuburb}
          year={year}
          sc={sc}
          planMetric={planMetric}
          setPlanMetric={setPlanMetric}
          planYear={planYear}
          setPlanYear={setPlanYear}
          onOpenQuadrant={() => setShowQuadrant(true)}
        />
      )}
      {rightPanelMode === 'place' && <PlaceAnalysisPanel selectedId={selectedId} />}
      {rightPanelMode === 'analysis' && (
        <AnalysisResultsPanel
          compareA={compareA}
          compareB={compareB}
          year={year}
          sc={sc}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          hoveredSuburb={hoveredSuburb}
          setHoveredSuburb={setHoveredSuburb}
        />
      )}
    </div>
  );
}
