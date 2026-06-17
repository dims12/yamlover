import { ReactNode, useState } from "react";

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

/** The scalar SELF-VALUE a string/scalar renderer should show. An OMNI node (a scalar that also
 *  carries fields — e.g. a markdown doc that gained `yamlover-annotations` keys) projects its page
 *  `value` as a `$yamloverMixed` marker, so peel it to the self-value; a plain scalar passes
 *  through. Pairs with the facet-tolerant dispatch (TYPES.md §9): routing keeps an annotated string
 *  on its renderer, and this hands that renderer the string — not the marker object. */
export function scalarValue(v: unknown): unknown {
  const m = asMixed(v);
  return m && m.kind === "omni" ? m.value : v;
}

type Syntax = "yaml" | "json";
type Nav = (path: string) => void;

/**
 * Render a value in YAML or JSON syntax, syntax-highlighted, with nested containers shown inline
 * (the server inlines them up to the requested DEPTH) and **collapsible** — each inline object /
 * array carries a fold chevron in the LEFT GUTTER (JetBrains-style, the same chevron as the TOC).
 * A container past the depth budget arrives as a link marker and is drawn as a CONTINUATION
 * hyperlink you click to descend. Used for every RHS data representation so they behave identically.
 */
export function Render({ value, syntax, onNavigate }: { value: unknown; syntax: Syntax; onNavigate: Nav }) {
  const bin = asBinary(value);
  if (bin && syntax === "yaml") return <BinaryYaml bin={bin} />;
  const v = bin ?? value; // JSON shows the {format,size,base64} metadata object
  return syntax === "yaml" ? (
    <YamlRoot value={v} indent={0} nav={onNavigate} />
  ) : (
    <JsonValue value={v} indent={0} nav={onNavigate} root />
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
function linkNode(link: Link, syntax: Syntax, nav: Nav): ReactNode {
  // a scalar child links by its rendered value (`~`/`null`, quoted/bare per syntax);
  // a container by its `{ … }`/`[ … ]` summary
  const label = link.kind === "scalar" ? scalarLabel(link.value, syntax) : linkLabel(link);
  return (
    <a
      className="descend"
      href={link.path}
      onClick={(e) => {
        e.preventDefault();
        nav(link.path);
      }}
    >
      {label}
    </a>
  );
}

/** A scalar value as it would render in `syntax` — used as a scalar link's label. */
function scalarLabel(v: unknown, syntax: Syntax): string {
  if (v === null || v === undefined) return syntax === "json" ? "null" : "~";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return syntax === "json" ? JSON.stringify(v) : String(v);
}

/** A `rel` pointer: its text as a hyperlink to the resolved `path`, or — when the
 *  pointer does not resolve — plain string text (no link). */
function refNode(ref: Ref, syntax: Syntax, nav: Nav): ReactNode {
  const text = syntax === "json" ? JSON.stringify(ref.text) : ref.text;
  if (!ref.path) return <span className="s">{text}</span>;
  const target = ref.path;
  return (
    <a
      className="descend"
      href={target}
      onClick={(e) => {
        e.preventDefault();
        nav(target);
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
  if (v === null) return <span className="null">{syntax === "json" ? "null" : "~"}</span>;
  if (typeof v === "boolean") return <span className="b">{String(v)}</span>;
  if (typeof v === "number") return <span className="n">{String(v)}</span>;
  const text = syntax === "json" ? JSON.stringify(v) : String(v);
  return <span className="s">{text}</span>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
function YamlRoot({ value, indent, nav }: { value: unknown; indent: number; nav: Nav }): ReactNode {
  const link = asLink(value);
  if (link) return <>{linkNode(link, "yaml", nav)}{"\n"}</>;
  const ref = asRef(value);
  if (ref) return <>{refNode(ref, "yaml", nav)}{"\n"}</>;
  if (foldable(value)) return <YamlBody value={value} indent={indent} nav={nav} />;
  if (isObj(value)) return <><span className="punct">{"{}"}</span>{"\n"}</>;
  if (Array.isArray(value)) return <><span className="punct">{"[]"}</span>{"\n"}</>;
  return <>{scalarNode(value, "yaml")}{"\n"}</>;
}

/** The lines of a non-empty container (object / array / mixed) at `indent` — no toggle of its own;
 *  the toggle for this block sits on the key/item row one level up. With `inlineHead`, the FIRST
 *  row drops its leading indent so it sits right after a `- ` on the line above (YAML block style). */
function YamlBody({ value, indent, nav, inlineHead = false }: { value: unknown; indent: number; nav: Nav; inlineHead?: boolean }): ReactNode {
  const mixed = asMixed(value);
  if (mixed) return <YamlMixed mixed={mixed} indent={indent} nav={nav} />;
  if (isObj(value)) return <YamlObject entries={Object.entries(value)} indent={indent} nav={nav} inlineHead={inlineHead} />;
  return <YamlArray items={value as unknown[]} indent={indent} nav={nav} inlineHead={inlineHead} />;
}

function YamlObject({ entries, indent, nav, inlineHead = false }: { entries: [string, unknown][]; indent: number; nav: Nav; inlineHead?: boolean }): ReactNode {
  const pad = " ".repeat(indent);
  return <>{entries.map(([k, v], i) => <YamlEntry key={i} k={k} v={v} pad={pad} indent={indent} nav={nav} noPad={inlineHead && i === 0} />)}</>;
}

function YamlArray({ items, indent, nav, inlineHead = false }: { items: unknown[]; indent: number; nav: Nav; inlineHead?: boolean }): ReactNode {
  const pad = " ".repeat(indent);
  return <>{items.map((item, i) => <YamlItem key={i} v={item} pad={pad} indent={indent} nav={nav} noPad={inlineHead && i === 0} />)}</>;
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

function YamlMixed({ mixed, indent, nav }: { mixed: Mixed; indent: number; nav: Nav }): ReactNode {
  const pad = " ".repeat(indent);
  return (
    <>
      {/* omni: the node's own scalar value on its own line first (`!!var 5` → `5`) */}
      {mixed.kind === "omni" && (
        <>
          {pad}
          {scalarNode(mixed.value, "yaml")}
          {"\n"}
        </>
      )}
      {mixed.entries.map((e, i) =>
        e.key === null ? (
          <YamlItem key={i} v={e.value} pad={pad} indent={indent} nav={nav} />
        ) : (
          <YamlEntry key={i} k={e.key} v={e.value} pad={pad} indent={indent} nav={nav} />
        ),
      )}
    </>
  );
}

/** A `key: value` row. A foldable value gets a gutter toggle on this row and its body below (or a
 *  fold summary when collapsed); a scalar / link / empty renders inline. `noPad` drops the leading
 *  indent when this row is the first child sitting after a `- ` (YAML block style). */
function YamlEntry({ k, v, pad, indent, nav, noPad = false }: { k: string; v: unknown; pad: string; indent: number; nav: Nav; noPad?: boolean }): ReactNode {
  const [open, setOpen] = useState(true);
  const head = (
    <>
      {noPad ? null : pad}
      <span className="k">{k}</span>
      <span className="punct">:</span>
    </>
  );
  if (!foldable(v)) return <>{head}{inlineYamlValue(v, nav)}</>;
  return (
    <>
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      {head}
      {open ? <>{"\n"}<YamlBody value={v} indent={indent + 2} nav={nav} /></> : <>{" "}<span className="fold-summary">{foldSummary(v)}</span>{"\n"}</>}
    </>
  );
}

/** A `- value` array / positional row, with the same fold behaviour as {@link YamlEntry}. A foldable
 *  container value renders COMPACT (first child on this same line, `- name: Rex`) when it can — see
 *  {@link canInlineAfterDash} — else its body drops to indented lines below. */
function YamlItem({ v, pad, indent, nav, noPad = false }: { v: unknown; pad: string; indent: number; nav: Nav; noPad?: boolean }): ReactNode {
  const [open, setOpen] = useState(true);
  // `.yaml-dash` styles the marker (gray like the chevron) — kept a fixed cell so columns line up
  const dash = (
    <>
      {noPad ? null : pad}
      <span className="punct yaml-dash">{"-"}</span>
    </>
  );
  if (!foldable(v)) return <>{dash}{inlineYamlValue(v, nav)}</>;
  const compact = canInlineAfterDash(v);
  return (
    <>
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      {dash}
      {!open ? (
        <>{" "}<span className="fold-summary">{foldSummary(v)}</span>{"\n"}</>
      ) : compact ? (
        <>{" "}<YamlBody value={v} indent={indent + 2} nav={nav} inlineHead /></>
      ) : (
        <>{"\n"}<YamlBody value={v} indent={indent + 2} nav={nav} /></>
      )}
    </>
  );
}

/** A non-foldable value following a `key:` / `- ` — a link, ref, empty container, or scalar,
 *  rendered inline with a leading space and a trailing newline. */
function inlineYamlValue(v: unknown, nav: Nav): ReactNode {
  const link = asLink(v);
  if (link) return <>{" "}{linkNode(link, "yaml", nav)}{"\n"}</>;
  const ref = asRef(v);
  if (ref) return <>{" "}{refNode(ref, "yaml", nav)}{"\n"}</>;
  if (isObj(v) && Object.keys(v).length === 0) return <>{" "}<span className="punct">{"{}"}</span>{"\n"}</>;
  if (Array.isArray(v) && v.length === 0) return <>{" "}<span className="punct">{"[]"}</span>{"\n"}</>;
  return <>{" "}{scalarNode(v, "yaml")}{"\n"}</>;
}

// --------------------------------------------------------------------------- //
// JSON (nested containers shown inline are collapsible; ones past the depth budget become links, so
// the view is not strictly valid JSON — it is the same representation, in JSON syntax)
// --------------------------------------------------------------------------- //
/** A JSON value at `indent`. At the root, a container renders without a toggle (it is the whole
 *  view); nested foldable containers carry a gutter toggle on their key/item row (see
 *  {@link JsonEntry}/{@link JsonItem}), so they never reach here while foldable. */
function JsonValue({ value, indent, nav, root = false }: { value: unknown; indent: number; nav: Nav; root?: boolean }): ReactNode {
  const link = asLink(value);
  if (link) return linkNode(link, "json", nav);
  const ref = asRef(value);
  if (ref) return refNode(ref, "json", nav);
  if (root && foldable(value)) return <JsonBody value={value} indent={indent} nav={nav} />;
  const objEntries = jsonObjEntries(value);
  if (objEntries) return objEntries.length ? <JsonBody value={value} indent={indent} nav={nav} /> : <span className="punct">{"{}"}</span>;
  if (Array.isArray(value)) return value.length ? <JsonBody value={value} indent={indent} nav={nav} /> : <span className="punct">{"[]"}</span>;
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
function JsonBody({ value, indent, nav }: { value: unknown; indent: number; nav: Nav }): ReactNode {
  const objEntries = jsonObjEntries(value);
  if (objEntries) return <JsonObject entries={objEntries} indent={indent} nav={nav} />;
  return <JsonArray items={value as unknown[]} indent={indent} nav={nav} />;
}

function JsonObject({ entries, indent, nav }: { entries: [string, unknown][]; indent: number; nav: Nav }): ReactNode {
  const pad = " ".repeat(indent + 2);
  return (
    <>
      <span className="punct">{"{"}</span>
      {"\n"}
      {entries.map(([k, v], i) => (
        <JsonEntry key={i} k={k} v={v} pad={pad} indent={indent + 2} nav={nav} last={i === entries.length - 1} />
      ))}
      {" ".repeat(indent)}
      <span className="punct">{"}"}</span>
    </>
  );
}

function JsonArray({ items, indent, nav }: { items: unknown[]; indent: number; nav: Nav }): ReactNode {
  const pad = " ".repeat(indent + 2);
  return (
    <>
      <span className="punct">{"["}</span>
      {"\n"}
      {items.map((item, i) => (
        <JsonItem key={i} v={item} pad={pad} indent={indent + 2} nav={nav} last={i === items.length - 1} />
      ))}
      {" ".repeat(indent)}
      <span className="punct">{"]"}</span>
    </>
  );
}

/** A `"key": value,` row. A foldable value gets a gutter toggle on this row; otherwise it renders
 *  inline. */
function JsonEntry({ k, v, pad, indent, nav, last }: { k: string; v: unknown; pad: string; indent: number; nav: Nav; last: boolean }): ReactNode {
  const [open, setOpen] = useState(true);
  const head = (
    <>
      {pad}
      <span className="k">{`"${k}"`}</span>
      <span className="punct">{": "}</span>
    </>
  );
  const tail = (
    <>
      {last ? "" : ","}
      {"\n"}
    </>
  );
  if (!foldable(v)) return <>{head}<JsonValue value={v} indent={indent} nav={nav} />{tail}</>;
  return (
    <>
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      {head}
      {open ? <JsonBody value={v} indent={indent} nav={nav} /> : <span className="fold-summary">{foldSummary(v)}</span>}
      {tail}
    </>
  );
}

/** An array element row, with the same fold behaviour as {@link JsonEntry}. */
function JsonItem({ v, pad, indent, nav, last }: { v: unknown; pad: string; indent: number; nav: Nav; last: boolean }): ReactNode {
  const [open, setOpen] = useState(true);
  const tail = (
    <>
      {last ? "" : ","}
      {"\n"}
    </>
  );
  if (!foldable(v)) return <>{pad}<JsonValue value={v} indent={indent} nav={nav} />{tail}</>;
  return (
    <>
      <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} />
      {pad}
      {open ? <JsonBody value={v} indent={indent} nav={nav} /> : <span className="fold-summary">{foldSummary(v)}</span>}
      {tail}
    </>
  );
}
