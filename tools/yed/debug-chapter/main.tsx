// THE CHAPTER DEBUG PAGE — `npm run debug-chapter`, port 5198, NO backend. Left: the NEW
// chapter cells (the yed cell contract: framed, captioned, controlled) over a fixture, with
// the debug CHECKBOX toggling y2-debug/y2-plain on the same DOM. Right: the panels — the
// keycap LEGEND (dry-run verdicts), the OP LOG (what a real mount would POST; the sink
// advances its committed snapshot exactly like the server path), the ChapterSite, the live
// serialized source, the intent history, and the watchdog alarm.
//
// This page is an APP (not the library): it injects the REAL marklower codec and read-only
// renderers from the server client — the same adapter surface the server mount fills.
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseSource, sourceOf, type Document, type Path, type Value } from "../src/state";
import { withNode } from "../src/apply";
import {
  applyChapterIntent, applyChapterKey, commitChapterText, createFirstChunk, initialChapterState,
  type ChapterState, type SplitPayload,
} from "../src/chapter/apply";
import type { ChapterIntent, ChapterKey } from "../src/chapter/dispatch";
import type { ChapterEdges } from "../src/chapter/site";
import { chapterSiteOf } from "../src/chapter/site";
import { chapterPositionsOf } from "../src/chapter/positions";
import { chapterWatchdog } from "../src/chapter/watchdog";
import { createColumnMemory } from "../src/chapter/caret";
import { ChapterCtx, ChapterDoc, type ChapterCellsAdapter, type ChapterCtxValue } from "../src/chapter/cells";
import { ChapterLegend, rolesOf } from "../src/chapter/legend";
import { marklowerToEditableHtml } from "../../server/src/client/renderers/marklower";
import { domToMarklower } from "../../server/src/client/marklower-serialize";
import { renderedTextLength } from "../../server/src/client/renderers/chunk-editors";
import { diffToOps } from "../../server/src/client/renderers/yed-sync";
import { publishFormatBus, clearFormatBus } from "../../server/src/client/renderers/chapter-editor/format-bus";
import { ChapterFormatControl } from "../../server/src/client/renderers/chapter-editor/format-control";
import "../../server/src/client/styles.css";
import "../src/yed.css";
import "../src/chapter/chapter-cells.css";
import "./debug-chapter.css";

// the app's LIGHT ("whitish") theme — styles.css defaults to dark
document.documentElement.dataset.theme = "light";

const FIXTURES: Record<string, string> = {
  "built-in: worked chapter":
    "The Pet Keeper's Handbook\ndescription: everything about keeping pets\n- Keeping a pet is a joy.\n" +
    "- Dogs\n  description: our best friends\n  - Dogs bark.\n  - Dogs fetch.\n- Cats\n  - Cats purr.\n" +
    "- !!<*yamlover: $defs: bullets>\n  - feed daily\n  - fresh water\n" +
    "- !!<*yamlover: $defs: table>\n  header:\n    - Pet\n    - Sound\n  - - dog\n    - woof\n  - - cat\n    - meow\n" +
    "- Closing words.\n",
  "built-in: empty": "",
  "built-in: source chunk":
    "Recipes\n- The stew needs:\n- !!<*yamlover: $defs: recipe>\n  serves: 4\n  time: 20\n- Serve hot.\n",
};
for (const [p, src] of Object.entries(import.meta.glob("../../../examples/**/body.yo", { eager: true, query: "?raw", import: "default" }))) {
  const name = p.replace(/^\.\.\/\.\.\/\.\.\//, "").replace(/\/\.yo\/body\.yo$/, "");
  FIXTURES[name] = src as string;
}

function openState(src: string): ChapterState {
  const doc = ((): Document => { try { return parseSource(src); } catch { return parseSource(""); } })();
  const st = initialChapterState(doc);
  const first = chapterPositionsOf(doc)[0] ?? null;
  return { ...st, focus: first, caret: first ? "end" : null };
}

function DebugChapterPage() {
  const names = useMemo(() => Object.keys(FIXTURES), []);
  const [name, setName] = useState(names[0]);
  const [debug, setDebug] = useState(true);
  const [depth, setDepth] = useState<number>(Infinity);
  const [state, setState] = useState<ChapterState>(() => openState(FIXTURES[names[0]]));
  const [ops, setOps] = useState<string[]>([]);
  const [alarm, setAlarm] = useState<string | null>(null);
  const committedRef = useRef<Document>(state.doc);
  const stateRef = useRef(state);
  stateRef.current = state;
  const columnMemory = useMemo(createColumnMemory, []);

  const update = (next: ChapterState): void => {
    setState(next);
    if (next.doc !== stateRef.current.doc) {
      // THE OP SINK — exactly what the server mount would flush, logged instead of POSTed
      const d = diffToOps(":doc", committedRef.current, next.doc);
      if (d.ops.length > 0 || d.renames.length > 0) {
        setOps((o) => [...o.slice(-199), ...d.ops.map((op) => JSON.stringify(op)), ...d.renames.map((r) => `rekey ${r.path} → ${r.key}`)]);
      }
      committedRef.current = next.doc;
    }
    try { chapterWatchdog(next); setAlarm(null); } catch (e) { setAlarm(String((e as Error).message)); console.error(e); }
  };
  const dispatch = (intent: ChapterIntent, split?: SplitPayload): void =>
    update(applyChapterIntent(stateRef.current, intent, split));

  const adapter: ChapterCellsAdapter = useMemo(() => ({
    codec: { toHtml: marklowerToEditableHtml, fromDom: domToMarklower, visibleLength: renderedTextLength },
    anchorFor: (path) => `[${path.join(".")}]`,
    navigate: (p) => setOps((o) => [...o, `navigate → ${p}`]),
    columnMemory,
    // sourceCells: the default yed registry — the seam a future math editor plugs into
  }), [columnMemory]);

  const ctx: ChapterCtxValue = {
    state,
    debug,
    adapter,
    dispatch,
    dispatchKey: (k: ChapterKey, edges?: ChapterEdges): boolean => {
      const out = applyChapterKey(stateRef.current, k, edges);
      if (out) update(out);
      return out !== null;
    },
    commitText: (p: Path, text: string) => update(commitChapterText(stateRef.current, p, text)),
    boot: (p: Path, text: string) => update(createFirstChunk(stateRef.current, p, text)),
    focusTo: (pos, caret = null) => update({ ...stateRef.current, focus: pos, caret }),
    graft: (p: Path, value: Value) => update({ ...stateRef.current, doc: withNode(stateRef.current.doc, p, () => value as never) }),
    chapterPath: ":doc",
  };

  useEffect(() => {
    const site = chapterSiteOf(state.doc, state.focus);
    const editable = site.cell === "title" || site.cell === "description" || site.cell === "prose" || site.cell === "listItem" || site.cell === "tableCell" || site.cell === "boot"; // boot too — the bar MATERIALIZES the first entry (no idle state)
    publishFormatBus({
      mounted: true,
      active: editable,
      current: editable ? site.currentFormat : null,
      choose: (f) => dispatch({ kind: "format", chosen: f }),
      roles: rolesOf(state),
      applyRole: (r) => dispatch({ kind: "role", role: r === "title" ? "title" : "desc" }),
    });
  });
  useEffect(() => () => clearFormatBus(), []);

  const open = (n: string): void => {
    setName(n);
    const st = openState(FIXTURES[n]);
    committedRef.current = st.doc;
    setOps([]);
    setAlarm(null);
    setState(st);
  };

  const site = chapterSiteOf(state.doc, state.focus);
  return (
    <div className="dc-page">
      <div className="dc-left">
        <div className="dc-toolbar">
          <select value={name} onChange={(e) => open(e.target.value)}>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <label className="dc-mode"><input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} /> debug</label>
          <label className="dc-mode">depth <select value={String(depth)} onChange={(e) => setDepth(e.target.value === "Infinity" ? Infinity : Number(e.target.value))}>
            {["1", "2", "3", "4", "Infinity"].map((d) => <option key={d} value={d}>{d === "Infinity" ? "∞" : d}</option>)}
          </select></label>
          <ChapterFormatControl />
        </div>
        {alarm && <pre className="dc-alarm" data-testid="dc-alarm">{alarm}</pre>}
        <div className="chapter-page">
          <ChapterCtx.Provider value={ctx}>
            <ChapterDoc key={name} budget={depth} />
          </ChapterCtx.Provider>
        </div>
      </div>
      <div className="dc-right">
        <h3>legend</h3>
        <ChapterLegend state={state} />
        <h3>site</h3>
        <pre data-testid="dc-site">{JSON.stringify(site, null, 1)}</pre>
        <h3>focus</h3>
        <pre data-testid="dc-focus">{JSON.stringify({ focus: state.focus, caret: state.caret, refused: state.refused })}</pre>
        <h3>ops (the sink — what a mount would POST)</h3>
        <pre className="dc-ops" data-testid="dc-ops">{ops.join("\n")}</pre>
        <h3>source</h3>
        <pre data-testid="dc-source">{sourceOf(state.doc)}</pre>
        <h3>intents</h3>
        <pre data-testid="dc-log">{state.log.slice(-25).join("\n")}</pre>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<DebugChapterPage />);
