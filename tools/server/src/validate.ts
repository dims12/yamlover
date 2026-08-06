// validate.ts — the VALIDATOR, in one pure module (no I/O, no index, no `node:path`, shared by
// client and server): given a snapshot of what a write is ABOUT to do, or of a concrete tree as it
// stands, it answers whether the yamlover format's invariants hold.
//
// Two halves, one runner:
//
//   LAYOUT (`layout/*`) — SCHEMA-LESS structure: where a value may live on disk. A `.yo`
//     overlay never nests inside another; a container derived to a real directory must actually be
//     written as one; a directory carries ONE instance overlay, and its concrete says which
//     (a `dir/.yo` owns its marker, a `dir/index.yo` its file, a plain `dir` neither). These need no
//     metadata at all, so they hold for a fresh directory the user has only just started typing
//     into — which is exactly where the corruption they catch is born.
//
//   VALUE (`value/*`) — a node's data against a `.yo/meta.yo` schema (docs/language/model/metadata). The
//     codes and the {@link SchemaRule} shape are RESERVED here and {@link compileMeta} ships
//     returning `[]`: the seam exists so that landing real schema rules later adds a rule SOURCE
//     and changes no call site, no diagnostic shape, and no enforcement decision.
//
// THIS MODULE NEVER RESTATES A POLICY. Every rule re-ASKS concrete.ts / concrete-rules.ts
// ({@link deriveMemberEncoding}, {@link requiredChildLanguage}, {@link nextMemberName}'s naming
// scheme, {@link dataFileConcrete}) and asserts only that the plan obeyed the answer. A rule that
// needed a policy of its own would mean the policy is missing from concrete-rules.ts.
//
// Paths cross this boundary as ROOT-RELATIVE POSIX strings (`a/b/.yo/body.yo`, `""`
// for the root) — the caller converts, the way engine-api.ts already does for the index.

import { BODY_FILE, INDEX_FILE, OVERLAY_DIR, baseLanguage, dataFileConcrete, isBinaryConcrete, isFileConcrete, type DirConcrete, type Inlined } from "./concrete";
import { deriveMemberEncoding, requiredChildLanguage, type DirEditRoute } from "./concrete-rules";

// --------------------------------------------------------------------------- //
// The overlay vocabulary — the ONLY names that may live inside a `.yo/`
// --------------------------------------------------------------------------- //

export { OVERLAY_DIR };

/** The files a `.yo/` may hold: the instance overlay, the schema, the project config, and
 *  the engine's derived index (plus SQLite's own journal siblings). */
const OVERLAY_FILES = new Set([BODY_FILE, "meta.yo", "settings.yo", "index.db", "index.db-wal", "index.db-shm"]);

/** The archive a detached member's storage moves into (engine-api's TRASH ON DELETE) — not
 *  derived: while it sits here it is the ONLY copy of what was deleted. */
const TRASH_DIR = ".trash";

/** The subdirectories a `.yo/` may hold — the derived sidecar blobs addressed by a
 *  `*::.yo:<subdir>:name` pointer (engine-api's CROP_SUBDIR / THUMB_SUBDIR), and the trash. */
const OVERLAY_SUBDIRS = new Set(["fragments", "thumbnails", TRASH_DIR]);

/** Characters no path segment may carry (the writeDirMemberTree charset, hoisted). */
const UNSAFE_SEG = /[\\/:*?"<>|]/;

/** A control character in a name — spelled by code point so this module stays plain ASCII. */
const hasControlChar = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 0x20);

/** The `item<key>` name scheme {@link nextMemberName} generates for `dir-seq` members. */
const ITEM_NAME = /^item\d+(?:-\d+)*$/;

/** The `<key>-<Title>` name scheme {@link nextMemberName} generates for title-born members. */
const TITLE_NAME = /^\d+(?:-\d+)*(?:-.*)?$/;

// --------------------------------------------------------------------------- //
// Diagnostics
// --------------------------------------------------------------------------- //

export type Severity = "error" | "warning";

/** Stable, machine-readable diagnostic codes. `layout/*` ship today (schema-less); `value/*` are
 *  RESERVED for {@link compileMeta}'s future output and are emitted by nothing yet. */
export type DiagnosticCode =
  // layout — pure path invariants (no node context needed; see validatePath)
  | "layout/nested-overlay"
  | "layout/reserved-overlay-name"
  | "layout/escapes-root"
  | "layout/unsafe-member-name"
  // layout — encoding invariants (need the routing decision and the payload's facets)
  | "layout/inline-collection"
  | "layout/duplicate-member"
  | "layout/language-switch"
  | "layout/off-scheme-name"
  // layout — whole-tree invariants (the doctor sweep)
  | "layout/orphan-overlay"
  | "layout/duplicate-overlay"
  | "layout/concrete-mismatch"
  // value — RESERVED for meta.yo (docs/language/model/metadata)
  | "value/type"
  | "value/required"
  | "value/enum"
  | "value/format"
  | "value/const";

/** One violation. At least one of `path` (canonical colon path) / `fsPath` (root-relative POSIX)
 *  is always set; `message` is a lowercase fragment in the `DropVerdict.reason` voice. */
export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  path?: string;
  fsPath?: string;
  hint?: string;
  /** FUTURE — the meta.yo keyword path that produced this (`properties/age/type`). */
  metaPath?: string;
  /** FUTURE — the schema keyword itself (`type`, `required`, `format`, …). */
  keyword?: string;
}

/** The verdict shape of drop-policy.ts, widened with the full diagnostic list: an ALLOWED verdict
 *  may still carry warnings, and `reason` is the first ERROR's message so a route can 400 with it. */
export type ValidationVerdict =
  | { allowed: true; diagnostics: Diagnostic[] }
  | { allowed: false; reason: string; diagnostics: Diagnostic[] };

/** Every code's severity unless {@link ValidateOptions.severity} says otherwise. */
const DEFAULT_SEVERITY: Partial<Record<DiagnosticCode, Severity>> = { "layout/off-scheme-name": "warning" };

// --------------------------------------------------------------------------- //
// Snapshots — the caller gathers, this module decides (the DirTargetState precedent)
// --------------------------------------------------------------------------- //

/** One node of the CONCRETE tree, observed or planned. `concrete` is the docs/language/concretes value;
 *  `names` is a directory's on-disk child names, when the caller has them. */
export interface ConcreteNode {
  path: string; // canonical colon path
  concrete: string | null;
  fsPath?: string; // root-relative POSIX; absent for an inlined node
  keyed?: boolean;
  container?: boolean;
  tagged?: boolean;
  names?: readonly string[];
}

/** One filesystem object a write is ABOUT to produce — the PLAN, not the deed. */
export type PlannedWrite =
  | { kind: "file"; fsPath: string; concrete: string }
  | { kind: "dir"; fsPath: string; concrete: DirConcrete }
  | { kind: "overlay"; fsPath: string } // a `<dir>/.yo/<entry>` write
  | { kind: "splice"; fsPath: string; within?: (string | number)[] }; // an in-body edit

/** PRE-FLIGHT input: what the routing decision saw, plus what it decided to write. Every optional
 *  field a rule needs is INERT when absent — a caller that cannot cheaply gather it simply gets
 *  fewer rules, never a false positive. */
export interface WriteSnapshot {
  /** The node the edit addresses. */
  target: ConcreteNode;
  /** Its enclosing document/directory, when known. */
  parent?: ConcreteNode;
  /** The payload's facets — the {@link deriveMemberEncoding} input the router used. */
  child?: { keyed: boolean; container: boolean; tagged?: boolean };
  /** What {@link deriveDirEditRoute} returned. */
  route?: DirEditRoute;
  /** An explicit `concrete:` on the edit, which OVERRIDES the derivation (concrete-rules.ts) and
   *  so suspends the encoding rules. */
  explicitConcrete?: string | null;
  /** The name a generated/keyed member will take. */
  memberName?: string;
  /** Which {@link nextMemberName} family `memberName` should belong to, when it was GENERATED. */
  nameFamily?: "item" | "title";
  /** The inlined language of content being spliced into the parent's source, when known. */
  childLanguage?: Inlined | null;
  writes: readonly PlannedWrite[];
}

/** POST-HOC input: a whole concrete tree in any order (the doctor sweep and fixture tests). */
export interface TreeSnapshot {
  nodes: readonly ConcreteNode[];
}

// --------------------------------------------------------------------------- //
// Rules
// --------------------------------------------------------------------------- //

/** A layout rule. `onPath` sees every planned write's path AND every tree node's path, so a path
 *  invariant is stated once and enforced by all three runners. */
export interface LayoutRule {
  code: DiagnosticCode;
  onPath?(fsPath: string, segs: readonly string[]): Diagnostic[];
  onWrite?(snap: WriteSnapshot): Diagnostic[];
  onNode?(node: ConcreteNode, tree: TreeSnapshot, fsPaths: ReadonlySet<string>): Diagnostic[];
}

/** FUTURE — one compiled `meta.yo` keyword, keyed by META-PATH (docs/language/model/metadata's meta-path →
 *  instance-path contract). A plain string, so a later `$ref`/`$defs` scheme slots in without
 *  touching the runner. */
export interface SchemaRule {
  metaPath: string;
  keyword: string;
  check(node: ConcreteNode, value: unknown): Diagnostic[];
}

/** FUTURE SEAM — compile a `meta.yo` document into value rules. Ships EMPTY: the type and
 *  the `opts.schema` plumbing are real from day one so landing the real body later is additive.
 *  When it grows, it walks the keyword nesting (`properties:` / `prefixItems:` / `items:`) and
 *  emits one rule per keyword; the engine's existing overlay read (walk.ts) supplies `meta`. */
export function compileMeta(meta: unknown, atPath: string): SchemaRule[] {
  void meta;
  void atPath;
  return [];
}

const d = (code: DiagnosticCode, message: string, where: Partial<Diagnostic>): Diagnostic => ({
  code,
  severity: DEFAULT_SEVERITY[code] ?? "error",
  message,
  ...where,
});

/** Root-relative POSIX path → its segments, dropping the empty root. */
function segsOf(fsPath: string): string[] {
  return fsPath.split("/").filter((s) => s !== "");
}

export const layoutRules: readonly LayoutRule[] = [
  {
    // A `.yo/` is the marker of the directory it sits in; a second one below it would make
    // the overlay itself a document root — the format violation that lets an editing session bury
    // content where no walk will ever look for it.
    code: "layout/nested-overlay",
    onPath(fsPath, segs) {
      const at = segs.reduce<number[]>((acc, s, i) => (s === OVERLAY_DIR ? [...acc, i] : acc), []);
      if (at.length < 2) return [];
      return [
        d("layout/nested-overlay", `\`${OVERLAY_DIR}\` cannot nest inside another \`${OVERLAY_DIR}\``, {
          fsPath,
          hint: "the overlay marks the directory it sits in; write into the directory itself",
        }),
      ];
    },
  },
  {
    // Everything under a `.yo/` is format furniture with a fixed vocabulary (docs/language/model/metadata). A
    // stray name here is content that has escaped the data tree.
    code: "layout/reserved-overlay-name",
    onPath(fsPath, segs) {
      const i = segs.indexOf(OVERLAY_DIR);
      if (i < 0 || i === segs.length - 1) return []; // no overlay, or the overlay dir itself
      const entry = segs[i + 1];
      if (entry === OVERLAY_DIR) return []; // a nested overlay is nested-overlay's diagnostic, not a second one
      const deeper = segs.length > i + 2;
      const known = OVERLAY_FILES.has(entry) || OVERLAY_SUBDIRS.has(entry);
      if (known && (!deeper || OVERLAY_SUBDIRS.has(entry))) return [];
      const why = known ? `\`${entry}\` holds no subtree` : `\`${entry}\` is not a \`${OVERLAY_DIR}\` entry`;
      return [
        d("layout/reserved-overlay-name", why, {
          fsPath,
          hint: `\`${OVERLAY_DIR}/\` holds ${[...OVERLAY_FILES].join(", ")} and ${[...OVERLAY_SUBDIRS].join("/")}`,
        }),
      ];
    },
  },
  {
    // The pre-flight twin of writeInside's post-hoc root-escape check — refused before the bytes
    // are assembled rather than after.
    code: "layout/escapes-root",
    onPath(fsPath, segs) {
      const absolute = fsPath.startsWith("/") || /^[A-Za-z]:/.test(fsPath);
      if (!absolute && !segs.includes("..")) return [];
      return [d("layout/escapes-root", "the path escapes the data root", { fsPath, hint: "paths are root-relative and POSIX" })];
    },
  },
  {
    // The writeDirMemberTree name check, hoisted out of engine-api so every write path shares it.
    // `.yo` is the one legal dot-name: the data tree is never hidden.
    code: "layout/unsafe-member-name",
    onPath(fsPath, segs) {
      const out: Diagnostic[] = [];
      for (const s of segs) {
        if (s === OVERLAY_DIR || s === "..") continue; // the overlay is vocabulary; `..` is escapes-root's
        const bad =
          s !== s.trim()
            ? "is padded"
            : s.startsWith(".")
              ? "is hidden"
              : UNSAFE_SEG.test(s) || hasControlChar(s)
                ? "carries a path metacharacter"
                : null;
        if (bad) out.push(d("layout/unsafe-member-name", `\`${s}\` ${bad} and cannot name a member`, { fsPath }));
      }
      return out;
    },
    // `index.yo` is the OTHER reserved name — the `dir/index.yo` flavor consumes it as the
    // directory's own overlay, so a member of that name would be swallowed rather than listed.
    // Judged on the member NAME, not on the path: the overlay's own write is spelled the same.
    onWrite(snap) {
      if (snap.memberName !== INDEX_FILE) return [];
      return [
        d("layout/unsafe-member-name", `\`${INDEX_FILE}\` is reserved and cannot name a member`, {
          path: snap.target.path,
          fsPath: snap.target.fsPath,
          hint: "a directory reads that file as its own overlay",
        }),
      ];
    },
  },
  {
    // THE PROMOTION CHECK. concrete-rules said this child becomes a real directory; assert the
    // plan actually makes one, instead of splicing the collection into the parent's body — the
    // bug where a whole nested list lands in a single file.
    code: "layout/inline-collection",
    onWrite(snap) {
      if (!snap.child || snap.explicitConcrete) return []; // an explicit concrete overrides the derivation
      const enc = deriveMemberEncoding(snap.child);
      if (enc === "body") return [];
      const madeDir = snap.writes.some((w) => w.kind === "dir");
      if (madeDir) return [];
      return [
        d("layout/inline-collection", `a container child derived to \`${enc}\` but no directory is written`, {
          path: snap.target.path,
          fsPath: snap.target.fsPath,
          hint: enc === "dir" ? "the key names a nested directory" : "an ordinal container becomes a directory plus a body pointer element",
        }),
      ];
    },
  },
  {
    // A keyed member's KEY names it — there is no uniqueName renaming to fall back on, so a
    // collision is a conflict, not a rename.
    code: "layout/duplicate-member",
    onWrite(snap) {
      if (snap.route !== "dir" || !snap.memberName || !snap.target.names) return [];
      if (!snap.target.names.includes(snap.memberName)) return [];
      return [
        d("layout/duplicate-member", `member \`${snap.memberName}\` already exists in the directory`, {
          path: snap.target.path,
          fsPath: snap.target.fsPath,
        }),
      ];
    },
  },
  {
    // THE LANGUAGE LOCK (concrete-rules.ts, obligatory): the interior of a `file/json5p` cannot
    // switch to yaml. Inert unless the caller knows the language it is splicing.
    code: "layout/language-switch",
    onWrite(snap) {
      const parent = snap.parent;
      if (!parent || !snap.childLanguage) return [];
      if (!isFileConcrete(parent.concrete) && baseLanguage(parent.concrete) == null) return []; // a dir imposes no interior
      const want = requiredChildLanguage(parent.concrete);
      if (snap.childLanguage === want) return [];
      return [
        d("layout/language-switch", `content inside a \`${parent.concrete}\` document must be ${want}, not ${snap.childLanguage}`, {
          path: snap.target.path,
          fsPath: snap.target.fsPath,
        }),
      ];
    },
  },
  {
    // A GENERATED member carries an order key so a plain directory listing sorts in body order.
    // A warning, not an error: the order is the body's data, the name is cosmetic.
    code: "layout/off-scheme-name",
    onWrite(snap) {
      const family = snap.nameFamily ?? (snap.route === "dir-seq" ? "item" : undefined);
      if (!family || !snap.memberName) return [];
      if ((family === "item" ? ITEM_NAME : TITLE_NAME).test(snap.memberName)) return [];
      return [
        d("layout/off-scheme-name", `generated member \`${snap.memberName}\` carries no ${family} order key`, {
          path: snap.target.path,
          fsPath: snap.target.fsPath,
          hint: family === "item" ? "nextItemName spells these item01, item02, …" : "nextMemberName spells these 01-Title",
        }),
      ];
    },
  },
  {
    // A `.yo/` whose directory is gone, or which holds only DERIVED sidecar blobs, is debris:
    // the walk will never reach it and the user cannot see it.
    code: "layout/orphan-overlay",
    onNode(node, tree, fsPaths) {
      const fsPath = node.fsPath;
      if (!fsPath) return [];
      const segs = segsOf(fsPath);
      if (segs[segs.length - 1] !== OVERLAY_DIR) return [];
      const out: Diagnostic[] = [];
      const parent = segs.slice(0, -1).join("/");
      if (!fsPaths.has(parent)) {
        out.push(d("layout/orphan-overlay", `\`${OVERLAY_DIR}\` has no directory to mark`, { path: node.path, fsPath }));
      }
      // An overlay earns its place three ways: it holds a format FILE (meta.yo alone is legal —
      // the scalar-as-binary shape); it preserves a `.trash` archive, which is the only copy of
      // what was deleted; or it marks a `dir/index.yo`, whose INSTANCE OVERLAY sits outside it —
      // the `.yo/` is unaffected by the flavor and still carries the schema, the cache and the
      // sidecars, it simply has no body of its own to hold.
      const bodyOutside = tree.nodes.find((n) => n.fsPath === parent)?.names?.includes(INDEX_FILE) ?? false;
      const earnsIt = node.names?.some((n) => OVERLAY_FILES.has(n) || n === TRASH_DIR) ?? true;
      if (node.names && !earnsIt && !bodyOutside) {
        out.push(
          d("layout/orphan-overlay", `\`${OVERLAY_DIR}\` holds no body, meta or settings`, {
            path: node.path,
            fsPath,
            hint: "an overlay with only derived sidecars is debris",
          }),
        );
      }
      return out;
    },
  },
  {
    // ONE directory, ONE instance overlay. The two flavors are alternatives, not layers: with
    // both present the walk reads `.yo/body.yo` and the `index.yo` silently stops being data,
    // so the user's edits land in a file nothing renders.
    code: "layout/duplicate-overlay",
    onNode(node, tree) {
      const { names, fsPath } = node;
      if (fsPath === undefined || !names?.includes(INDEX_FILE)) return [];
      const overlay = tree.nodes.find((n) => n.fsPath === [...segsOf(fsPath), OVERLAY_DIR].join("/"));
      if (!overlay?.names?.includes(BODY_FILE)) return [];
      return [
        d("layout/duplicate-overlay", `\`${INDEX_FILE}\` sits beside a \`${OVERLAY_DIR}/${BODY_FILE}\``, {
          path: node.path,
          fsPath,
          hint: `\`${OVERLAY_DIR}/${BODY_FILE}\` wins; move its content into one file or the other`,
        }),
      ];
    },
  },
  {
    // The concrete and the shape backing it must agree — a `dir/.yo` without its marker is
    // indistinguishable from a plain folder to the next walk.
    code: "layout/concrete-mismatch",
    onNode(node) {
      const { concrete, names, fsPath } = node;
      const at = { path: node.path, fsPath };
      if (concrete === "dir/.yo" && names && !names.includes(OVERLAY_DIR))
        return [d("layout/concrete-mismatch", `a \`dir/.yo\` carries no \`${OVERLAY_DIR}\` marker`, at)];
      if (concrete === "dir/index.yo" && names && !names.includes(INDEX_FILE))
        return [d("layout/concrete-mismatch", `a \`dir/index.yo\` carries no \`${INDEX_FILE}\` overlay`, at)];
      if (concrete === "dir" && names && names.includes(INDEX_FILE))
        return [d("layout/concrete-mismatch", `a plain \`dir\` carries an \`${INDEX_FILE}\` overlay`, { ...at, hint: "its concrete is dir/index.yo" })];
      if (concrete === "dir" && names && names.includes(OVERLAY_DIR))
        return [d("layout/concrete-mismatch", `a plain \`dir\` carries a \`${OVERLAY_DIR}\` marker`, { ...at, hint: "its concrete is dir/.yo" })];
      if (fsPath && isFileConcrete(concrete) && !isBinaryConcrete(concrete)) {
        const byExt = dataFileConcrete(fsPath);
        if (byExt && byExt !== concrete) return [d("layout/concrete-mismatch", `\`${concrete}\` is backed by a ${byExt} file`, at)];
      }
      return [];
    },
  },
];

// --------------------------------------------------------------------------- //
// Runners
// --------------------------------------------------------------------------- //

export interface ValidateOptions {
  /** Defaults to {@link layoutRules}. */
  rules?: readonly LayoutRule[];
  /** FUTURE — {@link compileMeta} output; runs alongside the layout rules into one list. */
  schema?: readonly SchemaRule[];
  ignore?: readonly DiagnosticCode[];
  /** Per-project severity overrides (demote a rule to a warning rather than switching it off). */
  severity?: Partial<Record<DiagnosticCode, Severity>>;
}

/** Apply `ignore`/`severity`, then decide the verdict: any surviving ERROR refuses. */
function verdict(found: Diagnostic[], opts?: ValidateOptions): ValidationVerdict {
  const ignore = new Set(opts?.ignore ?? []);
  const diagnostics = found
    .filter((x) => !ignore.has(x.code))
    .map((x) => (opts?.severity?.[x.code] ? { ...x, severity: opts.severity[x.code]! } : x));
  const first = diagnostics.find((x) => x.severity === "error");
  return first ? { allowed: false, reason: first.message, diagnostics } : { allowed: true, diagnostics };
}

function pathDiagnostics(fsPath: string, rules: readonly LayoutRule[]): Diagnostic[] {
  const segs = segsOf(fsPath);
  return rules.flatMap((r) => r.onPath?.(fsPath, segs) ?? []);
}

/** The cheapest net: the rules needing ONLY a root-relative path. Callable from the byte/mkdir
 *  chokepoints, which have no node context at all. */
export function validatePath(fsPath: string, opts?: ValidateOptions): ValidationVerdict {
  return verdict(pathDiagnostics(fsPath, opts?.rules ?? layoutRules), opts);
}

/** PRE-FLIGHT: every path rule over every planned write, plus the encoding rules over the
 *  routing decision. Call BEFORE the first `fs` call of the batch. */
export function validateWrite(snap: WriteSnapshot, opts?: ValidateOptions): ValidationVerdict {
  const rules = opts?.rules ?? layoutRules;
  const found = [
    ...snap.writes.flatMap((w) => pathDiagnostics(w.fsPath, rules)),
    ...rules.flatMap((r) => r.onWrite?.(snap) ?? []),
  ];
  return verdict(found, opts);
}

/** POST-HOC: the whole tree — the `yamlover doctor` sweep, and the fixture net that keeps a new
 *  rule from being over-eager. */
export function validateTree(tree: TreeSnapshot, opts?: ValidateOptions): ValidationVerdict {
  const rules = opts?.rules ?? layoutRules;
  const fsPaths = new Set<string>([""]);
  for (const n of tree.nodes) if (n.fsPath !== undefined) fsPaths.add(n.fsPath);
  const found = tree.nodes.flatMap((n) => [
    ...(n.fsPath !== undefined ? pathDiagnostics(n.fsPath, rules) : []),
    ...rules.flatMap((r) => r.onNode?.(n, tree, fsPaths) ?? []),
  ]);
  return verdict(found, opts);
}

// --------------------------------------------------------------------------- //
// Enforcement
// --------------------------------------------------------------------------- //

/** How a verdict is acted on: `throw` — any diagnostic, warnings included, aborts (dev/test, so
 *  the suite goes red on corruption); `refuse` — errors abort, warnings are returned to be logged
 *  (production); `report` — nothing aborts; `off` — the runner's output is discarded. */
export type EnforcementMode = "throw" | "refuse" | "report" | "off";

const MODES = new Set<string>(["throw", "refuse", "report", "off"]);

export class ValidationError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(reason: string, diagnostics: Diagnostic[]) {
    super(reason);
    this.name = "ValidationError";
    this.diagnostics = diagnostics;
  }
}

/** The mode to run in: an explicit project/env setting wins, else dev/test throws and production
 *  refuses. Corruption is a bug, so it must break the build before it can reach a user's data. */
export function defaultMode(env: { dev?: boolean; setting?: string | null }): EnforcementMode {
  const s = env.setting?.trim();
  if (s && MODES.has(s)) return s as EnforcementMode;
  return env.dev ? "throw" : "refuse";
}

/** Act on a verdict; returns the diagnostics the caller should LOG (never the fatal ones, which
 *  leave through the throw). */
export function enforce(v: ValidationVerdict, mode: EnforcementMode): Diagnostic[] {
  if (mode === "off") return [];
  if (mode === "report") return v.diagnostics;
  if (mode === "throw") {
    if (v.diagnostics.length) throw new ValidationError(v.allowed ? v.diagnostics[0].message : v.reason, v.diagnostics);
    return [];
  }
  if (!v.allowed) throw new ValidationError(v.reason, v.diagnostics);
  return v.diagnostics;
}
