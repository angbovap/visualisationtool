# CoCS Climate Risk Tolerance Tool: style

One style for the whole tool. It follows the editorial cartography
tradition (newspaper and research data graphics) rather than app or
dashboard templates: type does the work, colour encodes data, and nothing
is decorative.

## Type

- **Libre Franklin** (the open-source Franklin Gothic) for everything:
  headings, text, labels and numbers. No second family.
- Weights: 400 text, 500 labels, 700 headings and key figures.
- Numbers use tabular figures (`.num`) so columns line up.
- Sentence case everywhere. No all-caps labels, no letter-spaced text.

## Colour

| Role | Value | Use |
|---|---|---|
| Paper | `#F6F4EF` | Page and secondary surfaces |
| White | `#FFFFFF` | Panels and map cards |
| Ink | `#1C1B19` | Headings and primary text |
| Ink 2 | `#4E4B45` | Body text |
| Ink 3 | `#86827A` | Labels, notes, units |
| Rule | `#DCD8CE` | Dividers and borders |
| Accent | `#0E6E6A` | Interactive elements only (links, selected states, checkboxes) |

Hazard colours encode data and are used the same way everywhere:
flood blue `#1D4ED8`, heat red `#DC2626`, water `#0284C7`,
social vulnerability amber `#B45309`, assets slate `#374151`.
Risk ratings: Low `#15803D`, Moderate `#CA8A04`, High `#EA580C`,
Extreme `#B91C1C`.

Colour is never used as decoration: no tinted backgrounds behind text, no
coloured edge bars, no gradients.

## Structure

- **Section headings:** a short ink rule above a bold heading (as a
  newspaper section), not boxes or bands.
- **Lists:** rows divided by thin rules. Icon (if any) on the left, label,
  then value or chevron on the right. No cards, no icon-on-top tiles.
- **Figures:** a label above a value; values in Franklin bold, tabular.
- **Controls:** checkboxes for anything on or off (as in desktop GIS
  layer lists); one solid ink button per view for the main action;
  everything else as text links.
- **Corners:** square (2px at most on controls). **Shadows:** none, except
  a faint one where a card floats over the map.

## Writing

- Titles are names, not descriptions. Notes are short and factual.
- Say what the data is and where it came from; don't explain the
  interface.
