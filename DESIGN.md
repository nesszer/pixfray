# PixFray design

Applies to every page PixFray renders: the home page tour (`/`), the picker (`/play/`), a channel's fighter page
(`/?channel=`), `/start/`, the mod page (`/admin/`), the owner page, the not-found page and the OBS overlay.
The look is a **night arena tavern**: warm near-black wood, one gold trim accent, Fraunces headings, and the 3D
arena scene behind the page. Everything here is already built in `public/dashboard.css` (pages) and
`src/intro/intro.css` (home page); this file says how to use it. Read it before changing any page.

## 1. Who each page is for

Write one line for yourself before laying anything out: who opens this page and what they came to do.

| Page | Reader and job | First screen holds |
|---|---|---|
| `/` | A viewer or streamer who heard of PixFray: learn what it is | The 3D tour and one way in |
| `/play/` | A viewer: find the stream they watch | "Which stream are you watching?", the search, the channel rows |
| `/?channel=` | A viewer: build their fighter and save it | The 3D fighter stage, the character grid, **Save profile** |
| `/start/` | A streamer: set PixFray up | The headline, **Sign in with Twitch**, the live overlay demo |
| `/admin/` | A mod or the broadcaster: run duels live | The live state, Pause duels, the setup checklist |
| overlay | Stream viewers, through OBS | Fighters and duels only, on a transparent page |

- Tools (`/?channel=`, `/admin/`) put controls first and explanation second, in one line of how-to at most.
- Every screen has **one gold primary button**. On a page that the header's "Pick your fighter" points to, that
  button drops to plain so the page's own action stays the only gold one.

## 2. Structure

- One `h1` per page that says the subject in plain words ("Set up PixFray on your Twitch channel",
  "Duel controls for nesszerra"). Headings are sentence case and upright.
- Every page uses the shared header (brand left, plain links, "Pick your fighter" as a gold-edged button) and the
  shared quiet footer. Don't build a page-specific header.
- Tabs hold sections on the fighter and mod pages (`.tabs`, `role="tab"`, arrow keys move between them, the hash
  follows the tab). Ranks and Rules are reading tabs: switching to them never moves the page.
- Separate sections with space and 1px rules, never with nested boxes. A picture may keep its corner brackets;
  the copy around it sits straight on the page.
- Text is left-aligned at reading width (`--measure`, 68ch). Tables use the full width of their column.

## 3. Copy

- Plain and concrete, with a light arena voice allowed in headings and empty states ("This page drifted off the
  island", "Lost in the arena? Type !fray"). Instructions, errors and buttons stay plain.
- Buttons say what happens: "Save profile", "Sign in with Twitch", "Copy link", "Connect chat", "Need $40 more".
  Never "Get started", "Learn more" or "Submit".
- Name chat commands exactly as typed (`!challenge @name`, `!fight`) in `code`.
- Errors say what went wrong and what to do next. A locked or unavailable control says why, in quiet text.
- No marketing filler, exclamation marks or emoji in headings, buttons or bot lines. Never invent numbers,
  channels or fighters for a page; demos use `demo=1` data and say so.

## 4. Visual rules

- **Theme:** dark always (`color-scheme: dark`); it sits next to OBS. No light theme.
- **Color:** use the tokens only. Backgrounds `--bg` `--surface` `--raised` `--panel`; rules `--border`
  `--border-strong`; text `--text` `--text-2` `--text-3`. **Gold (`--accent` / `--trim`) is the one accent**: links,
  the primary button, the selected item, the active tab underline and the brand mark. `--positive` and
  `--negative` mean win/loss or ok/error and always repeat a word, never carry meaning alone. Never add a new color.
- **Type:** Fraunces (`--font-display`) for `h1`–`h3`, legends, the brand and channel names; the system sans for
  everything else. Scale 12/14/16/20/24/32/44 px (`--text-xs`…`--text-3xl`); hero titles may go to 52–56 px.
  Weight 650 for headings and strong labels. Small text never goes under 14 px except badges and captions (12).
  Numbers use tabular figures (`.num`, `font-variant-numeric: tabular-nums`). Monospace is only for commands,
  links to copy and keys.
- **Space:** the `--space-1`…`--space-9` scale (4–96 px). No other values.
- **Shape:** `--radius-sm` (4 px) on buttons, inputs, badges and chips; `--radius` (6 px) on panels. A 1px border
  or a background, not both plus a shadow. Shadows only on layers that float (the pinned phone preview).
- **Selection is a lock-on:** a picked tile, build, channel row or the 3D stage gets the four gold corner brackets
  (`--lock` via `border-image`), not a filled gold box.
- **Pixel art stays pixel art:** sprites draw at whole-pixel scale with `image-rendering: pixelated`.

## 5. Motion

- The arena moves only as **baked stills scrubbed by scroll** (`src/scrub.js`, `public/assets/scene/seq/`). Only the
  home page runs live WebGL as the page itself, and the fighter stage is the one live 3D view elsewhere.
- Other motion is feedback for an interaction: hover lift, tab panel settling, the Save bar stepping aside. No
  entrance or decorative scroll animations.
- Everything respects `prefers-reduced-motion`: scrubs and tours cut to whole steps.
- The home page keeps its frame budget: it caps resolution and steps quality down on slow machines. Don't add work
  per frame without measuring it.

## 6. Overlay (OBS)

- Transparent page at 1920×1080; nothing but fighters, nameplates, speech bubbles and duel effects. No panels,
  no logo, no winner banner (the bot names the winner in chat).
- Duel effects are 2D (glow, sparks, shake, knockout push-in) and turn off with `fx=off`. Bubbles turn off with
  `bubbles=0`. Size and cap come from the URL options in `docs/PAGES.md`.
- Nameplates stay readable over any game: solid dark plate, 1px border, 14 px bold text.

## 7. Responsive

- It must read correctly at **390 px and 1280 px**. Breakpoints: 900 (stacked layout, pinned preview, fixed Save
  bar), 760 (phone header, wrapping tabs), 480 (single column).
- Touch targets are at least 44 px. Tabs and filter chips wrap or show that they scroll (a fade at the edge).
- Wide tables scroll inside `.table-wrap`, or drop detail columns on phones (`.wide-only`, column rules for
  `#leaderboard`, `#duels`, `#players`, `#ranks`). No horizontal page overflow, ever.
- The phone Save bar never covers content: it steps aside while scrolling down, and focused fields scroll clear
  of it (`scroll-padding-bottom`).

## 8. Primitives

All in `public/dashboard.css`; use these names instead of new ones.
- **Layout:** `.page`, `.page-header` (`h1`, `.subtitle`, `.meta`), `.section`, `.stack`, `.grid-2`, `.grid-3`,
  `.split`, `.hero` / `.hero-grid`, `.landing`, `.with-index`.
- **Blocks:** `.summary`, `.card`, `.callout[.warning|.negative]`, `.note`, `.hint`, `.caveat`, `.muted`,
  `.small`, `.status[.ok|.error|.warning]`.
- **Numbers:** `.stat-strip` > `.stat` (`.label`, `.value`, `.delta.up|.down`), `.table-wrap` > `table.data`
  (`td.num`, `tr.total`, `tr.me`, `tr.podium`), `.bars`.
- **Controls:** `.btn`, `.btn-primary`, `.btn-small`, `.btn-danger`, `.badge[.positive|.negative|.warning]`,
  `.toolbar`, `.controls`, `.config-grid`, `.config-bar` (sticky Save), `.tabs`, `.filter-buttons`, `.swatches`.
- **PixFray pieces:** `.fighter-card`, `.showcase` (3D stage with lock-on), `.preview` (on-stream view),
  `.char-grid` > `.char-option`, `.build-bar` > `.build`, `.upgrade-list`, `.checklist`, `.setup-steps`,
  `.channel-list` > `.channel`, `.stage` (overlay demo), `.nameplate`.

## 9. Avoid

Each of these came back in a review round. Check for them by name.

1. **Card soup:** a panel inside a panel, or three frames where one will do.
2. **Second gold button:** more than one `.btn-primary` on a screen, or the header button competing with the page's.
3. **Gold fill selection:** a filled gold box instead of the lock-on corners.
4. **New color or size:** a hex value, font size, radius or spacing outside the tokens.
5. **Live backdrop:** a full-page live WebGL scene on a page other than `/`.
6. **Dimmed steps:** marking the active step by fading the others; mark it with the gold rule instead.
7. **Fake controls:** a picture of controls (the locked mod-page preview) drawn so it looks clickable.
8. **Hidden row:** chips or tabs cut off at the edge with no sign they scroll.
9. **Covered content:** a sticky or fixed bar sitting over fields, the footer or the last row.
10. **Squeezed table:** a data table at prose width, or numbers left-aligned.
11. **Smooth sprites:** pixel art scaled with smoothing, or at a fractional scale.
12. **Generic SaaS:** gradients, glow blobs, glass blur, pill shapes, emoji headings, a hero slogan with two buttons.

## 10. Verify before handing over

1. `bun run test:ui` passes (page structure, overflow at both widths, one sign-in button, tab behavior).
2. Look at every changed page at 1280 and 390 px in headed Chrome, signed in and signed out. Check the reader's
   job is obvious in the first screen, nothing overflows or is clipped, and the empty states read as sentences.
3. Fix problems with these rules and tokens, not by hand-tuning one page.

## 11. Changing this file

A rule earns its place when a review keeps catching the same problem. Put the fix in the narrowest place: a class
or token in `dashboard.css` for mechanics, a check in `tests/ui.mjs` for anything testable, and prose here for
judgment. Recheck the affected pages at both widths after the change.
