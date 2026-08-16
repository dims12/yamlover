// Type/format icon for a TOC node — chosen by the schema `format`, falling back
// to `type`. One exception to being concrete-agnostic: a node stored as an
// on-disk directory gets a folder icon, since it really is a filesystem folder —
// plain (`dir`, no overlay) or a yamlover entity (`dir/.yo`, `dir/index.yo`).

export interface Glyph {
  glyph: string;
  cls: string; // CSS class (color)
  title: string; // tooltip
}

// Type → a monochrome glyph, colored by category (matches the value highlighting).
const TYPE: Record<string, { glyph: string; cls: string }> = {
  // cube corners (docs/meta/facets) — typeName emits the lower bound; JSON-Schema aliases read forever
  map: { glyph: "{}", cls: "t-struct t-code" },
  object: { glyph: "{}", cls: "t-struct t-code" },
  seq: { glyph: "[]", cls: "t-struct t-code" },
  array: { glyph: "[]", cls: "t-struct t-code" },
  kseq: { glyph: "()", cls: "t-struct t-code" }, // flow fields — marklower `[…](…)` without the self-value
  mixed: { glyph: "()", cls: "t-struct t-code" },
  vmap: { glyph: "{=}", cls: "t-struct t-code" },
  vseq: { glyph: "[=]", cls: "t-struct t-code" },
  omni: { glyph: "[]()", cls: "t-struct t-code" }, // flow omni — `[]` self-value, `()` fields
  variant: { glyph: "[]()", cls: "t-struct t-code" },
  str: { glyph: "“”", cls: "t-str" },
  string: { glyph: "“”", cls: "t-str" },
  int: { glyph: "#", cls: "t-num" },
  integer: { glyph: "#", cls: "t-num" },
  float: { glyph: "½", cls: "t-num" },
  number: { glyph: "½", cls: "t-num" },
  bool: { glyph: "◧", cls: "t-bool" },
  boolean: { glyph: "◧", cls: "t-bool" },
  null: { glyph: "∅", cls: "t-null" },
  binary: { glyph: "0110", cls: "t-bin binsq" }, // bits in a little square
};

// Exact-match formats → an icon.
const FORMAT: Record<string, string> = {
  "date-time": "🕑",
  date: "📅",
  time: "🕑",
  duration: "⏳",
  email: "✉️",
  "idn-email": "✉️",
  hostname: "🖥️",
  "idn-hostname": "🖥️",
  ipv4: "🌐",
  ipv6: "🌐",
  uri: "🔗",
  iri: "🔗",
  "uri-reference": "🔗",
  "iri-reference": "🔗",
  "uri-template": "🔗",
  url: "🔗",
  uuid: "🆔",
  regex: "🔣",
  "json-pointer": "📍",
  "relative-json-pointer": "📍",
  password: "🔑",
  color: "🎨",
};

// Media-type / binary-encoding / custom formats → an icon, chosen by prefix.
function mediaIcon(format: string): string | null {
  if (format === "x-yamlover-chapter") return "§"; // a chapter — the section sign
  if (format === "x-yamlover-onto") return "🏷️";
  if (format === "x-yamlover-board") return "📋"; // a task board — a clipboard of tickets
  if (format === "x-yamlover-task") return "🎫"; // a task — one ticket
  if (format.startsWith("x-yamlover-")) return "🧩"; // a custom yamlover renderer
  if (format === "application/pdf") return "📕";
  if (format === "application/x-fictionbook+xml") return "📘";
  if (format === "application/epub+zip") return "📗";
  if (format === "image/vnd.djvu") return "📓";
  if (format.startsWith("image/")) return "🖼️";
  if (format === "text/markdown") return "📝";
  if (format === "text/asciidoc") return "📃";
  if (format === "text/csv" || format === "text/tab-separated-values") return "▦"; // a table
  if (format === "text/x-plantuml") return "📊"; // source that compiles to a diagram
  if (format === "application/vnd.ms-excel") return "▦"; // legacy .xls workbook
  if (format === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "▦"; // .xlsx
  if (format === "application/rtf") return "📄";
  if (format === "application/msword") return "📄"; // legacy .doc
  if (format === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "📄"; // .docx
  if (format === "application/vnd.google-earth.kml+xml" || format === "application/vnd.google-earth.kmz") return "🗺️"; // map overlay
  if (format.startsWith("text/")) return "📄";
  if (format.startsWith("audio/")) return "🔊";
  if (format.startsWith("video/")) return "🎬";
  if (/^(u?int|float)\d/.test(format)) return "💾"; // int32/le, float64, …
  return null;
}

/** The type/format icon for a node — `format` wins, then a directory concrete
 *  (`dir`/`yamlover`) shows a folder, else `type`. */
export function typeIcon(type: string, format: string | null, concrete?: string | null): Glyph {
  // a fragment (a marked region) gets a "selection" mark — a handled box with a centre plus —
  // drawn from CSS (`.frag-icon`), so it reads as a region rather than a generic renderer glyph.
  if (format === "x-yamlover-fragment") return { glyph: "", cls: "t-fmt frag-icon", title: "fragment" };
  if (format) {
    const g = FORMAT[format] ?? mediaIcon(format);
    if (g) return { glyph: g, cls: "t-fmt", title: format };
  }
  // a plain directory (no `.yo/`) — a real OS folder
  if (concrete === "dir") return { glyph: "📁", cls: "t-struct", title: "folder" };
  // a yamlover entity stored as a directory — a folder carrying an instance overlay, under the
  // `.yo/` marker or as a plain `index.yo` (docs/language/concretes/03-yamlover/01-dir)
  if (concrete === "dir/.yo" || concrete === "dir/index.yo") return { glyph: "🗂️", cls: "t-struct", title: "yamlover folder" };
  const t = TYPE[type];
  if (t) return { glyph: t.glyph, cls: t.cls, title: type };
  return { glyph: "•", cls: "t-bin", title: type || "unknown" };
}
