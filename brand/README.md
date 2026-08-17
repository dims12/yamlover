# yamlover logo kit

## Naming

- Product name: **yamlover** — always one lowercase word.
- Short name and compact mark: **yo** — always lowercase.
- Meaning: **YAML Overlay**. Do not spell it “Yam Lover”, “yaml lover”, or “YAMLover”.

## Assets

- `yo-mark.svg` — the symbol on its own, for badges and any surface down to about 32 px.
- `yo-favicon.svg` — the small cut on a cobalt tile: browser tabs and anything else drawn at 16–32 px.
- `yo-app-icon.svg` — square application icon.
- `yo-wordmark.svg` — compact shorthand lockup.
- `yamlover-lockup.svg` — primary full-name lockup.
- `yamlover-logo-system.png` — visual overview and concept board.
- `yamlover-social-preview.png` — the 1280×640 card GitHub shows when the repo is linked
  anywhere (Settings → General → Social preview; it cannot be set from the API or `gh`).
  `yamlover-social-preview.html` is its source: open it at 1280×640 and screenshot to redraw.
- `youtube-avatar.png` (800×800) and `youtube-banner.png` (2048×1152) — the channel art for
  [@yamloverlay](https://www.youtube.com/@yamloverlay), each with its `.html` source beside it.
  YouTube crops the avatar to a circle, and only the centred 1235×338 of the banner is safe on
  a phone, so nothing but the ground may live outside it. Both are uploaded by hand in YouTube
  Studio → Customisation → Branding. There is deliberately **no** video watermark.

The `.html` sources are screenshotted, not exported: serve this folder over http (`file:` is
blocked in the automation browser), open the page at exactly the pixel size named in its
comment, and take a full-page shot.

The mark is two-coloured: the `y` in ink, the `o` in cobalt — the same split the lockup makes at
`yaml`/`over`. Reversed onto a cobalt ground (the app icon, the favicon tile, an active toolbar
button) it goes to solid white instead: a cobalt `o` on cobalt is no `o` at all.

## Small sizes

Below roughly 32 px the three branch nodes swallow the arms they sit on and the `y` turns to
mush, so the small sizes use a **small cut**: the branch nodes dropped and the stroke thickened
to compensate. The round caps still terminate the branches, so the silhouette does not change.
A line mark that fine also all but vanishes in a browser tab, which is why the favicon puts it
on a tile.

This folder is the source of truth. The copies that ship are:

- `tools/server/public/yo-favicon.svg` — the app's own browser-tab icon.
- `tools/demo/public/yo-favicon.svg` and `tools/demo/public/yo-mark.svg` — the demo landing page.
- `tools/server/src/client/brand.tsx` — the small cut redrawn as JSX, which has to take its two
  colours from CSS to survive being reversed on an active toolbar button.
- `tools/jetbrains-plugin/src/main/resources/icons/yamlover{,_dark}.svg` — the 16 px file-type
  icon, and `META-INF/pluginIcon{,_dark}.svg` — the 40 px Marketplace logo. The IDE has no
  `currentColor` to offer, so those carry a hand-cut dark palette instead of one adaptive file.

Change a mark here and those follow by hand.

Keep the comments in these files ASCII. An em dash written into an SVG comment has already once
landed as a raw control byte, which makes the whole file unparseable XML — and a favicon that
silently renders as nothing.

## Color

- Cobalt: `#246BFD`
- Indigo: `#2437B8`
- Ink: `#111827`
- Warm white: `#FAFAF7`

Keep clear space around a logo equal to the diameter of the mark’s smallest node. Use the symbol alone below 96 px wide; use the full lockup when the name needs to be learned or confirmed.

## Construction

The three branches of the `y` run at exact 45° angles. The center node of the `o` sits on the down-right continuation of the `y`’s upper-left branch. The outer circle of the `o` is mathematically tangent to the `y` at its crossing point: the center-to-crossing distance is exactly equal to the circle radius.
