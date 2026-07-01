# Data-view colors (JetBrains Darcula)

The structured **data view** — the `yamlover` / `json5p` / `yamlover/schema` tabs rendered by
`render.tsx` into `<pre class="code">` — is syntax-highlighted with the **JetBrains Darcula**
editor palette, so it reads like the YAML/JSON editor in an IntelliJ-family IDE.

These colors apply **only** to the data view. The rest of the app keeps its own theme
(Catppuccin-derived `--bg`/`--fg`/… in `styles.css`); the TOC type-icon colors (`.t-*`) and the
board chips are unaffected.

## Palette

Defined as `--jb-*` CSS variables in `:root` (`styles.css`) and applied to the token classes
emitted by `render.tsx`. The hue roles are Darcula's, but each color is lifted in
saturation/lightness: the original values were tuned for IntelliJ's `#2B2B2B` editor background
and read washed-out on our darker blue-tinted `--bg` (`#1E1E2E`).

| Token | Class | Variable | Hex | Darcula original | Note |
|------|-------|----------|-----|------------------|------|
| Mapping / property key | `.k` | `--jb-key` | `#BB89D2` | `#9876AA` | purple |
| String scalar | `.s` | `--jb-string` | `#94C577` | `#6A8759` | green |
| Number scalar | `.n` | `--jb-number` | `#79AFD8` | `#6897BB` | blue |
| `true` / `false` | `.b` | `--jb-keyword` | `#E6914D` | `#CC7832` | orange (keyword) |
| `null` / `~` | `.null` | `--jb-keyword` | `#E6914D` | `#CC7832` | orange (keyword) |
| Structural punctuation `:` `{}` `[]` | `.punct` | `--jb-punct` | `#A9B7C6` | `#A9B7C6` | default text |
| Comment / `!!binary` note | `.c` | `--jb-comment` | `#808080` | `#808080` | gray |
| YAML list dash `-` | `.yaml-dash` | `--jb-dash` | `#808080` | `#808080` | gray — matches the fold chevron |

Reference values from the Darcula editor scheme (not currently overridden, kept for context):

| Role | Hex |
|------|-----|
| Editor background | `#2B2B2B` |
| Default foreground | `#A9B7C6` |
| Hyperlink | `#287BDE` |

## Changing them

Edit the `--jb-*` variables in `:root` (`styles.css`) — every data-view token follows. To restyle a
single token, change the matching class rule (`.k`, `.s`, …) directly.
