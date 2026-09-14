# CoCS Climate Risk Explorer

Climate risk decision-support tool for City of Charles Sturt council staff.

## Running

```
npm install
npm run dev
```

Then open the URL Vite prints. `npm run build` produces a production bundle,
`npm run typecheck` runs TypeScript with no emit.

## Layout

- `src/app/App.tsx` is the whole application: types, data, helpers, map and
  every panel.
- `src/styles/globals.css` holds the design tokens, and `fonts.css` the
  Google Fonts import for DM Sans and JetBrains Mono.

## A note on the data

Every figure in the tool is an indicative demonstration value shaped to the
real geography of the LGA. None of it comes from council systems. The app says
so in each panel, and the Help tab lists the thresholds and conventions it
applies.
