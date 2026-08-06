// concrete-rules.ts — the INHERITANCE (composition) rules of concretes, in ONE pure module
// (no I/O, no index, shared by client and server): every "where does a new child live, what
// language does it speak" decision is asked HERE, never hand-rolled at a call site.
//
// Two kinds of rule, kept apart on purpose:
//
//   OBLIGATORY — what is legal at all. Content INSIDE a file document speaks that file's
//     language ({@link requiredChildLanguage}): the interior of a `.json5p` file cannot switch
//     to yaml; an existing node never changes concrete through an edit (a conversion is a move —
//     enforced server-side). A directory MEMBER needs a real name on disk.
//
//   DEFAULT — what an UNSPECIFIED concrete resolves to. Composition INHERITS the storage
//     family ({@link defaultChildConcrete}): a directory-concrete document keeps its children
//     directory-concrete (a subchapter of a dir chapter becomes a subdirectory member, the
//     ex-66 shape); a file/inline document keeps them inline in its source. An explicit
//     `concrete:` from the author always wins over any default.
//
// The MEMBER-ENCODING derivation ({@link deriveMemberEncoding}) is the server-side face of the
// same inheritance: an edit that creates a child of a directory-backed parent WITHOUT naming a
// concrete derives one from the child's shape — containers become real directories (keyed by
// their key, keyless under an order-numbered {@link nextMemberName}), leaves go to the body
// overlay.

import { isDirConcrete, interiorOf, pointerSafeName, type Inlined } from "./concrete";

/** The directory concrete a new member of a `parent`-stored node takes: the parent's OWN overlay
 *  flavor, so an `index.yo` chapter grows `index.yo` members and a `.yo/` chapter `.yo/` ones.
 *  Anything else (a plain `dir`, a file, an inline node) births the `.yo/` form. */
function dirFlavorOf(parent: string | null | undefined): "dir/.yo" | "dir/index.yo" {
  return parent === "dir/index.yo" ? "dir/index.yo" : "dir/.yo";
}

// --------------------------------------------------------------------------- //
// Child creation — the concretes offered, the default picked
// --------------------------------------------------------------------------- //

/** A creatable child's storage form (the create menu's vocabulary). */
export type ChildConcrete = "yamlover" | "file/yamlover" | "dir/.yo" | "dir/index.yo";

/** The concretes a NEW child of a `parent`-stored node may take (the create menu's rows).
 *  A CHILD of a document (any storage) may be inline in the parent's source, a linked file,
 *  or a linked directory; a MEMBER of a plain directory has no source to be inline in —
 *  file or directory only. The DIRECTORY row is the parent's own overlay flavor
 *  ({@link dirFlavorOf}): one menu entry, spelled the way this branch of the tree is spelled. */
export function allowedChildConcretes(parent: string | null | undefined, kind: "child" | "member"): ChildConcrete[] {
  const dir = dirFlavorOf(parent);
  return kind === "member" ? ["file/yamlover", dir] : ["yamlover", "file/yamlover", dir];
}

/** THE INHERITANCE RULE — the default concrete for a NEW child when the author picks none:
 *  a directory-concrete parent keeps its children directory-concrete (a sub-container of a
 *  directory stays a directory; a subchapter of a dir chapter becomes a subdirectory member),
 *  in the parent's own overlay flavor; everything else stays inline in the parent's source. */
export function defaultChildConcrete(parent: string | null | undefined): ChildConcrete {
  return isDirConcrete(parent) ? dirFlavorOf(parent) : "yamlover";
}

/** Whether a freshly wrapped SUBCHAPTER of a document stored as `parent` MATERIALIZES as its
 *  own directory member the moment it gains body content (the chapter editor's deferred
 *  Tab-wrap rule, docs/documents/chapter/attaching) — the same inheritance as
 *  {@link defaultChildConcrete}, asked with the enclosing DOCUMENT's concrete: the edited
 *  root's, or a just-materialized member's own (directory-concrete from birth). */
export function subchapterMaterializes(parent: string | null | undefined): boolean {
  return isDirConcrete(defaultChildConcrete(parent));
}

/** THE LANGUAGE LOCK (obligatory): the inlined language content inside a document stored as
 *  `parent` must speak — the interior of a `file/json5p` is json5p, never yaml; a yamlover
 *  interior stays yamlover. Delegates to {@link interiorOf} (concrete.ts), restated here so
 *  the constraint reads next to its sibling rules. */
export function requiredChildLanguage(parent: string | null | undefined): Inlined {
  return interiorOf(parent);
}

// --------------------------------------------------------------------------- //
// Member encoding — where an UNDERIVED child of a directory-backed parent lands
// --------------------------------------------------------------------------- //

export type MemberEncoding = "body" | "dir" | "dir-seq";

/** Where a NEW child of a directory-backed parent is encoded when the edit names NO concrete
 *  (the server-side face of {@link defaultChildConcrete}):
 *   - a KEYED CONTAINER child (it has entries of its own — an omni counts) → a nested REAL
 *     DIRECTORY named by the key; its own children re-derive recursively;
 *   - an UNTAGGED ORDINAL (keyless) CONTAINER child → a real directory under a SEQUENTIAL
 *     generated name ({@link nextItemName}), referenced from the parent's body by a
 *     pointer-array element (`- *item01`) granting its position — the
 *     examples/56-array-of-files shape. A TAGGED ordinal container (a table, a typographical
 *     list — the edit carries `meta`; a `!!yo` DATA ISLAND counts as tagged too, the callers
 *     fold `rootIsYo` in) is CONTENT, not structure: it stays inline — and content
 *     is content ALL THE WAY DOWN (`insideContent`): a node INSIDE an inline tagged container
 *     (a table's row, a list's sublist) never promotes out of it, whatever its own shape —
 *     promoting one would leave a `- *: itemNN` pointer inside the content unit, which the
 *     positional addressing the editor uses cannot descend through (the reported
 *     "cannot descend into a scalar element" sync failures);
 *   - everything else — a keyed scalar, an ordinal scalar, a flow one-liner — → the parent's own
 *     instance overlay, `.yo/body.yo` or `index.yo` by its flavor (created on demand).
 *  An explicit `concrete:` on the edit always overrides this derivation. */
export function deriveMemberEncoding(child: { keyed: boolean; container: boolean; tagged?: boolean; insideContent?: boolean }): MemberEncoding {
  if (child.insideContent) return "body";
  if (child.keyed && child.container) return "dir";
  if (!child.keyed && child.container && !child.tagged) return "dir-seq";
  return "body";
}

// --------------------------------------------------------------------------- //
// Generated member names — order-numbered, never renumbered
// --------------------------------------------------------------------------- //
//
// A GENERATED directory member carries an ORDER KEY in its name — dash-separated numeric
// segments (`01` = [1], `01-1` = [1,1], `item03` = [3]) — so a plain directory listing sorts
// roughly in body order. The key is COSMETIC: order is the body pointer-array's data, never
// the filesystem's, and an existing member is NEVER renamed — an insert between neighbors
// slots a SUB-NUMBER in between (`01` … `01-1` … `02`; `item01` … `item01-1` … `item02`).
// Two families: `item<key>` (dir-seq ordinal members) and `<key>-<Title>` (title-born
// subchapters). SHARED client/server: the client that births a member computes the SAME
// name the server will write (blocks.ts), so follow-up edits address it by key immediately.

type OrderKey = number[];

const ITEM_RE = /^item(\d+(?:-\d+)*)$/;
const TITLE_RE = /^(\d+(?:-\d+)*)(?:-(.*))?$/;

/** The order key a name carries, or null when it carries none (legacy/user names). */
function orderKeyOf(name: string, family: "item" | "title"): OrderKey | null {
  const m = (family === "item" ? ITEM_RE : TITLE_RE).exec(name);
  return m ? m[1].split("-").map((s) => parseInt(s, 10)) : null;
}

/** Element-wise numeric; a key that is a strict prefix sorts FIRST ([1] < [1,1] < [2]). */
function cmpKey(a: OrderKey, b: OrderKey): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** A key strictly between `prev` and `next` (null = open end). Best-effort betweenness. */
function betweenKey(prev: OrderKey | null, next: OrderKey | null): OrderKey {
  if (!prev && !next) return [1];
  if (!prev) {
    return next![0] > 1 ? [next![0] - 1] : [0]; // head insert; before `01` degrades to `00`
  }
  if (!next) return [prev[0] + 1]; // append past the tail neighbor
  const inc = [...prev];
  inc[inc.length - 1]++;
  if (cmpKey(inc, next) < 0) return inc;
  const sub = [...prev, 1];
  if (cmpKey(sub, next) < 0) return sub;
  return [...prev, 0, 1]; // the `01` vs `01-1` edge: 01-0-1 slots strictly between
}

/** `key` spelled as a name segment: first segment two-padded, sub-segments plain. */
function formatKey(key: OrderKey): string {
  return key.map((s, i) => (i === 0 ? String(s).padStart(2, "0") : String(s))).join("-");
}

/** The name for a GENERATED, body-pointer-ordered directory member. `existingNames` is the
 *  parent's on-disk child names (files included — a user `item5` advances, never collides);
 *  `prevName`/`nextName` are the member names of the body pointer-array NEIGHBORS around the
 *  insert position (absent/unnumbered sides count as open ends). Uniqueness against
 *  `existingNames` is guaranteed IN-SCHEME (deepening the key), so `uniqueName`'s `-N`
 *  collision suffix — ambiguous with a between-number — never fires for these names. */
export function nextMemberName(
  existingNames: readonly string[],
  family: "item" | "title",
  opts: { prevName?: string; nextName?: string; title?: string } = {},
): string {
  const prev = opts.prevName !== undefined ? orderKeyOf(opts.prevName, family) : null;
  const next = opts.nextName !== undefined ? orderKeyOf(opts.nextName, family) : null;
  let key: OrderKey;
  if (opts.prevName === undefined && opts.nextName === undefined) {
    // pure append: past the MAX existing leading segment (gaps never refilled)
    let max = 0;
    for (const n of existingNames) {
      const k = orderKeyOf(n, family);
      if (k) max = Math.max(max, k[0]);
    }
    key = [max + 1];
  } else {
    key = betweenKey(prev, next);
  }
  const render = (k: OrderKey): string =>
    family === "item" ? "item" + formatKey(k) : `${formatKey(k)}-${pointerSafeName(opts.title ?? "")}`;
  const taken = new Set(existingNames);
  let name = render(key);
  while (taken.has(name)) {
    key = [...key, 1]; // deepen in-scheme: still sorts right after the collided key
    name = render(key);
  }
  return name;
}

/** The next SEQUENTIAL member name for an ordinal child materialized as a directory
 *  (`dir-seq`) with no known neighbors: item01, item02, … — the pure-append face of
 *  {@link nextMemberName}. */
export function nextItemName(names: readonly string[]): string {
  return nextMemberName(names, "item");
}

/** The observed state of a DIRECTORY edit target — everything the routing decision needs.
 *  The caller gathers it (engine-api owns the I/O and the index); the decision lives here. */
export interface DirTargetState {
  hasBody: boolean; // the directory's instance overlay (`.yo/body.yo` or `index.yo`) exists on disk
  indexedAsDocument: boolean; // the index knows the directory as a document root
}

export type DirEditRoute = MemberEncoding | "document";

/** Where an edit against a directory target routes:
 *  - `dir`      — the child derives to a nested real directory ({@link deriveMemberEncoding});
 *  - `dir-seq`  — the child derives to a sequentially-named real directory plus a body
 *    pointer-array element granting its position (both target states: the pointer splice
 *    lands in the body either way);
 *  - `document` — the directory is an ESTABLISHED document (its body exists on disk AND the
 *    index knows it): the ordinary document route applies, with the body's own positional
 *    index space;
 *  - `body`     — everything else: the edit lands in the directory's own body overlay,
 *    materialized on demand.
 *  Disk and index must AGREE for `document` — the same rule for every directory, the served
 *  root included (it is always index-flagged a document root, even before any body exists;
 *  a body born earlier in the current batch exists on disk while the index is still stale).
 *  In both half-states `body` is correct: the edit targets the dir's OWN body either way. */
export function deriveDirEditRoute(target: DirTargetState, child?: { keyed: boolean; container: boolean; tagged?: boolean }): DirEditRoute {
  if (child) {
    const enc = deriveMemberEncoding(child);
    if (enc !== "body") return enc;
  }
  return target.hasBody && target.indexedAsDocument ? "document" : "body";
}
