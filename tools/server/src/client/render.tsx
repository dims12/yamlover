import { ReactNode, useState, Fragment } from "react";
import { Chevron } from "./chevron";
import { fragmentOf, isAncestorPath, ROOT_FRAGMENT } from "./paths";
import { segToken } from "../../../parser/ts/src/pathseg.ts";
import type { CommentBucket, CommentMap } from "./api";
import { isJsonFamily } from "../concrete";
import { ScalarLeaf } from "./renderers/value-editors";
import { navigateToFragment } from "./renderers/headings";
import { highlightLang, highlightSpans } from "./highlight";

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
  valueType?: string | null; // renderer dispatch facets (docs/language/logical-graph/matching) — carried so a chunk routes correctly
  hasKeyed?: boolean;
  hasOrdinal?: boolean;
  yo?: boolean; // `!!yo` — plain yamlover, exempt from the enclosing schema (chapter routing)
  value?: unknown; // for a link to a scalar: its value, shown as the label
  color?: string | null; // for a link to a pure color tag: its explicit color (badges)
  concrete?: string | null; // how the target is stored; `dir`/`yamlover` → a folder icon
  preview?: string | null; // a representative image path to thumbnail (a fragment → its crop blob)
}

export interface Ref {
  text: string;
  path: string | null;
}

export interface Mixed {
  kind: "omni" | "mix" | "array"; // "array": a format-stamped all-keyless container (e.g. a tagged nested table)
  value?: unknown; // omni: the node's own scalar self-value
  selfAt?: number; // omni: the self-value's authored display position among `entries` (0/absent → first)
  format?: string | null; // the node's stamped/derived format — a renderer's branch point (a chapter CELL vs a nested table)
  yo?: boolean; // `!!yo` — plain yamlover, exempt from the enclosing schema (chapter routing)
  // key=null ⇒ positional item, else keyed field. `keyNull` ⇒ the NULL KEY (YAML's rule): key is
  // null but the entry is KEYED — rendered `~: value`, addressed by the `~` path segment.
  // `anchor` ⇒ a POSITIONAL member whose key is a
  // DERIVED storage anchor (a dir-backed pointer-array body consumed the `*key` pointer): rendered
  // `- &key value`, the anchor dimmed (`.anchor.derived`) — a view spelling, not authored source.
  entries: { key: string | null; keyNull?: boolean; value: unknown; anchor?: boolean }[];
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
/** Read a pointer marker ({text, path|null}) / an omni-mix marker — exported for custom
 *  renderers that treat them specially (the table renderer's merged cells / nested tables). */
export const asRef = (v: unknown) => asSingle<Ref>(v, REF_KEY);
export const asMixed = (v: unknown) => asSingle<Mixed>(v, MIXED_KEY);
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
 *  through. Pairs with the facet-tolerant dispatch (docs/language/logical-graph/matching): routing keeps an annotated string
 *  on its renderer, and this hands that renderer the string — not the marker object. */
export function scalarValue(v: unknown): unknown {
  const m = asMixed(v);
  const self = m && m.kind === "omni" ? m.value : v;
  const num = asNum(self);
  if (num) return num === "NaN" ? NaN : num === "-Infinity" ? -Infinity : Infinity; // peel to the JS number
  return self;
}

export type Syntax = "yaml" | "json";
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
  editable: boolean;     // this view may be unlocked → scalar leaves render an inline editor
  concrete: string | null; // how the value is stored (the storage LANGUAGE) — gates which edits are legal
}

/** The absolute (canonical colon-form) path of a child node — its parent `path` plus one segment,
 *  spelled exactly as {@link segsToStr} would (`:` + the segment's percent-encoded canonical token —
 *  bare digits for a position, `~` for the null key). Threaded PARALLEL to `frag` (rather than
 *  derived from it) because `frag` is slash-joined
 *  DECODED keys — a key containing `/` is ambiguous there, fine for a scroll anchor but unsafe for a
 *  write. `null` propagates: a leaf with no addressable path (a JSON-flattened omni/mix entry) stays
 *  read-only. */
function childPath(path: string | null, seg: string | number | null): string | null {
  if (path === null) return null;
  const base = path === ":" ? "" : path;
  return base + ":" + encodeURIComponent(segToken(seg));
}

/** A child's fragment continuation: `frag` + `/` + the segment's canonical token — mirroring
 *  paths.ts `fragmentOf`, so an in-page anchor id and a computed continuation always agree
 *  (`/0` for a position, `/~` for the null key). */
function childFrag(frag: string, seg: string | number | null): string {
  return `${frag}/${segToken(seg)}`;
}

/** The path/frag segment an omni-mix entry answers to: its key, the NULL key, or its position. */
function entrySeg(e: { key: string | null; keyNull?: boolean }, i: number): string | number | null {
  return e.keyNull === true ? null : e.key !== null ? e.key : i;
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

/** The `&…` token for a DERIVED storage anchor (a positional member's key — see {@link Mixed}).
 *  Quoting mirrors serialize-yamlover's `anchorToken`: anchor tokens end at whitespace, so a
 *  name with spaces (or a leading quote) takes the `&'…'` form. Exported for the yed editor. */
export function fmtDerivedAnchor(name: string): string {
  if (/^['"]/.test(name) || /\s/.test(name)) return `&'${name.replace(/'/g, "''")}'`;
  return "&" + name;
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

/** The `trailing` comment that rides an entry's line (after its value), joined if several.
 *  A TAB precedes it: with the pre's `tab-size` (styles.css) every comment aligns at one
 *  column (~1/3 of the pane) instead of hugging its value — a comment gutter. */
function trailingComment(ctx: Ctx, frag: string, syntax: Syntax): ReactNode {
  const trail = commentsAt(ctx, frag)?.trailing;
  if (!trail?.length) return null;
  return <>{"	"}<span className="c">{trail.map((t) => fmtComment(t, syntax)).join(" ")}</span></>;
}

/** A comment that rides a node's own SELF-VALUE line (an omni `5 # …`), keyed at the node's frag. */
function valueTrailingComment(ctx: Ctx, frag: string, syntax: Syntax): ReactNode {
  const vt = commentsAt(ctx, frag)?.valueTrailing;
  if (!vt?.length) return null;
  return <>{"	"}<span className="c">{vt.map((t) => fmtComment(t, syntax)).join(" ")}</span></>;
}

/** A container's LEFTOVER comments (bucket.tail — own-line remarks after its last entry, the
 *  parser's tail rule), rendered inside the block at the comment tab stop, one per line. */
function TailComments({ ctx, frag, syntax }: { ctx: Ctx; frag: string; syntax: Syntax }): ReactNode {
  const tail = commentsAt(ctx, frag)?.tail;
  if (!tail?.length) return null;
  return <>{tail.map((t, i) => <Fragment key={`tc${i}`}>{"\t"}<span className="c">{fmtComment(t, syntax)}</span>{"\n"}</Fragment>)}</>;
}

/** The viewed node's OWN decorations as standalone lines above its value (yamlover syntax):
 *  its `!!<…>` tag application / `!!set`, then its `&` path anchors — the same own-line
 *  placement the canonical serializer uses for a document root.
 *
 *  `tag` false CONSUMES the root's tag: an embedding whose very existence was decided BY that
 *  tag (a `!!yo` island in a chapter) would otherwise print the switch alongside the thing it
 *  switched to. Anchors still show — they are content, not the dispatch. */
function RootDeco({ ctx, frag, tag = true }: { ctx: Ctx; frag: string; tag?: boolean }): ReactNode {
  const d = commentsAt(ctx, frag);
  const anchors = d?.anchors ?? [];
  const shown = tag ? d?.tag : undefined;
  if (!shown && anchors.length === 0) return null;
  return (
    <>
      {shown && <><span className="b">{shown}</span>{"\n"}</>}
      {anchors.map((a, i) => <Fragment key={`ra${i}`}><span className="anchor">{fmtAnchor(a, "yaml")}</span>{"\n"}</Fragment>)}
    </>
  );
}

/** A file-level comment block: the $head banner stays at the left margin (a document header);
 *  $tail leftovers ride the comment TAB STOP like every other comment (`tab`). */
function CommentBlock({ texts, syntax, tab = false }: { texts: string[]; syntax: Syntax; tab?: boolean }): ReactNode {
  return <>{texts.map((t, i) => <Fragment key={`fc${i}`}>{tab ? "\t" : null}<span className="c">{fmtComment(t, syntax)}</span>{"\n"}</Fragment>)}</>;
}

function fileComments(comments: CommentMap | undefined, key: "$head" | "$tail"): string[] | undefined {
  const v = comments?.[key];
  return Array.isArray(v) && v.length ? v : undefined;
}

/** A zero-width anchor stamping a node's `#`-fragment id at its line, so a deep link or a local ref
 *  can scroll straight to it. Nothing when anchors are off or the frag is empty — the page root
 *  spells its empty continuation as {@link ROOT_FRAGMENT} at its one call site in {@link Render}.
 *  `path` (the node's absolute colon path — threaded parallel to `frag`, which is NOT invertible
 *  for exotic keys) rides along as `data-node-path`, the DOM→path bridge the TOC presence scan
 *  reads (toc-presence.ts); a non-addressable node (`path` null) stays scannable-invisible. */
function Anchor({ ctx, frag, path }: { ctx: Ctx; frag: string; path?: string | null }): ReactNode {
  if (!ctx.anchors || !frag) return null;
  return <span id={frag} className="frag-anchor" data-node-path={path ?? undefined} />;
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
  editable = false,
  concrete = null,
  rootTag = true,
}: {
  value: unknown;
  syntax: Syntax;
  onNavigate: Nav;
  documentPath?: string;
  nodePath?: string;
  anchors?: boolean;
  comments?: CommentMap;
  editable?: boolean;    // when true (and the view is unlocked), scalar leaves become editable
  concrete?: string | null; // the storage language — carried to leaf editors for concrete-safe edits
  rootTag?: boolean;     // false: the caller was DISPATCHED by the root's tag and consumes it (RootDeco)
}) {
  const base = fragmentOf(documentPath, nodePath); // the rendered root's continuation from the doc
  const ctx: Ctx = { nav: onNavigate, doc: documentPath, node: nodePath, anchors, comments, base, editable, concrete };
  const bin = asBinary(value);
  if (bin && syntax === "yaml") return <BinaryYaml bin={bin} />;
  const v = bin ?? value; // JSON shows the {format,size,base64} metadata object
  const head = fileComments(comments, "$head"); // the file banner, above the value
  const tail = fileComments(comments, "$tail"); // leftover comments after the last entry
  return (
    <>
      {head && <CommentBlock texts={head} syntax={syntax} />}
      {/* the rendered ROOT's own anchor — entry rows stamp only their children, so without this
          the page's own node is unaddressable (`#/` for the doc root, its continuation below) */}
      <Anchor ctx={ctx} frag={base || ROOT_FRAGMENT} path={nodePath} />
      {syntax === "yaml" ? (
        <>
          <RootDeco ctx={ctx} frag={base} tag={rootTag} />
          <YamlRoot value={v} indent={0} ctx={ctx} frag={base} path={nodePath} />
        </>
      ) : (
        <JsonValue value={v} indent={0} ctx={ctx} frag={base} path={nodePath} root />
      )}
      {tail && <CommentBlock texts={tail} syntax={syntax} tab />}
    </>
  );
}

/** A selected binary leaf as a YAML `!!binary` block (a comment carries the
 *  format/size; the base64 is the block scalar's content, canonically wrapped at
 *  76 columns and indented two spaces), foldable like any big scalar. */
function BinaryYaml({ bin }: { bin: BinaryPayload }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      <BigScalarYaml v={bin} indent={2} open={open} />
    </>
  );
}

/** A ROOT multiline string as its authored block — the document IS the scalar, so the block
 *  renders open with its own gutter toggle (mirrors {@link BinaryYaml} for a root binary). */
function RootBigString({ value, ctx, frag }: { value: string; ctx: Ctx; frag: string }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      <BigScalarYaml v={value} indent={2} open={open} raw={commentsAt(ctx, frag)?.raw} format={tagFormat(commentsAt(ctx, frag)?.tag)} />
    </>
  );
}

/** A BIG scalar that folds like a container: a multiline string (shown as a `|` block) or a
 *  selected binary's bytes. Single-line scalars stay inline (never foldable). */
const bigScalar = (v: unknown): boolean => (typeof v === "string" && v.includes("\n")) || !!asBinary(v);

/** The base64 of a binary payload, canonically wrapped at 76 columns. */
function wrap76(b64: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
  return out;
}

/** The format of a one-line `!!<format: …>` tag (the code-chunk shape), for highlighting the
 *  block body it decorates; null for any other (or absent) tag. */
function tagFormat(tag: string | undefined): string | null {
  const m = tag ? /^!!<\s*format:\s*([^\s>]+)\s*>/.exec(tag) : null;
  return m ? m[1] : null;
}

/** A BIG scalar's YAML rendering after its row head (`key:` / `- ` / an omni's own line): the
 *  block header (with the `!!binary # format, size` note for bytes) stays on the row; the body sits
 *  indented below when open, or a `{ N lines }` summary takes its place when folded. The FOLD TOGGLE
 *  is the caller's (it must anchor at the row START for the gutter alignment). `raw` is the scalar's
 *  AUTHORED block token from the comment sidecar (`|`/`|-`/`>`… header + content lines) — when
 *  present it is reproduced verbatim; only without it is a `|`/`|-` block derived from the value.
 *  `format` (the node's `!!<format: …>` tag) turns a yamlover-family body into HIGHLIGHTED
 *  source via the shared lexer — the code chunks of the docs, seen from the source view. */
function BigScalarYaml({ v, indent, open, trail = null, raw, format = null }: { v: string | BinaryPayload; indent: number; open: boolean; trail?: ReactNode; raw?: string; format?: string | null }): ReactNode {
  const bin = typeof v === "string" ? null : v;
  const blockRaw = !bin && raw && /^[|>]/.test(raw) && raw.includes("\n") ? raw : null;
  const header = bin ? "|" : blockRaw ? blockRaw.slice(0, blockRaw.indexOf("\n")) : (v as string).endsWith("\n") ? "|" : "|-";
  const lines = bin ? wrap76(bin.base64) : blockRaw ? blockRaw.split("\n").slice(1) : (v as string).replace(/\n$/, "").split("\n");
  const pad = " ".repeat(indent);
  const body = lines.map((l) => (l ? pad + l : l)).join("\n");
  const lang = bin ? null : highlightLang(format);
  return (
    <>
      {bin ? (
        <>
          <span className="b">!!binary</span> <span className="punct">|</span>{"  "}
          <span className="c">{`# ${bin.format ?? "binary"}, ${bin.size} bytes`}</span>
        </>
      ) : (
        <span className="punct">{header}</span>
      )}
      {open ? (
        <>{trail}{"\n"}{lang ? highlightSpans(body, lang) : <span className="s">{body}</span>}{"\n"}</>
      ) : (
        <>{" "}<span className="fold-summary">{`{ ${lines.length} lines }`}</span>{trail}{"\n"}</>
      )}
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
    const frag = fragmentOf(ctx.doc, ref.path) || ROOT_FRAGMENT; // a ref AT the page root scrolls to its top

    return (
      <a
        className="descend ref-local"
        href={"#" + frag}
        onClick={(e) => {
          e.preventDefault();
          navigateToFragment(frag);
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
  if (link.kind === "mix") return `{ kseq with ${n} ${n === 1 ? "entry" : "entries"} }`;
  if (link.kind === "omni") return `{ omni ${scalarLabel(link.value, "yaml")} + ${n} ${n === 1 ? "field" : "fields"} }`;
  return `{ object with ${n} ${n === 1 ? "property" : "properties"} }`;
}

/** Render a scalar in `syntax`. When `raw` is given (a scalar's authored source token, carried in the
 *  comment sidecar for representation-significant scalars — a quoted string, `~`/word null, hex int,
 *  `.inf`, …) it is shown VERBATIM with the value's own colour, so e.g. a string `"~"` reads as a
 *  quoted string, not the null `~`. Otherwise the value's default bare form is shown. */
export function scalarNode(v: unknown, syntax: Syntax, raw?: string): ReactNode {
  if (v === null) return <span className="null">{raw ?? "null"}</span>; // canonical yamlover null (not the obsolete `~`)
  if (typeof v === "boolean") return <span className="b">{raw ?? String(v)}</span>;
  const num = asNum(v);
  if (num) return <span className="n">{raw ?? numToken(num, syntax)}</span>; // ±Infinity / NaN literal
  if (typeof v === "number") return <span className="n">{raw ?? String(v)}</span>;
  const text = raw ?? (syntax === "json" ? JSON.stringify(v) : String(v));
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
    if (mixed.kind === "omni") return `{ omni ${scalarLabel(mixed.value, "yaml")} + ${n} ${n === 1 ? "field" : "fields"} }`;
    return `{ kseq with ${n} ${n === 1 ? "entry" : "entries"} }`;
  }
  if (Array.isArray(value)) {
    const n = value.length;
    return `[ ${n} ${n === 1 ? "item" : "items"} ]`;
  }
  const n = Object.keys(value as object).length;
  return `{ ${n} ${n === 1 ? "property" : "properties"} }`;
}

/** The fold chevron for an inline container — the SAME chevron the TOC uses (the shared
 *  {@link Chevron} mark, rotated 90° when open). It is a ZERO-WIDTH anchor placed at the START of
 *  the container's opening line; its chevron is absolutely positioned into the left gutter (see
 *  `.fold`/`.code` in styles.css), so it sits in one fixed column at the correct line regardless
 *  of nesting depth. */
function FoldToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  // reuse the TOC's `.toggle`/`.chevron` (so the chevron is IDENTICAL — same mark, size,
  // rotation); `.fold-gutter` only repositions it into the code's left gutter (see styles.css)
  return (
    <button type="button" className={"toggle fold-gutter" + (open ? " open" : "")} aria-label={open ? "collapse" : "expand"} onClick={onToggle}>
      <Chevron />
    </button>
  );
}

// --------------------------------------------------------------------------- //
// YAML
// --------------------------------------------------------------------------- //
/** A YAML value as a block at `indent` — the entry point (root) and the body of every nested
 *  container. The root container is NOT itself foldable (it is the whole view); its nested
 *  containers are, via their key/item rows. */
function YamlRoot({ value, indent, ctx, frag, path }: { value: unknown; indent: number; ctx: Ctx; frag: string; path: string | null }): ReactNode {
  const link = asLink(value);
  if (link) return <>{linkNode(link, "yaml", ctx)}{"\n"}</>;
  const ref = asRef(value);
  if (ref) return <>{refNode(ref, "yaml", ctx)}{"\n"}</>;
  if (foldable(value)) {
    // a whole DOCUMENT authored as one flow token (`[12, 13, 14]`) stays one line; a K&R one keeps
    // its own lines, closing back at column 0
    const flow = flowOrKr(value, ctx, frag, path, indent);
    if (flow) return <>{flow}{"\n"}</>;
  }
  if (foldable(value)) return <YamlBody value={value} indent={indent} ctx={ctx} frag={frag} path={path} />;
  if (isObj(value)) return <><span className="punct">{"{}"}</span>{"\n"}</>;
  if (Array.isArray(value)) return <><span className="punct">{"[]"}</span>{"\n"}</>;
  if (typeof value === "string" && value.includes("\n")) return <RootBigString value={value} ctx={ctx} frag={frag} />;
  return <><ScalarLeaf value={value} syntax="yaml" path={path} editable={ctx.editable} concrete={ctx.concrete} raw={commentsAt(ctx, frag)?.raw} />{valueTrailingComment(ctx, frag, "yaml")}{"\n"}</>;
}

/** Whether the node at `frag` was AUTHORED as a one-line flow token — the `yaml/flow` representation
 *  concrete (docs/language/concretes), carried per node in the comment sidecar. The read-only view honours it
 *  for the same reason the editor does: rendering `[12, 13]` as two dashed rows tells the reader
 *  the file says something it does not. */
function isFlowAt(ctx: Ctx, frag: string): boolean {
  return commentsAt(ctx, frag)?.repr === "yaml/flow";
}

/** Whether the node at `frag` was AUTHORED as a flow token SPANNING LINES — K&R braces, which on
 *  the yamlover surface is an inline concrete switch to json5p (docs/language/concretes/00-storage/00-inlined).
 *  Carried as the sidecar's `concrete`, and only where the switch happens: below it the language
 *  says flow, which is why {@link krBlock} recurses without re-asking. */
function isKrAt(ctx: Ctx, frag: string): boolean {
  return isJsonFamily(commentsAt(ctx, frag)?.concrete);
}

/** The node's authored flow rendering, whichever kind it is: a K&R block (several lines, `indent`
 *  being the column its closer returns to) or a one-line token. Null ⇒ neither, so the caller draws
 *  ordinary block rows. */
function flowOrKr(v: unknown, ctx: Ctx, frag: string, path: string | null, indent: number): ReactNode | null {
  if (isKrAt(ctx, frag)) return krBlock(v, ctx, frag, path, indent);
  return isFlowAt(ctx, frag) ? flowLine(v, ctx, frag, path) : null;
}

/** A json5p subtree as K&R lines — the opener rides the caller's row, one element per line at
 *  `indent + 2`, the closer alone at `indent`. The layout mirrors `serialize-json5p.ts` exactly
 *  (that emitter writes the file), which is why nesting recurses into K&R unconditionally instead of
 *  re-reading a per-node style: inside the switch the LANGUAGE is json5p, and it expands
 *  everything. Null on anything one line cannot hold either (a self-value, a multiline scalar), so
 *  the token falls back to block rows — the same refusal {@link flowLine} makes. */
function krBlock(value: unknown, ctx: Ctx, frag: string, path: string | null, indent: number): ReactNode | null {
  const mixed = asMixed(value);
  if (mixed?.kind === "omni") return null; // a self-value needs its own line — json5p has no `!!var`
  const entries: { key: string | null; keyNull?: boolean; value: unknown }[] = mixed
    ? mixed.entries.map((e) => ({ key: e.key, keyNull: e.keyNull, value: e.value }))
    : isObj(value)
      ? Object.entries(value).map(([k, v]) => ({ key: k, value: v }))
      : Array.isArray(value)
        ? value.map((v) => ({ key: null, value: v }))
        : [];
  const seq = entries.length > 0 && entries.every((e) => e.key === null && e.keyNull !== true);
  const cells = entries.map((e, i): ReactNode | null => {
    const cf = childFrag(frag, entrySeg(e, i));
    const cp = childPath(path, entrySeg(e, i));
    const link = asLink(e.value);
    if (link) return linkNode(link, "yaml", ctx);
    const ref = asRef(e.value);
    if (ref) return refNode(ref, "yaml", ctx);
    if (foldable(e.value)) return krBlock(e.value, ctx, cf, cp, indent + 2);
    if (bigScalar(e.value)) return null;
    if (isObj(e.value)) return <span className="punct">{"{}"}</span>;
    if (Array.isArray(e.value)) return <span className="punct">{"[]"}</span>;
    return <ScalarLeaf value={e.value} syntax="yaml" path={cp} editable={ctx.editable} concrete={ctx.concrete} raw={commentsAt(ctx, cf)?.raw} />;
  });
  if (cells.some((c) => c === null)) return null;
  const inner = " ".repeat(indent + 2);
  return (
    <>
      <span className="punct">{seq ? "[" : "{"}</span>{"\n"}
      {entries.map((e, i) => (
        <Fragment key={i}>
          {inner}
          {(e.key !== null || e.keyNull === true) && <><span className="k">{e.keyNull === true ? "~" : e.key}</span><span className="punct">{": "}</span></>}
          {cells[i]}
          {i < entries.length - 1 && <span className="punct">{","}</span>}
          {"\n"}
        </Fragment>
      ))}
      {" ".repeat(indent)}<span className="punct">{seq ? "]" : "}"}</span>
    </>
  );
}

/** A flow container rendered as ONE line — `[a, b]` / `{k: v}`. Every element goes through the
 *  ordinary value renderers, so scalar tokens keep their authored spelling, pointers stay
 *  clickable, and a nested flow token nests. A member flow cannot hold (a multiline scalar, a
 *  nested BLOCK container) makes the whole token fall back to block rows — the same refusal the
 *  serializer applies, so the screen never claims a shape the file cannot carry. */
function flowLine(value: unknown, ctx: Ctx, frag: string, path: string | null): ReactNode | null {
  const mixed = asMixed(value);
  const entries: { key: string | null; keyNull?: boolean; value: unknown }[] = mixed
    ? (mixed.kind === "omni" ? [] : mixed.entries.map((e) => ({ key: e.key, keyNull: e.keyNull, value: e.value })))
    : isObj(value)
      ? Object.entries(value).map(([k, v]) => ({ key: k, value: v }))
      : Array.isArray(value)
        ? value.map((v) => ({ key: null, value: v }))
        : [];
  if (mixed?.kind === "omni") return null; // a self-value needs its own line
  const seq = entries.length > 0 && entries.every((e) => e.key === null && e.keyNull !== true);
  const cell = (e: { key: string | null; keyNull?: boolean; value: unknown }, i: number): ReactNode | null => {
    const cf = childFrag(frag, entrySeg(e, i));
    const cp = childPath(path, entrySeg(e, i));
    const link = asLink(e.value);
    if (link) return linkNode(link, "yaml", ctx);
    const ref = asRef(e.value);
    if (ref) return refNode(ref, "yaml", ctx);
    if (foldable(e.value)) {
      if (!isFlowAt(ctx, cf)) return null; // a nested BLOCK container needs rows of its own
      return flowLine(e.value, ctx, cf, cp);
    }
    if (bigScalar(e.value)) return null; // a multiline scalar / bytes has no one-line form
    return <ScalarLeaf value={e.value} syntax="yaml" path={cp} editable={ctx.editable} concrete={ctx.concrete} raw={commentsAt(ctx, cf)?.raw} />;
  };
  const cells = entries.map(cell);
  if (cells.some((c) => c === null)) return null; // one unrepresentable member demotes the token
  return (
    <>
      <span className="punct">{seq ? "[" : "{"}</span>
      {entries.map((e, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="punct">{", "}</span>}
          {(e.key !== null || e.keyNull === true) && <><span className="k">{e.keyNull === true ? "~" : e.key}</span><span className="punct">{": "}</span></>}
          {cells[i]}
        </Fragment>
      ))}
      <span className="punct">{seq ? "]" : "}"}</span>
    </>
  );
}

/** The lines of a non-empty container (object / array / mixed) at `indent` — no toggle of its own;
 *  the toggle for this block sits on the key/item row one level up. With `inlineHead`, the FIRST
 *  row drops its leading indent so it sits right after a `- ` on the line above (YAML block style).
 *  `frag` is this container's own fragment continuation; each child appends its key/index to it. */
function YamlBody({ value, indent, ctx, frag, path, inlineHead = false }: { value: unknown; indent: number; ctx: Ctx; frag: string; path: string | null; inlineHead?: boolean }): ReactNode {
  const mixed = asMixed(value);
  if (mixed) return <YamlMixed mixed={mixed} indent={indent} ctx={ctx} frag={frag} path={path} inlineHead={inlineHead} />;
  if (isObj(value)) return <YamlObject entries={Object.entries(value)} indent={indent} ctx={ctx} frag={frag} path={path} inlineHead={inlineHead} />;
  return <YamlArray items={value as unknown[]} indent={indent} ctx={ctx} frag={frag} path={path} inlineHead={inlineHead} />;
}

function YamlObject({ entries, indent, ctx, frag, path, inlineHead = false }: { entries: [string, unknown][]; indent: number; ctx: Ctx; frag: string; path: string | null; inlineHead?: boolean }): ReactNode {
  const pad = " ".repeat(indent);
  return <>{entries.map(([k, v], i) => <YamlEntry key={i} k={k} v={v} pad={pad} indent={indent} ctx={ctx} frag={childFrag(frag, k)} path={childPath(path, k)} noPad={inlineHead && i === 0} />)}</>;
}

function YamlArray({ items, indent, ctx, frag, path, inlineHead = false }: { items: unknown[]; indent: number; ctx: Ctx; frag: string; path: string | null; inlineHead?: boolean }): ReactNode {
  const pad = " ".repeat(indent);
  return <>{items.map((item, i) => <YamlItem key={i} v={item} pad={pad} indent={indent} ctx={ctx} frag={childFrag(frag, i)} path={childPath(path, i)} noPad={inlineHead && i === 0} />)}</>;
}

/** Whether an array item's container value can render in COMPACT YAML block style — its first
 *  child on the dash's own line (`- name: Rex`, `- title: …`, `- <omni self-value>`). Qualifies
 *  when the FIRST rendered row is NOT foldable and NOT a big scalar: that keeps a single fold chevron
 *  per row (no toggle would land on the shared first line). A first child that is foldable or a big
 *  scalar (multiline text / bytes — it carries its own toggle, which must anchor at row start) stays
 *  on its own line below the dash. */
function canInlineAfterDash(v: unknown): boolean {
  const mixed = asMixed(v);
  if (mixed) {
    // the first rendered row is the self-value (an omni whose self sits first) or entry 0
    if (mixed.kind === "omni" && (mixed.selfAt ?? 0) === 0) return !bigScalar(mixed.value);
    const first = mixed.entries[0];
    return !!first && !foldable(first.value) && !bigScalar(first.value);
  }
  if (isObj(v)) { const vs = Object.values(v); return vs.length > 0 && !foldable(vs[0]) && !bigScalar(vs[0]); }
  if (Array.isArray(v)) return v.length > 0 && !foldable(v[0]) && !bigScalar(v[0]);
  return false;
}

/** An omni node's own scalar line. A plain scalar renders inline; a BIG one (multiline text /
 *  binary bytes) becomes a foldable `|` / `!!binary` block with its toggle in the row's gutter. */
function YamlSelfValue({ value, pad, indent, ctx, frag, path, noPad = false }: { value: unknown; pad: string; indent: number; ctx: Ctx; frag: string; path: string | null; noPad?: boolean }): ReactNode {
  const [open, setOpen] = useState(true);
  const trail = valueTrailingComment(ctx, frag, "yaml");
  // a FILE-backed omni's self-value is a navigable `< binary >` link (its bytes never inline) — render
  // it as the link, not a bare scalar (which would print `[object Object]` / drop it)
  const link = asLink(value);
  if (link) return <>{noPad ? null : pad}{linkNode(link, "yaml", ctx)}{trail}{"\n"}</>;
  // the omni node's OWN scalar edits at the node's own path — `emplace` touches only the scalar facet,
  // leaving the keyed/ordinal fields (and any tag) standing.
  if (!bigScalar(value)) return <>{noPad ? null : pad}<ScalarLeaf value={value} syntax="yaml" path={path} editable={ctx.editable} concrete={ctx.concrete} raw={commentsAt(ctx, frag)?.raw} />{trail}{"\n"}</>;
  return (
    <>
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      {noPad ? null : pad}
      <BigScalarYaml v={asBinary(value) ?? (value as string)} indent={indent + 2} open={open} trail={trail} raw={commentsAt(ctx, frag)?.raw} format={tagFormat(commentsAt(ctx, frag)?.tag)} />
    </>
  );
}

function YamlMixed({ mixed, indent, ctx, frag, path, inlineHead = false }: { mixed: Mixed; indent: number; ctx: Ctx; frag: string; path: string | null; inlineHead?: boolean }): ReactNode {
  const pad = " ".repeat(indent);
  // omni: the node's own scalar value renders on its own line at its AUTHORED position among the
  // entries (`selfAt`; 0/absent → first) — order-preserving, matching the source. A big self-value
  // — a multiline string, or the BYTES of a blob-backed omni (an image with overlay entries, fetched
  // ?binary=1) — renders as a foldable block, like a pure binary leaf / any big scalar.
  const isOmni = mixed.kind === "omni";
  const selfAt = isOmni ? Math.min(mixed.selfAt ?? 0, mixed.entries.length) : -1;
  // With `inlineHead` (this node rides a `- `), the FIRST rendered row drops its leading pad: the
  // self-value if it sits first, otherwise entry 0 (`- <self>` / `- title: …` — canInlineAfterDash).
  const selfFirst = inlineHead && selfAt === 0;
  const selfValue = <YamlSelfValue value={mixed.value} pad={pad} indent={indent} ctx={ctx} frag={frag} path={path} noPad={selfFirst} />;
  return (
    <>
      {mixed.entries.map((e, i) => {
        const noPad = inlineHead && i === 0 && !selfFirst; // entry 0 rides the dash unless the self does
        return (
          <Fragment key={i}>
            {i === selfAt && selfValue}
            {e.keyNull === true ? (
              // the NULL KEY (YAML's rule): a KEYED entry whose key is the null value — rendered
              // `~: value`, addressed by the `~` path segment
              <YamlEntry k="~" v={e.value} pad={pad} indent={indent} ctx={ctx} frag={childFrag(frag, null)} path={childPath(path, null)} noPad={noPad} />
            ) : e.key === null ? (
              <YamlItem v={e.value} pad={pad} indent={indent} ctx={ctx} frag={childFrag(frag, i)} path={childPath(path, i)} noPad={noPad} />
            ) : e.anchor ? (
              // a positional member with a derived storage anchor: a `- &key value` row — but the
              // frag/path stay KEYED (fragments, comment buckets and edits address `:key`, not the position)
              <YamlItem v={e.value} pad={pad} indent={indent} ctx={ctx} frag={childFrag(frag, e.key)} path={childPath(path, e.key)} noPad={noPad} anchorName={e.key} />
            ) : (
              <YamlEntry k={e.key} v={e.value} pad={pad} indent={indent} ctx={ctx} frag={childFrag(frag, e.key)} path={childPath(path, e.key)} noPad={noPad} />
            )}
          </Fragment>
        );
      })}
      {isOmni && selfAt >= mixed.entries.length && selfValue}
      <TailComments ctx={ctx} frag={frag} syntax="yaml" />
    </>
  );
}

/** A `key: value` row. A foldable value gets a gutter toggle on this row and its body below (or a
 *  fold summary when collapsed); a scalar / link / empty renders inline. `noPad` drops the leading
 *  indent when this row is the first child sitting after a `- ` (YAML block style). `frag` is this
 *  node's fragment continuation (its `#`-anchor id). */
function YamlEntry({ k, v, pad, indent, ctx, frag, path, noPad = false }: { k: string; v: unknown; pad: string; indent: number; ctx: Ctx; frag: string; path: string | null; noPad?: boolean }): ReactNode {
  const [open, setOpen] = useState(true);
  const blank = !noPad && commentsAt(ctx, frag)?.blankBefore ? "\n" : null; // preserve an empty source line
  const lead = noPad ? null : <LeadingComments ctx={ctx} frag={frag} pad={pad} syntax="yaml" />;
  const trail = trailingComment(ctx, frag, "yaml");
  const ptr = commentsAt(ctx, frag)?.pointer; // a ref's authored `*…` token, if any
  const deco = decoSpan(ctx, frag, "yaml"); // type tag + `&` anchors on the key line
  const head = (
    <>
      {noPad ? null : pad}
      <Anchor ctx={ctx} frag={frag} path={path} />
      <span className="k">{k}</span>
      <span className="punct">:</span>
    </>
  );
  if (bigScalar(v)) {
    // a multiline string / binary bytes: a `|` block under the key, foldable from the row
    return (
      <>
        {blank}
        {lead}
        <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
        {head}
        {deco}
        {" "}
        <BigScalarYaml v={asBinary(v) ?? (v as string)} indent={indent + 2} open={open} trail={trail} raw={commentsAt(ctx, frag)?.raw} format={tagFormat(commentsAt(ctx, frag)?.tag)} />
      </>
    );
  }
  if (!foldable(v)) return <>{blank}{lead}{head}{deco}{inlineYamlValue(v, ctx, path, trail, ptr && fmtPointer(ptr, "yaml"), commentsAt(ctx, frag)?.raw)}</>;
  // An OMNI whose self-value sits first renders that scalar ON the key row (`world: World`), its
  // entries below — matching the source and the projectional editor (nodeHeadKind "self"). Only the
  // node's OWN self-value inlines after a `key:`; a first CHILD may not (`person: name: Rex` is not
  // valid yaml — that stays on its own line), unlike a `- ` item where both compact forms are legal.
  const m = asMixed(v);
  // an AUTHORED flow token rides the key row (`k: [12, 13]`) — one line, so no fold toggle; a K&R
  // one opens there and closes on its own line at this column
  const flowTok = flowOrKr(v, ctx, frag, path, indent);
  if (flowTok) return <>{blank}{lead}{head}{deco}{" "}{flowTok}{trail}{"\n"}</>;
  const inlineSelf = !!m && m.kind === "omni" && (m.selfAt ?? 0) === 0 && !bigScalar(m.value);
  return (
    <>
      {blank}
      {lead}
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      {head}
      {deco}
      {!open ? (
        <>{" "}<span className="fold-summary">{foldSummary(v)}</span>{trail}{"\n"}</>
      ) : inlineSelf ? (
        <>{" "}<YamlBody value={v} indent={indent + 2} ctx={ctx} frag={frag} path={path} inlineHead /></>
      ) : (
        <>{trail}{"\n"}<YamlBody value={v} indent={indent + 2} ctx={ctx} frag={frag} path={path} /></>
      )}
    </>
  );
}

/** A `- value` array / positional row, with the same fold behaviour as {@link YamlEntry}. A foldable
 *  container value renders COMPACT (first child on this same line, `- name: Rex`) when it can — see
 *  {@link canInlineAfterDash} — else its body drops to indented lines below. */
function YamlItem({ v, pad, indent, ctx, frag, path, noPad = false, anchorName }: { v: unknown; pad: string; indent: number; ctx: Ctx; frag: string; path: string | null; noPad?: boolean; anchorName?: string }): ReactNode {
  const [open, setOpen] = useState(true);
  const blank = !noPad && commentsAt(ctx, frag)?.blankBefore ? "\n" : null;
  const lead = noPad ? null : <LeadingComments ctx={ctx} frag={frag} pad={pad} syntax="yaml" />;
  const trail = trailingComment(ctx, frag, "yaml");
  const ptr = commentsAt(ctx, frag)?.pointer; // a `- *…` item's authored pointer token
  const deco = decoSpan(ctx, frag, "yaml");
  // `.yaml-dash` styles the marker (gray like the chevron) — kept a fixed cell so columns line up.
  // `anchorName` (a positional member's DERIVED storage anchor, {@link Mixed}) rides right after
  // the dash, dimmed — provenance, not authored source.
  const dash = (
    <>
      {noPad ? null : pad}
      <Anchor ctx={ctx} frag={frag} path={path} />
      <span className="punct yaml-dash">{"-"}</span>
      {anchorName !== undefined && <>{" "}<span className="anchor derived">{fmtDerivedAnchor(anchorName)}</span></>}
    </>
  );
  if (bigScalar(v)) {
    // a multiline string / binary bytes item: `- |` with the block below, foldable from the row
    return (
      <>
        {blank}
        {lead}
        <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
        {dash}
        {deco}
        {" "}
        <BigScalarYaml v={asBinary(v) ?? (v as string)} indent={indent + 2} open={open} trail={trail} raw={commentsAt(ctx, frag)?.raw} format={tagFormat(commentsAt(ctx, frag)?.tag)} />
      </>
    );
  }
  if (!foldable(v)) return <>{blank}{lead}{dash}{deco}{inlineYamlValue(v, ctx, path, trail, ptr && fmtPointer(ptr, "yaml"), commentsAt(ctx, frag)?.raw)}</>;
  // an AUTHORED flow token rides the dash (`- [12, 13]`) — one line, so no fold toggle; a K&R one
  // opens there and closes on its own line at the dash column
  const flowTok = flowOrKr(v, ctx, frag, path, indent);
  if (flowTok) return <>{blank}{lead}{dash}{deco}{" "}{flowTok}{trail}{"\n"}</>;
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
        <>{" "}<YamlBody value={v} indent={indent + 2} ctx={ctx} frag={frag} path={path} inlineHead /></>
      ) : (
        <>{trail}{"\n"}<YamlBody value={v} indent={indent + 2} ctx={ctx} frag={frag} path={path} /></>
      )}
    </>
  );
}

/** A non-foldable value following a `key:` / `- ` — a link, ref, empty container, or scalar,
 *  rendered inline with a leading space and a trailing newline. `path` is the value's own node path
 *  (for an editable scalar leaf); null when it has no addressable path. */
function inlineYamlValue(v: unknown, ctx: Ctx, path: string | null, trail: ReactNode = null, ptr?: string, raw?: string): ReactNode {
  const link = asLink(v);
  if (link) return <>{" "}{linkNode(link, "yaml", ctx)}{trail}{"\n"}</>;
  const ref = asRef(v);
  if (ref) return <>{" "}{refNode(ref, "yaml", ctx, ptr)}{trail}{"\n"}</>;
  if (isObj(v) && Object.keys(v).length === 0) return <>{" "}<span className="punct">{"{}"}</span>{trail}{"\n"}</>;
  if (Array.isArray(v) && v.length === 0) return <>{" "}<span className="punct">{"[]"}</span>{trail}{"\n"}</>;
  return <>{" "}<ScalarLeaf value={v} syntax="yaml" path={path} editable={ctx.editable} concrete={ctx.concrete} raw={raw} />{trail}{"\n"}</>;
}

// --------------------------------------------------------------------------- //
// JSON (nested containers shown inline are collapsible; ones past the depth budget become links, so
// the view is not strictly valid JSON — it is the same representation, in JSON syntax)
// --------------------------------------------------------------------------- //
/** A JSON value at `indent`. At the root, a container renders without a toggle (it is the whole
 *  view); nested foldable containers carry a gutter toggle on their key/item row (see
 *  {@link JsonEntry}/{@link JsonItem}), so they never reach here while foldable. */
function JsonValue({ value, indent, ctx, frag, path, root = false }: { value: unknown; indent: number; ctx: Ctx; frag: string; path: string | null; root?: boolean }): ReactNode {
  const link = asLink(value);
  if (link) return linkNode(link, "json", ctx);
  const ref = asRef(value);
  if (ref) {
    const ptr = commentsAt(ctx, frag)?.pointer; // the authored pointer, json5p-quoted
    return refNode(ref, "json", ctx, ptr && fmtPointer(ptr, "json"));
  }
  if (root && foldable(value)) return <JsonBody value={value} indent={indent} ctx={ctx} frag={frag} path={path} />;
  const objEntries = jsonObjEntries(value);
  if (objEntries) return objEntries.length ? <JsonBody value={value} indent={indent} ctx={ctx} frag={frag} path={path} /> : <span className="punct">{"{}"}</span>;
  if (Array.isArray(value)) return value.length ? <JsonBody value={value} indent={indent} ctx={ctx} frag={frag} path={path} /> : <span className="punct">{"[]"}</span>;
  // a BLOCK scalar's raw (`|`/`>` + lines) is yamlover representation — JSON has no block form,
  // so a multiline string falls back to its JSON escaping here
  const raw = commentsAt(ctx, frag)?.raw;
  return <ScalarLeaf value={value} syntax="json" path={path} editable={ctx.editable} concrete={ctx.concrete} raw={raw?.includes("\n") ? undefined : raw} />;
}

/** The object entries a JSON value projects: an omni/mix marker flattened (`$value` + entries), or a
 *  plain object's own entries, or null when it is not object-like. */
function jsonObjEntries(value: unknown): [string, unknown][] | null {
  const mixed = asMixed(value);
  if (mixed)
    return [
      ...(mixed.kind === "omni" ? ([["$value", mixed.value]] as [string, unknown][]) : []),
      ...mixed.entries.map((e, i): [string, unknown] => [e.keyNull === true ? "~" : e.key ?? String(i), e.value]),
    ];
  return isObj(value) ? Object.entries(value) : null;
}

/** The `{ … }` / `[ … ]` body of a container, no toggle of its own. */
function JsonBody({ value, indent, ctx, frag, path }: { value: unknown; indent: number; ctx: Ctx; frag: string; path: string | null }): ReactNode {
  const objEntries = jsonObjEntries(value);
  if (objEntries) {
    // a plain object's keys ARE its entries' paths; a FLATTENED omni/mix (`$value`, `String(i)` keys)
    // has no faithful address here → null path keeps those leaves read-only (JSON omni editing is
    // out of scope for now — edit it via the yamlover view).
    const entryPath = isObj(value) ? path : null;
    return <JsonObject entries={objEntries} indent={indent} ctx={ctx} frag={frag} path={entryPath} />;
  }
  return <JsonArray items={value as unknown[]} indent={indent} ctx={ctx} frag={frag} path={path} />;
}

function JsonObject({ entries, indent, ctx, frag, path }: { entries: [string, unknown][]; indent: number; ctx: Ctx; frag: string; path: string | null }): ReactNode {
  const pad = " ".repeat(indent + 2);
  return (
    <>
      <span className="punct">{"{"}</span>
      {"\n"}
      {entries.map(([k, v], i) => (
        <JsonEntry key={i} k={k} v={v} pad={pad} indent={indent + 2} ctx={ctx} frag={childFrag(frag, k)} path={childPath(path, k)} last={i === entries.length - 1} />
      ))}
      {" ".repeat(indent)}
      <span className="punct">{"}"}</span>
    </>
  );
}

function JsonArray({ items, indent, ctx, frag, path }: { items: unknown[]; indent: number; ctx: Ctx; frag: string; path: string | null }): ReactNode {
  const pad = " ".repeat(indent + 2);
  return (
    <>
      <span className="punct">{"["}</span>
      {"\n"}
      {items.map((item, i) => (
        <JsonItem key={i} v={item} pad={pad} indent={indent + 2} ctx={ctx} frag={childFrag(frag, i)} path={childPath(path, i)} last={i === items.length - 1} />
      ))}
      {" ".repeat(indent)}
      <span className="punct">{"]"}</span>
    </>
  );
}

/** A `"key": value,` row. A foldable value gets a gutter toggle on this row; otherwise it renders
 *  inline. `frag` is this node's fragment continuation (its `#`-anchor id). */
function JsonEntry({ k, v, pad, indent, ctx, frag, path, last }: { k: string; v: unknown; pad: string; indent: number; ctx: Ctx; frag: string; path: string | null; last: boolean }): ReactNode {
  const [open, setOpen] = useState(true);
  const lead = <LeadingComments ctx={ctx} frag={frag} pad={pad} syntax="json" />;
  const head = (
    <>
      {pad}
      <Anchor ctx={ctx} frag={frag} path={path} />
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
  if (!foldable(v)) return <>{lead}{head}<JsonValue value={v} indent={indent} ctx={ctx} frag={frag} path={path} />{tail}</>;
  return (
    <>
      {lead}
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      {head}
      {open ? <JsonBody value={v} indent={indent} ctx={ctx} frag={frag} path={path} /> : <span className="fold-summary">{foldSummary(v)}</span>}
      {tail}
    </>
  );
}

/** An array element row, with the same fold behaviour as {@link JsonEntry}. */
function JsonItem({ v, pad, indent, ctx, frag, path, last }: { v: unknown; pad: string; indent: number; ctx: Ctx; frag: string; path: string | null; last: boolean }): ReactNode {
  const [open, setOpen] = useState(true);
  const lead = <LeadingComments ctx={ctx} frag={frag} pad={pad} syntax="json" />;
  const tail = (
    <>
      {last ? "" : ","}
      {trailingComment(ctx, frag, "json")}
      {"\n"}
    </>
  );
  if (!foldable(v)) return <>{lead}{pad}<Anchor ctx={ctx} frag={frag} path={path} />{decoSpan(ctx, frag, "json")}<JsonValue value={v} indent={indent} ctx={ctx} frag={frag} path={path} />{tail}</>;
  return (
    <>
      {lead}
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      {pad}
      <Anchor ctx={ctx} frag={frag} path={path} />
      {decoSpan(ctx, frag, "json")}
      {open ? <JsonBody value={v} indent={indent} ctx={ctx} frag={frag} path={path} /> : <span className="fold-summary">{foldSummary(v)}</span>}
      {tail}
    </>
  );
}
