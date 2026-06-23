// The canonical concrete taxonomy. Normative prose: CONCRETES.md (repo root).
//
// A node's `concrete` records HOW / WHERE its value is stored. The vocabulary,
// shared by the server (which assigns it onto every YNode) and the client (which
// shows it and routes on it):
//
//   Inlined — a portion of a text file written in a given language. Descendants
//   inherit the language unless the syntax switches mid-stream (yaml → json,
//   yamlover → json5p), after which they take the switched language:
//       json · json5 · json5p · yaml · yamlover
//
//   Files — a whole text file of a given language in the outer block; the file's
//   own interior nodes are usually that same language WITHOUT the `file/` prefix:
//       file/json · file/json5 · file/json5p · file/yaml · file/yamlover
//
//   Binary file — opaque bytes (an image, a pdf, …):
//       file/binary
//
//   Directories:
//       dir          — a plain OS directory
//       dir/yamlover — a directory carrying a `.yamlover/` marker; descendants are yamlover
//
//   Multi-document — one file holding several `---`-separated documents, each an
//   element of the singular concrete (RESERVED — multi-doc parsing is Phase 2c):
//       multi-yaml · multi-yamlover
//
// yamlover is a SEPARATE language: close to yaml but not a superset of it. It can
// switch to json5p, never to pure yaml.

export type Inlined = "json" | "json5" | "json5p" | "yaml" | "yamlover";
export type FileConcrete =
  | "file/json"
  | "file/json5"
  | "file/json5p"
  | "file/yaml"
  | "file/yamlover"
  | "file/binary";
export type DirConcrete = "dir" | "dir/yamlover";
export type MultiConcrete = "multi-yaml" | "multi-yamlover";
export type Concrete = Inlined | FileConcrete | DirConcrete | MultiConcrete;

const JSON_FAMILY = new Set<string>(["json", "json5", "json5p"]);
const YAML_FAMILY = new Set<string>(["yaml", "yamlover"]);

/** A whole-file concrete (`file/…`), incl. `file/binary`. */
export function isFileConcrete(c?: string | null): boolean {
  return !!c && c.startsWith("file/");
}

/** The opaque-bytes concrete. */
export function isBinaryConcrete(c?: string | null): boolean {
  return c === "file/binary";
}

/** A directory concrete (`dir` or `dir/yamlover`). */
export function isDirConcrete(c?: string | null): boolean {
  return c === "dir" || c === "dir/yamlover";
}

/** A multi-document concrete (`multi-yaml` / `multi-yamlover`). */
export function isMultiConcrete(c?: string | null): boolean {
  return c === "multi-yaml" || c === "multi-yamlover";
}

/** The bare inlined language of a concrete, ignoring any `file/` prefix
 *  (`file/yaml` → `yaml`). Null for binary / dir / multi concretes, which name
 *  no inlined language. */
export function baseLanguage(c?: string | null): Inlined | null {
  if (!c) return null;
  const bare = c.startsWith("file/") ? c.slice("file/".length) : c;
  return JSON_FAMILY.has(bare) || YAML_FAMILY.has(bare) ? (bare as Inlined) : null;
}

/** A json-family concrete (json/json5/json5p), incl. its `file/…` form — used to
 *  decide whether a node offers the json5p (JSON-syntax) data view. */
export function isJsonFamily(c?: string | null): boolean {
  const bare = baseLanguage(c);
  return bare != null && JSON_FAMILY.has(bare);
}

/** A yaml-family concrete (yaml/yamlover), incl. its `file/…` form. */
export function isYamlFamily(c?: string | null): boolean {
  const bare = baseLanguage(c);
  return bare != null && YAML_FAMILY.has(bare);
}

/** The inlined language a `file/<lang>` wraps its interior with (`file/yaml` →
 *  `yaml`). Binary names none; an unknown text file defaults to `yaml` (a raw
 *  string is a valid yaml scalar). */
export function interiorOf(c?: string | null): Inlined {
  return baseLanguage(c) ?? "yaml";
}

// Extension → the `file/<lang>` concrete of a stray/loose data file. Anything not
// listed (a markdown/csv material, an unknown text file) is modeled as a
// `file/yaml` scalar string — see CONCRETES.md.
const EXT_FILE_CONCRETE: Record<string, FileConcrete> = {
  ".yamlover": "file/yamlover",
  ".yaml": "file/yaml",
  ".yml": "file/yaml",
  ".json": "file/json",
  ".json5": "file/json5",
  ".json5p": "file/json5p",
};

/** The `file/<lang>` concrete of a path whose extension names a yamlover DATA language
 *  (`.yaml`/`.yml`/`.yamlover`/`.json`/`.json5`/`.json5p`), or null for anything else (a
 *  binary, a markdown/csv material, an extensionless file). Pure string work so the client
 *  bundle can share it (no `node:path`). */
export function dataFileConcrete(filePath: string): FileConcrete | null {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = filePath.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
  return EXT_FILE_CONCRETE[ext] ?? null;
}

/** The `file/<lang>` concrete implied by a path's extension, defaulting to `file/yaml` for a
 *  non-data text file (a raw string is a valid yaml scalar — see CONCRETES.md). */
export function fileConcreteForExt(filePath: string): FileConcrete {
  return dataFileConcrete(filePath) ?? "file/yaml";
}
