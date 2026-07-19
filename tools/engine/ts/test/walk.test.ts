import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { walkDir } from '../src/walk.ts';
import { Store } from '../src/store.ts';
import { resolveDocument } from '../src/resolve.ts';
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
  // the predicate receives OS-native absolute paths (walkDir builds them with path.join)
  s.indexDocument(walkDir(join(examples, '51-object-in-dir'), { ignore: (abs) => abs.endsWith(sep + 'isAdmin') }));
  assert.equal(s.node(':name')?.value, 'Alice');
  assert.equal(s.node(':isAdmin'), null); // filtered out
  s.close();
});

test('meta.yamlover format attaches to body-overlay text entries', () => {
  // a minimal overlay pair (the shape the retired 59-all-formats-object sidecar had, until that
  // sample is re-authored): body.yamlover carries the block scalars, meta.yamlover their formats
  const dir = mkdtempSync(join(tmpdir(), 'yamlover-meta-'));
  try {
    mkdirSync(join(dir, '.yamlover'));
    writeFileSync(
      join(dir, '.yamlover', 'body.yamlover'),
      'markdown: |\n  # Markdown\n  Some *marked* prose.\nplantuml: |\n  @startuml\n  Alice -> Bob\n  @enduml\n',
    );
    writeFileSync(
      join(dir, '.yamlover', 'meta.yamlover'),
      'properties:\n  markdown: { type: string, format: text/markdown }\n  plantuml: { type: string, format: text/x-plantuml }\n',
    );
    const s = new Store(':memory:');
    s.indexDocument(walkDir(dir));
    assert.equal(s.node(':markdown')?.format, 'text/markdown');
    assert.equal(s.node(':plantuml')?.format, 'text/x-plantuml');
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  // a FULLY-OMNI chapter: the title is the root's self-value (no index); `description` is [0],
  // so the positional body starts at [1].
  assert.equal(s.node(ch)?.format, 'x-yamlover-chapter'); // root (tagged)
  assert.equal(s.node(ch)?.value, 'Getting Started with yamlover'); // the self-value title
  assert.equal(s.node(ch + '[1]')?.format, 'text/marklower'); // first chunk — from the chunk branch
  assert.equal(s.node(ch + '[4]')?.format, 'text/marklower'); // "Why one file" — title-only ≡ a chunk
  assert.equal(s.node(ch + '[5]')?.format, 'x-yamlover-chapter'); // titled subchapter (omni) — inherited via items anyOf
  assert.equal(s.node(ch + '[5][1]')?.format, 'text/marklower'); // a chunk inside the subchapter (recursive)
  assert.equal(s.node(ch + '[6]')?.format, 'x-yamlover-chapter'); // untitled subchapter (a container, no self-value)
  s.close();
});

test('`*: file` resolves within its OWN directory chapter, each dir a document boundary (66-pet-keeper-handbook)', () => {
  const s = new Store(':memory:');
  s.indexDocument(walkDir(examples));
  // Each chapter is its own directory (dogs/, cats/, fish/, dogs/puppies/), so each `.yamlover/
  // body.yamlover` is its own document boundary. The Puppies chapter's `*: puppy-paw.png` resolves to
  // the sibling file living in the puppies/ directory — not the root handbook dir.
  const deep = s.entries(':66-pet-keeper-handbook:dogs:puppies').find((c) => c.kind === 'ref');
  assert.equal(deep?.to, ':66-pet-keeper-handbook:dogs:puppies:puppy-paw.png');
  // the Dogs chapter's `*: dog-bone.png` resolves to its own directory's file
  const dog = s.entries(':66-pet-keeper-handbook:dogs').find((c) => c.kind === 'ref');
  assert.equal(dog?.to, ':66-pet-keeper-handbook:dogs:dog-bone.png');
  // a top-level chapter's `*: sample.png` resolves within that chapter too (a positional body ref)
  const top = s.entries(':65-all-formats-chunks').find((c) => c.kind === 'ref');
  assert.equal(top?.to, ':65-all-formats-chunks:sample.png');
  s.close();
});

test('a directory chapter tree: each subchapter is its OWN directory, referenced by a `*` body pointer (66-pet-keeper-handbook)', () => {
  const s = new Store(':memory:');
  s.indexDocument(walkDir(examples));
  const ch = ':66-pet-keeper-handbook';
  // The root dir's members (`.yamlover`, cats, cover-paw.png, dogs, fish, description) sort as
  // keyed entries first — the title is the body root's SELF-VALUE and consumes no index — so the
  // positional body starts at [6]; the three subchapters are `*` refs to the sibling directories
  // (dogs/cats/fish, in source order) at [11..13].
  assert.equal(s.node(ch)?.format, 'x-yamlover-chapter'); // schema carried from body.yamlover root
  assert.equal(s.node(ch)?.value, "The Pet Keeper's Handbook"); // the self-value title
  assert.equal(s.node(ch + '[6]')?.format, 'text/marklower'); // first prose chunk
  assert.equal(s.node(ch + '[10]')?.format, 'text/x-plantuml'); // the mindmap diagram chunk
  // each subchapter is a real directory chapter (its own body.yamlover root tag), reached by a body ref
  assert.equal(s.entries(ch)[11]?.to, ch + ':dogs');
  assert.equal(s.entries(ch)[12]?.to, ch + ':cats');
  assert.equal(s.entries(ch)[13]?.to, ch + ':fish');
  assert.equal(s.node(ch + ':dogs')?.format, 'x-yamlover-chapter');
  assert.equal(s.node(ch + ':cats')?.format, 'x-yamlover-chapter');
  assert.equal(s.node(ch + ':fish')?.format, 'x-yamlover-chapter');
  assert.equal(s.node(ch + ':dogs:puppies')?.format, 'x-yamlover-chapter'); // nested subchapter dir
  s.close();
});

test('schema propagation: `items: {anyOf:[chapter, chunk]}` routes container→chapter, leaf→chunk', () => {
  // The union's structural dispatch, over the FULLY-OMNI chapter shape (title = the self-value):
  // a titled subchapter (omni scalar + body entries) and an untitled one (a mapping) take the
  // chapter branch; a bare scalar — a chunk, which IS a title-only subchapter — takes the chunk
  // branch, and so does an annotated chunk (its overlay keys are not body — ANNOTATIONS.md).
  const root = mkdtempSync(join(tmpdir(), 'yo-anyof-'));
  mkdirSync(join(root, '$defs'), { recursive: true });
  writeFileSync(join(root, '$defs', 'chapter'),
    'type: variant\nvalue:\n  type: string\nitems:\n  anyOf:\n    - *//yamlover/$defs/chapter\n    - *//yamlover/$defs/chunk\n');
  writeFileSync(join(root, '$defs', 'chunk'), 'type: [string, binary]\nformat: text/marklower\n');
  writeFileSync(join(root, 'doc.yamlover'), [
    '!!<*yamlover/$defs/chapter>',
    'T',
    '- a leaf chunk',
    '- Sub',
    '  - deep chunk',
    '- - an untitled subchapter (no self-value, only body)',
    '- an annotated chunk stays a chunk',
    '  yamlover-annotations:',
    '  - a tag application',
    '',
  ].join('\n'));
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  const d = ':doc.yamlover';
  assert.equal(s.node(d)?.format, 'x-yamlover-chapter'); // the root, its self-value the title
  assert.equal(s.node(d)?.value, 'T');
  assert.equal(s.node(d + '[0]')?.format, 'text/marklower'); // leaf → chunk branch
  assert.equal(s.node(d + '[1]')?.format, 'x-yamlover-chapter'); // titled subchapter (omni) → chapter branch
  assert.equal(s.node(d + '[1]')?.value, 'Sub'); // its self-value is its title
  assert.equal(s.node(d + '[1][0]')?.format, 'text/marklower'); // recursion into the subchapter's chunk
  assert.equal(s.node(d + '[2]')?.format, 'x-yamlover-chapter'); // untitled subchapter (mapping) → chapter branch
  assert.equal(s.node(d + '[3]')?.format, 'text/marklower'); // annotated chunk: overlay keys are not body
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test('table cells: leaf→chunk, untagged container→CHAPTER, a TAGGED table cell→table (MARKLOWER.md §Cells)', () => {
  // The cell union is anyOf:[chunk, chapter, table] with chapter the FIRST container branch — the
  // table schema consumes exactly TWO nesting levels (rows, cells), so an untagged container cell
  // switches BACK to a chapter; a nested table enters only by its explicit tag.
  const root = mkdtempSync(join(tmpdir(), 'yo-tablecell-'));
  mkdirSync(join(root, '$defs'), { recursive: true });
  writeFileSync(join(root, '$defs', 'chapter'),
    'type: variant\nproperties:\n  title:\n    type: string\nitems:\n  anyOf:\n    - *//yamlover/$defs/chapter\n    - *//yamlover/$defs/chunk\n');
  writeFileSync(join(root, '$defs', 'chunk'), 'type: [string, binary]\nformat: text/marklower\n');
  writeFileSync(join(root, '$defs', 'table'),
    'type: variant\nproperties:\n  title:\n    type: string\nitems:\n  type: array\n  items:\n    anyOf:\n      - *//yamlover/$defs/chunk\n      - *//yamlover/$defs/chapter\n      - *//yamlover/$defs/table\n');
  writeFileSync(join(root, 'doc.yamlover'), [
    '!!<*yamlover/$defs/table>',
    '- [plain, other]',
    '- - leaf',
    '  - - an untagged container cell is a CHAPTER',
    '- - leaf2',
    '  - !!<*yamlover/$defs/table>',
    '    - [duty]',
    '',
  ].join('\n'));
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  const d = ':doc.yamlover';
  assert.equal(s.node(d)?.format, 'x-yamlover-table');
  assert.equal(s.node(d + '[0][0]')?.format, 'text/marklower'); // leaf cell → chunk branch
  assert.equal(s.node(d + '[1][1]')?.format, 'x-yamlover-chapter'); // untagged container cell → CHAPTER
  assert.equal(s.node(d + '[1][1][0]')?.format, 'text/marklower'); // its prose body item (chapter rules resume)
  assert.equal(s.node(d + '[2][1]')?.format, 'x-yamlover-table'); // a nested table — by its explicit tag
  assert.equal(s.node(d + '[2][1][0][0]')?.format, 'text/marklower'); // the inner table's cell
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test('list schemas: bullets/numbered apply at ANY depth until an explicit tag switches', () => {
  // items: anyOf:[bullets, chunk] — an untagged container item is a nested sublist of the SAME
  // kind (the container branch is the schema itself), a leaf is marklower prose; a tagged item
  // switches schema explicitly (here: a numbered list inside a bullets list).
  const root = mkdtempSync(join(tmpdir(), 'yo-lists-'));
  mkdirSync(join(root, '$defs'), { recursive: true });
  writeFileSync(join(root, '$defs', 'chunk'), 'type: [string, binary]\nformat: text/marklower\n');
  writeFileSync(join(root, '$defs', 'bullets'),
    'type: variant\nitems:\n  anyOf:\n    - *//yamlover/$defs/bullets\n    - *//yamlover/$defs/chunk\n');
  writeFileSync(join(root, '$defs', 'numbered'),
    'type: variant\nitems:\n  anyOf:\n    - *//yamlover/$defs/numbered\n    - *//yamlover/$defs/chunk\n');
  writeFileSync(join(root, 'doc.yamlover'), [
    '!!<*yamlover/$defs/bullets>',
    '- top item',
    '- - nested item',
    '  - - deeper item',
    '- !!<*yamlover/$defs/numbered>',
    '  - step one',
    '',
  ].join('\n'));
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  const d = ':doc.yamlover';
  assert.equal(s.node(d)?.format, 'x-yamlover-bullets');
  assert.equal(s.node(d + '[0]')?.format, 'text/marklower'); // a leaf item → chunk
  assert.equal(s.node(d + '[1]')?.format, 'x-yamlover-bullets'); // untagged container → SAME kind
  assert.equal(s.node(d + '[1][1]')?.format, 'x-yamlover-bullets'); // … at any depth
  assert.equal(s.node(d + '[1][1][0]')?.format, 'text/marklower'); // the deep leaf
  assert.equal(s.node(d + '[2]')?.format, 'x-yamlover-numbered'); // the explicit tag switches
  assert.equal(s.node(d + '[2][0]')?.format, 'text/marklower');
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test('schema propagation: `allOf:[chapter]` (task extends chapter) inherits body + narrows recursion', () => {
  // A task IS-A chapter: it stamps x-yamlover-task, inherits the chapter title/body propagation via
  // allOf, and its OWN `items:{anyOf:[task,chunk]}` wins so a subtask is x-yamlover-task (not chapter).
  const root = mkdtempSync(join(tmpdir(), 'yo-allof-'));
  mkdirSync(join(root, '$defs'), { recursive: true });
  writeFileSync(join(root, '$defs', 'chapter'),
    'type: variant\nproperties:\n  title:\n    type: string\n    format: text/marklower\nitems:\n  anyOf:\n    - *//yamlover/$defs/chapter\n    - *//yamlover/$defs/chunk\n');
  writeFileSync(join(root, '$defs', 'chunk'), 'type: [string, binary]\nformat: text/marklower\n');
  writeFileSync(join(root, '$defs', 'task'),
    'allOf:\n  - *//yamlover/$defs/chapter\ntype: variant\nitems:\n  anyOf:\n    - *//yamlover/$defs/task\n    - *//yamlover/$defs/chunk\n');
  writeFileSync(join(root, 'doc.yamlover'), '!!<*yamlover/$defs/task>\ntitle: T\n- a chunk\n- title: Sub\n  - sub chunk\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  const d = ':doc.yamlover';
  assert.equal(s.node(d)?.format, 'x-yamlover-task'); // the task format from its $defs pointer
  assert.equal(s.node(d + ':title')?.format, 'text/marklower'); // inherited chapter title propagation
  assert.equal(s.node(d + '[1]')?.format, 'text/marklower'); // a chunk (leaf branch)
  assert.equal(s.node(d + '[2]')?.format, 'x-yamlover-task'); // a SUBTASK — task's own items wins over chapter's
  s.close();
  rmSync(root, { recursive: true, force: true });
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
  assert.equal(s.node(':yamlover:$defs:chapter:type')?.value, 'variant'); // the schemas ride along
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

test('detached tree: the BUNDLED yamlover taxonomy resolves *::yamlover:tags:workflow:dev (IMPORTS.md §4)', () => {
  // a board copied away from its project (no ancestor `$defs/`) — the bug behind a board with no
  // lanes. The bundled taxonomy must supply the dev workflow + its states + the board/task schemas.
  const root = mkdtempSync(join(tmpdir(), 'yo-detached-'));
  mkdirSync(join(root, '.yamlover'));
  writeFileSync(join(root, '.yamlover', 'body.yamlover'),
    '!!<*yamlover:$defs:board>\nworkflow: *::yamlover:tags:workflow:dev\n');
  const doc = walkDir(root);
  const s = new Store(':memory:');
  s.indexDocument(doc);
  assert.equal(s.node(':yamlover:tags:workflow:dev')?.format, 'x-yamlover-workflow');
  for (const st of ['backlog', 'ready', 'in-progress', 'done', 'cancelled'])
    assert.equal(s.node(`:yamlover:tags:workflow:dev:${st}`)?.format, 'x-yamlover-tag');
  assert.equal(s.node(':yamlover:$defs:board:format')?.value, 'x-yamlover-board');
  assert.ok(s.node(':yamlover:$defs:task') !== null);
  // and the board's workflow pointer actually resolves to the grafted workflow node
  const edge = resolveDocument(doc).find((e) => e.from === ':workflow');
  assert.equal(edge?.target.kind, 'node');
  assert.equal(edge?.target.kind === 'node' && edge.target.path, ':yamlover:tags:workflow:dev');
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test('world URI: ::: yamlover.inthemoon.net is the bundled self-import; other authorities stay external', () => {
  const root = mkdtempSync(join(tmpdir(), 'yo-world-'));
  mkdirSync(join(root, '.yamlover'));
  writeFileSync(join(root, '.yamlover', 'body.yamlover'),
    'mine: *::: yamlover.inthemoon.net: tags: colors: yellow\nother: *::: acme.example: x\n');
  const edges = resolveDocument(walkDir(root));
  const mine = edges.find((e) => e.from === ':mine');
  assert.equal(mine?.target.kind === 'node' && mine.target.path, ':yamlover:tags:colors:yellow');
  const other = edges.find((e) => e.from === ':other');
  assert.equal(other?.target.kind, 'external'); // transport out of scope — stays external
  assert.equal(other?.target.kind === 'external' && other.target.authority, 'acme.example');
  rmSync(root, { recursive: true, force: true });
});

test('self-import: explicit `yamlover: *::: …` key materializes the taxonomy; a yamlover-key elsewhere is left as override', () => {
  // authoring the implicit import explicitly (IMPORTS.md §4 / Task 4) behaves like leaving it out
  const root = mkdtempSync(join(tmpdir(), 'yo-explicit-'));
  mkdirSync(join(root, '.yamlover'));
  writeFileSync(join(root, '.yamlover', 'body.yamlover'), 'yamlover: *::: yamlover.inthemoon.net\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  assert.equal(s.node(':yamlover:tags:colors:yellow')?.format, 'x-yamlover-tag');
  s.close();
  rmSync(root, { recursive: true, force: true });
  // a `yamlover` key pointing ELSEWHERE is a user override — no graft happens
  const root2 = mkdtempSync(join(tmpdir(), 'yo-override-'));
  mkdirSync(join(root2, '.yamlover'));
  writeFileSync(join(root2, '.yamlover', 'body.yamlover'), 'local:\n  hi: 1\nyamlover: *local\n');
  const s2 = new Store(':memory:');
  s2.indexDocument(walkDir(root2));
  assert.equal(s2.node(':yamlover:tags:colors:yellow'), null);
  s2.close();
  rmSync(root2, { recursive: true, force: true });
});

test('settings.yamlover is indexed as a HIDDEN node (x-yamlover-config); body/meta stay unindexed', () => {
  // the config file is openable/editable at :.yamlover:settings.yamlover by the settings editor,
  // but hidden from the TOC (IMPORTS.md). body/meta remain consumed overlays (not nodes).
  const root = mkdtempSync(join(tmpdir(), 'yo-settingsnode-'));
  mkdirSync(join(root, '.yamlover'));
  writeFileSync(join(root, '.yamlover', 'settings.yamlover'), '!!<*yamlover:$defs:config>\ntags: *:: tags\n');
  writeFileSync(join(root, '.yamlover', 'body.yamlover'), 'extra: 1\n');
  writeFileSync(join(root, 'name'), 'Alice\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  assert.equal(s.node(':.yamlover:settings.yamlover')?.format, 'x-yamlover-config');
  assert.equal(s.node(':.yamlover')?.meta?.hidden, true); // parent overlay node is hidden
  assert.equal(s.node(':.yamlover:body.yamlover'), null); // body stays a consumed overlay
  assert.equal(s.node(':extra')?.value, 1); // …and is applied to the parent
  s.close();
  rmSync(root, { recursive: true, force: true });
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

test('self-import graft: a root that IS a project is DE-MATERIALIZED — `::yamlover:X` resolves to the real `:X`', () => {
  // SEPARATOR.md §2: inside the yamlover project, ::X ≡ ::yamlover:X. When the served root IS the
  // project (its own $defs/ is a direct child), the taxonomy is already at :$defs / :tags — so the
  // self-import is NOT materialized a second time (no duplicate :yamlover: subtree); the `yamlover`
  // authority is absorbed VIRTUALLY by the resolver back to the project root (graft-virtualize).
  const dir = mkdtempSync(join(tmpdir(), 'yamlover-walk-'));
  mkdirSync(join(dir, '$defs'));
  writeFileSync(join(dir, '$defs', 'thing'), 'type: object\n');
  mkdirSync(join(dir, 'tags'));
  writeFileSync(join(dir, 'tags', 'red.yamlover'), 'Red things\n');
  // a material whose pointer uses the self-import (graft-scope) spelling the client emits
  writeFileSync(join(dir, 'data.yamlover'), 'ref: *::yamlover:tags:red.yamlover\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(dir));
  // the real taxonomy is at the root…
  assert.ok(s.node(':$defs:thing'));
  assert.ok(s.node(':tags:red.yamlover'));
  // …and NO duplicate self-import subtree is materialized
  assert.equal(s.node(':yamlover'), null);
  assert.equal(s.node(':yamlover:tags:red.yamlover'), null);
  // the `::yamlover:…` pointer resolves VIRTUALLY to the REAL node (absorbed self-import)
  const inb = s.relationships(':tags:red.yamlover').in.filter((e) => e.kind === 'ref');
  assert.equal(inb.length, 1);
  assert.equal(inb[0].from, ':data.yamlover');
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
