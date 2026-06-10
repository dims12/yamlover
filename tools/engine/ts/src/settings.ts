// Project configuration — `<root>/.yamlover/settings.yamlover` (PLAN.md 1d, META.md §Settings).
//
// Settings are DEFAULTS, never constraints: a graph node (an annotation, say) may live in ANY
// directory and keeps working — that is the point of the graph. Settings only tell the server
// where to CREATE things when the user does not say. The file lives in the served root's
// `.yamlover/` overlay dir, so (like body/meta) it is never part of the instance itself.

import fs from 'node:fs';
import path from 'node:path';
import { toPlain } from '../../../parser/ts/src/ir.ts';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';

export interface Settings {
  /** Where new annotations are created: a project path (from the served root), e.g.
   *  `/annotations`. Reading is location-independent — an annotation is recognized by its
   *  schema (`x-yamlover-annotation`), wherever it sits. (Planned: when nodes become freely
   *  movable, the last location an annotation was moved to becomes the remembered default.) */
  annotations: { location: string };
}

export const DEFAULT_SETTINGS: Settings = { annotations: { location: '/annotations' } };

/** Read `<absRoot>/.yamlover/settings.yamlover`, overlaying DEFAULT_SETTINGS. A missing or
 *  unparsable file (or field) silently yields the defaults — settings must never break serving. */
export function loadSettings(absRoot: string): Settings {
  const file = path.join(absRoot, '.yamlover', 'settings.yamlover');
  if (!fs.existsSync(file)) return DEFAULT_SETTINGS;
  let plain: Record<string, unknown>;
  try {
    plain = toPlain(parseYamlover(fs.readFileSync(file, 'utf8'), file).root) as Record<string, unknown>;
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (!plain || typeof plain !== 'object') return DEFAULT_SETTINGS;
  const ann = (plain.annotations ?? {}) as Record<string, unknown>;
  const location = projectPath(ann?.location, DEFAULT_SETTINGS.annotations.location);
  return { annotations: { location } };
}

/** Normalize a settings value into a safe project path: a non-empty string, forced to one
 *  leading `/`, trailing `/` stripped, and refusing `..` segments (a settings path must stay
 *  inside the served root). Anything else falls back to `dflt`. */
function projectPath(v: unknown, dflt: string): string {
  if (typeof v !== 'string' || v.trim() === '') return dflt;
  const p = '/' + v.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (p === '/' || p.split('/').some((seg) => seg === '..')) return dflt;
  return p;
}
