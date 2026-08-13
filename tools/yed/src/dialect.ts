// yed2 — THE DIALECT: every language-POLICY decision the edit layer makes, as one pure object.
// The grammar (dispatch.ts) and the classifier (keys.ts) stay dialect-blind — they are shared
// with production; apply.ts consults the dialect at each decision point and REFUSES visibly
// where a dialect forbids a form (never a silent swallow — the watchdog's law holds per
// dialect). The `yamlover` dialect reproduces the editor's current behavior exactly: every gate
// reads `true`, so under it the gates are dead code and the corpus byte ledgers cannot move.

export type DialectId = "yamlover" | "json5" | "json";

export interface Dialect {
  readonly id: DialectId;
  /** Block context exists: block rows, `- `/`k: ` markers, entry-stage classification, and
   *  Enter's descend creating a BLOCK child. false ⇒ documents are flow end to end. */
  readonly blockContext: boolean;
  /** `- ` decides a keyless entry; un-naming keeps the row as an ordered one. */
  readonly ordinals: boolean;
  /** A bare scalar among a NONEMPTY block container's entries may become the container's own
   *  value (the omni / value-plus-fields form). The empty-container case — the value replacing
   *  the empty container wholesale, the fresh root included — is universal and NOT gated. */
  readonly omniValue: boolean;
  /** Enter may spread a flow token to K&R rows. NOTE: the spread marker is the yamlover
   *  surface's inline concrete switch (`meta.concrete = "json5p"`); what a NATIVE json5
   *  document should store for layout is an open serializer question, out of scope here. */
  readonly spread: boolean;
  /** `*`-led hole text commits as a REFERENCE (a pointer value). false ⇒ `*…` is plain text
   *  and refuses at the scalar gate like any other non-token. */
  readonly pointers: boolean;
  /** `&`-led entry-stage text opens the BOOKMARK face (an anchor on the container). false ⇒
   *  `&…` is plain text and refuses at the scalar gate. (json5p PARSES `&'p' v` — parse-side
   *  tolerance is not an entry gesture; the json5 dialect models plain-json5 typing.) */
  readonly anchors: boolean;
  /** `k2: ` typed in a NAMED value hole extends the key path — a FLAT ROW segment
   *  (docs/language/flattening), committed with the yamlover/key/flat concrete. false ⇒
   *  the text stays content and refuses at the scalar gate (YAML's ZCZ6 reading). */
  readonly flatRows: boolean;
  /** May this key be typed BARE (`k:` without quotes)? A refused key rings; `"k":` (the quoted
   *  form) is accepted by every dialect. */
  bareKey(key: string): boolean;
  /** Is this source token an acceptable SCALAR spelling? */
  scalarToken(raw: string): boolean;
}

export const YAMLOVER: Dialect = {
  id: "yamlover",
  blockContext: true,
  ordinals: true,
  omniValue: true,
  spread: true,
  pointers: true,
  anchors: true,
  flatRows: true,
  bareKey: () => true,
  scalarToken: () => true,
};

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const JSON5_NUMBER = /^[+-]?(0[xX][0-9a-fA-F]+|Infinity|NaN|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)$/;
const SINGLE_QUOTED = /^'(?:[^'\\]|\\.)*'$/;

function jsonToken(raw: string): boolean {
  const t = raw.trim();
  if (t === "true" || t === "false" || t === "null") return true;
  if (JSON_NUMBER.test(t)) return true;
  if (t.startsWith('"') && t.endsWith('"')) {
    try { JSON.parse(t); return true; } catch { return false; }
  }
  return false;
}

function json5Token(raw: string): boolean {
  const t = raw.trim();
  return jsonToken(t) || JSON5_NUMBER.test(t) || SINGLE_QUOTED.test(t);
}

export const JSON5_D: Dialect = {
  id: "json5",
  blockContext: false,
  ordinals: false,
  omniValue: false,
  spread: true,
  pointers: false, // json5 has no `*` sigil — a star is just an illegal token
  anchors: false,
  flatRows: false,
  bareKey: (k) => IDENT.test(k),
  scalarToken: json5Token,
};

export const JSON_D: Dialect = {
  id: "json",
  blockContext: false,
  ordinals: false,
  omniValue: false,
  spread: true,
  pointers: false,
  anchors: false,
  flatRows: false,
  bareKey: () => false,
  scalarToken: jsonToken,
};

export const DIALECTS: Record<DialectId, Dialect> = { yamlover: YAMLOVER, json5: JSON5_D, json: JSON_D };
