/**
 * The render depth for the structured-data views (`yamlover` / `json5p` / `yamlover/schema`) and
 * the chapter renderers. Like the markup reading-width (markup.tsx), the depth is a **URL
 * parameter** — `?depth=<n>`, alongside `?format=` — so a particular depth is a shareable link.
 *
 * The default is **`.inf` (infinity)**: a text data file (json / json5 / yaml / yamlover) inlines
 * whole, and references show *as references* (their pointer text, local ones as in-page `#` links).
 * A FINITE depth `n` inlines `n` levels of nested containers (collapsible) and *resolves* references
 * within that budget; anything deeper becomes a continuation hyperlink. Infinity is `null` here,
 * the value the server treats as unlimited; non-text concretes fall back to one level server-side.
 * The control lives in the node bar next to the data tabs (see NodeView) and in the chapter
 * renderer's config slot (registry.tsx).
 */
const MIN_DEPTH = 1;
/** The discrete slider's finite stops (1..MAX_STOP); one past it is the ∞ position. */
const MAX_STOP = 6;
const INF_STOP = MAX_STOP + 1;
const params = () => new URLSearchParams(window.location.search);

/** Whether `text` denotes infinity (`.inf` / `inf`, case-insensitive). */
function isInf(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === ".inf" || t === "inf";
}

/** A depth string is valid if it is `.inf`/`inf` or an integer ≥ 1. */
export function validDepth(text: string): boolean {
  if (isInf(text)) return true;
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n >= MIN_DEPTH;
}

/** The render depth from the URL's `?depth=`: `null` for infinity (the default, and an explicit
 *  `.inf`/absent), else the finite level. An out-of-range / malformed value falls back to infinity. */
export function viewDepth(): number | null {
  const raw = params().get("depth");
  if (raw == null || raw === "" || isInf(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_DEPTH ? n : null;
}

function writeDepth(d: number | null): void {
  const q = params();
  if (d == null) q.delete("depth"); // infinity is the default — drop the param
  else q.set("depth", String(d));
  const qs = q.toString();
  window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
}

/**
 * The depth control beside the data-view tabs (in the node bar): a DISCRETE slider with stops
 * `1 2 3 4 5 6 ∞` — the LAST stop is infinity, the default (a released `?depth=` param). Moving
 * the knob writes the URL and `onChange()` re-renders/refetches at the new depth. A hand-typed
 * URL depth past 6 clamps the KNOB only — {@link viewDepth} still reports the true value. No
 * visible label: the hover title reads "depth".
 */
export function DepthControl({ onChange }: { onChange: () => void }) {
  const urlDepth = viewDepth();
  const knob = urlDepth == null ? INF_STOP : Math.min(Math.max(urlDepth, MIN_DEPTH), MAX_STOP);
  return (
    <span className="depth-control">
      <input
        type="range"
        min={MIN_DEPTH}
        max={INF_STOP}
        step={1}
        title="depth"
        value={knob}
        onChange={(e) => {
          const v = Number(e.target.value);
          writeDepth(v >= INF_STOP ? null : v);
          onChange();
        }}
      />
      <span className="depth-ticks" aria-hidden="true">
        {[...Array.from({ length: MAX_STOP }, (_, i) => String(i + 1)), "∞"].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </span>
    </span>
  );
}
