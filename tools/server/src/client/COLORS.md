# Data-view colors (JetBrains Darcula / IntelliJ Light)

The structured **data view** — the `yamlover` / `json5p` / `yamlover/schema` tabs rendered by
`render.tsx` into `<pre class="code">` — is syntax-highlighted with the **JetBrains Darcula**
editor palette (dark theme) or **IntelliJ Light** (light theme), so it reads like the YAML/JSON
editor in an IntelliJ-family IDE in either mode.

These colors apply **only** to the data view. The rest of the app keeps its own theme
(Catppuccin-derived `--bg`/`--fg`/… in `styles.css`: Mocha-toned dark, Latte light); the TOC
type-icon colors (`.t-*`) and the board chips are unaffected.

## Theme switching

The whole palette — chrome and data view alike — flips on ONE attribute:
`html[data-theme="light"]` (styles.css `:root[data-theme="light"]` overrides every variable).
The attribute is stamped by `browser-settings.ts applyTheme()`, resolving the `theme:` setting
as browser settings document → project settings → `dark`; `index.html` carries a pre-paint
inline script reading the `yamlover.theme` mirror key so a reload never flashes the wrong theme.
Semantic state/effect variables (`--danger`, `--ok`, `--warn`, `--zebra`, `--scrim`,
`--swatch-ring`, `--hover-filter`) are themed the same way — never hardcode a status color.

## Palette

Defined as `--jb-*` CSS variables in `:root` (`styles.css`) and applied to the token classes
emitted by `render.tsx`. The hue roles are Darcula's, but each color is lifted in
saturation/lightness: the original values were tuned for IntelliJ's `#2B2B2B` editor background
and read washed-out on our darker blue-tinted `--bg` (`#1E1E2E`).

| Token | Class | Variable | Dark (Darcula-derived) | Darcula original | Light (IntelliJ Light) | Note |
|------|-------|----------|-----|------------------|-----|------|
| Mapping / property key | `.k` | `--jb-key` | `#BB89D2` | `#9876AA` | `#660E7A` | purple |
| String scalar | `.s` | `--jb-string` | `#94C577` | `#6A8759` | `#067D17` | green |
| Number scalar | `.n` | `--jb-number` | `#79AFD8` | `#6897BB` | `#1750EB` | blue |
| `true` / `false` | `.b` | `--jb-keyword` | `#E6914D` | `#CC7832` | `#0033B3` | orange (dark) / navy (light) |
| `null` / `~` | `.null` | `--jb-keyword` | `#E6914D` | `#CC7832` | `#0033B3` | as `true`/`false` |
| Structural punctuation `:` `{}` `[]` | `.punct` | `--jb-punct` | `#A9B7C6` | `#A9B7C6` | `#4C4F69` | default text |
| Comment / `!!binary` note | `.c` | `--jb-comment` | `#808080` | `#808080` | `#8C8C8C` | gray |
| YAML list dash `-` | `.yaml-dash` | `--jb-dash` | `#808080` | `#808080` | `#8C8C8C` | gray — matches the fold chevron |

Reference values from the Darcula editor scheme (not currently overridden, kept for context):

| Role | Hex |
|------|-----|
| Editor background | `#2B2B2B` |
| Default foreground | `#A9B7C6` |
| Hyperlink | `#287BDE` |

## Changing them

Edit the `--jb-*` variables in `:root` (dark) and `:root[data-theme="light"]` (light) in
`styles.css` — every data-view token follows. To restyle a single token, change the matching
class rule (`.k`, `.s`, …) directly.
