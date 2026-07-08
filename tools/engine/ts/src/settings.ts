// Project configuration — `<root>/.yamlover/settings.yamlover` (PLAN.md 1d, META.md §Settings).
//
// Settings are DEFAULTS, never constraints: a graph node (an annotation, say) may live in ANY
// directory and keeps working — that is the point of the graph. Settings only tell the server
// where to CREATE things when the user does not say. The file lives in the served root's
// `.yamlover/` overlay dir, so (like body/meta) it is never part of the instance itself.
//
// A location is authored as a PROJECT-SCOPE `*`-pointer naming the object at the project root
// (`annotations: *:: annotations` — "create annotations in `:annotations`"). The scope ladder
// (SEPARATOR.md §2): `*x` = parent/current scope, `*:x` = document root, `*::x` = project root.
// A bare `*x` would be parent-relative (self-referential here), so locations use `*::`. A plain
// string (`annotations: /annotations`) is accepted too. The settings file speaks the same pointer
// language as any yamlover document, resolved against the served root.

import fs from 'node:fs';
import path from 'node:path';
import { isPointer } from '../../../parser/ts/src/ir.ts';
import type { Node, Pointer, Value } from '../../../parser/ts/src/ir.ts';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';

export interface Settings {
  /** This project's identity (IMPORTS.md §1) — the authority of its world URI, e.g.
   *  `yamlover.inthemoon.net`, authored as `uri: ::: yamlover.inthemoon.net`. Undefined when the
   *  project declares no URI (then it cannot be imported by others). Identity, not transport. */
  uri?: string;
  /** The paths this project EXPORTS to importers (IMPORTS.md §2): a list of pointer/query texts
   *  (QUERY.md), e.g. `*:: $defs`, `*:: tags`. Empty when nothing is exported. Advisory metadata —
   *  the engine bundles the yamlover taxonomy regardless; this documents the contract. */
  exports: string[];
  /** Where new annotations are created — a project path (`:annotations`), authored as the
   *  project-scope pointer `annotations: *:: annotations`. Reading is location-independent — an
   *  annotation is recognized by its schema (`x-yamlover-annotation`), wherever it sits. */
  annotations: string;
  /** Where new tags are created (the picker's create-on-miss target) — a project path, authored
   *  `tags: *:: tags`. As with annotations, reading is location-independent — a tag is recognized
   *  by its schema (`x-yamlover-tag`), wherever it sits. */
  tags: string;
  /** Where DERIVED sidecar blobs (thumbnail + fragment-crop images) are written, under a hidden
   *  `.yamlover/` overlay dir. An ENUM, not a path: `'per-directory'` → the source file's own
   *  directory `.yamlover/` (a self-contained doc; document-scope pointer `*:.yamlover:…`);
   *  `'project'` → the served root's `.yamlover/` (`*::.yamlover:…`). Reading is location-
   *  independent — a sidecar resolves by its pointer wherever it sits. */
  sidecars: SidecarLocation;
}

export type SidecarLocation = 'per-directory' | 'project';

export const DEFAULT_SETTINGS: Settings = {
  uri: undefined,
  exports: [],
  annotations: ':annotations',
  tags: ':tags',
  sidecars: 'per-directory',
};

/** The source written for a fresh `settings.yamlover` (see `ensureSettingsFile`). Authors the
 *  DEFAULT_SETTINGS values explicitly and tags the file with `!!<*yamlover:$defs:config>` so it
 *  indexes as an `x-yamlover-config` node — the gear button's settings editor can then open it.
 *  It carries only the universal location defaults; `uri`/`exports` are project-specific and left
 *  out (the yamlover project authors its own, by hand). */
export const DEFAULT_SETTINGS_SOURCE = `# .yamlover/settings.yamlover — project settings for this root (created with defaults).
# Settings are DEFAULTS, never constraints: they only say where the server CREATES things when you
# do not; reading is location-independent (a node is recognized by its schema, wherever it sits).
# Locations are PROJECT-SCOPE pointers: \`*::x\` = project root, \`*:x\` = document root, \`*x\` =
# parent/current scope (SEPARATOR.md §2). A missing field falls back to these same values. Edit me
# here or via the gear button's settings editor.
!!<*yamlover:$defs:config>

annotations: *:: annotations   # create new annotations in :annotations
tags: *:: tags                 # create new tags in :tags
sidecars: per-directory        # where derived thumbnail/crop blobs go (enum, not a path)
`;

/** Create `<absRoot>/.yamlover/settings.yamlover` with DEFAULT_SETTINGS_SOURCE when it is absent,
 *  so the config node always exists — navigable at `:.yamlover:settings.yamlover` and openable by
 *  the settings editor (otherwise opening the gear on a fresh project 404s the node). A no-op when
 *  the file already exists, so hand edits are never clobbered. Returns the file path. */
export function ensureSettingsFile(absRoot: string): string {
  const file = path.join(absRoot, '.yamlover', 'settings.yamlover');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, DEFAULT_SETTINGS_SOURCE);
  }
  return file;
}

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
    uri: uriSetting(valueAt(root, 'uri')),
    exports: exportsSetting(valueAt(root, 'exports')),
    annotations: locationSetting(valueAt(root, 'annotations'), DEFAULT_SETTINGS.annotations),
    tags: locationSetting(valueAt(root, 'tags'), DEFAULT_SETTINGS.tags),
    sidecars: sidecarLocation(valueAt(root, 'sidecars'), DEFAULT_SETTINGS.sidecars),
  };
}

/** Normalize a project `uri` to its authority (IMPORTS.md §1). Accepts a `:::`-scope pointer
 *  (`*::: host`) — take its authority — or a plain string (`::: host`, `host`) — strip leading
 *  colons/space. Anything empty/odd → undefined (no declared identity). */
function uriSetting(v: Value | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (isPointer(v)) return v.base.scope === 'link' ? v.base.authority : undefined;
  if (v.kind === 'scalar' && typeof v.value === 'string') {
    const a = v.value.replace(/^[:\s]+/, '').trim();
    return a === '' ? undefined : a;
  }
  return undefined;
}

/** The exported path texts (IMPORTS.md §2): each sequence item is a pointer (its authored text,
 *  re-prefixed with `*`) or a plain string. Non-list / empty → []. */
function exportsSetting(v: Value | undefined): string[] {
  if (v === undefined || isPointer(v) || !v.entries) return [];
  const out: string[] = [];
  for (const e of v.entries) {
    if (isPointer(e.value)) out.push('*' + e.value.raw);
    else if (e.value.kind === 'scalar' && typeof e.value.value === 'string' && e.value.value.trim() !== '') out.push(e.value.value.trim());
  }
  return out;
}

/** Set ONE top-level key in `<absRoot>/.yamlover/settings.yamlover` to `valueText`, preserving every
 *  OTHER line (comments, fields, ordering). Replaces an existing top-level `<key>:` line in place, else
 *  appends. Used to persist the last-used annotation tag (the picker default) without rewriting — and
 *  so clobbering — the hand-authored config. Returns the file path. */
export function writeSettingKey(absRoot: string, key: string, valueText: string): string {
  const file = path.join(absRoot, '.yamlover', 'settings.yamlover');
  const src = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const line = `${key}: ${valueText}`;
  const re = new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':.*$', 'm');
  let out = re.test(src) ? src.replace(re, line) : (src === '' || src.endsWith('\n') ? src : src + '\n') + line;
  if (!out.endsWith('\n')) out += '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out);
  return file;
}

/** Normalize a settings `sidecars.location` enum: `'per-directory'` (or the `'document'` alias)
 *  vs `'project'`; anything else falls back to `dflt`. */
function sidecarLocation(v: Value | undefined, dflt: SidecarLocation): SidecarLocation {
  const s = v !== undefined && !isPointer(v) && v.kind === 'scalar' && typeof v.value === 'string' ? v.value.trim() : '';
  if (s === 'per-directory' || s === 'document') return 'per-directory';
  if (s === 'project') return 'project';
  return dflt;
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

/** Normalize a settings `location` into a safe project path. Accepts a `*`-pointer (the canonical
 *  form `*:: name` — project-scope) or a plain string; anything unsafe — `..` segments, parent
 *  steps — falls back to `dflt`. `dflt` may be `undefined` (e.g. the optional last-used tag). */
function locationSetting<D extends string | undefined>(v: Value | undefined, dflt: D): string | D {
  if (v === undefined) return dflt;
  if (isPointer(v)) return pointerPath(v) ?? dflt;
  if (v.kind === 'scalar' && typeof v.value === 'string') return stringPath(v.value, dflt);
  return dflt;
}

/** A pointer's project path. The canonical authored form is PROJECT scope `*:: name` (`scope:
 *  'link'`, authority + key steps) → `:name:…`; document/current scope is also accepted leniently
 *  (a settings pointer resolves against the served root, where document ≡ project root). World
 *  (`*:::`) maps its authority + steps the same way. Parent steps / non-key steps → null. */
function pointerPath(p: Pointer): string | null {
  const segs: string[] = [];
  if (p.base.scope === 'link') segs.push(p.base.authority); // `::`/`:::` — authority is the first portion
  else if (p.base.scope !== 'current' && p.base.scope !== 'document') return null; // parent → not a place inside the root
  for (const s of p.steps) {
    if (s.sel !== 'key') return null;
    segs.push(s.name);
  }
  if (segs.length === 0 || segs.some((seg) => seg === '..' || seg === '')) return null;
  return ':' + segs.join(':');
}

/** Normalize a plain-string location to a COLON project path (legacy `/`-spellings are
 *  accepted), refusing `..` segments (a settings path must stay inside the served root). */
function stringPath<D extends string | undefined>(v: string, dflt: D): string | D {
  if (v.trim() === '') return dflt;
  const segs = v.trim().split(/[/:]/).filter((seg) => seg !== '');
  if (segs.length === 0 || segs.some((seg) => seg === '..')) return dflt;
  return ':' + segs.join(':');
}
