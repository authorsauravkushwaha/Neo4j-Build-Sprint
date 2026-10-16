# Accessibility

What this app does for accessibility, what has been measured, what has not, and where the
known exceptions are. The rule for this page is the rule for the rest of the repository: a
claim stays only if a command backs it.

## Implemented

- **Structure.** One `<h1>` per route, landmarks (`header`/`main`/`footer`) on every screen, a
  skip-to-content link as the first focusable element, and headings that nest (H1 → H2 → H3,
  no skipped levels).
- **Keyboard.** Every action is reachable without a pointer. The command palette is mounted
  above the router, so <kbd>Cmd/Ctrl</kbd>+<kbd>K</kbd> works on every screen including
  lazy-loaded ones. Focus is visible on the neumorphic surface: a token ring, not a shadow
  change, so it survives both themes.
- **Motion.** `store.ts applyTheme()` writes `data-theme` and `data-motion` on `<html>`; the
  WebGL scene, the graph view and CSS animations all read that attribute. With
  `prefers-reduced-motion: reduce`, no 3D canvas mounts, tilt transforms are neutralised and
  nothing animates — each of those three is a browser check, not an intention.
- **Colour and contrast.** Two themes, one base colour each. State (hover, pressed, selected)
  is never carried by shadow alone — border and text change too — which is the failure mode
  soft-UI designs usually ship. Measured on the landing page: body text **15.13:1** and muted
  text **6.51:1** against the material (both ≥ 4.5:1 AA).
- **Targets.** Standalone controls aim for 36 px in their smallest dimension (`min-h-9`).
  Interactive elements smaller than the WCAG 2.5.8 AA floor of 24 px: **0** on `/`,
  `/dashboard`, `/graph` and `/roadmap`, out of 55/37/67/54 interactive elements respectively.
- **Screen readers.** Icon-only buttons carry accessible names, the route changes announce via
  live regions (2 on the landing page), images carry `alt`, and `lang="en"` is set on `<html>`.
- **Forms.** Inputs have real labels, errors are announced, and the password field has a
  length and character-class policy shown before submission.

## Measured, with the command that measured it

| Fact | Command | Last result |
| --- | --- | --- |
| Reduced motion kills canvas, tilt and CSS animation | `npm run verify:browser` | 112/112 checks, 2026-10-14 08:49 UTC |
| No `backdrop-filter` fallback in any surface | `npm run verify:browser` | same run |
| Contrast ratios above | `npm run verify:browser` | 15.13:1 / 6.51:1 |
| 0 controls under the 24 px AA floor on four routes | `npm run verify:browser` | same run |
| 0 sub-36 px targets on the landing first screen | `BASE_URL=… npm run audience` | round 4 instrument output |
| `lang`, unnamed controls, images without `alt` per route | `BASE_URL=… npm run audience` | round 4 instrument output |

## Known exceptions and limits

- **Sub-36 px controls remain** on the 3D graph view's Canvas / 3D / List toggles (32 px tall,
  ~70–100 px wide) and on the four `/settings` checkboxes. They pass the WCAG 2.5.8 AA floor
  and are disclosed here rather than called fixed.
- **No screen-reader user testing.** No VoiceOver/NVDA/TalkBack session has been run against
  this app by a person who uses one, and no third-party accessibility audit has been
  commissioned. The checks above are automated or self-run; they are necessary, not sufficient.
- **Automated checks cover a subset.** Contrast is sampled on the landing page, not every
  surface; target sizes are counted, not judged for spacing; nothing here catches a confusing
  focus order or a badly worded accessible name.
- **Localisation is not attempted.** The interface is English-only; the dataset lists
  programming languages, not UI locales.

## Re-measuring

```bash
npm run build && npm run preview &          # serve the production build
BASE_URL=http://127.0.0.1:4173 npm run verify:browser
BASE_URL=http://127.0.0.1:4173 npm run audience:measure
```

`docs/browser-verification.json` records every browser check with its measured detail and
`screenshots` list; if this page and that file disagree, the file is right and this page is a
bug.


