// Type/format icon for a TOC node — chosen by the schema `format`, falling back
// to `type`. One exception to being concrete-agnostic: a node stored as a plain
// on-disk directory (the `dir` concrete — a folder with no `.yamlover/` marker)
// gets a normal folder icon, since it really is a filesystem folder.

export interface Glyph {
  glyph: string;
  cls: string; // CSS class (color)
  title: string; // tooltip
}

// Type → a monochrome glyph, colored by category (matches the value highlighting).
const TYPE: Record<string, { glyph: string; cls: string }> = {
  object: { glyph: "{}", cls: "t-struct" },
  array: { glyph: "[]", cls: "t-struct" },
  string: { glyph: "“”", cls: "t-str" },
  integer: { glyph: "#", cls: "t-num" },
  number: { glyph: "½", cls: "t-num" },
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
  if (format === "x-yamlover-tag") return "🏷️";
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

/** The type/format icon for a node — `format` wins, then a plain-directory
 *  (`dir`) concrete shows a folder, else `type`. */
export function typeIcon(type: string, format: string | null, concrete?: string | null): Glyph {
  if (format) {
    const g = FORMAT[format] ?? mediaIcon(format);
    if (g) return { glyph: g, cls: "t-fmt", title: format };
  }
  // a plain directory (no `.yamlover/`) — a real OS folder
  if (concrete === "dir") return { glyph: "📁", cls: "t-struct", title: "folder" };
  const t = TYPE[type];
  if (t) return { glyph: t.glyph, cls: t.cls, title: type };
  return { glyph: "•", cls: "t-bin", title: type || "unknown" };
}
