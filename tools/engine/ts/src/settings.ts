// Project configuration — `<root>/.yamlover/settings.yamlover` (PLAN.md 1d, META.md §Settings).
//
// Settings are DEFAULTS, never constraints: a graph node (an annotation, say) may live in ANY
// directory and keeps working — that is the point of the graph. Settings only tell the server
// where to CREATE things when the user does not say. The file lives in the served root's
// `.yamlover/` overlay dir, so (like body/meta) it is never part of the instance itself.
//
// A `location` is authored as a `*`-pointer into the served tree (`location: *tags`) — the
// settings file speaks the same pointer language as any yamlover document, resolved against
// the served root. A plain string (`location: /annotations`) is accepted too.

import fs from 'node:fs';
import path from 'node:path';
import { isPointer } from '../../../parser/ts/src/ir.ts';
import type { Node, Pointer, Value } from '../../../parser/ts/src/ir.ts';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';

export interface Settings {
  /** Where new annotations are created: a project path (from the served root), e.g.
   *  `/annotations`. Reading is location-independent — an annotation is recognized by its
   *  schema (`x-yamlover-annotation`), wherever it sits. (Planned: when nodes become freely
   *  movable, the last location an annotation was moved to becomes the remembered default.) */
  annotations: { location: string };
  /** Where new tags are created (the picker's create-on-miss target): a project path from the
   *  served root. As with annotations, reading is location-independent — a tag is recognized
   *  by its schema (`x-yamlover-tag`), wherever it sits. */
  tags: { location: string };
}

export const DEFAULT_SETTINGS: Settings = {
  annotations: { location: '/annotations' },
  tags: { location: '/tags' },
};

/** Read `<absRoot>/.yamlover/settings.yamlover`, overlaying DEFAULT_SETTINGS. A missing or
 *  unparsable file (or field) silently yields the defaults — settings must never break serving. */
export function loadSettings(absRoot: string): Settings {
  const file = path.join(absRoot, '.yamlover', 'settings.yamlover');
  if (!fs.existsSync(file)) return DEFAULT_SETTINGS;
  let root: Node;
  try {
    root = parseYamlover(fs.readFileSync(file, 'utf8'), file).root;
  } catch {
    return DEFAULT_SETTINGS;
  }
  return {
    annotations: { location: locationSetting(valueAt(root, 'annotations', 'location'), DEFAULT_SETTINGS.annotations.location) },
    tags: { location: locationSetting(valueAt(root, 'tags', 'location'), DEFAULT_SETTINGS.tags.location) },
  };
}

/** The value under a chain of string keys, walked over the raw IR (NOT toPlain — a `*`-pointer
 *  value must come through as the Pointer it is, and one odd field must not sink the others). */
function valueAt(node: Node, ...keys: string[]): Value | undefined {
  let v: Value | undefined = node;
  for (const key of keys) {
    if (v === undefined || isPointer(v)) return undefined;
    v = v.entries?.find((e) => e.key === key)?.value;
  }
  return v;
}

/** Normalize a settings `location` into a safe project path. Accepts a `*`-pointer (the
 *  authored form — root-relative key steps only) or a plain string; anything unsafe — `..`
 *  segments, link (`//…`) pointers, the bare root — falls back to `dflt`. */
function locationSetting(v: Value | undefined, dflt: string): string {
  if (v === undefined) return dflt;
  if (isPointer(v)) return pointerPath(v) ?? dflt;
  if (v.kind === 'scalar' && typeof v.value === 'string') return stringPath(v.value, dflt);
  return dflt;
}

/** A pointer's project path: `*tags/sub` (current scope, also `/tags/sub` after the `*` for
 *  document scope) → `/tags/sub`. A settings pointer is resolved against the served root, so
 *  both scopes mean the same thing; parent steps and link scopes cannot name a place inside
 *  the root → null. */
function pointerPath(p: Pointer): string | null {
  if (p.base.scope !== 'current' && p.base.scope !== 'document') return null;
  if (p.steps.length === 0 || !p.steps.every((s) => s.sel === 'key')) return null;
  const segs = p.steps.map((s) => (s as { sel: 'key'; name: string }).name);
  if (segs.some((seg) => seg === '..' || seg === '')) return null;
  return '/' + segs.join('/');
}

/** Normalize a plain-string location: forced to one leading `/`, trailing `/` stripped, and
 *  refusing `..` segments (a settings path must stay inside the served root). */
function stringPath(v: string, dflt: string): string {
  if (v.trim() === '') return dflt;
  const p = '/' + v.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (p === '/' || p.split('/').some((seg) => seg === '..')) return dflt;
  return p;
}
