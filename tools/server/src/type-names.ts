// Yamlover type spellings (docs/language/logical-graph/values, docs/meta/facets).
// JSON Schema names stay on `valueType` for renderer dispatch; the header/TOC `type`
// chip and {@link typeName} use these.

const YO: Record<string, string> = {
  object: "map",
  array: "seq",
  mixed: "kseq",
  variant: "omni",
  string: "str",
  integer: "int",
  number: "float",
  boolean: "bool",
};

/** JSON Schema / legacy kind → the yamlover name shown in the header and TOC. */
export function displayType(type: string): string {
  return YO[type] ?? type;
}
