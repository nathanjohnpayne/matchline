# Matchline UI Design Guidance

Target aesthetic: **Attio-like**. Clean, modern, dense, keyboard-first, monochrome-with-restraint. Not Apple-marketing-website whitespace-maxi; not SaaS-dashboard-rainbow-chart. The Attio reference is the direction:

[Attio Full Dashboard UI – Figma Community](https://www.figma.com/design/GG7XjKr0OyYZoxEvWJr63g/Attio-Full-Dashboard-UI-Screens--–-250--Screens-for-Research---Inspiration--Community-?node-id=0-1&p=f&t=RX6dMGwhOkxfSYAm-0)

This is the canonical reference for every UI surface in `src/routes/**`. When in doubt, open that Figma and check how Attio solves an analogous problem. Agents should read this doc before opening a PR that touches any `src/routes/**` file.

## The short version

Ten rules. If the PR can answer "yes" to each, it's on-brief.

1. **Monochrome + one accent.** Neutral grayscale palette; one brand accent used sparingly (interactive states, the approved-unit chip, the "send" CTA). Color earns its place — it's never decoration.
2. **Typography is the information architecture.** One typeface (Inter, or the Tailwind default `font-sans`). Hierarchy via size and weight, not color. Tabular-numeric font feature for scores, costs, latencies.
3. **Density over excess whitespace.** Attio packs information without feeling cramped. Tight line heights (`leading-tight`, `leading-snug`), small sizes for metadata (`text-xs`, `text-sm`), larger for primary content (`text-base` / `text-lg`). Padding is intentional, not padded-for-padding's-sake.
4. **Inline over modal.** Editing happens in place. No "Edit Experience Unit" modal — click the field, type, `Enter` commits, `Escape` cancels. Modals exist only for destructive confirmations (delete Unit, unlink Application) and the command palette.
5. **Keyboard-first.** Command palette (`Cmd+K` / `Ctrl+K`). Arrow keys navigate lists, `Enter` opens, `Escape` closes. Primary actions have shortcuts visible in tooltips and the command palette. Every mouse-reachable action is also keyboard-reachable — not the other way around.
6. **Subtle animation.** 150–200ms transitions on hover, focus, and state changes (`transition`, `duration-150`, `duration-200`). No bouncy easing. No decorative animation. Reduced-motion preference respected.
7. **Light + dark parity.** Both themes ship together from day one. Neither is an afterthought. Use Tailwind's `dark:` variants throughout rather than branching components.
8. **Data-dense surfaces.** Lists show a lot. Truncation is intentional and consistent (`truncate`, `line-clamp-2`). Hover reveals detail (tooltip, inline expand); the resting state is scannable.
9. **Consistent components.** Reuse a small primitive set (`List`, `Card`, `Chip`, `Button`, `Input`, `Popover`, `CommandPalette`). No one-off components unless a PR justifies the new primitive in its description.
10. **Fail visibly, still quietly.** Validation flags, errors, cap warnings all surface inline, never as a toast that disappears. Red is for genuine blocking state (export-blocked, validation-flag-unresolved), not for casual attention.

## Per-surface direction

### Sign-in (#57)

Borrow the Attio sign-in layout: centered card, minimal copy, one primary CTA. No marketing content. Single input (email) → password or provider. `matchline` wordmark top-center; tagline ("From what you've done to what's next.") one line below in small caps or medium-weight. Background is neutral, not a hero image.

### Onboarding (#18 / extraction flow)

Three-paned: left = input method selection (paste resume / LinkedIn HTML / long-form), center = the pasted content, right = extracted Units streaming in as they land. Mirrors Attio's "import contacts" flow — progress is visible in real time, nothing feels like a batch operation. Progress indicator is a thin top bar, not a spinner overlay.

### Unit Review (#18)

The most data-dense surface in V1. Take the pattern directly from Attio's list view:

- **Filter bar top**: skill / tool / domain / date range / approval-status chips. Chips are filter toggles, not badges.
- **List rows**: normalized summary, compressed metadata row (skills + tools as chips, metrics inline), approval state as a left-rail icon (✓ / — / ⚠). Row height: tight, ~48px.
- **Inline edit**: click any field → field becomes editable in place. `Tab` moves between fields. `Enter` commits. `Escape` reverts.
- **Approve/reject/flag**: single-key shortcuts when a row is focused (`a`, `r`, `f`). Visible in a help popover via `?`.
- **Right-pane detail**: when a row is expanded, metadata opens in a right pane rather than a modal, so the list stays in context.

No approval badges shouting for attention. Approved is the default visual state; unapproved is slightly dimmed.

### Role Detail (#21)

Three tabs: **Requirements**, **Matches**, **Applications**. Tab bar is minimal — underline-on-selected, not a pill.

Matches tab is the heart of the product:

- Split view: Requirements on the left as a vertical list, candidate Units on the right scoped to the selected Requirement.
- Each candidate Unit row shows: the match's composite score (right-aligned, tabular-numeric), the surface_evidence string (truncated to 2 lines), a small chevron to expand the full rationale.
- Gaps surface in the Requirements list itself — Requirements with no qualifying match show a muted "gap" chip. Don't hide them. Don't move them to a separate tab. Users need to see what's missing next to what's covered.
- Approve/reject on a match uses the same keyboard shortcuts as Unit Review. Consistency across surfaces is a feature.

### Application Editor (#24)

Two-pane layout verbatim from Attio's inspector-pattern views:

- Left: the generated output (resume or cover letter), rendered as an editable document. Each claim is subtly underlined (a 1px underline with a lower opacity) where a source-Unit reference is attached.
- Right: the approved Units pane. Hovering a left-pane claim highlights the source Unit(s) on the right. Clicking a right-pane Unit scrolls it into view and highlights every claim grounded in it.
- Validation flags surface inline on the left: red 1px underline where a claim failed traceability, a yellow underline where specificity flagged. Never a modal, never a toast. The underline opens a popover on click with the flag reason and three resolution paths (edit / remove / add supporting Unit).
- Export is disabled with a tooltip as long as any flag is unresolved. The disabled state is an affordance, not a scold — make it feel like an expected workflow state, not a rejection.

### Pipeline (#32)

Kanban with seven columns. Each column has a muted header row with stage name + count. Cards are tight:

- Company name (medium weight, first line).
- Title (muted, second line, truncated).
- Metadata row (third line): days-in-stage chip, next-action chip, key-contact avatar.
- Maximum three-line card. Resist adding more.

Drag-to-stage uses the browser's native drag API with a subtle 2px border highlight on the drop target. No physics, no bounce.

Right sidebar: tasks + follow-up reminders. Same density as the board. Reminders surface at the top when due.

## Component primitives (build order)

Start small. Resist the temptation to bring in a full component library — Attio's aesthetic doesn't come from shadcn/ui defaults. Custom Tailwind is fine. If a library is used, pick one that ships unstyled primitives (`@radix-ui`) and style them against this guidance.

Build in this order, not in parallel:

1. `Button` (primary / secondary / ghost / destructive variants).
2. `Input` (text / number, inline-edit variant, focus ring).
3. `Chip` (filter toggle / static metadata / approval-state — distinct from button by size and prominence).
4. `List` + `ListRow` (keyboard-navigable, approve/reject shortcut bindings).
5. `Popover` (Radix under the hood; custom styled).
6. `CommandPalette` (Cmd+K; search + actions).
7. `ClaimAnnotation` (inline text decoration + popover; the Editor's workhorse).
8. `Kanban` (columns + draggable cards; built on the List primitive).

## Color tokens

Resist opening this section to new tokens without a strong case. The fewer tokens, the more consistent the product. Extending is easier than subtracting.

- **Neutrals**: Tailwind `zinc` scale (50 → 950). Background, surface, text, muted-text, border.
- **Accent**: one token, TBD (leaning toward a desaturated indigo or slate-blue that survives the light/dark transition). Used for: primary CTA, approved-unit chip border, selected-state rail, focus ring.
- **Semantic**: `red-600` for validation flags (traceability failure), `amber-500` for specificity flags and cap warnings, `emerald-600` for successful approval states. Each used only in its documented role; never decoratively.

## Typography tokens

- **Font family**: Tailwind `font-sans` (Inter via `@fontsource/inter` or system fallback).
- **Scale**: `text-xs` (metadata), `text-sm` (body default), `text-base` (primary content in dense surfaces), `text-lg` (section headers), `text-2xl` (screen titles). No larger without a reason.
- **Weight**: `font-normal` (body), `font-medium` (UI elements, subtle emphasis), `font-semibold` (headers, approved-state). No `font-bold` — over-weight in dense UIs reads loud.
- **Numeric**: `font-variant-numeric: tabular-nums` on every score, cost, latency, and percentage.

## Motion

- Hover / focus transitions: `duration-150`, `ease-in-out`.
- State changes (stage transitions, flag resolution): `duration-200`.
- Layout shifts: avoid. Reserved for drawer / panel open-close only, and always `duration-200`.
- Respect `prefers-reduced-motion`: every transition class wrapped or gated accordingly.

## Accessibility baseline

Not a separate phase; built in.

- Every interactive element has a visible focus ring (Tailwind `ring-2` on focus).
- Every icon-only button has an `aria-label`.
- Keyboard reach: full product usable without a mouse. Tested per-PR by tabbing through the changed surface.
- Color contrast: 4.5:1 for body text, 3:1 for large text. Enforced in the review checklist, not just at ship.

## Out-of-scope for V1

Resist these until they're earned by usage data:

- Theming beyond light/dark.
- Customizable layouts (user-draggable panes, saved view presets).
- Animations beyond the Motion section above.
- Any notification surface — inline feedback only.
- Icon libraries beyond `lucide-react` (one icon set, minimalist by default).

## When to deviate

The Figma reference is the direction; it's not a pixel contract. Deviate when Matchline's specific problem (zero-fabrication traceability, approve-gate workflows, match-score pair views) needs something Attio doesn't demonstrate. Note the deviation in the PR description and point back to this doc's relevant rule.

When you're unsure, default to the more restrained choice — and open the Figma.
