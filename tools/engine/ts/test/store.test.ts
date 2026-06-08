import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';
import { Store } from '../src/store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', '..', '..', '..', 'examples');

// An in-memory DB (`:memory:`) keeps tests side-effect-free; the file path is the only
// difference in production (<root>/.yamlover/index.db).
function indexed(src: string): Store {
  const s = new Store(':memory:');
  s.indexDocument(parseYamlover(src));
  return s;
}

test('indexes nodes and containment edges; node() returns attributes', () => {
  const s = indexed('title: Hi\nbody:\n  a: 1\n  b: two\n');
  assert.equal(s.node('/')?.type, 'mapping');
  assert.equal(s.node('/title')?.value, 'Hi');
  assert.equal(s.node('/body')?.type, 'mapping');
  assert.equal(s.node('/body/a')?.value, 1);
  assert.equal(s.node('/body/b')?.value, 'two');
  assert.equal(s.node('/nope'), null);
  s.close();
});

test('toc is the containment subtree, ordered, depth-limited', () => {
  const s = indexed('a: 1\nb:\n  c: 2\n  d: 3\n');
  const top = s.toc('/');
  assert.deepEqual(top.map((n) => n.path), ['/a', '/b']); // source order preserved (pos)
  const b = top.find((n) => n.path === '/b')!;
  assert.deepEqual(b.children.map((n) => n.path), ['/b/c', '/b/d']);
  // depth 1: only the immediate children, no grandchildren
  const shallow = s.toc('/', 1);
  assert.deepEqual(shallow.find((n) => n.path === '/b')!.children, []);
  s.close();
});

test('keyless (positional) entries index under [i] and carry is_array', () => {
  const s = indexed('list:\n  - x\n  - y\n');
  assert.equal(s.node('/list')?.is_array, true);
  assert.equal(s.node('/list[0]')?.value, 'x');
  assert.equal(s.node('/list[1]')?.value, 'y');
  s.close();
});

test('resolved `*` pointers become ref edges; relationships() derives inverses', () => {
  // `feline: *cat` is a labeled ref edge off the OWNER mapping (/) — there is no /feline
  // node (pointers are edges, not owned nodes; ENGINE.md edge(owner, target, label=key)).
  const s = indexed('cat:\n  name: Tom\nfeline: *cat\n');
  assert.equal(s.node('/feline'), null); // no owned node at a pointer entry
  const rel = s.relationships('/');
  assert.ok(rel.out.some((e) => e.kind === 'ref' && e.label === 'feline' && e.to === '/cat'));
  // the inverse: /cat has a derived incoming edge back to the owner /
  const catRel = s.relationships('/cat');
  assert.ok(catRel.in.some((e) => e.kind === 'derived' && e.to === '/'));
  s.close();
});

test('entries() keeps positional pointers in order alongside inline values', () => {
  // an array mixing inline scalars and `*` pointers (like a chapter chunks list)
  const s = indexed('pets:\n  rex: {}\nlist:\n  - a\n  - */pets/rex\n  - c\n');
  const e = s.entries('/list');
  assert.deepEqual(e.map((x) => x.pos), [0, 1, 2]); // order preserved across kinds
  assert.deepEqual(e.map((x) => x.kind), ['contain', 'ref', 'contain']);
  assert.equal(e[1].to, '/pets/rex'); // the pointer resolved to its target
  // children() stays containment-only (TOC spine)
  assert.deepEqual(s.children('/list').map((x) => x.pos), [0, 2]);
  s.close();
});

test('indexes the 06-tour example (mix/omni nodes included)', () => {
  const s = indexed(readFileSync(join(examples, '06-tour.yamlover'), 'utf8'));
  // omni node: a scalar self-value AND fields
  assert.equal(s.node('/rating')?.type, 'scalar');
  assert.equal(s.node('/rating')?.value, 5);
  assert.equal(s.node('/rating[0]')?.value, 'solid'); // positional field
  assert.equal(s.node('/rating/scale')?.value, 10); // keyed field
  // mix node: keyless entries store under [i]; the keyed `title` stores under its string
  // key (position 2 is the resolver-derived ALIAS of /playlist/title — positions aren't
  // double-stored, IR.md). Both forms of access are exercised here.
  assert.equal(s.node('/playlist[0]')?.value, 'Intro'); // keyless → positional path
  assert.equal(s.node('/playlist/title')?.value, 'Greatest Hits'); // keyed → string-key path
  s.close();
});
