# CoCS Climate Risk Tolerance Tool: style

One style for the whole tool. It follows the editorial cartography
tradition (newspaper and research data graphics) rather than app or
dashboard templates: type does the work, colour encodes data, and nothing
is decorative.

## Type

- **Franklin Gothic**, the installed Windows and Office faces: Book for
  text, Medium for labels, Demi for headings. Libre Franklin (the
  open-source version) only where those are missing.
- Headings Demi, 17px at most. No bold display type.
- Numbers use tabular figures (`.num`) so columns line up.
- Sentence case everywhere. No all-caps labels, no letter-spaced text.

## Colour

| Role | Value | Use |
|---|---|---|
| Page grey | `#F3F4F5` | Page behind widgets, secondary surfaces |
| White | `#FFFFFF` | Panels and map cards |
| Ink | `#1F2328` | Headings and primary text |
| Ink 2 | `#3E454B` | Body text, values |
| Ink 3 | `#596066` | Notes and units only |
| Rule | `#DADEE1` | Dividers and borders |
| Rail | `#0B3D3B` | The navigation rail, the one block of solid colour in the frame |
| Accent | `#0E6E6A` | Interactive elements only (links, selected states, checkboxes) |

Hazard colours encode data and are used the same way everywhere:
flood blue `#1D4ED8`, heat red `#DC2626`, water `#0284C7`,
social vulnerability amber `#B45309`, assets slate `#374151`.
Risk ratings: Low `#15803D`, Moderate `#CA8A04`, High `#EA580C`,
Extreme `#B91C1C`.

Colour has three jobs and no others:

1. **Frame:** the rail is solid council teal, so navigation reads apart
   from content.
2. **Data:** each theme keeps its map colour wherever it appears (icon,
   "on" count, map symbol, chart). A filled chip in that colour means
   "something of this theme is on the map now".
3. **Action:** accent teal marks what can be clicked or is selected.

No pale or translucent text, no frosted glass, no tinted backgrounds
behind text, no coloured edge bars, no gradients.

## Structure

Modelled on ArcGIS Dashboards, the tool council GIS teams already use
(Esri, "Author effective dashboards"): one theme, few custom colours,
modular widgets, most important first, figures shown against a reference.

- **Widgets:** each section is a white panel on the grey page, with a thin
  title bar (12.5px semibold) and its content below. Related widgets sit
  together; the most important comes first.
- **Group labels:** outside widgets, a small semibold ink-2 label.
- **Lists:** one line per row: icon on the left, name, then value, count
  or chevron on the right. No second line of description under a row;
  explanations go in a tooltip. Rows are separated by space, not rules,
  and highlight grey on hover.
- **Figures:** a label above a value, always with a reference (target,
  total, or comparison) where one exists.
- **Tabs:** a segmented control; the selected tab is white with a border.
- **Chips:** risk ratings as solid colour chips with white text.
- **Registers:** risk information as a register table (one row per risk),
  each rating shown on the same Low to Extreme scale with the target
  marked, a short status, and detail on demand (AS ISO 31000 council
  practice).
- **Controls:** checkboxes for anything on or off; one solid button per
  view for the main action; everything else as text links.
- **Corners:** 4px (3px on checkboxes, 8px on the map locator frame).

## Punctuation and marks

- No middle-dot separators (·) and no em dashes. Use a comma, a colon, or
  a new line. Breadcrumbs use a slash: "Assets / Whole LGA".
- Ranges of numbers take an en dash ($0–180k, 0–14 days); ranges of words
  are written out ("Moderate to High").
- No decorative dots or squares beside labels. Colour sits in the data mark
  itself (map symbol, chart, legend swatch).
- No drop shadows and no hover tints; hover changes the text colour.

## Writing

- Titles are names, not descriptions. Notes are short and factual.
- Say what the data is and where it came from; don't explain the
  interface.
