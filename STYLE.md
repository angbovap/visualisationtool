# CoCS Climate Risk Tolerance Tool: style

One style for the whole tool, taken from the reference map dashboard the
project agreed on (a zone-management GIS dashboard): white panels, bold
small titles, rounded controls, chips for values, the map as the main show.

## Type

- **Plus Jakarta Sans** for everything. Weights 400 text, 500 labels,
  600 values, 700 titles.
- Panel titles 20px bold; section titles 14px bold.
- Numbers use tabular figures (`.num`) so columns line up.
- Sentence case everywhere. No all-caps labels, no letter-spaced text.

## Colour

| Role | Value | Use |
|---|---|---|
| White | `#FFFFFF` | Panels and map cards (no grey page behind) |
| Ink | `#16191D` | Titles, primary text, map tool buttons |
| Ink 2 | `#3E454B` | Body text, values |
| Ink 3 | `#596066` | Notes and units only |
| Chip | `#F1F3F5` | Value chips, tab tracks |
| Rule | `#E6E8EB` | Lines between sections and rows |
| Rail | `#0B3D3B` | Navigation rail |
| Accent | `#0E6E6A` | Interactive elements, selected states |

Colour has three jobs: the rail frames the app; each theme keeps its map
colour wherever it appears (icons, "on" chips, map symbols, charts); accent
teal marks what can be clicked. Risk ratings: Low `#15803D`, Moderate
`#CA8A04`, High `#EA580C`, Extreme `#B91C1C`.

## Organising information

- **Overview first, details on demand** (Shneiderman). Every panel opens
  on its summary; detail is a click away, never all on screen at once.
- **Progressive disclosure** (Nielsen Norman Group). Each panel is a stack
  of collapsible sections: chevron, bold title, a count or value chip.
  Overview sections start open, secondary ones (notes, sources, context)
  start folded.
- **One organising principle per list** (Wurman, LATCH: location,
  alphabet, time, category, hierarchy). Layers and case layers are grouped
  by category; suburbs are ranked by the chosen measure, with no second
  alphabetical copy of the same list.
- **Inside a section,** related rows are listed under small labels (e.g.
  Hazards, then Flood and Heat in their hazard colours), all visible.
- **Layer categories** are sections with their category icon and colour;
  the chip shows the layer count, or "2 of 6 on" in the category colour.
- **Figures** (counts, values, headline readings) are grey tiles, two or
  three to a row.

## Structure

- **Panels:** white. Sections are open blocks split by one thin
  full-width line, each with a 14px bold title and an optional control on
  the right. No boxed widgets.
- **Rows:** one line: icon, name, then a value chip, count chip or chevron.
  No second line of description; explanations go in tooltips.
- **Chips:** values sit in small grey rounded chips (6px). Ratings and
  "on" counts are solid colour chips with white text.
- **Tabs:** a grey track with the selected tab as a white pill.
- **Buttons:** small outlined buttons (6px) for actions in rows; one solid
  accent button per view for the main action.
- **Map cards:** white, 12px corners, a soft shadow, no border. Map tool
  buttons (locate, zoom) are dark rounded squares. The locator has a dark
  3px frame.
- **Charts:** compact, with a dot legend underneath (Figure 10 radar on
  the Tolerance tab).
- **Corners:** 12px cards, 8–10px controls, 6px chips, 4px checkboxes.

## Punctuation and marks

- No middle-dot separators (·) and no em dashes. Use a comma, a colon, or
  a new line. Breadcrumbs use a slash: "Assets / Whole LGA".
- Ranges of numbers take an en dash ($0–180k, 0–14 days); ranges of words
  are written out ("Moderate to High").
- Shadows only on floating map cards and the selected tab pill.

## Writing

- Titles are names, not descriptions. Notes are short and factual.
- Say what the data is and where it came from; don't explain the
  interface.
