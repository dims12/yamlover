# Vendored: DjVu.js

`djvu.js` is a prebuilt bundle of the **DjVu.js library** by Roman Chistokhodov
(RussCoder), used by the `djvu` renderer to decode `.djvu` documents in the
browser (the browser has no native DjVu support).

- Upstream: https://github.com/RussCoder/djvujs — https://djvu.js.org
- Version: 0.5.4
- **License: GNU GPL v2** (the library only; the upstream viewer/extension are
  Unlicense). By bundling it here, the distributed client includes GPL-v2 code.
  See https://www.gnu.org/licenses/old-licenses/gpl-2.0.html.

## Why it's vendored

The npm package `djvujs-dist` ships *source*, not an importable module (no
`main`/`module`/`types`), and pulls a large dev toolchain. We build its IIFE
bundle once and commit the single output here instead of depending on the
package at runtime.

## Regenerating

```sh
npm install djvujs-dist            # temporary
cd node_modules/djvujs-dist/library && npm run build
cp dist/djvu.js <repo>/tools/server/src/client/vendor/djvu.js
npm uninstall djvujs-dist
```

The bundle defines a global `DjVu` (`var DjVu = (function(){…})()`); the renderer
loads it as a classic `<script>` and uses `new DjVu.Document(arrayBuffer)`.
