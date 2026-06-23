import { ReactNode, useState, Fragment } from "react";
import { fragmentOf, isAncestorPath } from "./paths";
import type { CommentBucket, CommentMap } from "./api";

// Keep in sync with LINK_KEY / BINARY_KEY in src/server/yamlover.ts.
//
// A node shown only as a link (a container past the depth budget, or any binary
// leaf) arrives as `{ [LINK_KEY]: {kind, path, count|size} }` — the same marker in
// the value and the schema — so every representation renders the same hyperlink.
//
// The bytes of a selected binary leaf arrive as `{ [BINARY_KEY]: {format,size,
// base64} }`, rendered as `!!binary` (YAML) or the metadata object (JSON).
//
// An `x-yamlover.rel` pointer arrives as `{ [REF_KEY]: {text, path} }` — the
// pointer string rendered as a hyperlink that navigates to the resolved `path`
// (or as plain text when `path` is null, i.e. the pointer does not resolve).
const LINK_KEY = "$yamloverLink";
const BINARY_KEY = "$yamloverBinary";
const REF_KEY = "$yamloverRef";
// An omni/mix node (a `!!var` self-value + fields, or a `!!mix` of items + fields) arrives as
// `{ [MIXED_KEY]: {kind, value?, entries:[{key,value}]} }`, rendered in yamlover as a leading
// scalar (omni) then each entry positional (`- v`, key=null) or keyed (`k: v`).
const MIXED_KEY = "$yamloverMixed";
// A non-finite number (±Infinity / NaN) that JSON cannot carry: arrives as `{ [NUM_KEY]: name }`
// where name is "Infinity" | "-Infinity" | "NaN", rendered as the literal for the active syntax.
const NUM_KEY = "$yamloverNum";

export interface Link {
  kind: "object" | "array" | "scalar" | "binary" | "omni" | "mix";
  type?: string; // the target's JSON-Schema type; with the facets, the routing key
  path: string;
  title?: string; // the target's schema title, when set (used as a link label)
  count?: number;
  size?: number;
  format?: string | null;
  valueType?: string | null; // renderer dispatch facets (TYPES.md §9) — carried so a chunk routes correctly
  hasKeyed?: boolean;
  hasOrdinal?: boolean;
  value?: unknown; // for a link to a scalar: its value, shown as the label
  color?: string | null; // for a link to a pure color tag: its explicit color (badges)
  concrete?: string | null; // how the target is stored; `dir`/`yamlover` → a folder icon
}

interface Ref {
  text: string;
  path: string | null;
}

interface Mixed {
  kind: "omni" | "mix";
  value?: unknown; // omni: the node's own scalar self-value
  entries: { key: string | null; value: unknown }[]; // key=null ⇒ positional item, else keyed field
}

interface BinaryPayload {
  format: string | null;
  size: number;
  base64: string;
}

function asSingle<T>(v: unknown, key: string): T | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v as object);
    if (keys.length === 1 && keys[0] === key) return (v as any)[key] as T;
  }
  return null;
}

/** Read a one-level link marker (a nested container or binary shown as a
 *  hyperlink), or null when `v` is not one. Exported for custom renderers that
 *  need to treat a child's link specially (e.g. the chapter renderer). */
export const asLink = (v: unknown) => asSingle<Link>(v, LINK_KEY);
const asBinary = (v: unknown) => asSingle<BinaryPayload>(v, BINARY_KEY);
const asRef = (v: unknown) => asSingle<Ref>(v, REF_KEY);
const asMixed = (v: unknown) => asSingle<Mixed>(v, MIXED_KEY);
const asNum = (v: unknown) => asSingle<string>(v, NUM_KEY);

/** The literal for a non-finite number `name` ("Infinity"|"-Infinity"|"NaN") in the active syntax:
 *  YAML float specials in yamlover (`.inf`/`-.inf`/`.nan`), the json5 words in json5p. */
function numToken(name: string, syntax: Syntax): string {
  if (syntax === "json") return name; // Infinity / -Infinity / NaN are json5 literals
  return name === "NaN" ? ".nan" : name === "-Infinity" ? "-.inf" : ".inf";
}

/** The scalar SELF-VALUE a string/scalar renderer should show. An OMNI node (a scalar that also
 *  carries fields — e.g. a markdown doc that gained `yamlover-annotations` keys) projects its page
 *  `value` as a `$yamloverMixed` marker, so peel it to the self-value; a plain scalar passes
 *  through. Pairs with the facet-tolerant dispatch (TYPES.md §9): routing keeps an annotated string
 *  on its renderer, and this hands that renderer the string — not the marker object. */
export function scalarValue(v: unknown): unknown {
  const m = asMixed(v);
  const self = m && m.kind === "omni" ? m.value : v;
  const num = asNum(self);
  if (num) return num === "NaN" ? NaN : num === "-Infinity" ? -Infinity : Infinity; // peel to the JS number
  return self;
}

type Syntax = "yaml" | "json";
type Nav = (path: string) => void;

/** Shared per-render context: navigation plus the anchoring needed to (a) stamp each node with its
 *  `#`-fragment id and (b) turn a LOCAL reference (one resolving inside the rendered subtree) into
 *  an in-page `#` link that scrolls instead of navigating. `doc` is the document root — the fragment
 *  base; `node` is the rendered root — a ref into its subtree is local; `anchors` gates id emission
 *  (off for the relations panel, so its keys don't collide with the value's ids). */
interface Ctx {
  nav: Nav;
  doc: string;
  node: string;
  anchors: boolean;
  comments?: CommentMap; // keyed by each node's fragment continuation FROM the rendered root
  base: string;          // the rendered root's fragment — what `frag` values are prefixed with
}

/** The leading/trailing comment bucket for the node at `frag` (its key relative to the rendered
 *  root is `frag` minus the base). Undefined when there are no comments or none for this node. */
function commentsAt(ctx: Ctx, frag: string): CommentBucket | undefined {
  if (!ctx.comments) return undefined;
  const v = ctx.comments[frag.slice(ctx.base.length)];
  return v && !Array.isArray(v) ? v : undefined;
}

/** A comment line as it reads in `syntax`: `# body` (yaml) / `// body` (json), dimmed (`.c`). */
function fmtComment(text: string, syntax: Syntax): string {
  return (syntax === "yaml" ? "#" : "//") + " " + text.trim();
}

/** The `*…` deref token for a canonical pointer `raw` (no `*`): yamlover quotes only when outer
 *  whitespace would be lost (mirrors serialize-yamlover `pointerToken`); json5p JSON-quotes it. */
function fmtPointer(raw: string, syntax: Syntax): string {
  if (syntax === "json") return "*" + JSON.stringify(raw);
  return raw !== raw.trim() ? `*'${raw.replace(/'/g, "''")}'` : "*" + raw;
}

/** The `&…` anchor token for a path-anchor `body` (no `&`). In yamlover the canonical colon
 *  body (`: chief`) rides BARE — its `: ` is styling, not a delimiter (the token runs to the
 *  end of the line). json5p JSON-quotes it. */
function fmtAnchor(body: string, syntax: Syntax): string {
  return syntax === "json" ? "&" + JSON.stringify(body) : "&" + body;
}

/** The syntax decorations on an entry's key line — its type tag then its `&` anchors (a tag is
 *  yamlover-only; json5p has no `!!…`). Rendered right after `key:`, before the value. */
function decoSpan(ctx: Ctx, frag: string, syntax: Syntax): ReactNode {
  const d = commentsAt(ctx, frag);
  if (!d) return null;
  const tag = syntax === "yaml" ? d.tag : undefined;
  const anchors = d.anchors ?? [];
  if (!tag && anchors.length === 0) return null;
  return (
    <>
      {tag && <>{" "}<span className="b">{tag}</span></>}
      {anchors.map((a, i) => <Fragment key={`an${i}`}>{" "}<span className="anchor">{fmtAnchor(a, syntax)}</span></Fragment>)}
    </>
  );
}

/** Own-line `leading` comments above an entry, each at `pad` indent. */
function LeadingComments({ ctx, frag, pad, syntax }: { ctx: Ctx; frag: string; pad: string; syntax: Syntax }): ReactNode {
  const lead = commentsAt(ctx, frag)?.leading;
  if (!lead?.length) return null;
  return <>{lead.map((t, i) => <Fragment key={`lc${i}`}>{pad}<span className="c">{fmtComment(t, syntax)}</span>{"\n"}</Fragment>)}</>;
}

/** The `trailing` comment that rides an entry's line (after its value), joined if several. */
function trailingComment(ctx: Ctx, frag: string, syntax: Syntax): ReactNode {
  const trail = commentsAt(ctx, frag)?.trailing;
  if (!trail?.length) return null;
  return <>{" "}<span className="c">{trail.map((t) => fmtComment(t, syntax)).join(" ")}</span></>;
}

/** A comment that rides a node's own SELF-VALUE line (an omni `5 # …`), keyed at the node's frag. */
function valueTrailingComment(ctx: Ctx, frag: string, syntax: Syntax): ReactNode {
  const vt = commentsAt(ctx, frag)?.valueTrailing;
  if (!vt?.length) return null;
  return <>{" "}<span className="c">{vt.map((t) => fmtComment(t, syntax)).join(" ")}</span></>;
}

/** A file-level comment block ($head banner / $tail leftovers) at the rendered root, no indent. */
function CommentBlock({ texts, syntax }: { texts: string[]; syntax: Syntax }): ReactNode {
  return <>{texts.map((t, i) => <Fragment key={`fc${i}`}><span className="c">{fmtComment(t, syntax)}</span>{"\n"}</Fragment>)}</>;
}

function fileComments(comments: CommentMap | undefined, key: "$head" | "$tail"): string[] | undefined {
  const v = comments?.[key];
  return Array.isArray(v) && v.length ? v : undefined;
}

/** Navigate to an in-page fragment: record `<doc>#/cont` in history and scroll to the node stamped
 *  with that id. The id is the DECODED slash continuation (see {@link fragmentOf}). */
function goFragment(frag: string): void {
  const base = window.location.pathname + window.location.search;
  window.history.pushState({}, "", base + "#" + frag);
  document.getElementById(frag)?.scrollIntoView?.(); // optional-call: absent in jsdom
}

/** A zero-width anchor stamping a node's `#`-fragment id at its line, so a deep link or a local ref
 *  can scroll straight to it. Nothing for the page root (empty fragment) or when anchors are off. */
function Anchor({ ctx, frag }: { ctx: Ctx; frag: string }): ReactNode {
  if (!ctx.anchors || !frag) return null;
  return <span id={frag} className="frag-anchor" />;
}

/**
 * Render a value in YAML or JSON syntax, syntax-highlighted, with nested containers shown inline
 * (the server inlines them up to the requested DEPTH) and **collapsible** — each inline object /
 * array carries a fold chevron in the LEFT GUTTER (JetBrains-style, the same chevron as the TOC).
 * A container past the depth budget arrives as a link marker and is drawn as a CONTINUATION
 * hyperlink you click to descend. Used for every RHS data representation so they behave identically.
 *
 * `documentPath`/`nodePath` anchor the fragment scheme: every node is stamped with its slash
 * continuation from the document root as an `id`, and a reference resolving inside the rendered
 * subtree renders as an in-page `#` link. `anchors=false` (the relations panel) suppresses ids.
 */
export function Render({
  value,
  syntax,
  onNavigate,
  documentPath = ":",
  nodePath = ":",
  anchors = true,
  comments,
}: {
  value: unknown;
  syntax: Syntax;
  onNavigate: Nav;
  documentPath?: string;
  nodePath?: string;
  anchors?: boolean;
  comments?: CommentMap;
}) {
  const base = fragmentOf(documentPath, nodePath); // the rendered root's continuation from the doc
  const ctx: Ctx = { nav: onNavigate, doc: documentPath, node: nodePath, anchors, comments, base };
  const bin = asBinary(value);
  if (bin && syntax === "yaml") return <BinaryYaml bin={bin} />;
  const v = bin ?? value; // JSON shows the {format,size,base64} metadata object
  const head = fileComments(comments, "$head"); // the file banner, above the value
  const tail = fileComments(comments, "$tail"); // leftover comments after the last entry
  return (
    <>
      {head && <CommentBlock texts={head} syntax={syntax} />}
      {syntax === "yaml" ? (
        <YamlRoot value={v} indent={0} ctx={ctx} frag={base} />
      ) : (
        <JsonValue value={v} indent={0} ctx={ctx} frag={base} root />
      )}
      {tail && <CommentBlock texts={tail} syntax={syntax} />}
    </>
  );
}

/** A selected binary leaf as a YAML `!!binary` block (a comment carries the
 *  format/size; the base64 is the block scalar's content, canonically wrapped at
 *  76 columns and indented two spaces). */
function BinaryYaml({ bin }: { bin: BinaryPayload }) {
  const lines: string[] = [];
  for (let i = 0; i < bin.base64.length; i += 76) lines.push("  " + bin.base64.slice(i, i + 76));
  return (
    <>
      <span className="b">!!binary</span> <span className="punct">|</span>{"  "}
      <span className="c">{`# ${bin.format ?? "binary"}, ${bin.size} bytes`}</span>
      {"\n"}
      <span className="s">{lines.join("\n")}</span>
    </>
  );
}

// --------------------------------------------------------------------------- //
// Shared leaves (links / refs / scalars / fold toggle)
// --------------------------------------------------------------------------- //
function linkNode(link: Link, syntax: Syntax, ctx: Ctx): ReactNode {
  // a scalar child links by its rendered value (`~`/`null`, quoted/bare per syntax);
  // a container by its `{ … }`/`[ … ]` summary
  const label = link.kind === "scalar" ? scalarLabel(link.value, syntax) : linkLabel(link);
  return (
    <a
      className="descend"
      href={link.path}
      onClick={(e) => {
        e.preventDefault();
        ctx.nav(link.path);
      }}
    >
      {label}
    </a>
  );
}

/** A scalar value as it would render in `syntax` — used as a scalar link's label. */
function scalarLabel(v: unknown, syntax: Syntax): string {
  if (v === null || v === undefined) return "null";
  const num = asNum(v);
  if (num) return numToken(num, syntax);
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return syntax === "json" ? JSON.stringify(v) : String(v);
}

/** A `rel` pointer rendered AS a reference: its yamlover pointer text, hyperlinked. A pointer that
 *  resolves INSIDE the rendered subtree becomes an in-page `#` fragment link (scrolls to where the
 *  target sits, so the URL path stays on the document); one resolving elsewhere navigates to its
 *  page; an unresolved pointer is plain text (no link). */
function refNode(ref: Ref, syntax: Syntax, ctx: Ctx, display?: string): ReactNode {
  // `display` (the authored `*…` pointer token, from the IR sidecar) is the faithful rendering;
  // fall back to the resolved path text only when the sidecar has no pointer for this node.
  const text = display ?? (syntax === "json" ? JSON.stringify(ref.text) : ref.text);
  if (!ref.path) return <span className="s">{text}</span>;
  const local = ref.path === ctx.node || isAncestorPath(ctx.node, ref.path);
  if (local) {
    const frag = fragmentOf(ctx.doc, ref.path);
    return (
      <a
        className="descend ref-local"
        href={"#" + frag}
        onClick={(e) => {
          e.preventDefault();
          goFragment(frag);
        }}
      >
        {text}
      </a>
    );
  }
  const target = ref.path;
  return (
    <a
      className="descend"
      href={target}
      onClick={(e) => {
        e.preventDefault();
        ctx.nav(target);
      }}
    >
      {text}
    </a>
  );
}

function linkLabel(link: Link): string {
  const n = link.count ?? 0;
  if (link.kind === "array") return `[ array with ${n} ${n === 1 ? "item" : "items"} ]`;
  if (link.kind === "binary") return `< binary of ${link.size ?? 0} bytes >`;
  if (link.kind === "mix") return `{ mixed with ${n} ${n === 1 ? "entry" : "entries"} }`;
  if (link.kind === "omni") return `{ variant ${scalarLabel(link.value, "yaml")} + ${n} ${n === 1 ? "field" : "fields"} }`;
  return `{ object with ${n} ${n === 1 ? "property" : "properties"} }`;
}

function scalarNode(v: unknown, syntax: Syntax): ReactNode {
  if (v === null) return <span className="null">null</span>; // canonical yamlover null (not the obsolete `~`)
  if (typeof v === "boolean") return <span className="b">{String(v)}</span>;
  const num = asNum(v);
  if (num) return <span className="n">{numToken(num, syntax)}</span>; // ±Infinity / NaN literal
  if (typeof v === "number") return <span className="n">{String(v)}</span>;
  const text = syntax === "json" ? JSON.stringify(v) : String(v);
  return <span className="s">{text}</span>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !asNum(v); // a `$yamloverNum` marker is a scalar leaf

/** Whether a value renders as an inline, COLLAPSIBLE container — a non-empty object / array, or an
 *  omni/mix marker. Link / ref markers (continuations, navigated not folded), empty containers, and
 *  scalars are not foldable. */
function foldable(v: unknown): boolean {
  if (asLink(v) || asRef(v)) return false;
  if (asMixed(v)) return true;
  if (isObj(v)) return Object.keys(v).length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return false;
}

/** The summary shown when an inline container is FOLDED — distinct wording from a continuation
 *  link's {@link linkLabel}, since a fold reveals in place, it does not navigate. */
function foldSummary(value: unknown): string {
  const mixed = asMixed(value);
  if (mixed) {
    const n = mixed.entries.length;
    if (mixed.kind === "omni") return `{ variant ${scalarLabel(mixed.value, "yaml")} + ${n} ${n === 1 ? "field" : "fields"} }`;
    return `{ mixed with ${n} ${n === 1 ? "entry" : "entries"} }`;
  }
  if (Array.isArray(value)) {
    const n = value.length;
    return `[ ${n} ${n === 1 ? "item" : "items"} ]`;
  }
  const n = Object.keys(value as object).length;
  return `{ ${n} ${n === 1 ? "property" : "properties"} }`;
}

/** The fold chevron for an inline container — the SAME chevron the TOC uses (`›`, rotated 90° when
 *  open). It is a ZERO-WIDTH anchor placed at the START of the container's opening line; its chevron
 *  is absolutely positioned into the left gutter (see `.fold`/`.code` in styles.css), so it sits in
 *  one fixed column at the correct line regardless of nesting depth. */
function FoldToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  // reuse the TOC's `.toggle`/`.chevron` (so the chevron is IDENTICAL — same `›`, size, weight,
  // rotation); `.fold-gutter` only repositions it into the code's left gutter (see styles.css)
  return (
    <button type="button" className={"toggle fold-gutter" + (open ? " open" : "")} aria-label={open ? "collapse" : "expand"} onClick={onToggle}>
      <span className="chevron">›</span>
    </button>
  );
}

// --------------------------------------------------------------------------- //
// YAML
// --------------------------------------------------------------------------- //
/** A YAML value as a block at `indent` — the entry point (root) and the body of every nested
 *  container. The root container is NOT itself foldable (it is the whole view); its nested
 *  containers are, via their key/item rows. */
function YamlRoot({ value, indent, ctx, frag }: { value: unknown; indent: number; ctx: Ctx; frag: string }): ReactNode {
  const link = asLink(value);
  if (link) return <>{linkNode(link, "yaml", ctx)}{"\n"}</>;
  const ref = asRef(value);
  if (ref) return <>{refNode(ref, "yaml", ctx)}{"\n"}</>;
  if (foldable(value)) return <YamlBody value={value} indent={indent} ctx={ctx} frag={frag} />;
  if (isObj(value)) return <><span className="punct">{"{}"}</span>{"\n"}</>;
  if (Array.isArray(value)) return <><span className="punct">{"[]"}</span>{"\n"}</>;
  return <>{scalarNode(value, "yaml")}{valueTrailingComment(ctx, frag, "yaml")}{"\n"}</>;
}

/** The lines of a non-empty container (object / array / mixed) at `indent` — no toggle of its own;
 *  the toggle for this block sits on the key/item row one level up. With `inlineHead`, the FIRST
 *  row drops its leading indent so it sits right after a `- ` on the line above (YAML block style).
 *  `frag` is this container's own fragment continuation; each child appends its key/index to it. */
function YamlBody({ value, indent, ctx, frag, inlineHead = false }: { value: unknown; indent: number; ctx: Ctx; frag: string; inlineHead?: boolean }): ReactNode {
  const mixed = asMixed(value);
  if (mixed) return <YamlMixed mixed={mixed} indent={indent} ctx={ctx} frag={frag} />;
  if (isObj(value)) return <YamlObject entries={Object.entries(value)} indent={indent} ctx={ctx} frag={frag} inlineHead={inlineHead} />;
  return <YamlArray items={value as unknown[]} indent={indent} ctx={ctx} frag={frag} inlineHead={inlineHead} />;
}

function YamlObject({ entries, indent, ctx, frag, inlineHead = false }: { entries: [string, unknown][]; indent: number; ctx: Ctx; frag: string; inlineHead?: boolean }): ReactNode {
  const pad = " ".repeat(indent);
  return <>{entries.map(([k, v], i) => <YamlEntry key={i} k={k} v={v} pad={pad} indent={indent} ctx={ctx} frag={`${frag}/${k}`} noPad={inlineHead && i === 0} />)}</>;
}

function YamlArray({ items, indent, ctx, frag, inlineHead = false }: { items: unknown[]; indent: number; ctx: Ctx; frag: string; inlineHead?: boolean }): ReactNode {
  const pad = " ".repeat(indent);
  return <>{items.map((item, i) => <YamlItem key={i} v={item} pad={pad} indent={indent} ctx={ctx} frag={`${frag}[${i}]`} noPad={inlineHead && i === 0} />)}</>;
}

/** Whether an array item's container value can render in COMPACT YAML block style — its first
 *  child on the dash's own line (`- name: Rex`). Only a plain object/array whose FIRST child is
 *  itself NOT foldable qualifies: that keeps a single fold chevron per row (no toggle would land on
 *  the shared first line). A mixed/omni node, or one whose first child is foldable, stays on its
 *  own line below the dash. */
function canInlineAfterDash(v: unknown): boolean {
  if (asMixed(v)) return false;
  if (isObj(v)) { const vs = Object.values(v); return vs.length > 0 && !foldable(vs[0]); }
  if (Array.isArray(v)) return v.length > 0 && !foldable(v[0]);
  return false;
}

function YamlMixed({ mixed, indent, ctx, frag }: { mixed: Mixed; indent: number; ctx: Ctx; frag: string }): ReactNode {
  const pad = " ".repeat(indent);
  return (
    <>
      {/* omni: the node's own scalar value on its own line first (`!!var 5` → `5`) */}
      {mixed.kind === "omni" && (
        <>
          {pad}
          {scalarNode(mixed.value, "yaml")}
          {valueTrailingComment(ctx, frag, "yaml")}
          {"\n"}
        </>
      )}
      {mixed.entries.map((e, i) =>
        e.key === null ? (
          <YamlItem key={i} v={e.value} pad={pad} indent={indent} ctx={ctx} frag={`${frag}[${i}]`} />
        ) : (
          <YamlEntry key={i} k={e.key} v={e.value} pad={pad} indent={indent} ctx={ctx} frag={`${frag}/${e.key}`} />
        ),
      )}
    </>
  );
}

/** A `key: value` row. A foldable value gets a gutter toggle on this row and its body below (or a
 *  fold summary when collapsed); a scalar / link / empty renders inline. `noPad` drops the leading
 *  indent when this row is the first child sitting after a `- ` (YAML block style). `frag` is this
 *  node's fragment continuation (its `#`-anchor id). */
function YamlEntry({ k, v, pad, indent, ctx, frag, noPad = false }: { k: string; v: unknown; pad: string; indent: number; ctx: Ctx; frag: string; noPad?: boolean }): ReactNode {
  const [open, setOpen] = useState(true);
  const blank = !noPad && commentsAt(ctx, frag)?.blankBefore ? "\n" : null; // preserve an empty source line
  const lead = noPad ? null : <LeadingComments ctx={ctx} frag={frag} pad={pad} syntax="yaml" />;
  const trail = trailingComment(ctx, frag, "yaml");
  const ptr = commentsAt(ctx, frag)?.pointer; // a ref's authored `*…` token, if any
  const deco = decoSpan(ctx, frag, "yaml"); // type tag + `&` anchors on the key line
  const head = (
    <>
      {noPad ? null : pad}
      <Anchor ctx={ctx} frag={frag} />
      <span className="k">{k}</span>
      <span className="punct">:</span>
    </>
  );
  if (!foldable(v)) return <>{blank}{lead}{head}{deco}{inlineYamlValue(v, ctx, trail, ptr && fmtPointer(ptr, "yaml"))}</>;
  return (
    <>
      {blank}
      {lead}
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      {head}
      {deco}
      {open ? <>{trail}{"\n"}<YamlBody value={v} indent={indent + 2} ctx={ctx} frag={frag} /></> : <>{" "}<span className="fold-summary">{foldSummary(v)}</span>{trail}{"\n"}</>}
    </>
  );
}

/** A `- value` array / positional row, with the same fold behaviour as {@link YamlEntry}. A foldable
 *  container value renders COMPACT (first child on this same line, `- name: Rex`) when it can — see
 *  {@link canInlineAfterDash} — else its body drops to indented lines below. */
function YamlItem({ v, pad, indent, ctx, frag, noPad = false }: { v: unknown; pad: string; indent: number; ctx: Ctx; frag: string; noPad?: boolean }): ReactNode {
  const [open, setOpen] = useState(true);
  const blank = !noPad && commentsAt(ctx, frag)?.blankBefore ? "\n" : null;
  const lead = noPad ? null : <LeadingComments ctx={ctx} frag={frag} pad={pad} syntax="yaml" />;
  const trail = trailingComment(ctx, frag, "yaml");
  const ptr = commentsAt(ctx, frag)?.pointer; // a `- *…` item's authored pointer token
  const deco = decoSpan(ctx, frag, "yaml");
  // `.yaml-dash` styles the marker (gray like the chevron) — kept a fixed cell so columns line up
  const dash = (
    <>
      {noPad ? null : pad}
      <Anchor ctx={ctx} frag={frag} />
      <span className="punct yaml-dash">{"-"}</span>
    </>
  );
  if (!foldable(v)) return <>{blank}{lead}{dash}{deco}{inlineYamlValue(v, ctx, trail, ptr && fmtPointer(ptr, "yaml"))}</>;
  const compact = canInlineAfterDash(v);
  return (
    <>
      {blank}
      {lead}
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      {dash}
      {deco}
      {!open ? (
        <>{" "}<span className="fold-summary">{foldSummary(v)}</span>{trail}{"\n"}</>
      ) : compact ? (
        <>{" "}<YamlBody value={v} indent={indent + 2} ctx={ctx} frag={frag} inlineHead /></>
      ) : (
        <>{trail}{"\n"}<YamlBody value={v} indent={indent + 2} ctx={ctx} frag={frag} /></>
      )}
    </>
  );
}

/** A non-foldable value following a `key:` / `- ` — a link, ref, empty container, or scalar,
 *  rendered inline with a leading space and a trailing newline. */
function inlineYamlValue(v: unknown, ctx: Ctx, trail: ReactNode = null, ptr?: string): ReactNode {
  const link = asLink(v);
  if (link) return <>{" "}{linkNode(link, "yaml", ctx)}{trail}{"\n"}</>;
  const ref = asRef(v);
  if (ref) return <>{" "}{refNode(ref, "yaml", ctx, ptr)}{trail}{"\n"}</>;
  if (isObj(v) && Object.keys(v).length === 0) return <>{" "}<span className="punct">{"{}"}</span>{trail}{"\n"}</>;
  if (Array.isArray(v) && v.length === 0) return <>{" "}<span className="punct">{"[]"}</span>{trail}{"\n"}</>;
  return <>{" "}{scalarNode(v, "yaml")}{trail}{"\n"}</>;
}

// --------------------------------------------------------------------------- //
// JSON (nested containers shown inline are collapsible; ones past the depth budget become links, so
// the view is not strictly valid JSON — it is the same representation, in JSON syntax)
// --------------------------------------------------------------------------- //
/** A JSON value at `indent`. At the root, a container renders without a toggle (it is the whole
 *  view); nested foldable containers carry a gutter toggle on their key/item row (see
 *  {@link JsonEntry}/{@link JsonItem}), so they never reach here while foldable. */
function JsonValue({ value, indent, ctx, frag, root = false }: { value: unknown; indent: number; ctx: Ctx; frag: string; root?: boolean }): ReactNode {
  const link = asLink(value);
  if (link) return linkNode(link, "json", ctx);
  const ref = asRef(value);
  if (ref) {
    const ptr = commentsAt(ctx, frag)?.pointer; // the authored pointer, json5p-quoted
    return refNode(ref, "json", ctx, ptr && fmtPointer(ptr, "json"));
  }
  if (root && foldable(value)) return <JsonBody value={value} indent={indent} ctx={ctx} frag={frag} />;
  const objEntries = jsonObjEntries(value);
  if (objEntries) return objEntries.length ? <JsonBody value={value} indent={indent} ctx={ctx} frag={frag} /> : <span className="punct">{"{}"}</span>;
  if (Array.isArray(value)) return value.length ? <JsonBody value={value} indent={indent} ctx={ctx} frag={frag} /> : <span className="punct">{"[]"}</span>;
  return scalarNode(value, "json");
}

/** The object entries a JSON value projects: an omni/mix marker flattened (`$value` + entries), or a
 *  plain object's own entries, or null when it is not object-like. */
function jsonObjEntries(value: unknown): [string, unknown][] | null {
  const mixed = asMixed(value);
  if (mixed)
    return [
      ...(mixed.kind === "omni" ? ([["$value", mixed.value]] as [string, unknown][]) : []),
      ...mixed.entries.map((e, i): [string, unknown] => [e.key ?? String(i), e.value]),
    ];
  return isObj(value) ? Object.entries(value) : null;
}

/** The `{ … }` / `[ … ]` body of a container, no toggle of its own. */
function JsonBody({ value, indent, ctx, frag }: { value: unknown; indent: number; ctx: Ctx; frag: string }): ReactNode {
  const objEntries = jsonObjEntries(value);
  if (objEntries) return <JsonObject entries={objEntries} indent={indent} ctx={ctx} frag={frag} />;
  return <JsonArray items={value as unknown[]} indent={indent} ctx={ctx} frag={frag} />;
}

function JsonObject({ entries, indent, ctx, frag }: { entries: [string, unknown][]; indent: number; ctx: Ctx; frag: string }): ReactNode {
  const pad = " ".repeat(indent + 2);
  return (
    <>
      <span className="punct">{"{"}</span>
      {"\n"}
      {entries.map(([k, v], i) => (
        <JsonEntry key={i} k={k} v={v} pad={pad} indent={indent + 2} ctx={ctx} frag={`${frag}/${k}`} last={i === entries.length - 1} />
      ))}
      {" ".repeat(indent)}
      <span className="punct">{"}"}</span>
    </>
  );
}

function JsonArray({ items, indent, ctx, frag }: { items: unknown[]; indent: number; ctx: Ctx; frag: string }): ReactNode {
  const pad = " ".repeat(indent + 2);
  return (
    <>
      <span className="punct">{"["}</span>
      {"\n"}
      {items.map((item, i) => (
        <JsonItem key={i} v={item} pad={pad} indent={indent + 2} ctx={ctx} frag={`${frag}[${i}]`} last={i === items.length - 1} />
      ))}
      {" ".repeat(indent)}
      <span className="punct">{"]"}</span>
    </>
  );
}

/** A `"key": value,` row. A foldable value gets a gutter toggle on this row; otherwise it renders
 *  inline. `frag` is this node's fragment continuation (its `#`-anchor id). */
function JsonEntry({ k, v, pad, indent, ctx, frag, last }: { k: string; v: unknown; pad: string; indent: number; ctx: Ctx; frag: string; last: boolean }): ReactNode {
  const [open, setOpen] = useState(true);
  const lead = <LeadingComments ctx={ctx} frag={frag} pad={pad} syntax="json" />;
  const head = (
    <>
      {pad}
      <Anchor ctx={ctx} frag={frag} />
      <span className="k">{`"${k}"`}</span>
      <span className="punct">{": "}</span>
      {decoSpan(ctx, frag, "json")}
    </>
  );
  // a `//` trailing comment goes AFTER the comma (else it would swallow the separator)
  const tail = (
    <>
      {last ? "" : ","}
      {trailingComment(ctx, frag, "json")}
      {"\n"}
    </>
  );
  if (!foldable(v)) return <>{lead}{head}<JsonValue value={v} indent={indent} ctx={ctx} frag={frag} />{tail}</>;
  return (
    <>
      {lead}
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      {head}
      {open ? <JsonBody value={v} indent={indent} ctx={ctx} frag={frag} /> : <span className="fold-summary">{foldSummary(v)}</span>}
      {tail}
    </>
  );
}

/** An array element row, with the same fold behaviour as {@link JsonEntry}. */
function JsonItem({ v, pad, indent, ctx, frag, last }: { v: unknown; pad: string; indent: number; ctx: Ctx; frag: string; last: boolean }): ReactNode {
  const [open, setOpen] = useState(true);
  const lead = <LeadingComments ctx={ctx} frag={frag} pad={pad} syntax="json" />;
  const tail = (
    <>
      {last ? "" : ","}
      {trailingComment(ctx, frag, "json")}
      {"\n"}
    </>
  );
  if (!foldable(v)) return <>{lead}{pad}<Anchor ctx={ctx} frag={frag} />{decoSpan(ctx, frag, "json")}<JsonValue value={v} indent={indent} ctx={ctx} frag={frag} />{tail}</>;
  return (
    <>
      {lead}
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      {pad}
      <Anchor ctx={ctx} frag={frag} />
      {decoSpan(ctx, frag, "json")}
      {open ? <JsonBody value={v} indent={indent} ctx={ctx} frag={frag} /> : <span className="fold-summary">{foldSummary(v)}</span>}
      {tail}
    </>
  );
}
