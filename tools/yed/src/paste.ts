// yed2 PASTE — clipboard text into the PURE edit layer, under the typing laws. The page hands
// the string in (no clipboard API here); everything else is a pure function over the IR.
//
// Fidelity contract (the legacy editor's, kept): a paste that lands does so with full token
// fidelity — the parsed IR splices in directly, so authored raws (quotes, `|-` headers, flow
// style) survive as representation. A JSON / JSON5 blob is not yamlover source but IS a value
// the user means to paste: the shape is sniffed and read with the json5p parser, flow end to
// end. Refusals (the ring, nothing mutated): parse errors, oversized pastes, `~` back edges
// (dropping one would lose an entry), block structure into a flow token, an omni slot already
// taken. DELIBERATE DIVERGENCE from the legacy: no duplicate-key refusal — yed's typing has no
// duplicate-key law, and the paste obeys the same laws typing does.

import { parseYamlover } from "../../parser/ts/src/yamlover.ts";
import { parseJson5p } from "../../parser/ts/src/json5p.ts";
import { isPointer, type Document as IRDocument, type Node } from "../../parser/ts/src/ir.ts";
import { insertEntry, pasteParsed, withNode } from "./apply";
import { isFlow, nodeAt, type EditorState } from "./state";

/** The editor is not a bulk importer — refuse pastes beyond this. */
export const MAX_PASTE = 256 * 1024;

/** `\r\n`/`\r` → `\n`; strip the trailing newline run (a shell copy's artifact); keep inner blanks. */
export function normalizeClipboard(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/** Parse or null — a failure is the caller's ring, never an exception. */
export function tryParse(text: string): IRDocument | null {
  if (text.length > MAX_PASTE) return null;
  try {
    return parseYamlover(text, "<paste>");
  } catch {
    /* not yamlover — it may still be JSON (below) */
  }
  const t = text.trim();
  if (!/^[[{]/.test(t) || !/[\]}]$/.test(t)) return null;
  try {
    const doc = parseJson5p(t, "<paste>");
    markFlow(doc.root as Node);
    return doc;
  } catch {
    return null;
  }
}

/** Stamp the authored collection style onto a json5p tree — the language is flow throughout.
 *  IMMUTABLE: returns nothing but rebuilds meta per node (the parsed doc is paste-local, so
 *  in-place stamping is safe — no shared state exists yet). */
function markFlow(n: Node): void {
  if (n.kind === "blob") return;
  if ((n.entries ?? []).length > 0 || n.kind === "mapping") n.meta = { ...n.meta, style: "flow" };
  for (const e of n.entries ?? []) if (!isPointer(e.value)) markFlow(e.value as Node);
}

/** The one thing the editor cannot hold at all: a `~` back edge (deprecated; dropping it would
 *  lose an entry, not a decoration). Returns the human reason, or null when the paste can land. */
export function pasteBlockers(node: Node): string | null {
  if (node.kind === "blob") return "binary content";
  for (const e of node.entries ?? []) {
    if (e.edge === "back") return "a ~ back edge";
    if (!isPointer(e.value)) {
      const b = pasteBlockers(e.value as Node);
      if (b) return b;
    }
  }
  return null;
}

const refuse = (s: EditorState): EditorState => ({ ...s, refused: true });
const ok = (s: EditorState): EditorState => ({ ...s, refused: false });

/** Clipboard text pasted at the CURSOR's hole. The one-value laws are pasteParsed's (the same
 *  laws typing obeys); on top rides THE SIBLING SPLICE: a block-shaped document pasted into an
 *  undecided hole AMONG ENTRIES splices its top-level entries as siblings — with a parsed SELF
 *  value becoming the container's omni line at its authored position (the legacy
 *  pasteEntriesAt). All checks precede any mutation. */
export function pasteText(state: EditorState, raw: string): EditorState {
  const { doc, cursor } = state;
  if (cursor.at !== "hole" || cursor.text.trim() !== "") return refuse(state);
  const text = normalizeClipboard(raw);
  if (text.trim() === "") return refuse(state);
  const parsed = tryParse(text);
  if (parsed === null) return refuse(state);
  const root = parsed.root as Node;
  if (pasteBlockers(root) !== null) return refuse(state);
  const container = nodeAt(doc, cursor.path);
  if (!container) return refuse(state);

  // THE SIBLING SPLICE — an UNDECIDED hole among a block container's entries takes a pasted
  // DOCUMENT's top-level entries as siblings (the legacy pasteEntriesAt): the root sheds its
  // own brace style, each entry keeps its own. A lone scalar takes the omni path below; a
  // decided `k: `/`- ` hole names ONE value.
  const among = cursor.key === null && cursor.ordinal !== true && !isFlow(container)
    && (container.entries ?? []).length > 0;
  if (among && (root.entries ?? []).length > 0) {
    const hasSelf = root.kind === "scalar";
    // one scalar line per block: the container must be a mapping with its slot free
    if (hasSelf && container.kind !== "mapping") return refuse(state);
    let out = doc;
    let idx = cursor.index;
    for (const e of root.entries ?? []) {
      out = insertEntry(out, cursor.path, idx, e);
      idx++;
    }
    if (hasSelf) {
      const v = root as Node & { value?: unknown; raw?: string };
      const selfAt = cursor.index + Math.min((root.meta as { selfAt?: number } | undefined)?.selfAt ?? 0, (root.entries ?? []).length);
      out = withNode(out, cursor.path, (n) => ({
        ...n, kind: "scalar", value: v.value,
        ...(v.raw !== undefined ? { raw: v.raw } : {}),
        meta: { ...(n.meta ?? {}), ...(selfAt > 0 ? { selfAt } : {}) },
      }) as unknown as Node);
    }
    return ok({ ...state, doc: out, cursor: { at: "hole", path: cursor.path, index: idx, text: "", key: null } });
  }

  // everything else: ONE value, under the very laws typing obeys
  return pasteParsed(state, root);
}
