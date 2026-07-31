// repr.ts — the REPRESENTATION axis, in one pure module (no I/O, no index, shared client and
// server), the sibling of concrete.ts. Normative prose: CONCRETES.md §"Scalar representation".
//
// A node carries TWO orthogonal concretes:
//
//   STORAGE (concrete.ts)        — WHERE the value lives and in what language: `yamlover`,
//                                  `file/yaml`, `dir/yamlover`, …
//   REPRESENTATION (this module) — HOW it is written: `yaml/flow`, `yaml/single`, `yaml/hex`, …
//
// Both are real: a flow sequence inside a `.yo` file is `concrete: "yamlover"` AND
// `repr: "yaml/flow"`. Flow is NOT a language switch — the language is still yamlover.
//
// The namespace is `yaml/…` (not `yamlover/…`) on purpose: yamlover, yaml and json5p share the
// scalar and flow grammars, so one vocabulary describes all three. It is drawn from the YAML 1.2
// spec — scalar styles (Ch. 7-8) and the core / type-repository content notations (Ch. 10).
//
// A representation is a CLASSIFICATION, never the bytes. The exact source token is already kept
// losslessly in the IR (`Scalar.raw`); this module is the label a renderer, a schema or a
// style-picker reasons about — which is what makes a string `"~"` distinguishable from a null `~`
// on screen. Formatting itself is normalized: `[1,2]` and `[ 1, 2 ]` are both `yaml/flow`, and
// both re-emit canonically.

import { isJsonFamily } from "./concrete";

// --------------------------------------------------------------------------- //
// The vocabulary — CONCRETES.md §"String styles" … §"Float notations"
// --------------------------------------------------------------------------- //

/** How a string is delimited / laid out (YAML 1.2 Ch. 7-8). */
export type StringRepr = "yaml/plain" | "yaml/single" | "yaml/double" | "yaml/literal" | "yaml/folded";
/** How a null is spelled. */
export type NullRepr = "yaml/tilde" | "yaml/null" | "yaml/empty";
/** How a boolean is spelled: core, or the YAML 1.1 word set (`yes`/`no`/`on`/`off`). */
export type BoolRepr = "yaml/bool" | "yaml/bool11";
/** An integer's base — all the same value. */
export type IntRepr = "yaml/dec" | "yaml/hex" | "yaml/oct" | "yaml/bin";
/** A float's notation. */
export type FloatRepr = "yaml/float" | "yaml/exp" | "yaml/inf" | "yaml/nan";
/** A container's STYLE — the collection half of the axis (YAML Ch. 7 flow / Ch. 8 block). */
export type CollectionRepr = "yaml/flow" | "yaml/block";

export type ScalarRepr = StringRepr | NullRepr | BoolRepr | IntRepr | FloatRepr;
export type Repr = ScalarRepr | CollectionRepr;

/** A block scalar's further modifiers (CONCRETES.md §113-116). They change trailing whitespace and
 *  layout, never the value, so they qualify the literal/folded concrete rather than replacing it. */
export interface BlockQualifiers {
  /** §8.1.1.2 — `clip` is the default and is not recorded. */
  chomp?: "strip" | "keep";
  /** §8.1.1.1 — an explicit block indent (`|2`). */
  indent?: number;
}

/** A classified scalar: its representation, plus a block scalar's qualifiers. */
export interface ScalarStyle {
  repr: ScalarRepr;
  block?: BlockQualifiers;
}

// --------------------------------------------------------------------------- //
// Classification
// --------------------------------------------------------------------------- //

const BOOL11 = new Set(["yes", "no", "on", "off"]);
/** A block-scalar header: `|`/`>` plus chomping and an indent indicator, in either order. */
const BLOCK_HEADER = /^([|>])(?:(\d)([+-])?|([+-])(\d)?)?/;

/** The representation a value takes when nothing marks it otherwise — the canonical spelling the
 *  wire omits `raw` for (mirroring engine-api's `scalarRawToken`, which drops a token equal to the
 *  plain rendering). So "no raw" and "the default repr" are the same statement. */
export function defaultRepr(value: unknown): ScalarRepr {
  if (value === null || value === undefined) return "yaml/null";
  if (typeof value === "boolean") return "yaml/bool";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "yaml/nan";
    if (!Number.isFinite(value)) return "yaml/inf";
    return Number.isInteger(value) ? "yaml/dec" : "yaml/float";
  }
  return "yaml/plain";
}

/** Classify a scalar's AUTHORED token. `raw` absent ⇒ {@link defaultRepr} — the wire carries a raw
 *  only when it differs from the canonical spelling, so its absence IS the canonical claim.
 *  The classification reads the token's SHAPE (the parser only ever produces a quoted, block, or
 *  plain token), falling back to the decoded value for the plain forms. */
export function classifyScalar(value: unknown, raw?: string | null): ScalarStyle {
  if (raw == null) return { repr: defaultRepr(value) };
  if (raw === "") return { repr: "yaml/empty" }; // `key:` with nothing after it
  const c = raw[0];
  if (c === "'") return { repr: "yaml/single" };
  if (c === '"') return { repr: "yaml/double" };
  if (c === "|" || c === ">") {
    const m = BLOCK_HEADER.exec(raw)!;
    const chompCh = m[3] ?? m[4];
    const indentCh = m[2] ?? m[5];
    const block: BlockQualifiers = {};
    if (chompCh === "-") block.chomp = "strip";
    else if (chompCh === "+") block.chomp = "keep";
    if (indentCh) block.indent = Number(indentCh);
    const repr: ScalarRepr = c === "|" ? "yaml/literal" : "yaml/folded";
    return Object.keys(block).length ? { repr, block } : { repr };
  }
  return { repr: plainRepr(value, raw.trim()) };
}

/** A PLAIN token's notation — the token's own spelling decides, because the decoded value cannot:
 *  `1.0` and `1` are both the JS number 1, and `0xff` and `255` are both 255. */
function plainRepr(value: unknown, tok: string): ScalarRepr {
  if (tok === "~") return "yaml/tilde";
  const lower = tok.toLowerCase();
  if (value === null || value === undefined) return lower === "null" ? "yaml/null" : "yaml/tilde";
  if (typeof value === "boolean") return BOOL11.has(lower) ? "yaml/bool11" : "yaml/bool";
  if (typeof value === "number") {
    const body = lower.replace(/^[+-]/, "");
    if (body === ".nan") return "yaml/nan";
    if (body === ".inf") return "yaml/inf";
    if (body.startsWith("0x")) return "yaml/hex";
    if (body.startsWith("0b")) return "yaml/bin";
    if (body.startsWith("0o")) return "yaml/oct";
    // NOT `0377`: the core schema reads a leading zero as decimal (377, not 255), and CONCRETES.md
    // §155-158 keeps leading zeros in `raw` rather than giving them a concrete of their own.
    if (/[.e]/.test(body)) return /e/.test(body) ? "yaml/exp" : "yaml/float";
    return "yaml/dec";
  }
  return "yaml/plain";
}

/** A container's style. `style` is the parser's AUTHORED bit (`NodeMeta.style`); absent falls back
 *  to the language default — a json-family document is flow end to end, everything else is block,
 *  which is why json5p containers need no per-node marker. */
export function collectionRepr(style: "flow" | undefined, concrete?: string | null): CollectionRepr {
  return style === "flow" || isJsonFamily(concrete) ? "yaml/flow" : "yaml/block";
}

export const isFlowRepr = (r?: string | null): r is "yaml/flow" => r === "yaml/flow";

/** Whether a classified repr is worth putting ON THE WIRE: the defaults are re-derivable from the
 *  value, so carrying them would bloat every node's sidecar for nothing. `yaml/block` is the
 *  collection default for the same reason. */
export function isDefaultRepr(repr: Repr, value?: unknown): boolean {
  return repr === "yaml/block" || repr === defaultRepr(value);
}
