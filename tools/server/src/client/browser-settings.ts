// The BROWSER settings document — the per-device settings layer (the second gear in the topbar).
//
// A yamlover text stored in localStorage, carrying the SAME schema as the project's
// `.yamlover/settings.yamlover` (`!!<*yamlover:$defs:config>`). It is a first-class, inspectable
// document — rendered and edited in the same generic data view (BrowserSettingsView posts it to
// the stateless /api/preview + /api/edit-text) — NOT a bag of ad-hoc keys. Resolution priority for
// a viewer preference: URL param → this document → the project settings → the built-in default.
// Only VIEWER preferences live here (reading width, theme); the server-side creation locations
// (annotations/tags/sidecars) are project-governed — a key authored here does not reach them.
//
// The document always AUTHORS every templated viewer key (the template writes them; an older doc
// is upgraded on read): the generic data view can only edit keys that are present, so presence is
// what makes a setting selectable. What the visible document says is what applies — the project
// layer decides only when this document's value is missing-in-effect (invalid, or unparsable).

import { isPointer } from "../../../parser/ts/src/ir.ts";
import type { Node } from "../../../parser/ts/src/ir.ts";
import { parseYamlover } from "../../../parser/ts/src/yamlover.ts";
import { fetchConfig } from "./api";

/** The browser settings document's VIRTUAL node path — `*:: .browser: settings.yamlover`. It is
 *  a real address (URL, breadcrumbs, edit targets) in a namespace no served tree can occupy: the
 *  walk skips every dot-directory except `.yamlover`, so `:.browser:…` never names a server node.
 *  The document itself still lives in this browser's localStorage. */
export const BROWSER_SETTINGS_PATH = ":.browser:settings.yamlover";

/** Whether a client path addresses the browser-settings namespace (the virtual `.browser` dir). */
export function isBrowserSettingsPath(p: string): boolean {
  return p === ":.browser" || p === BROWSER_SETTINGS_PATH || p.startsWith(":.browser:");
}

const KEY = "yamlover.settings";
const LEGACY_WIDTH_KEY = "yamlover.markupWidthCh"; // pre-document storage — migrated once, then dead

const MIN_WIDTH = 20;
const MAX_WIDTH = 400;

/** The source a fresh browser-settings document is born with: the same self-documenting shape as
 *  the project template (engine settings.ts DEFAULT_SETTINGS_SOURCE), scoped to this device. */
export function browserSettingsTemplate(width: number): string {
  return `# Browser settings — THIS DEVICE only (stored in this browser, not in any project), living
# at the virtual path *:: .browser: settings.yamlover. The same schema as
# .yamlover/settings.yamlover; a key authored here OVERRIDES the project's value for viewer
# preferences (reading width). Server-side creation locations stay project-governed. Edit me
# here, or via the second gear in the topbar.
!!<*yamlover:$defs:config>

width: ${width}   # reading width (ch) for rendered prose (markdown, asciidoc, chapters)
theme: dark   # ui palette: dark | light
`;
}

// Settings keys ADDED to the template after a release: an EXISTING document predates them, and
// the generic data view can only edit keys that are present — so upgrade in place by appending
// the template's line (settings are defaults; appending the default changes no behavior). The
// `^key:` check is line-anchored, so a commented-out `# theme: …` still counts as absent.
const TEMPLATE_UPGRADES: { key: string; line: string }[] = [
  { key: "theme", line: "theme: dark   # ui palette: dark | light" },
];

function upgraded(src: string): string {
  let out = src;
  for (const u of TEMPLATE_UPGRADES) {
    if (new RegExp(`^${u.key}:`, "m").test(out)) continue;
    out = (out === "" || out.endsWith("\n") ? out : out + "\n") + u.line + "\n";
  }
  return out;
}

/** The browser-settings document text. Initialized on first read from the template — migrating a
 *  legacy `yamlover.markupWidthCh` width once — and persisted; a document from an older release
 *  gains newly-templated keys (appended, defaults). When storage is blocked (private mode), the
 *  template is returned un-persisted so the page still works for the session. */
export function browserSettingsSource(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing != null) {
      const up = upgraded(existing);
      if (up !== existing) localStorage.setItem(KEY, up);
      return up;
    }
    const fresh = browserSettingsTemplate(legacyWidth() ?? 72);
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return browserSettingsTemplate(72);
  }
}

/** Persist a new document text (the edit flow's output) and re-apply the theme — so a `theme:`
 *  edit on the settings page recolors the UI instantly. */
export function saveBrowserSettings(source: string): void {
  try {
    localStorage.setItem(KEY, source);
  } catch {
    /* storage unavailable — the edit lives for this page only */
  }
  applyTheme();
}

/** The legacy raw width key's value, when it holds a usable number. */
function legacyWidth(): number | null {
  try {
    const w = Number(localStorage.getItem(LEGACY_WIDTH_KEY));
    return Number.isFinite(w) && w >= MIN_WIDTH && w <= MAX_WIDTH ? w : null;
  } catch {
    return null;
  }
}

// The parsed document, memoized BY ITS SOURCE TEXT (parse is cheap, but width is read per
// render): comparing the current text keeps the memo honest against any storage change this
// module did not make — another tab's edit, a cleared storage. `null` = the current text does
// not parse — treat every key as unset.
let memoSrc: string | undefined;
let memoRoot: Node | null = null;

function parsedRoot(): Node | null {
  const src = browserSettingsSource();
  if (src !== memoSrc) {
    memoSrc = src;
    try {
      memoRoot = parseYamlover(src, "<browser-settings>").root;
    } catch {
      memoRoot = null;
    }
  }
  return memoRoot;
}

/** The `width` this browser authors, or null when unset/invalid — fall through to the next layer. */
export function browserWidthCh(): number | null {
  const root = parsedRoot();
  const v = root && !isPointer(root) ? root.entries?.find((e) => e.key === "width")?.value : undefined;
  if (!v || isPointer(v) || v.kind !== "scalar" || typeof v.value !== "number") return null;
  return Number.isInteger(v.value) && v.value >= MIN_WIDTH && v.value <= MAX_WIDTH ? v.value : null;
}

export type Theme = "dark" | "light";
const isTheme = (v: unknown): v is Theme => v === "dark" || v === "light";

/** The `theme` this browser authors, or null when unset/invalid — fall through to the next layer. */
export function browserTheme(): Theme | null {
  const root = parsedRoot();
  const v = root && !isPointer(root) ? root.entries?.find((e) => e.key === "theme")?.value : undefined;
  if (!v || isPointer(v) || v.kind !== "scalar") return null;
  return isTheme(v.value) ? v.value : null;
}

// The pre-paint MIRROR key: index.html's inline <head> script reads it synchronously (parsing the
// yamlover doc needs the app bundle) and stamps `data-theme` before the first paint, so a reload
// never flashes the wrong palette. Strictly a CACHE of the resolved theme — the settings document
// stays the source of truth (browser-storage-as-cache doctrine).
const THEME_MIRROR_KEY = "yamlover.theme";

/** Resolve the effective theme (browser doc → project settings → dark) and stamp it on the
 *  document root (`html[data-theme]` — styles.css switches every palette var on it), mirroring
 *  it for the pre-paint script. Called at App mount, when the project layer arrives, and on
 *  every settings save — so a `theme:` edit applies instantly. */
export function applyTheme(): void {
  const theme: Theme = browserTheme() ?? projTheme ?? "dark";
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_MIRROR_KEY, theme);
  } catch {
    /* storage unavailable — the pre-paint script just falls back to dark */
  }
}

/** Set ONE top-level key in the browser-settings document, preserving every other line — the same
 *  single-key splice the engine's writeSettingKey does for the project file (settings.ts), pure
 *  and synchronous so the width control needs no round-trip. Structural edits go through the full
 *  /api/edit-text path instead (BrowserSettingsView). */
export function setBrowserSettingKey(key: string, valueText: string): void {
  const src = browserSettingsSource();
  const line = `${key}: ${valueText}`;
  const re = new RegExp("^" + key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":.*$", "m");
  let out = re.test(src) ? src.replace(re, line) : (src === "" || src.endsWith("\n") ? src : src + "\n") + line;
  if (!out.endsWith("\n")) out += "\n";
  saveBrowserSettings(out);
}

// ---- the PROJECT layer (the level below this document) --------------------------------------- //
// One /api/config fetch per page load, cached; a project-settings edit needs a reload to show up
// here — acceptable for a house-style default that the browser layer usually overrides anyway.

let projectWidth: number | null = null;
let projTheme: Theme | null = null;

/** Fetch the project settings once and cache the viewer-relevant bits. Call from App startup.
 *  Re-applies the theme when the answer lands (the project layer may be the deciding one). */
export function primeProjectSettings(): void {
  fetchConfig()
    .then((c) => {
      const w = c.settings.width;
      projectWidth = typeof w === "number" && Number.isInteger(w) && w >= MIN_WIDTH && w <= MAX_WIDTH ? w : null;
      projTheme = isTheme(c.settings.theme) ? c.settings.theme : null;
      applyTheme();
    })
    .catch(() => {
      projectWidth = null;
      projTheme = null;
    });
}

/** The project settings' `width`, or null when unset — fall through to the built-in default. */
export function projectWidthCh(): number | null {
  return projectWidth;
}
