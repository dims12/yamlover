// Type/format icon for a TOC node — chosen by the schema `format`, falling back
// to `type`. The tree is agnostic to *concrete* (how the node is stored).

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
  binary: { glyph: "▤", cls: "t-bin" },
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
  if (format === "x-yamlover-chapter") return "📖";
  if (format.startsWith("x-yamlover-")) return "🧩"; // a custom yamlover renderer
  if (format.startsWith("image/")) return "🖼️";
  if (format === "text/markdown") return "📝";
  if (format.startsWith("text/")) return "📄";
  if (format.startsWith("audio/")) return "🔊";
  if (format.startsWith("video/")) return "🎬";
  if (/^(u?int|float)\d/.test(format)) return "💾"; // int32/le, float64, …
  return null;
}

/** The type/format icon for a node — `format` wins, else `type`. */
export function typeIcon(type: string, format: string | null): Glyph {
  if (format) {
    const g = FORMAT[format] ?? mediaIcon(format);
    if (g) return { glyph: g, cls: "t-fmt", title: format };
  }
  const t = TYPE[type];
  if (t) return { glyph: t.glyph, cls: t.cls, title: type };
  return { glyph: "•", cls: "t-bin", title: type || "unknown" };
}
