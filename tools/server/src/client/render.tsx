import { ReactNode } from "react";

// Keep in sync with LINK_KEY / BINARY_KEY in src/server/yamlover.ts.
//
// A node shown only as a link (a container past the one-level view, or any binary
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
// An omni/mix node (a `!!omni` self-value + fields, or a `!!mix` of items + fields) arrives as
// `{ [MIXED_KEY]: {kind, value?, entries:[{key,value}]} }`, rendered in yamlover as a leading
// scalar (omni) then each entry positional (`- v`, key=null) or keyed (`k: v`).
const MIXED_KEY = "$yamloverMixed";

export interface Link {
  kind: "object" | "array" | "scalar" | "binary" | "omni" | "mix";
  type?: string; // the target's JSON-Schema type; with `format`, the routing key
  path: string;
  title?: string; // the target's schema title, when set (used as a link label)
  count?: number;
  size?: number;
  format?: string | null;
  value?: unknown; // for a link to a scalar: its value, shown as the label
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

type Syntax = "yaml" | "json";

/**
 * Render a one-level value or schema in YAML or JSON syntax, syntax-highlighted,
 * with nested containers as hyperlinks. Used for every RHS representation so they
 * behave identically: scalars shown, nested objects/arrays clicked to descend.
 */
export function Render({
  value,
  syntax,
  onNavigate,
}: {
  value: unknown;
  syntax: Syntax;
  onNavigate: (path: string) => void;
}) {
  const bin = asBinary(value);
  if (bin && syntax === "yaml") return <BinaryYaml bin={bin} />;
  const v = bin ?? value; // JSON shows the {format,size,base64} metadata object

  const out: ReactNode[] = [];
  const kc = { n: 0 };
  if (syntax === "yaml") emitYaml(v, 0, out, kc, onNavigate);
  else emitJson(v, 0, out, kc, onNavigate);
  return <>{out}</>;
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

interface KC {
  n: number;
}

function linkNode(link: Link, syntax: Syntax, kc: KC, onNavigate: (p: string) => void): ReactNode {
  // a scalar child links by its rendered value (`~`/`null`, quoted/bare per syntax);
  // a container by its `{ … }`/`[ … ]` summary
  const label = link.kind === "scalar" ? scalarLabel(link.value, syntax) : linkLabel(link);
  return (
    <a
      key={kc.n++}
      className="descend"
      href={link.path}
      onClick={(e) => {
        e.preventDefault();
        onNavigate(link.path);
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
function refNode(ref: Ref, syntax: Syntax, kc: KC, onNavigate: (p: string) => void): ReactNode {
  const text = syntax === "json" ? JSON.stringify(ref.text) : ref.text;
  if (!ref.path) return <span className="s" key={kc.n++}>{text}</span>;
  const target = ref.path;
  return (
    <a
      key={kc.n++}
      className="descend"
      href={target}
      onClick={(e) => {
        e.preventDefault();
        onNavigate(target);
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

function scalarNode(v: unknown, syntax: Syntax, kc: KC): ReactNode {
  if (v === null) return <span className="null" key={kc.n++}>{syntax === "json" ? "null" : "~"}</span>;
  if (typeof v === "boolean") return <span className="b" key={kc.n++}>{String(v)}</span>;
  if (typeof v === "number") return <span className="n" key={kc.n++}>{String(v)}</span>;
  const text = syntax === "json" ? JSON.stringify(v) : String(v);
  return <span className="s" key={kc.n++}>{text}</span>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// --------------------------------------------------------------------------- //
// YAML
// --------------------------------------------------------------------------- //
function emitYaml(value: unknown, indent: number, out: ReactNode[], kc: KC, nav: (p: string) => void): void {
  const link = asLink(value);
  if (link) {
    out.push(linkNode(link, "yaml", kc, nav), "\n");
    return;
  }
  const ref = asRef(value);
  if (ref) {
    out.push(refNode(ref, "yaml", kc, nav), "\n");
    return;
  }
  const mixed = asMixed(value);
  if (mixed) {
    const pad = " ".repeat(indent);
    // omni: the node's own scalar value on its own line first (`!!omni 5` → `5`)
    if (mixed.kind === "omni") out.push(pad, scalarNode(mixed.value, "yaml", kc), "\n");
    for (const e of mixed.entries) {
      if (e.key === null) {
        out.push(pad, <span className="punct" key={kc.n++}>{"- "}</span>);
        emitYamlChild(e.value, indent, out, kc, nav, true);
      } else {
        out.push(pad, <span className="k" key={kc.n++}>{e.key}</span>, <span className="punct" key={kc.n++}>:</span>);
        emitYamlChild(e.value, indent, out, kc, nav);
      }
    }
    return;
  }
  if (isObj(value)) {
    const entries = Object.entries(value);
    if (!entries.length) {
      out.push(<span className="punct" key={kc.n++}>{"{}"}</span>, "\n");
      return;
    }
    const pad = " ".repeat(indent);
    for (const [k, v] of entries) {
      out.push(pad, <span className="k" key={kc.n++}>{k}</span>, <span className="punct" key={kc.n++}>:</span>);
      emitYamlChild(v, indent, out, kc, nav);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      out.push(<span className="punct" key={kc.n++}>{"[]"}</span>, "\n");
      return;
    }
    const pad = " ".repeat(indent);
    for (const item of value) {
      out.push(pad, <span className="punct" key={kc.n++}>{"- "}</span>);
      emitYamlChild(item, indent, out, kc, nav, true);
    }
    return;
  }
  out.push(scalarNode(value, "yaml", kc), "\n");
}

// Render a value that follows a `key:` or `- ` — inline for scalars/links/empties,
// or a newline then a nested block.
function emitYamlChild(
  v: unknown,
  indent: number,
  out: ReactNode[],
  kc: KC,
  nav: (p: string) => void,
  inArray = false,
): void {
  const link = asLink(v);
  const ref = asRef(v);
  if (link) {
    out.push(" ", linkNode(link, "yaml", kc, nav), "\n");
  } else if (ref) {
    out.push(" ", refNode(ref, "yaml", kc, nav), "\n");
  } else if (isObj(v) && Object.keys(v).length === 0) {
    out.push(" ", <span className="punct" key={kc.n++}>{"{}"}</span>, "\n");
  } else if (Array.isArray(v) && v.length === 0) {
    out.push(" ", <span className="punct" key={kc.n++}>{"[]"}</span>, "\n");
  } else if (isObj(v) || Array.isArray(v)) {
    out.push("\n");
    emitYaml(v, indent + 2, out, kc, nav);
  } else {
    out.push(" ", scalarNode(v, "yaml", kc), "\n");
  }
  void inArray;
}

// --------------------------------------------------------------------------- //
// JSON (nested containers become links, so the view is not strictly valid JSON —
// it is the same one-level representation, in JSON syntax)
// --------------------------------------------------------------------------- //
function emitJson(value: unknown, indent: number, out: ReactNode[], kc: KC, nav: (p: string) => void): void {
  const link = asLink(value);
  if (link) {
    out.push(linkNode(link, "json", kc, nav));
    return;
  }
  const ref = asRef(value);
  if (ref) {
    out.push(refNode(ref, "json", kc, nav));
    return;
  }
  const mixed = asMixed(value);
  const objEntries: [string, unknown][] | null = mixed
    ? [
        ...(mixed.kind === "omni" ? ([["$value", mixed.value]] as [string, unknown][]) : []),
        ...mixed.entries.map((e, i): [string, unknown] => [e.key ?? String(i), e.value]),
      ]
    : isObj(value)
      ? Object.entries(value)
      : null;
  if (objEntries) {
    const entries = objEntries;
    if (!entries.length) {
      out.push(<span className="punct" key={kc.n++}>{"{}"}</span>);
      return;
    }
    const pad = " ".repeat(indent + 2);
    out.push(<span className="punct" key={kc.n++}>{"{"}</span>, "\n");
    entries.forEach(([k, v], i) => {
      out.push(pad, <span className="k" key={kc.n++}>{`"${k}"`}</span>, <span className="punct" key={kc.n++}>{": "}</span>);
      emitJson(v, indent + 2, out, kc, nav);
      out.push(i < entries.length - 1 ? "," : "", "\n");
    });
    out.push(" ".repeat(indent), <span className="punct" key={kc.n++}>{"}"}</span>);
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      out.push(<span className="punct" key={kc.n++}>{"[]"}</span>);
      return;
    }
    const pad = " ".repeat(indent + 2);
    out.push(<span className="punct" key={kc.n++}>{"["}</span>, "\n");
    value.forEach((item, i) => {
      out.push(pad);
      emitJson(item, indent + 2, out, kc, nav);
      out.push(i < value.length - 1 ? "," : "", "\n");
    });
    out.push(" ".repeat(indent), <span className="punct" key={kc.n++}>{"]"}</span>);
    return;
  }
  out.push(scalarNode(value, "json", kc));
}
