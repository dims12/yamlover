// THE OVERLAY-KEY VOCABULARY — the ONE module that spells the reserved `.yo` technical
// namespace and the hidden-by-name rule (docs/annotations, docs/language/concretes). The
// engine walk, the server, both renderers and yed all import THESE predicates, so no two
// consumers can disagree about what counts as the overlay or as a hidden key.
//
// The law:
//   - `.yo` is the reserved technical key — HIDDEN and SPECIAL: its subtree is engine-managed
//     (fragments/lanes/thumbnails as a document key; body.yo/meta.yo/settings.yo/sidecars as
//     the on-disk `.yo/` directory). Concrete-agnostic: a document key and the overlay dir
//     are the same namespace.
//   - ANY key starting with `.` is HIDDEN by default: absent from the TOC, member listings,
//     query results and sitemap, yet fully browsable when navigated directly or by link.
//   - LEGACY spellings are read forever, never written: `yo:` (the pre-dot overlay key),
//     `yamlover-thumbnails:` (pre-`.yo: thumbnails:`) and `yamlover-annotations:` (the retired
//     annotation array — pruned on untag, never grown).
//
// Hidden-BY-NAME is a producer of the node flag `meta.hidden`, never its replacement: the
// `yamlover` self-import graft is hidden by FLAG alone (its key matches nothing here), and
// flag consumers (store toc, projections, queries) must keep reading the flag.

/** The reserved overlay key — hidden AND special (engine-managed subtree). */
export const OVERLAY_KEY = '.yo';
/** The pre-dot spelling of the overlay key — read forever, never written. */
export const LEGACY_OVERLAY_KEY = 'yo';
/** Both overlay spellings, the CANONICAL one first — descent helpers try `.yo`, then fall
 *  back to a legacy `yo`, and REUSE whichever a file already has (a file never grows two). */
export const overlayKeyAlts: readonly string[] = [OVERLAY_KEY, LEGACY_OVERLAY_KEY];

/** `.yo: fragments:` — the annotation fragments mapping (docs/annotations/fragments). */
export const FRAGMENTS_SUBKEY = 'fragments';
/** `.yo: lanes:` — the tag-board structure (the whole board config value). */
export const LANES_SUBKEY = 'lanes';
/** `.yo: thumbnails:` — the derived [w, h] thumbnail registry per image member. */
export const THUMBNAILS_SUBKEY = 'thumbnails';
/** The pre-`.yo:` thumbnails key — read forever, never written. */
export const LEGACY_THUMBNAILS_KEY = 'yamlover-thumbnails';
/** The RETIRED annotation array key — read (and husk-pruned on untag) forever, never grown. */
export const LEGACY_ANNOTATIONS_KEY = 'yamlover-annotations';

/** An OVERLAY key in either spelling — the engine-managed technical subtree's root. */
export const isOverlayKey = (k: unknown): boolean =>
  k === OVERLAY_KEY || k === LEGACY_OVERLAY_KEY;

/** A key that is HIDDEN BY NAME: any dot-prefixed key, plus every legacy technical spelling
 *  (which predates the dot convention but names the same machinery). This is the naming
 *  PRODUCER of `meta.hidden` — flag consumers keep reading the flag, not the name. */
export const isHiddenEntryKey = (k: unknown): boolean =>
  typeof k === 'string' &&
  (k.startsWith('.') || k === LEGACY_OVERLAY_KEY ||
    k === LEGACY_THUMBNAILS_KEY || k === LEGACY_ANNOTATIONS_KEY);

/** Whether a seg path addresses a FRAGMENT node: `…:<host>:.yo:fragments:<slug>` in either
 *  overlay spelling. The slug is the last seg; the host is everything before the overlay key. */
export const isFragmentSegs = (segs: readonly unknown[]): boolean =>
  segs.length >= 3 &&
  isOverlayKey(segs[segs.length - 3]) &&
  segs[segs.length - 2] === FRAGMENTS_SUBKEY;
