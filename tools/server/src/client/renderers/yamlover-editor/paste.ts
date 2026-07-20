// PASTE — valid yamlover source dropped into the projectional editor. The clipboard text parses
// CLIENT-SIDE (parseYamlover is already bundled); the parsed IR converts into model entries with
// full TOKEN fidelity (a scalar's authored raw — quotes, `|-` headers — becomes MScalar.src) and
// the standard emission machinery (commitSpine / setSelfValue) mirrors the splice server-side.
//
// Fidelity contract (user-decided): a paste always succeeds structurally; comments, `&` path
// anchors and `!!set` in the snippet are DROPPED silently (the op pipeline cannot carry them —
// scalar TOKENS keep their authored spelling), and flow authoring (`[1, 2]`) canonicalizes to
// block form (the IR keeps no flow bit). Only genuinely unrepresentable content refuses: `~`
// back edges (dropping one would lose a whole entry), oversized pastes, parse errors. The
// EMPTY document's root paste emits the very ops typing would — one insert per top-level entry
// plus the self/tag emplaces — because the server's document root takes no whole-payload
// emplace (root emplace is defined as tag/self-value only, engine-api editChapterSource).

import { parseYamlover } from "../../../../../parser/ts/src/yamlover.ts";
import { isPointer } from "../../../../../parser/ts/src/ir.ts";
import type {
  Document, Entry as IREntry, Node as IRNode, Scalar as IRScalar, Value as IRValue,
} from "../../../../../parser/ts/src/ir.ts";
import type { Edit } from "../../api";
import * as M from "./model";

/** The editor is not a bulk importer — refuse pastes beyond this. */
export const MAX_PASTE = 256 * 1024;

/** `\r\n`/`\r` → `\n`; strip the trailing newline run (a shell copy's artifact); keep inner blanks. */
export function normalizeClipboard(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/** Parse or null — a SyntaxError is the caller's error ring, never an exception. */
export function tryParse(text: string): Document | null {
  if (text.length > MAX_PASTE) return null;
  try { return parseYamlover(text, "<paste>"); } catch { return null; }
}

/** The one thing the model cannot hold at all: a `~` back edge (deprecated; dropping it would
 *  lose an entry, not a decoration). Returns the human reason, or null when the paste can land. */
export function pasteBlockers(node: IRNode): string | null {
  if (node.kind === "blob") return "binary content"; // unreachable from parsed text — belt and braces
  for (const e of node.entries ?? []) {
    if (e.edge === "back") return "a ~ back edge";
    if (!isPointer(e.value)) {
      const b = pasteBlockers(e.value);
      if (b) return b;
    }
  }
  return null;
}

/** Whether the paste's root is a LONE scalar (no entries) — routed through the typed-token
 *  paths by the caller instead of the structural splice. */
export function isLoneScalar(n: IRNode): n is IRScalar {
  return n.kind === "scalar" && !(n.entries?.length);
}

// --------------------------------------------------------------------------- //
// IR → model conversion
// --------------------------------------------------------------------------- //

/** A pasted key that would not survive BARE emission goes out quoted (keyToken emits it
 *  verbatim otherwise) — the mirror of keys.ts's bare-key shape. */
const BARE_KEY = /^[^\s:#"'{}[\],*&!|>-][^:#]*$/;

/** `!!<…>` CONTENT from an IR schema Value: a pointer keeps its AUTHORED text; an inline node
 *  is accepted only when it renders on ONE line (`format: text/x-latex`); multi-line → null
 *  (the tag is dropped — the model's tag cell is single-line). */
export function metaTagFromIR(schema: IRValue): string | null {
  if (isPointer(schema)) return "*" + schema.raw;
  const rendered = M.serializeMNode(nodeFromIR(schema));
  return rendered.includes("\n") ? null : rendered;
}

/** The authored token → MScalar (quote/block modes derived from the raw, representation kept). */
export function scalarFromIR(s: IRScalar): M.MScalar {
  return M.scalarFromRaw(s.value, s.raw);
}

export function entryFromIR(e: IREntry): M.MEntry {
  const node = isPointer(e.value)
    ? pointerNodeFromIR(e.value.raw)
    : nodeFromIR(e.value);
  return {
    id: M.nid(),
    key: e.key,
    ...(e.key !== null && !BARE_KEY.test(e.key) ? { quotedKey: true } : {}),
    decided: true,
    committed: false,
    node,
  };
}

function pointerNodeFromIR(raw: string): M.MNode {
  return {
    id: M.nid(), rev: 0, kind: "pointer", pointer: { raw, refPath: null },
    entries: [], selfAt: 0, metaTag: null, setTag: false,
  };
}

export function nodeFromIR(n: IRNode): M.MNode {
  const base: M.MNode = {
    id: M.nid(), rev: 0, kind: "container", entries: [], selfAt: 0,
    metaTag: n.meta?.schema !== undefined ? metaTagFromIR(n.meta.schema) : null,
    setTag: false,
  };
  if (n.kind === "scalar" && !(n.entries?.length)) {
    return { ...base, kind: "scalar", scalar: scalarFromIR(n) };
  }
  base.entries = (n.entries ?? []).map(entryFromIR);
  if (n.kind === "scalar") {
    // OMNI: the self-value rides the node alongside its entries, at its authored position
    base.selfValue = scalarFromIR(n as IRScalar);
    base.selfAt = Math.min(n.meta?.selfAt ?? 0, base.entries.length);
  }
  return base;
}

// --------------------------------------------------------------------------- //
// The paste mutations — null ⇒ REFUSED, model untouched (all checks precede any mutation)
// --------------------------------------------------------------------------- //

/** Splice the parsed root's top-level entries as SIBLINGS at `index` of `containerId`,
 *  committing each through the standard per-entry insert (ascending server indices come free —
 *  each commitSpine marks its subtree committed before the next runs; a container on an
 *  uncommitted spine commits WHOLE on the first call, the rest emit nothing). A parsed SELF
 *  value becomes the container's omni line, saved at its typed position (the commitHoleAsSelf
 *  twin). Refusals: dup keys (against decided existing entries AND within the paste), a second
 *  scalar self line. */
export function pasteEntriesAt(
  rootPath: string, root: M.MNode, containerId: string, index: number, parsed: IRNode,
): Edit[] | null {
  const container = containerId === root.id ? root : M.findNode(root, containerId)?.node;
  if (!container || container.kind !== "container") return null;
  const hasSelf = parsed.kind === "scalar";
  if (hasSelf && container.selfValue) return null; // one scalar line per block
  const incoming = (parsed.entries ?? []).map((e) => entryFromIR(e));
  const seen = new Set(container.entries.filter((e) => e.decided && e.key !== null).map((e) => e.key));
  for (const e of incoming) {
    if (e.key !== null) {
      if (seen.has(e.key)) return null;
      seen.add(e.key);
    }
  }
  container.entries.splice(index, 0, ...incoming);
  container.rev++;
  const edits: Edit[] = [];
  for (const e of incoming) edits.push(...M.commitSpine(rootPath, root, e.id));
  if (hasSelf) {
    // the self line lands LAST: setSelfValue's `at` then counts the just-committed siblings,
    // saving the line at the position it was pasted (THE REPRESENTATION RULE)
    container.selfAt = index + Math.min(parsed.meta?.selfAt ?? 0, incoming.length);
    edits.push(...M.setSelfValue(rootPath, root, container.id, scalarFromIR(parsed as IRScalar)));
  }
  return edits;
}

/** The parsed root becomes a DECIDED value hole's VALUE. Uncommitted entry → the standard
 *  subtree insert; committed entry (the `key: ""` restructure placeholder) → one emplace of the
 *  serialized subtree at the entry's path. The hole node's id is KEPT (cell keys survive), as is
 *  a user-typed `!!<…>` tag when the paste carries none. */
export function pasteValueAt(rootPath: string, root: M.MNode, entryId: string, parsed: IRNode): Edit[] | null {
  const spine = M.findEntry(root, entryId);
  if (!spine || spine.entry.node.kind !== "hole") return null;
  const { container } = spine.parents[spine.parents.length - 1];
  if (container.flow) return null; // no block structure inside flow
  const converted = nodeFromIR(parsed);
  const node = spine.entry.node;
  node.kind = converted.kind;
  node.scalar = converted.scalar;
  node.entries = converted.entries;
  node.selfValue = converted.selfValue;
  node.selfAt = converted.selfAt;
  node.metaTag = converted.metaTag ?? node.metaTag;
  node.dirty = false;
  node.rev++;
  if (!spine.entry.committed) return M.commitSpine(rootPath, root, entryId);
  M.markCommitted(spine.entry); // the emplace below persists the subtree whole
  return [{ path: M.pathOfSpine(rootPath, spine), op: "emplace", yamlover: M.serializeMNode(node) }];
}

/** The EMPTY document's whole-document paste. The server's document root takes NO whole-payload
 *  emplace (root emplace = tag / scalar self-value only), so the paste lands as the very ops
 *  typing would produce: the root tag's meta emplace, one insert per top-level entry, and the
 *  self line's scalar emplace — all through the standard splice. A lone-scalar document becomes
 *  the root scalar (the legal scalar-only root emplace). Null = dup keys within the paste (the
 *  previously-empty root stays empty). */
export function pasteRootDocument(rootPath: string, root: M.MNode, doc: Document): Edit[] | null {
  const parsed = doc.root;
  const tag = parsed.meta?.schema !== undefined ? metaTagFromIR(parsed.meta.schema) : null;
  // the legacy fresh-file body is a lone `""` scalar root — its line must LEAVE before entries
  // land (an empty-string emplace drops it); a root scalar with real content refuses (a paste
  // must not clobber a document silently)
  const legacy = root.kind === "scalar";
  if (legacy && !(root.scalar?.value === "" || root.scalar?.value == null)) return null;
  const clear: Edit[] = legacy && !isLoneScalar(parsed)
    ? [{ path: rootPath, op: "emplace", yamlover: '""' }]
    : [];
  root.kind = "container";
  root.scalar = undefined;
  root.entries = [];
  root.selfValue = undefined;
  root.selfAt = 0;
  root.metaTag = tag;
  root.metaOnServer = tag !== null;
  root.dirty = false;
  root.rev++;
  const edits: Edit[] = [...clear, ...(tag !== null ? [{ path: rootPath, op: "emplace", meta: tag } as Edit] : [])];
  if (isLoneScalar(parsed)) {
    root.kind = "scalar";
    root.scalar = scalarFromIR(parsed);
    return [...edits, { path: rootPath, op: "emplace", yamlover: root.scalar.src }];
  }
  const spliced = pasteEntriesAt(rootPath, root, root.id, 0, parsed);
  if (spliced === null) return null;
  return [...edits, ...spliced];
}
