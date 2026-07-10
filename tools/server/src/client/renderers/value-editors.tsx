// The library of inline editors for a DATA-view scalar (a leaf of the yamlover `Render` tree). A
// locked view renders read-only through `scalarNode`; when the view is UNLOCKED (the Edit button,
// `useEditing().unlocked`) every addressable scalar becomes an inline field that edits the node's
// YAMLOVER SOURCE and commits one surgical `emplace` at the leaf's own path.
//
// Design (per the project direction — a schema/meta-guided, MPS-style structured editor):
//   - The field edits yamlover SOURCE, not raw text we escape. What you type is re-parsed with the
//     real parser and sent VERBATIM. So `~` → null, `42` → number, `true` → boolean, `"a, b"` → the
//     string "a, b" — the language is honored, nothing is silently quoted.
//   - We accept only what this editor supports: a single SCALAR. Flow sequences/maps (`a: b`,
//     `[1,2]`, `{x:1}`), pointers (`*x`), and parse errors are refused (revert + red). A BARE token
//     carrying flow-structural chars (`,` `[` `]` `{` `}`) is refused too — so `a, b` must be
//     quoted (`"a, b"`), matching "we only accept scalars". `valueEditorFor`/`validateEdit` are the
//     seams where schema/meta-guided richer widgets and constraints slot in later.
//   - The SERVER stays permissive (it still accepts full yamlover facets, so chapters / node
//     replaces keep working) — the constraint lives here, in the client, next to the widget.

import { ReactNode, useEffect, useRef, useState } from "react";
import { scalarNode, type Syntax } from "../render";
import { useEditing } from "./editing";
import { editChunks } from "../api";
import { parseYamlover } from "../../../../parser/ts/src/yamlover.ts";

/** The primitive JS values a leaf editor handles. A non-finite number arrives as a `$yamloverNum`
 *  MARKER object, not a JS number, so it is excluded here and stays read-only. */
type Primitive = string | number | boolean | null;

function isEditablePrimitive(v: unknown): v is Primitive {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

// --------------------------------------------------------------------------- //
// Value → its yamlover SOURCE token (the field's initial text)
// --------------------------------------------------------------------------- //
/** A yaml/yamlover plain (bare) scalar is safe only for a conservative shape — letter-led, then word
 *  chars / space / dot / dash — and never when it would reparse as another type. Everything else is
 *  double-quoted, which is a valid flow scalar in yaml and yamlover alike. */
const SAFE_YAML_BARE = /^[A-Za-z][\w .-]*$/;
const YAML_RESERVED = /^(true|false|null|yes|no|on|off|~|\.nan|[-+]?\.inf)$/i;
function yamlStringSource(s: string): string {
  if (s !== "" && s === s.trim() && SAFE_YAML_BARE.test(s) && !YAML_RESERVED.test(s)) return s;
  return JSON.stringify(s); // JSON escaping is a subset of yaml/yamlover double-quoted escaping
}

/** The value's canonical yamlover SOURCE token — what the field shows to start (and reverts to).
 *  `null`/booleans/numbers are bare literals; strings are bare when safe, else double-quoted. */
export function scalarToSource(value: Primitive, syntax: Syntax): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return syntax === "json" ? JSON.stringify(value) : yamlStringSource(value);
}

// --------------------------------------------------------------------------- //
// Accept only a yamlover SCALAR (the re-parse that replaces auto-escaping)
// --------------------------------------------------------------------------- //
const BARE_FLOW = /[,{}[\]]/; // flow-structural chars that demand quoting in a bare token

/** True when `text` is yamlover source for a single SCALAR value this editor supports. Re-parses with
 *  the real parser: rejects a mapping/sequence, a pointer (`*…` throws), and parse errors; also
 *  rejects a BARE token carrying flow chars so `a, b` needs quotes. Empty input is not a scalar (type
 *  `""` for the empty string). */
export function acceptsAsScalar(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  const quoted = t[0] === '"' || t[0] === "'";
  if (!quoted && BARE_FLOW.test(t)) return false;
  try {
    const root = parseYamlover(t, "<edit>").root;
    return root.kind === "scalar";
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------- //
// Validation seam (schema/meta — deferred)
// --------------------------------------------------------------------------- //
export type EditVerdict = { ok: true } | { ok: false; error: string };

/** The seam for the future schema/meta validation layer — none exists in the codebase yet (deferred,
 *  IR.md Phase 6 / META.md "later optional pass"). Today it affirms every scalar; when the layer
 *  lands, enforce enum / const / minimum / maximum (from an attached `!!<…>` schema) here. */
export function validateEdit(_path: string, _source: string, _concrete: string | null): EditVerdict {
  return { ok: true };
}

// --------------------------------------------------------------------------- //
// Persist one scalar edit — the typed SOURCE, verbatim
// --------------------------------------------------------------------------- //
/** Send one `emplace` carrying `source` (VERBATIM yamlover) for the scalar at `path`. Resolves true
 *  on success, false on a server rejection (a parse failure 400s with the file untouched). */
async function commitSource(path: string, source: string, concrete: string | null): Promise<boolean> {
  const verdict = validateEdit(path, source, concrete);
  if (!verdict.ok) return false;
  try {
    await editChunks([{ path, op: "emplace", yamlover: source }]);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------- //
// The widget — one yamlover-source field for every scalar leaf
// --------------------------------------------------------------------------- //
/** An uncontrolled contentEditable field that edits the leaf's yamlover SOURCE. Commits on blur and
 *  Enter, cancels on Esc; a rejected commit (not a scalar, or a server 400) reverts and flags
 *  `.edit-error`. `className` colours the token like its read-only form (`.s/.n/.b/.null`). */
function YamloverScalarField({
  initial,
  className,
  path,
  concrete,
}: {
  initial: string;
  className: string;
  path: string;
  concrete: string | null;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const focused = useRef(false);
  const cancel = useRef(false);
  const busy = useRef(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (ref.current && !focused.current) ref.current.textContent = initial;
  }, [initial]);

  const revert = () => {
    if (ref.current) ref.current.textContent = initial;
  };

  const commit = async () => {
    if (cancel.current) { cancel.current = false; revert(); return; }
    if (busy.current) return;
    const text = (ref.current?.textContent ?? "").trim();
    if (text === initial) { setError(false); return; } // no-op
    if (!acceptsAsScalar(text)) { setError(true); revert(); return; } // not a scalar we support
    busy.current = true;
    const ok = await commitSource(path, text, concrete);
    busy.current = false;
    if (!ok) { setError(true); revert(); } else setError(false);
  };

  return (
    <span
      ref={ref}
      className={className + " editable" + (error ? " edit-error" : "")}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onFocus={() => { focused.current = true; setError(false); }}
      onBlur={() => { focused.current = false; void commit(); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLElement).blur(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel.current = true; (e.target as HTMLElement).blur(); }
      }}
    />
  );
}

/** The token colour class for a value's read-only rendering — reused on the editor so it looks the
 *  same. */
function classFor(value: Primitive): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return "b";
  if (typeof value === "number") return "n";
  return "s";
}

// --------------------------------------------------------------------------- //
// The registry — pick a widget for a value + concrete
// --------------------------------------------------------------------------- //
/** Choose the inline editor for a primitive `value`. Today every scalar edits through the one
 *  yamlover-source field; this is the extension point where schema/meta-guided widgets (enum picker,
 *  boolean toggle, pointer completer, date field) will be added, gated by concrete + attached schema. */
export function valueEditorFor(value: Primitive, path: string, syntax: Syntax, concrete: string | null, raw?: string): ReactNode {
  // the field starts from the value's FAITHFUL source token when we have it (a quoted string, `~`,
  // `0xff`, …), else the canonical source form — so editing shows exactly what is on disk.
  return <YamloverScalarField initial={raw ?? scalarToSource(value, syntax)} className={classFor(value)} path={path} concrete={concrete} />;
}

// --------------------------------------------------------------------------- //
// The dispatcher used by render.tsx at every scalar site
// --------------------------------------------------------------------------- //
/** A scalar leaf: read-only `scalarNode` unless the view opted into editing (`editable`), is
 *  UNLOCKED, the leaf has an addressable `path`, and the value is an editable primitive. */
export function ScalarLeaf({
  value,
  syntax,
  path,
  editable,
  concrete,
  raw,
}: {
  value: unknown;
  syntax: Syntax;
  path: string | null;
  editable: boolean;
  concrete: string | null;
  raw?: string; // the scalar's faithful source token, when the projection carries one
}): ReactNode {
  const { unlocked } = useEditing();
  if (!editable || !unlocked || path === null || !isEditablePrimitive(value)) return scalarNode(value, syntax, raw);
  return valueEditorFor(value, path, syntax, concrete, raw);
}
