// Dangling-link / parse checker for a yamlover tree.
// Uses the engine's OWN seams: reindex (store), parseYamlover + scanTextLinks (prose links),
// ownerNodePath (overlay file -> the node it belongs to). Run from anywhere:
//
//   node --experimental-strip-types bkng-dogfooding/linkcheck.mjs <tree>
//
// Exists because nothing in the product reports a prose link that resolves to nothing —
// see 2026-08-11-dangling-prose-links-are-never-reported.md.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, reindex, walkTree } from '../tools/engine/ts/src/index.ts';
import { ownerNodePath } from '../tools/engine/ts/src/walk.ts';
import { parseYamlover } from '../tools/parser/ts/src/yamlover.ts';
import { scanTextLinks } from '../tools/engine/ts/src/resolve.ts';

const root = resolve(process.argv[2] ?? '.');
const s = new Store(':memory:');
reindex(s, root);

// every indexed file, so we can map file-local paths to tree paths
const files = (walkTree(root).files ?? []).filter(f => f.path.endsWith('.yo'));
let nParse = 0, nLink = 0;
const bad = [];

for (const f of files) {
  let doc;
  try { doc = parseYamlover(readFileSync(resolve(root, f.path), 'utf8'), { uri: f.path }); }
  catch (e) { nParse++; bad.push(`PARSE  ${f.path}: ${e.message}`); continue; }

  // the tree path this file's root maps to: its owning node, as a store path
  const rel = ownerNodePath(root, f.path);
  const owner = rel === '' ? ':' : ':' + rel.split('/').join(':');

  for (const l of scanTextLinks(doc)) {
    nLink++;
    if (l.target === null) { bad.push(`NOPATH ${f.path}  ${l.raw}  (no nominal path)`); continue; }
    // project scope (`*::a:b`) is already an absolute tree path; document/current/parent
    // scopes are file-local, so they hang off the file's owning node
    const rooted = l.ptr.base.scope === 'link' || owner === ':';
    const treePath = rooted ? l.target : (l.target === ':' ? owner : owner + l.target);
    if (s.node(treePath) === null) bad.push(`DANGLE ${f.path}  ${l.raw}  ->  ${treePath}`);
  }
}

console.log(`files: ${files.length}  prose links: ${nLink}  parse errors: ${nParse}`);
for (const b of bad) console.log(b);
console.log(bad.length === 0 ? 'OK' : `${bad.length} problem(s)`);
process.exitCode = bad.length === 0 ? 0 : 1;
