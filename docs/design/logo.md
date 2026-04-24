# Matchline logo — implementation

Canonical logo spec and implementation notes. This doc governs every
surface that renders the matchline mark — app chrome, favicons, OG
images, emails, and any external artwork.

See also: [`BRAND.md`](../../BRAND.md) for brand vocabulary and
[`docs/design/ui-guidance.md`](ui-guidance.md) for UI tokens and
typography.

## Decision

Variant C from the logo exploration: a purely typographic mark. The
pipe character does all the semantic work — it is both the
architectural match-line symbol (a vertical seam where two sheets
align) and the typographic divider between "match" and "line."

- **Wordmark**: `match|line`
- **Monogram / icon**: `m|`
- **Typeface**: Inter, lowercase
- **Letter weight**: 500 (medium)
- **Pipe weight**: 700 (bold) — asserts the seam structurally
- **Color**: monochrome, inherits text-primary in whatever context it sits

No flame. No architectural tick marks. No long line. No accent color.
The brand's one slate accent is reserved for the product UI's
interactive states, not for the logo.

## Files

Three SVGs ship from `public/`:

| File | Purpose | ViewBox |
|---|---|---|
| `public/favicon.svg` | Browser tab, bookmark, PWA icon | 64×64 |
| `public/logo-monogram.svg` | Scalable `m\|` for avatars, compact spots, app badges | 64×64 |
| `public/logo-wordmark.svg` | Scalable `match\|line` for email headers, external surfaces, OG images | 320×72 |

All three respect dark mode via `prefers-color-scheme` and render in
`#0F0F10` on light backgrounds, `#F5F5F5` on dark.

## In-app usage

Render the wordmark through the reusable component — do **not**
import the SVG files for in-app chrome and do **not** hand-roll the
inline JSX at new call sites.

```tsx
import Wordmark from "./components/Wordmark.tsx";

<Wordmark className="text-lg" />              // full wordmark
<Wordmark className="text-3xl" monogram />    // monogram variant
```

`<Wordmark />` is the single source of truth for the variant-C
treatment. It guarantees:

- **Visual contract.** `font-medium` letters + `font-bold` pipe +
  `tracking-tight` on the outer span. Inherits parent color so
  light/dark parity is automatic.
- **Accessibility contract.** Outer span carries `role="img"` +
  `aria-label="matchline"` so screen readers announce the brand
  as a single named graphic. Inner pipe span carries
  `aria-hidden="true"` so the separator glyph isn't announced
  (otherwise assistive tech reads the mark as "matchline pipe").
- **Test pin.** `src/components/Wordmark.test.tsx` pins both
  contracts, including a regression guard against the pre-variant-C
  treatment (`font-semibold` + zinc-tinted pipe).

Size the wrapper with Tailwind text-size utilities (`text-lg`,
`text-3xl`, etc.) on `className` or on an enclosing element. Do not
override color on the pipe — monochrome is the commitment.

If you ever need to recreate the pattern outside the component (email
HTML, a one-off standalone surface), the equivalent markup is:

```tsx
<span
  role="img"
  aria-label="matchline"
  className="font-medium tracking-tight"
>
  match
  <span aria-hidden="true" className="font-bold">|</span>
  line
</span>
```

- `font-medium` → Tailwind weight 500 (letters)
- `font-bold` on the pipe → Tailwind weight 700 (the seam)
- `tracking-tight` → matches the negative letter-spacing used in the SVGs
- `role="img"` + `aria-label` + `aria-hidden` → the same accessible
  name behavior the component provides

## Call sites

The variant-C treatment ships at two in-app surfaces as of #76. Both
use `<Wordmark />`; extend this list rather than introducing a third
hand-rolled copy:

- `src/App.tsx` — app header, `<Wordmark className="text-lg" />`
- `src/routes/SignIn.tsx` — sign-in card header,
  `<Wordmark className="text-3xl text-zinc-900 dark:text-zinc-100" />`

## Favicon wiring

The SVG favicon is wired via `index.html`:

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
```

**PNG fallback — deliberately scoped out for V1.** SVG favicons are
supported in Chrome 80+, Firefox 41+, Safari 9+, which covers the V1
single-user target. When the app goes external-facing, generate a
32×32 PNG (the 16×16 size is too small for typographic marks — use
32×32 rasterized at browser scale), commit as `public/favicon.png`,
and add the fallback link:

```html
<link rel="alternate icon" type="image/png" href="/favicon.png" />
```

The PNG can be rasterized from `favicon.svg` with any vector tool
(Figma export, Inkscape, `resvg-js`, `@resvg/resvg-js` on CI).

## Clear space

Reserve padding around the wordmark equal to the cap height of the
"m". At weight 500, 52px, the cap height is roughly 22px — so reserve
at least 22px of clear space on all sides before placing other UI next
to the mark.

For the monogram the same rule applies: clear space equal to the "m"
cap height on all sides.

## Minimum sizes

- Wordmark: 120px wide. Below that, the pipe disappears into
  surrounding letterforms; use the monogram instead.
- Monogram: 16px wide. At smaller sizes the pipe collapses into a
  single pixel at most screen DPRs — use a pre-rasterized PNG.

## Font loading

Inter is declared in the SVG font stack but not currently loaded by
the application. Until it is, the in-app JSX wordmark renders in the
Tailwind default font stack (system sans). This is acceptable per
[`ui-guidance.md § Typography`](ui-guidance.md) which allows Tailwind
default as a fallback.

The standalone SVG files render in whatever sans-serif the consumer
has available. System sans is the likely fallback on most surfaces and
is close enough in the relevant size range that the mark holds its
shape.

To load Inter (recommended once the app goes external-facing), add to
`index.html`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700&display=swap" rel="stylesheet" />
```

And prepend Inter in `src/index.css`:

```css
body {
  font-family:
    Inter,
    ui-sans-serif,
    system-ui,
    -apple-system,
    "Segoe UI",
    Roboto,
    "Helvetica Neue",
    Arial,
    sans-serif;
}
```

Loading only weights 500 and 700 keeps the font payload small — those
are the only weights the logo needs. Other surfaces that need
additional weights should add them to the URL, not load a separate
font file.

## Production polish

The SVG files use live text rather than outlined paths. This keeps
them editable (you can tweak letter-spacing or the pipe weight by
hand) but makes them dependent on the consumer having a suitable sans
font available.

For contexts where font availability is not guaranteed — OG images
scraped by social platforms that rasterize the SVG, printed
materials, email clients with restricted CSS — convert the text to
paths before final export:

1. Open the SVG in Figma or Illustrator
2. Select the text → "Outline text" (Figma) or "Create outlines" (Illustrator)
3. Re-export as SVG

Keep the source text-based SVGs in `public/` and check any path-based
exports into `public/*-paths.svg` alongside. Don't replace the source.

## Forbidden treatments

The following variations were rejected during the exploration and
should not reappear:

- Flames, match heads, architectural tick marks, or any other
  decorative element. The mark is purely typographic.
- Warm colors (coral, amber, orange) on any part of the logo. The app
  palette is monochrome + one cool accent; warm palette fights both.
- The pipe in a different color from the letters. Monochrome is the
  commitment — a colored pipe turns the logo into an accent-bearing
  element, which the "one accent, used sparingly" rule in
  `ui-guidance.md` reserves for interactive UI states.
- Uppercase ("MATCHLINE", "Matchline"). Lowercase is always.
- Stacking the pipe vertically as a separator between wrapped lines.
  The wordmark is horizontal; if space forces wrapping, reduce the
  size or use the monogram.
