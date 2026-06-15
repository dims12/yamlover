import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { walkDir } from '../src/walk.ts';
import { Store } from '../src/store.ts';
import { parseYamlover } from '../../../parser/ts/src/yamlover.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', '..', '..', '..', 'examples');

function indexedDir(name: string): Store {
  const s = new Store(':memory:');
  s.indexDocument(walkDir(join(examples, name)));
  return s;
}

test('plain directory: each file is an entry keyed by filename (51-object-in-dir)', () => {
  const s = indexedDir('51-object-in-dir');
  assert.equal(s.node(':name')?.value, 'Alice'); // "Alice" parsed
  assert.equal(s.node(':age')?.value, 30); // 30 parsed as a number
  assert.equal(s.node(':isAdmin')?.value, true);
  s.close();
});

test('overlay-only directory: body.yamlover supplies the content (50-object-in-overlay)', () => {
  const s = indexedDir('50-object-in-overlay');
  assert.equal(s.node(':name')?.value, 'Alice');
  assert.equal(s.node(':age')?.value, 30);
  assert.equal(s.node(':isAdmin')?.value, true);
  s.close();
});

test('single-file directory parses its scalar (53-plain-dir)', () => {
  const s = indexedDir('53-plain-dir');
  assert.equal(s.node(':age')?.value, 30);
  s.close();
});

test('pointer-array body imposes order; the directory projects as an array (56-array-of-files)', () => {
  const s = indexedDir('56-array-of-files');
  // body order is anyfile01, alsoany02, andany03.json — TOC reflects it
  const top = s.toc(':');
  assert.deepEqual(
    top.map((n) => n.label),
    ['anyfile01', 'alsoany02', 'andany03.json'],
  );
  assert.equal(s.node(':')?.is_array, true);
  assert.equal(s.node(':anyfile01')?.value, 'Alice');
  assert.equal(s.node(':andany03.json')?.value, true);
  s.close();
});

test('an .ini file is an opaque text/plain blob (the plaintext renderer claims it)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yamlover-walk-'));
  writeFileSync(join(dir, 'config.ini'), '[core]\nname = Alice\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(dir));
  assert.equal(s.node(':config.ini')?.type, 'blob');
  assert.equal(s.node(':config.ini')?.format, 'text/plain');
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the ignore predicate skips matching children (e.g. node_modules at the root)', () => {
  const s = new Store(':memory:');
  // ignore anything named "isAdmin" — it should not appear as a node
  s.indexDocument(walkDir(join(examples, '51-object-in-dir'), { ignore: (abs) => abs.endsWith('/isAdmin') }));
  assert.equal(s.node(':name')?.value, 'Alice');
  assert.equal(s.node(':isAdmin'), null); // filtered out
  s.close();
});

test('meta.yamlover format attaches to body-overlay text entries (59-all-formats-object)', () => {
  const s = indexedDir('59-all-formats-object');
  // these live in body.yamlover (block scalars); their formats are in meta.yamlover
  assert.equal(s.node(':markdown')?.format, 'text/markdown');
  assert.equal(s.node(':asciidoc')?.format, 'text/asciidoc');
  assert.equal(s.node(':plantuml')?.format, 'text/x-plantuml');
  assert.equal(s.node(':csv')?.format, 'text/csv');
  s.close();
});

test('a file is parsed by extension: .json/.json5p via json5p, else yamlover', () => {
  // a directory holding multi-line JSON — the YAML parser would choke; json5p handles it
  const s = new Store(':memory:');
  // examples/ root has 01-tour.json (multi-line) and 03-tour.json5p
  s.indexDocument(walkDir(join(examples)));
  assert.equal(s.node(':01-tour.json')?.type, 'mapping'); // parsed as structure, not a text scalar
  assert.equal(s.node(':03-tour.json5p')?.type, 'mapping');
  assert.ok(s.hasChildren(':01-tour.json'));
  s.close();
});

test('a chapter file gets format x-yamlover-chapter from its $defs pointer schema (60)', () => {
  const s = new Store(':memory:');
  s.indexDocument(parseYamlover(readFileSync(join(examples, '60-simple-chapter.yamlover'), 'utf8')));
  assert.equal(s.node(':')?.format, 'x-yamlover-chapter');
  s.close();
});

test('the attached chapter schema propagates down: subchapters & chunks get their format (60)', () => {
  // via walkDir, which runs the schema-application pass (yamlover/$defs found by walking up from examples/)
  const s = new Store(':memory:');
  s.indexDocument(walkDir(examples));
  const ch = ':60-simple-chapter.yamlover';
  assert.equal(s.node(ch)?.format, 'x-yamlover-chapter'); // root (tagged)
  assert.equal(s.node(ch + ':children[0]')?.format, 'x-yamlover-chapter'); // subchapter — NOT tagged, inherited
  assert.equal(s.node(ch + ':chunks[0]')?.format, 'text/marklower'); // chunk — from $defs/chunk
  assert.equal(s.node(ch + ':children[0]:chunks[0]')?.format, 'text/marklower'); // recursive
  s.close();
});

test('`*/file` resolves to the nearest DOCUMENT root, depth-independently (66 nested chunks)', () => {
  const s = new Store(':memory:');
  s.indexDocument(walkDir(examples));
  // a deeply nested subchapter chunk `*/puppy-paw.png` resolves to the 66 chapter root's file,
  // NOT the served (examples) root — the directory-with-body is a document boundary.
  const deep = s.entries(':66-doc-tree:children[0]:children[0]:chunks').find((c) => c.kind === 'ref');
  assert.equal(deep?.to, ':66-doc-tree:puppy-paw.png');
  // a top-level chapter's `*/sample.png` resolves within that chapter too
  const top = s.entries(':65-all-formats-chunks:chunks').find((c) => c.kind === 'ref');
  assert.equal(top?.to, ':65-all-formats-chunks:sample.png');
  s.close();
});

test('a directory chapter: the body.yamlover root schema tag attaches to the dir (66-doc-tree)', () => {
  const s = new Store(':memory:');
  s.indexDocument(walkDir(examples));
  const ch = ':66-doc-tree';
  assert.equal(s.node(ch)?.format, 'x-yamlover-chapter'); // schema carried from body.yamlover root
  assert.equal(s.node(ch + ':children[0]')?.format, 'x-yamlover-chapter'); // subchapter (Dogs)
  assert.equal(s.node(ch + ':children[0]:children[0]')?.format, 'x-yamlover-chapter'); // Puppies (depth 2)
  assert.equal(s.node(ch + ':chunks[0]')?.format, 'text/marklower'); // prose chunk
  s.close();
});

test('67-pdf-tags (instance): omni-blobs (file + embedded annotations) + a tag taxonomy', () => {
  const s = new Store(':memory:');
  s.indexDocument(walkDir(examples));
  const R = ':67-pdf-tags';
  // the tag taxonomy gets x-yamlover-tag propagated down the open-keyed tree
  assert.equal(s.node(R + ':tags')?.format, 'x-yamlover-tag');
  assert.equal(s.node(R + ':tags:field:mathematics:number-theory')?.format, 'x-yamlover-tag');
  // a paper is the real file (a blob) AUGMENTED with an owned `yamlover-annotations` array — an
  // omni-blob (binary value + a field), the EMBEDDED tagging model (ANNOTATIONS.md).
  const euler = R + ':S0002-9904-1966-11654-3.pdf';
  assert.equal(s.node(euler)?.type, 'blob');
  assert.equal(s.node(euler)?.format, 'application/pdf');
  assert.ok(s.entries(euler).some((e) => e.kind === 'contain' && e.label === 'yamlover-annotations'));
  // a tag application is a FORWARD ref from the paper's array straight to the leaf tag (no slug
  // label) — the reverse direction of the old `&`-anchor membership.
  const anns = euler + ':yamlover-annotations';
  const tags = s.entries(anns).filter((e) => e.kind === 'ref').map((e) => e.to);
  assert.ok(tags.includes(R + ':tags:field:mathematics:number-theory'));
  assert.ok(tags.includes(R + ':tags:genre:brevity:shortest-paper'));
  // the tag sees the paper's array as an incoming ref (the derived reverse → "materials under a tag")
  const nt = R + ':tags:field:mathematics:number-theory';
  assert.ok(s.relationships(nt).in.some((e) => e.kind === 'ref' && e.from === anns));
  s.close();
});

test('binary files become blobs with format + content hash (65-all-formats-chunks)', () => {
  const s = indexedDir('65-all-formats-chunks');
  const png = s.node(':sample.png');
  assert.equal(png?.type, 'blob');
  assert.equal(png?.format, 'image/png');
  assert.ok(png?.content_hash?.startsWith('xxh64:'));
  assert.ok((png?.size ?? 0) > 0);
  s.close();
});

test('a sub-document encoding format (yamlover/meta) parses the file — never an opaque blob', () => {
  // The repo's own `$defs/` is the real-world case (TODO bug "rendered as binary despite
  // meta"): extensionless schema files typed `{type: string, format: yamlover/meta}` must
  // come out as parsed structure, not bytes.
  const root = mkdtempSync(join(tmpdir(), 'yo-docfmt-'));
  mkdirSync(join(root, '.yamlover'));
  writeFileSync(join(root, '.yamlover', 'meta.yamlover'), 'properties:\n  tag:\n    type: string\n    format: yamlover/meta\n');
  writeFileSync(join(root, 'tag'), 'type: object\nformat: x-yamlover-tag\nproperties:\n  description:\n    type: string\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  const tag = s.node(':tag');
  assert.notEqual(tag?.type, 'blob'); // the bug rendered this as binary
  assert.equal(s.node(':tag:type')?.value, 'object'); // parsed structure is reachable
  assert.equal(s.node(':tag:properties:description:type')?.value, 'string');
  s.close();
  rmSync(root, { recursive: true, force: true });
});

// The BUILT-IN graft: serving a subdir of a `yamlover/$defs` host (the repo) grafts the host's
// `yamlover/` subtree into the walked root, so `*yamlover/$defs/…` (the hosted schemas) and
// `*//yamlover/tags/colors/…` (the pure color tags every annotation may apply) resolve from
// any served root.
test('built-in yamlover/ subtree is grafted when serving below a yamlover/$defs host', () => {
  const s = indexedDir('59-all-formats-object'); // a subdir of the repo (the yamlover/$defs host)
  assert.equal(s.node(':yamlover:tags:colors')?.format, 'x-yamlover-tag');
  assert.equal(s.node(':yamlover:tags:colors:yellow')?.format, 'x-yamlover-tag');
  assert.equal(s.node(':yamlover:tags:colors:yellow:color')?.value, '#f9e2af');
  assert.equal(s.node(':yamlover:$defs:chapter:type')?.value, 'object'); // the schemas ride along
  s.close();
});

test('built-in graft outside a yamlover/$defs host (palette always available); none into an array-projecting root', () => {
  // a temp tree has no `yamlover/$defs/` ancestor → the BUILT-IN yamlover/ (the color palette +
  // the tag schema) is grafted, so the pure color tags resolve and annotations validate anywhere
  const root = mkdtempSync(join(tmpdir(), 'yo-builtin-'));
  writeFileSync(join(root, 'name'), 'Alice\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  assert.equal(s.node(':yamlover:tags:colors:yellow')?.format, 'x-yamlover-tag');
  assert.equal(s.node(':yamlover:tags:colors:yellow:color')?.value, '#f9e2af');
  s.close();
  rmSync(root, { recursive: true, force: true });
  // an all-keyless root under the repo stays a pure array — a keyed graft would flip it to mix
  const arr = indexedDir('56-array-of-files');
  assert.equal(arr.node(':')?.is_array, true);
  assert.equal(arr.node(':yamlover'), null);
  arr.close();
});

test('~- membership in a body overlay: stored as a keyless back edge; !!set / uniqueItems mark sets', () => {
  const root = mkdtempSync(join(tmpdir(), 'yo-backseq-'));
  mkdirSync(join(root, '.yamlover'));
  writeFileSync(join(root, '.yamlover', 'body.yamlover'),
    'items:\n- plain\nmember:\n  name: m\n  ~- */items\nfixed: !!set\n- */member\n');
  writeFileSync(join(root, '.yamlover', 'meta.yamlover'), 'properties:\n  items:\n    uniqueItems: true\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  // the membership is a keyless back edge from the member to the container
  const back = s.relationships(':items').in.find((e) => e.kind === 'back');
  assert.ok(back && back.from === ':member' && back.label === null);
  // the member's own kind is untouched by its reverse declaration
  assert.equal(s.node(':member')?.type, 'mapping');
  assert.equal(s.node(':member')?.is_array, false);
  // !!set tag and meta uniqueItems both land as NodeMeta.set
  assert.equal(s.node(':fixed')?.meta?.set, true);
  assert.equal(s.node(':items')?.meta?.set, true);
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test('self-import graft: a root that IS a project (has $defs) still gains the yamlover key', () => {
  // SEPARATOR.md §2: inside the yamlover project, //X ≡ //yamlover/X — the engine grafts
  // the self-import key into EVERY served root, including the host project itself.
  const dir = mkdtempSync(join(tmpdir(), 'yamlover-walk-'));
  mkdirSync(join(dir, '$defs'));
  writeFileSync(join(dir, '$defs', 'thing'), 'type: object\n');
  mkdirSync(join(dir, 'tags'));
  writeFileSync(join(dir, 'tags', 'red.yamlover'), 'Red things\n');
  writeFileSync(join(dir, 'data.yamlover'), 'x: 1\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(dir));
  // the physical keys…
  assert.ok(s.node(':$defs'));
  assert.ok(s.node(':tags'));
  // …AND the grafted self-import alias, both subtrees reachable under it
  assert.ok(s.node(':yamlover:$defs:thing'));
  assert.ok(s.node(':yamlover:tags:red.yamlover'));
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('.yamlover is indexed as a HIDDEN subtree: sidecars resolve, the overlay/db are skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'yo-hidden-'));
  const dir = join(root, 'pics');
  mkdirSync(join(dir, '.yamlover', 'thumbnails'), { recursive: true });
  writeFileSync(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  writeFileSync(join(dir, '.yamlover', 'thumbnails', 't.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0, 1, 2, 3]));
  writeFileSync(join(dir, '.yamlover', 'index.db'), 'PRETEND DB'); // must NEVER be indexed (the db would index itself)
  writeFileSync(join(dir, '.yamlover', 'body.yamlover'), `"pic.png":\n  yamlover-thumbnails:\n    [256, 256]: *:.yamlover:thumbnails:t.jpg\n`);
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  // the `.yamlover` node exists, is flagged hidden, and is a real child of :pics (resolvable)
  assert.equal(s.node(':pics:.yamlover')?.meta?.hidden, true);
  assert.ok(s.children(':pics').map((c) => c.label).includes('.yamlover'));
  // its derived sidecar is indexed + addressable; the engine's own files are NOT
  assert.equal(s.node(':pics:.yamlover:thumbnails:t.jpg')?.type, 'blob');
  assert.equal(s.node(':pics:.yamlover:index.db'), null);
  assert.equal(s.node(':pics:.yamlover:body.yamlover'), null);
  // the DOCUMENT-relative pointer `*:.yamlover:thumbnails:t.jpg` resolved (nothing dangling)
  assert.deepEqual(s.dangling(), []);
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test('a .yamlover holding only the overlay + index db adds NO node (plain dirs keep their shape)', () => {
  const root = mkdtempSync(join(tmpdir(), 'yo-hidden2-'));
  mkdirSync(join(root, '.yamlover'), { recursive: true });
  writeFileSync(join(root, 'a'), 'Alice\n');
  writeFileSync(join(root, '.yamlover', 'body.yamlover'), 'a: !!<format: text/plain>\n');
  writeFileSync(join(root, '.yamlover', 'index.db'), 'DB');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  assert.equal(s.node(':.yamlover'), null); // nothing indexable under .yamlover → no hidden node
  s.close();
  rmSync(root, { recursive: true, force: true });
});
