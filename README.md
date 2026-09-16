# CoCS Climate Risk Explorer

Climate risk decision-support tool for City of Charles Sturt council staff.
Layers, an SA1/SA2 boundary map, a real building register and a real
consequence framework, all in one screen: hazard and asset data on the left,
what it means for council on the right.

## Running

```
npm install
npm run dev
```

Then open http://localhost:8080. `npm run build` produces a production
bundle (also runs a typecheck first), `npm run typecheck` runs TypeScript
alone with no emit.

## Layout

- `src/app/App.tsx` — the whole application: types, data, map, and every
  panel, left (data) and right (analysis/consequence).
- `src/data/` — real, sourced datasets the app reads at build time:
  - `sa2Boundaries.json`, `sa1Boundaries.json` — exact ABS ASGS 2021
    boundaries for Charles Sturt's 8 SA2s and 257 SA1s, fetched from
    `geo.abs.gov.au`, not drawn.
  - `ccsBuildings.json` — 434 real council buildings, extracted and
    collapsed from council's own asset register export (`CCS_Buildings.xlsx`).
  - `ccsBuildingsGeocoded.json` — approximate map positions for 263 of
    those buildings, geocoded from the register's address field via
    OpenStreetMap Nominatim (see in-app tooltips for the precision caveat).
- `src/styles/globals.css` — design tokens; `fonts.css` — the Google Fonts
  import for DM Sans and JetBrains Mono.
- `netlify.toml` / `.github/workflows/deploy-pages.yml` — deploy config for
  Netlify and GitHub Pages respectively. Both build with `npm run build`
  and publish `dist`; Pages additionally needs its Source set to
  **GitHub Actions** under repo Settings → Pages.

## What's real and what's indicative

This tool mixes two kinds of data, and every panel says which is which:

- **Real, sourced data**: the SA1/SA2 boundaries, the buildings register,
  the geocoded map positions, and the consequence framework's category and
  metric names (from project correspondence with council's planning team).
- **Indicative demonstration data**: population, hazard scores (heat,
  flood, coastal, drought), SEIFA, and the other suburb-level figures used
  to shape the map and demonstrate the mechanism. None of these come from
  council systems, and no consequence tolerance or threshold value has
  been invented for any category, those are shown as not yet set.

The Help tab documents this in full, including sources and the thresholds
the tool does use.
