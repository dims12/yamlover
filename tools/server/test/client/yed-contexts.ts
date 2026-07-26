// THE CONTEXT MATRIX — the enclosing structures every simple edit must behave identically inside
// (THE LAW of context-free behavior). A context is nothing but a TYPED PREFIX from the empty
// document plus the row-frame it wraps the script's result in: entering a context uses the same
// grammar under test, so a context that cannot even be entered fails loudly in every row it hosts.
//
// `hosts` declares what a context can contain: a flow token holds only flow-expressible content,
// so block-shaped scripts are SKIPPED there — explicitly, per row, never silently (a skip names
// its reason in the test title).

export interface EditContext {
  name: string;
  /** What the context can host: anything, or only flow-expressible (inline) content. */
  hosts: "any" | "flow";
  /** The keystrokes that enter the context, starting from the empty document. */
  prefix: string;
  /** A document override for contexts that are a MOUNT fact, not a typed prefix (the dir root). */
  doc?: Record<string, unknown>;
  /** Rows when the script's result is one INLINE token `s` (a scalar, a one-line flow token). */
  wrapInline(s: string): string[];
  /** Rows when the script's result is K&R ROWS (a spread token's own rows, closers included). */
  wrapRows(r: string[]): string[];
  /** Rows when the script's result is a TOKEN and this context is SPREAD: the token spreads too
   *  (THE WHOLE-TOKEN LAW — json5p expands everything under the switch), so the context embeds the
   *  token's own K&R rows rather than its inline form. Absent ⇒ wrapInline applies. */
  wrapToken?(tokenRows: string[]): string[];
}

export const CONTEXTS: EditContext[] = [
  {
    name: "at the root",
    hosts: "any",
    prefix: "",
    wrapInline: (s) => [s],
    wrapRows: (r) => r,
  },
  {
    name: "under a key (k: )",
    hosts: "any",
    prefix: "k: ",
    wrapInline: (s) => [`k: ${s}`],
    wrapRows: (r) => [`k: ${r[0]}`, ...r.slice(1)],
  },
  {
    name: "as a block item (- )",
    hosts: "any",
    prefix: "- ",
    wrapInline: (s) => [`- ${s}`],
    wrapRows: (r) => [`- ${r[0]}`, ...r.slice(1)],
  },
  {
    name: "inside a flow map ({p: )",
    hosts: "flow",
    prefix: "{{p: ",
    wrapInline: (s) => [`{p: ${s}}`],
    wrapRows: () => { throw new Error("a one-line token cannot hold rows"); },
  },
  {
    name: "inside a flow seq ([)",
    hosts: "flow",
    prefix: "[",
    wrapInline: (s) => [`[${s}]`],
    wrapRows: () => { throw new Error("a one-line token cannot hold rows"); },
  },
  {
    name: "inside a SPREAD token ([ Enter)",
    hosts: "flow",
    prefix: "[{Enter}",
    wrapInline: (s) => ["[", s, "]"],
    wrapRows: (r) => ["[", ...r, "]"],
    wrapToken: (r) => ["[", ...r, "]"],
  },
  {
    name: "nested two deep ({p: [)",
    hosts: "flow",
    prefix: "{{p: [",
    wrapInline: (s) => [`{p: [${s}]}`],
    wrapRows: () => { throw new Error("a one-line token cannot hold rows"); },
  },
  {
    // THE REPORTED SETTING: a fresh DIRECTORY opened in the editor — the root is dir-concrete, so
    // entries materialize as members. Every law holds here exactly as in a file document.
    name: "at the root of a DIRECTORY document",
    hosts: "any",
    prefix: "",
    doc: { path: ":n", type: "object", concrete: "dir/yamlover", title: null, description: null, value: {} },
    wrapInline: (s) => [s],
    wrapRows: (r) => r,
  },
];

/** The block-capable subset (scripts whose result is block rows). */
export const BLOCK_CONTEXTS = CONTEXTS.filter((c) => c.hosts === "any");
