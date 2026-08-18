import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { walkDir, ownerNodePath } from '../src/walk.ts';
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

test('plain directory: each file is an entry keyed by filename (50-dir)', () => {
  const s = indexedDir('50-dir');
  assert.equal(s.node(':name')?.value, 'Alice'); // "Alice" parsed
  assert.equal(s.node(':age')?.value, 30); // 30 parsed as a number
  assert.equal(s.node(':isAdmin')?.value, true);
  s.close();
});

test('overlay-only directory: body.yo supplies the content (51-dir-yo)', () => {
  const s = indexedDir('51-dir-yo');
  assert.equal(s.node(':name')?.value, 'Alice');
  assert.equal(s.node(':age')?.value, 30);
  assert.equal(s.node(':isAdmin')?.value, true);
  s.close();
});

test('single-file directory parses its scalar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yo-walk-single-'));
  writeFileSync(join(dir, 'age'), '30');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(dir));
  assert.equal(s.node(':age')?.value, 30);
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('pointer-array body grants positions to the members it names; the rest stay keyed-only (56-array-of-files)', () => {
  const s = indexedDir('56-array-of-files');
  // body order is anyfile01, alsoany02, andany03.json — the POSITIONAL PREFIX; andany04.json
  // is on disk but unreferenced, so it trails as a keyed-only member (never granted a position)
  const top = s.toc(':');
  assert.deepEqual(
    top.map((n) => n.label),
    ['anyfile01', 'alsoany02', 'andany03.json', 'andany04.json'],
  );
  const root = s.node(':');
  assert.equal(root?.is_array, false); // entries carry keys — the node is a mix, not an array
  // the members the body ORDERED by pointer, so their keys are storage provenance (a derived `&`
  // anchor) rather than authored keys — per-key, not a prefix count, since a body that mixes keyed
  // fields with its flow scatters them through source order
  assert.deepEqual((root?.meta as { anchored?: string[] } | null)?.anchored, ['anyfile01', 'alsoany02', 'andany03.json']);
  assert.equal(s.node(':anyfile01')?.value, 'Alice');
  assert.equal(s.node(':andany03.json')?.value, true);
  assert.equal(s.node(':andany04.json')?.value, 'string');
  s.close();
});

test('pointer-array body: inline elements and dangling pointers keep their positions; unlisted children trail keyed-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yamlover-posprefix-'));
  try {
    mkdirSync(join(dir, '.yo'));
    writeFileSync(join(dir, '.yo', 'body.yo'), '- *b\n- 42\n- *missing\n');
    writeFileSync(join(dir, 'a'), 'alpha\n');
    writeFileSync(join(dir, 'b'), 'beta\n');
    const s = new Store(':memory:');
    s.indexDocument(walkDir(dir));
    const root = s.node(':');
    assert.equal(root?.is_array, false);
    // only the pointer that MATCHED a child is an anchor; the inline 42 and the dangling *missing
    // are ordinary keyless elements, which need no marker to read as ordinal
    assert.deepEqual((root?.meta as { anchored?: string[] } | null)?.anchored, ['b']);
    // prefix: b (consumed pointer, keeps its key), the inline 42, the dangling *missing;
    // remainder: .yo (the hidden overlay node — body.yo is inspectable), then a (unlisted,
    // keyed-only). The hidden built-in graft is plumbing — not content.
    const entries = s.entries(':').filter((e) => e.label !== 'yamlover');
    assert.deepEqual(entries.map((e) => e.label), ['b', null, '.yo', 'a']); // dangling has no edge row
    assert.equal(s.node(':b')?.value, 'beta');
    assert.equal(s.node(':a')?.value, 'alpha');
    assert.equal(s.unrealizedRefs(':').length, 1); // `*missing` reported, never dropped
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pointer-array body: the DEAD slash spelling `- */file` does not consume a member', () => {
  // The migration window is closed (docs/language/pointers/paths): `*/b` is a pointer to the literal key
  // "/b" — it matches nothing, so it dangles at its position and `b` trails keyed-only.
  // The colon spelling `- *b` (or `- *: b`) is the one that consumes.
  const dir = mkdtempSync(join(tmpdir(), 'yamlover-deadslash-'));
  try {
    mkdirSync(join(dir, '.yo'));
    writeFileSync(join(dir, '.yo', 'body.yo'), '- */b\n');
    writeFileSync(join(dir, 'b'), 'beta\n');
    const s = new Store(':memory:');
    s.indexDocument(walkDir(dir));
    const entries = s.entries(':').filter((e) => e.label !== 'yamlover');
    assert.deepEqual(entries.map((e) => e.label), ['.yo', 'b']); // keyed-only remainder; the dangling ref has no edge row
    assert.equal(s.unrealizedRefs(':').length, 1); // `*/b` reported as dangling, never resolved
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test('a TEXT-format file over 1 MiB stays a blob — named, served, but not held inline', () => {
  // A TEXT format keeps the WHOLE FILE as one string scalar, so its ceiling is not the doc-parse
  // ceiling: at MAX_DOC_BYTES (64 MiB) a multi-MB source file's body lands in the node value, and
  // from there in every stub that mentions it (a 2.5 MB .jsonl put its entire body in a directory
  // listing). Above 1 MiB it is a blob — the FORMAT is still named (so the plaintext view still
  // claims it and /api/blob still serves the bytes); only the inline copy is refused.
  const dir = mkdtempSync(join(tmpdir(), 'yo-walk-bigtext-'));
  try {
    const line = JSON.stringify({ k: 'x'.repeat(80) }) + '\n';
    writeFileSync(join(dir, 'small.jsonl'), line.repeat(10));
    writeFileSync(join(dir, 'big.jsonl'), line.repeat(Math.ceil((1 << 20) / line.length) + 1));
    const s = new Store(':memory:');
    s.indexDocument(walkDir(dir));
    const small = s.node(':small.jsonl');
    assert.equal(small?.type, 'scalar'); // under the ceiling: the body is the value
    assert.equal(small?.format, 'application/x-ndjson');
    const big = s.node(':big.jsonl');
    assert.equal(big?.type, 'blob');
    assert.equal(big?.format, 'application/x-ndjson'); // NOT demoted to octet-stream
    assert.ok((big?.size ?? 0) > (1 << 20));
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the ignore predicate skips matching children (e.g. node_modules at the root)', () => {
  const s = new Store(':memory:');
  // ignore anything named "isAdmin" — it should not appear as a node
  // the predicate receives OS-native absolute paths (walkDir builds them with path.join)
  s.indexDocument(walkDir(join(examples, '50-dir'), { ignore: (abs) => abs.endsWith(sep + 'isAdmin') }));
  assert.equal(s.node(':name')?.value, 'Alice');
  assert.equal(s.node(':isAdmin'), null); // filtered out
  s.close();
});

test('meta.yo format attaches to body-overlay text entries', () => {
  // a minimal overlay pair (the shape the retired 59-all-formats-object sidecar had, until that
  // sample is re-authored): body.yo carries the block scalars, meta.yo their formats.
  // Deliberately the LEGACY `properties:` spelling — a read-forever pin (the authored corpus
  // states `members:` since the concrete/format split; members.test.ts pins the new reader)
  const dir = mkdtempSync(join(tmpdir(), 'yamlover-meta-'));
  try {
    mkdirSync(join(dir, '.yo'));
    writeFileSync(
      join(dir, '.yo', 'body.yo'),
      'markdown: |\n  # Markdown\n  Some *marked* prose.\nplantuml: |\n  @startuml\n  Alice -> Bob\n  @enduml\n',
    );
    writeFileSync(
      join(dir, '.yo', 'meta.yo'),
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

test('an UNTITLED directory chapter (pure seq body → ARRAY root) still derives child formats', () => {
  // An array root skips the `yamlover` graft (a keyed entry would flip its all-keyless projection
  // to mix) — but its attached `!!<…$defs:chapter>` must still RESOLVE via the bundled defs, or a
  // title-less chapter written in a plain folder derives nothing: no chunk formats, no subchapter
  // format, and the TOC sees no subchapters (the reported regression).
  const dir = mkdtempSync(join(tmpdir(), 'yamlover-untitled-chapter-'));
  try {
    mkdirSync(join(dir, '.yo'));
    writeFileSync(
      join(dir, '.yo', 'body.yo'),
      '!!<*::yamlover:$defs:chapter>\n- intro prose\n- Subpart\n  - sub chunk\n',
    );
    const s = new Store(':memory:');
    s.indexDocument(walkDir(dir));
    assert.equal(s.node(':')?.format, 'x-yamlover-chapter'); // the root tag
    const kids = s.toc(':', 1).filter((n) => n.label !== '.yo');
    assert.deepEqual(kids.map((n) => n.format ?? null), ['text/marklower', 'x-yamlover-chapter']); // chunk, then the subchapter
    const subKids = s.toc(kids[1].path, 1);
    assert.deepEqual(subKids.map((n) => n.format ?? null), ['text/marklower']); // recursion reaches the subchapter's own chunk
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
  s.indexDocument(parseYamlover(readFileSync(join(examples, '60-simple-chapter.yo'), 'utf8')));
  assert.equal(s.node(':')?.format, 'x-yamlover-chapter');
  s.close();
});

test('the attached chapter schema propagates down: subchapters & chunks get their format (60)', () => {
  // via walkDir, which runs the schema-application pass (yamlover/$defs found by walking up from examples/)
  const s = new Store(':memory:');
  s.indexDocument(walkDir(examples));
  const ch = ':60-simple-chapter.yo';
  // a FULLY-OMNI chapter: the title is the root's self-value (no index); `description` is [0],
  // so the positional body starts at [1].
  assert.equal(s.node(ch)?.format, 'x-yamlover-chapter'); // root (tagged)
  assert.equal(s.node(ch)?.value, 'Getting Started with yamlover'); // the self-value title
  assert.equal(s.node(ch + ':1')?.format, 'text/marklower'); // first chunk — from the chunk branch
  assert.equal(s.node(ch + ':4')?.format, 'text/marklower'); // "Why one file" — title-only ≡ a chunk
  assert.equal(s.node(ch + ':5')?.format, 'x-yamlover-chapter'); // titled subchapter (omni) — inherited via items anyOf
  assert.equal(s.node(ch + ':5:1')?.format, 'text/marklower'); // a chunk inside the subchapter (recursive)
  assert.equal(s.node(ch + ':6')?.format, 'x-yamlover-chapter'); // untitled subchapter (a container, no self-value)
  s.close();
});

test('`*: file` resolves within its OWN directory chapter, each dir a document boundary (66-pet-keeper-handbook)', () => {
  const s = new Store(':memory:');
  s.indexDocument(walkDir(examples));
  // Each chapter is its own directory (dogs/, cats/, fish/, dogs/puppies/), so each `.yo/
  // body.yo` is its own document boundary. The Puppies chapter's `*: puppy-paw.png` resolves to
  // the sibling file living in the puppies/ directory — not the root handbook dir.
  // A body pointer naming a child of its OWN directory is CONSUMED (applyBody): the member rides
  // the position the body gave it and its key becomes storage provenance (`meta.anchored`), so the
  // edge that remains is CONTAINMENT, not a ref — the member appears once, never beside its own
  // pointer. That it matched a child of THIS directory is exactly the document boundary.
  const consumed = (p: string, name: string): void => {
    assert.ok(((s.node(p)?.meta as { anchored?: string[] } | null)?.anchored ?? []).includes(name), `${p} should anchor ${name}`);
    const e = s.entries(p).find((c) => c.label === name);
    assert.equal(e?.kind, 'contain');
    assert.equal(e?.to, `${p}:${name}`);
  };
  consumed(':66-pet-keeper-handbook:dogs:puppies', 'puppy-paw.png');
  consumed(':66-pet-keeper-handbook:dogs', 'dog-bone.png'); // the Dogs chapter's own file
  consumed(':65-all-formats-chunks', 'sample.png'); // a top-level chapter resolves within itself too
  s.close();
});

test('a directory chapter tree: each subchapter is its OWN directory, referenced by a `*` body pointer (66-pet-keeper-handbook)', () => {
  const s = new Store(':memory:');
  s.indexDocument(walkDir(examples));
  const ch = ':66-pet-keeper-handbook';
  // THE BODY IMPOSES ORDER (applyBody): its own entries in SOURCE order — `description:`, the prose
  // chunks, and the members its `*` pointers CONSUMED, each riding the position its pointer held —
  // then the children the body never named (here only the hidden `.yo`), in filesystem order.
  // The title is the body root's SELF-VALUE and consumes no index.
  assert.equal(s.node(ch)?.format, 'x-yamlover-chapter'); // schema carried from body.yo root
  assert.equal(s.node(ch)?.value, "The Pet Keeper's Handbook"); // the self-value title
  assert.equal(s.node(ch + ':1')?.format, 'text/marklower'); // first prose chunk
  assert.equal(s.node(ch + ':5')?.format, 'text/x-plantuml'); // the mindmap diagram chunk
  // each subchapter is a real directory chapter (its own body.yo root tag), sitting at the
  // position its body pointer granted it — once, as a member, not beside a surviving ref
  assert.deepEqual(s.entries(ch).slice(6, 9).map((e) => e.to), [ch + ':dogs', ch + ':cats', ch + ':fish']);
  assert.deepEqual((s.node(ch)?.meta as { anchored?: string[] } | null)?.anchored, ['cover-paw.png', 'dogs', 'cats', 'fish']);
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
  // branch, and so does an annotated chunk (its overlay keys are not body — docs/annotations).
  const root = mkdtempSync(join(tmpdir(), 'yo-anyof-'));
  mkdirSync(join(root, '$defs'), { recursive: true });
  writeFileSync(join(root, '$defs', 'chapter'),
    'type: variant\nvalue:\n  type: string\nitems:\n  anyOf:\n    - *:: yamlover: $defs: chapter\n    - *:: yamlover: $defs: chunk\n');
  writeFileSync(join(root, '$defs', 'chunk'), 'type: [string, binary]\nformat: text/marklower\n');
  writeFileSync(join(root, 'doc.yo'), [
    '!!<*yamlover: $defs: chapter>',
    'T',
    '- a leaf chunk',
    '- Sub',
    '  - deep chunk',
    '- - an untitled subchapter (no self-value, only body)',
    '- an annotated chunk stays a chunk',
    '  yo:',
    '    fragments:',
    '      s1: chunk',
    '- !!yo',
    '  species: cat',
    '  - keyless',
    '',
  ].join('\n'));
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  const d = ':doc.yo';
  assert.equal(s.node(d)?.format, 'x-yamlover-chapter'); // the root, its self-value the title
  assert.equal(s.node(d)?.value, 'T');
  assert.equal(s.node(d + ':0')?.format, 'text/marklower'); // leaf → chunk branch
  assert.equal(s.node(d + ':1')?.format, 'x-yamlover-chapter'); // titled subchapter (omni) → chapter branch
  assert.equal(s.node(d + ':1')?.value, 'Sub'); // its self-value is its title
  assert.equal(s.node(d + ':1:0')?.format, 'text/marklower'); // recursion into the subchapter's chunk
  assert.equal(s.node(d + ':2')?.format, 'x-yamlover-chapter'); // untitled subchapter (mapping) → chapter branch
  assert.equal(s.node(d + ':3')?.format, 'text/marklower'); // annotated chunk: overlay keys are not body
  // a `!!yo` DATA ISLAND is exempt from the enclosing schema: no branch routing, no format —
  // it never becomes an x-yamlover-chapter (and so never appears in the chapter TOC)
  assert.equal(s.node(d + ':4')?.format, null);
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test('alias acceptance: schemas authored `type: omni` / `type: kseq` derive formats like variant/mixed', () => {
  // The ruled short spellings (docs/meta/facets: omni was variant, kseq was mixed) must drive
  // the same $defs naming and recursion as the long aliases they replace.
  const root = mkdtempSync(join(tmpdir(), 'yo-alias-'));
  mkdirSync(join(root, '$defs'), { recursive: true });
  writeFileSync(join(root, '$defs', 'chapter'),
    'type: omni\nvalue:\n  type: string\nitems:\n  anyOf:\n    - *:: yamlover: $defs: chapter\n    - *:: yamlover: $defs: chunk\n');
  writeFileSync(join(root, '$defs', 'chunk'), 'type: [string, binary]\nformat: text/marklower\n');
  writeFileSync(join(root, '$defs', 'kthing'), 'type: kseq\n');
  writeFileSync(join(root, 'doc.yo'), [
    '!!<*yamlover: $defs: chapter>',
    'T',
    '- a leaf chunk',
    '- Sub',
    '  - deep chunk',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'k.yo'), [
    '!!<*yamlover: $defs: kthing>',
    'head',
    '- keyless',
    '',
  ].join('\n'));
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  assert.equal(s.node(':doc.yo')?.format, 'x-yamlover-chapter'); // omni names the def like variant did
  assert.equal(s.node(':doc.yo:0')?.format, 'text/marklower'); // leaf → chunk branch
  assert.equal(s.node(':doc.yo:1')?.format, 'x-yamlover-chapter'); // titled subchapter → chapter branch
  assert.equal(s.node(':doc.yo:1:0')?.format, 'text/marklower'); // recursion continues through omni
  assert.equal(s.node(':k.yo')?.format, 'x-yamlover-kthing'); // kseq names the def like mixed did
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test('table cells: leaf→chunk, untagged container→CHAPTER, a TAGGED table cell→table (docs/documents/marklower/tables/cells)', () => {
  // The cell union is anyOf:[chunk, chapter, table] with chapter the FIRST container branch — the
  // table schema consumes exactly TWO nesting levels (rows, cells), so an untagged container cell
  // switches BACK to a chapter; a nested table enters only by its explicit tag.
  const root = mkdtempSync(join(tmpdir(), 'yo-tablecell-'));
  mkdirSync(join(root, '$defs'), { recursive: true });
  writeFileSync(join(root, '$defs', 'chapter'),
    'type: variant\nproperties:\n  title:\n    type: string\nitems:\n  anyOf:\n    - *:: yamlover: $defs: chapter\n    - *:: yamlover: $defs: chunk\n');
  writeFileSync(join(root, '$defs', 'chunk'), 'type: [string, binary]\nformat: text/marklower\n');
  writeFileSync(join(root, '$defs', 'table'),
    'type: variant\nproperties:\n  title:\n    type: string\nitems:\n  type: array\n  items:\n    anyOf:\n      - *:: yamlover: $defs: chunk\n      - *:: yamlover: $defs: chapter\n      - *:: yamlover: $defs: table\n');
  writeFileSync(join(root, 'doc.yo'), [
    '!!<*yamlover: $defs: table>',
    '- [plain, other]',
    '- - leaf',
    '  - - an untagged container cell is a CHAPTER',
    '- - leaf2',
    '  - !!<*yamlover: $defs: table>',
    '    - [duty]',
    '',
  ].join('\n'));
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  const d = ':doc.yo';
  assert.equal(s.node(d)?.format, 'x-yamlover-table');
  assert.equal(s.node(d + ':0:0')?.format, 'text/marklower'); // leaf cell → chunk branch
  assert.equal(s.node(d + ':1:1')?.format, 'x-yamlover-chapter'); // untagged container cell → CHAPTER
  assert.equal(s.node(d + ':1:1:0')?.format, 'text/marklower'); // its prose body item (chapter rules resume)
  assert.equal(s.node(d + ':2:1')?.format, 'x-yamlover-table'); // a nested table — by its explicit tag
  assert.equal(s.node(d + ':2:1:0:0')?.format, 'text/marklower'); // the inner table's cell
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
    'type: variant\nitems:\n  anyOf:\n    - *:: yamlover: $defs: bullets\n    - *:: yamlover: $defs: chunk\n');
  writeFileSync(join(root, '$defs', 'numbered'),
    'type: variant\nitems:\n  anyOf:\n    - *:: yamlover: $defs: numbered\n    - *:: yamlover: $defs: chunk\n');
  writeFileSync(join(root, 'doc.yo'), [
    '!!<*yamlover: $defs: bullets>',
    '- top item',
    '- - nested item',
    '  - - deeper item',
    '- !!<*yamlover: $defs: numbered>',
    '  - step one',
    '',
  ].join('\n'));
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  const d = ':doc.yo';
  assert.equal(s.node(d)?.format, 'x-yamlover-bullets');
  assert.equal(s.node(d + ':0')?.format, 'text/marklower'); // a leaf item → chunk
  assert.equal(s.node(d + ':1')?.format, 'x-yamlover-bullets'); // untagged container → SAME kind
  assert.equal(s.node(d + ':1:1')?.format, 'x-yamlover-bullets'); // … at any depth
  assert.equal(s.node(d + ':1:1:0')?.format, 'text/marklower'); // the deep leaf
  assert.equal(s.node(d + ':2')?.format, 'x-yamlover-numbered'); // the explicit tag switches
  assert.equal(s.node(d + ':2:0')?.format, 'text/marklower');
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test('schema propagation: `allOf:[chapter]` (task extends chapter) inherits body + narrows recursion', () => {
  // A task IS-A chapter: it stamps x-yamlover-task, inherits the chapter title/body propagation via
  // allOf, and its OWN `items:{anyOf:[task,chunk]}` wins so a subtask is x-yamlover-task (not chapter).
  const root = mkdtempSync(join(tmpdir(), 'yo-allof-'));
  mkdirSync(join(root, '$defs'), { recursive: true });
  writeFileSync(join(root, '$defs', 'chapter'),
    'type: variant\nproperties:\n  title:\n    type: string\n    format: text/marklower\nitems:\n  anyOf:\n    - *:: yamlover: $defs: chapter\n    - *:: yamlover: $defs: chunk\n');
  writeFileSync(join(root, '$defs', 'chunk'), 'type: [string, binary]\nformat: text/marklower\n');
  writeFileSync(join(root, '$defs', 'task'),
    'allOf:\n  - *:: yamlover: $defs: chapter\ntype: variant\nitems:\n  anyOf:\n    - *:: yamlover: $defs: task\n    - *:: yamlover: $defs: chunk\n');
  writeFileSync(join(root, 'doc.yo'), '!!<*yamlover: $defs: task>\ntitle: T\n- a chunk\n- title: Sub\n  - sub chunk\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  const d = ':doc.yo';
  assert.equal(s.node(d)?.format, 'x-yamlover-task'); // the task format from its $defs pointer
  assert.equal(s.node(d + ':title')?.format, 'text/marklower'); // inherited chapter title propagation
  assert.equal(s.node(d + ':1')?.format, 'text/marklower'); // a chunk (leaf branch)
  assert.equal(s.node(d + ':2')?.format, 'x-yamlover-task'); // a SUBTASK — task's own items wins over chapter's
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test('67-pdf-tags (instance): filed blobs (membership bookmarks) + an ontology', () => {
  const s = new Store(':memory:');
  s.indexDocument(walkDir(examples));
  const R = ':67-pdf-tags';
  // the tag taxonomy gets x-yamlover-onto propagated down the open-keyed tree
  assert.equal(s.node(R + ':ontos')?.format, 'x-yamlover-onto');
  assert.equal(s.node(R + ':ontos:field:mathematics:number-theory')?.format, 'x-yamlover-onto');
  // a paper is the real file (a blob) FILED by `&…:-` membership bookmarks — back edges into
  // the ontos, never owned entries (docs/annotations/applications).
  const euler = R + ':S0002-9904-1966-11654-3.pdf';
  assert.equal(s.node(euler)?.type, 'blob');
  assert.equal(s.node(euler)?.format, 'application/pdf');
  const filed = s.relationships(euler).out.filter((e) => e.kind === 'back').map((e) => e.to);
  assert.ok(filed.includes(R + ':ontos:field:mathematics:number-theory'));
  assert.ok(filed.includes(R + ':ontos:genre:brevity:shortest-paper'));
  // the onto sees the paper as an incoming back edge (its member — "materials under an onto")
  const nt = R + ':ontos:field:mathematics:number-theory';
  assert.ok(s.relationships(nt).in.some((e) => e.kind === 'back' && e.from === euler));
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
  mkdirSync(join(root, '.yo'));
  writeFileSync(join(root, '.yo', 'meta.yo'), 'properties:\n  tag:\n    type: string\n    format: yamlover/meta\n');
  writeFileSync(join(root, 'tag'), 'type: object\nformat: x-yamlover-onto\nproperties:\n  description:\n    type: string\n');
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
// `yamlover/` subtree into the walked root, so `*yamlover: $defs: …` (the hosted schemas) and
// `*:: yamlover: ontos: colors…` (the pure color tags every annotation may apply) resolve from
// any served root.
test('built-in yamlover/ subtree is grafted when serving below a yamlover/$defs host', () => {
  const s = indexedDir('59-all-formats-object'); // a subdir of the repo (the yamlover/$defs host)
  assert.equal(s.node(':yamlover:ontos:colors')?.format, 'x-yamlover-onto');
  assert.equal(s.node(':yamlover:ontos:colors:yellow')?.format, 'x-yamlover-onto');
  assert.equal(s.node(':yamlover:ontos:colors:yellow:color')?.value, '#f9e2af');
  assert.equal(s.node(':yamlover:$defs:chapter:type')?.value, 'variant'); // the schemas ride along
  s.close();
});

test('built-in graft outside a yamlover/$defs host (palette always available); UNIFORM into every root shape', () => {
  // a temp tree has no `yamlover/$defs/` ancestor → the BUILT-IN yamlover/ (the color palette +
  // the tag schema) is grafted, so the pure color tags resolve and annotations validate anywhere
  const root = mkdtempSync(join(tmpdir(), 'yo-builtin-'));
  writeFileSync(join(root, 'name'), 'Alice\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  assert.equal(s.node(':yamlover:ontos:colors:yellow')?.format, 'x-yamlover-onto');
  assert.equal(s.node(':yamlover:ontos:colors:yellow:color')?.value, '#f9e2af');
  s.close();
  rmSync(root, { recursive: true, force: true });
  // THE UNIFORM GRAFT (walk.ts): an all-keyless root gets the graft like every other shape —
  // yamlover tolerates mixtures, so the hidden keyed entry neither flips the authored seq's array
  // projection nor shows in its TOC. (A skip here once broke schema derivation for every untitled
  // directory chapter — shape special-cases are how projections silently diverge.) A FULLY
  // referenced pointer-array root shows it: the graft alone never demotes `is_array`.
  const seq = mkdtempSync(join(tmpdir(), 'yo-fullseq-'));
  mkdirSync(join(seq, '.yo'));
  writeFileSync(join(seq, '.yo', 'body.yo'), '- *a\n- *b\n');
  writeFileSync(join(seq, 'a'), '1\n');
  writeFileSync(join(seq, 'b'), '2\n');
  const full = new Store(':memory:');
  full.indexDocument(walkDir(seq));
  assert.equal(full.node(':')?.is_array, true); // fully referenced — still a seq despite the graft
  assert.deepEqual((full.node(':')?.meta as { anchored?: string[] } | null)?.anchored, ['a', 'b']);
  full.close();
  rmSync(seq, { recursive: true, force: true });
  // ex-56 has an authored keyed-only remainder (andany04.json) — an honest MIX, graft or not
  const arr = indexedDir('56-array-of-files');
  assert.equal(arr.node(':')?.is_array, false);
  assert.equal(arr.node(':yamlover')?.meta?.hidden, true); // grafted, hidden plumbing
  assert.equal(arr.node(':yamlover:ontos:colors:yellow:color')?.value, '#f9e2af'); // …and it resolves
  assert.ok(!arr.toc(':', 1).some((n) => n.label === 'yamlover')); // …and stays off the TOC
  arr.close();
});

test('detached tree: the BUNDLED yamlover taxonomy resolves *::yamlover:ontos:workflow:dev (IMPORTS.md §4)', () => {
  // a board copied away from its project (no ancestor `$defs/`) — the bug behind a board with no
  // lanes. The bundled taxonomy must supply the dev workflow + its states + the board/task schemas.
  const root = mkdtempSync(join(tmpdir(), 'yo-detached-'));
  mkdirSync(join(root, '.yo'));
  writeFileSync(join(root, '.yo', 'body.yo'),
    '!!<*yamlover:$defs:board>\nworkflow: *::yamlover:ontos:workflow:dev\n');
  const doc = walkDir(root);
  const s = new Store(':memory:');
  s.indexDocument(doc);
  assert.equal(s.node(':yamlover:ontos:workflow:dev')?.format, 'x-yamlover-workflow');
  for (const st of ['backlog', 'ready', 'in-progress', 'done', 'cancelled'])
    assert.equal(s.node(`:yamlover:ontos:workflow:dev:${st}`)?.format, 'x-yamlover-onto');
  assert.equal(s.node(':yamlover:$defs:board:format')?.value, 'x-yamlover-board');
  assert.ok(s.node(':yamlover:$defs:task') !== null);
  // and the board's workflow pointer actually resolves to the grafted workflow node
  const edge = resolveDocument(doc).find((e) => e.from === ':workflow');
  assert.equal(edge?.target.kind, 'node');
  assert.equal(edge?.target.kind === 'node' && edge.target.path, ':yamlover:ontos:workflow:dev');
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test('world URI: ::: yamlover.inthemoon.net is the bundled self-import; other authorities stay external', () => {
  const root = mkdtempSync(join(tmpdir(), 'yo-world-'));
  mkdirSync(join(root, '.yo'));
  writeFileSync(join(root, '.yo', 'body.yo'),
    'mine: *::: yamlover.inthemoon.net: ontos: colors: yellow\nother: *::: acme.example: x\n');
  const edges = resolveDocument(walkDir(root));
  const mine = edges.find((e) => e.from === ':mine');
  assert.equal(mine?.target.kind === 'node' && mine.target.path, ':yamlover:ontos:colors:yellow');
  const other = edges.find((e) => e.from === ':other');
  assert.equal(other?.target.kind, 'external'); // transport out of scope — stays external
  assert.equal(other?.target.kind === 'external' && other.target.authority, 'acme.example');
  rmSync(root, { recursive: true, force: true });
});

test('self-import: explicit `yamlover: *::: …` key materializes the taxonomy; a yamlover-key elsewhere is left as override', () => {
  // authoring the implicit import explicitly (IMPORTS.md §4 / Task 4) behaves like leaving it out
  const root = mkdtempSync(join(tmpdir(), 'yo-explicit-'));
  mkdirSync(join(root, '.yo'));
  writeFileSync(join(root, '.yo', 'body.yo'), 'yamlover: *::: yamlover.inthemoon.net\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  assert.equal(s.node(':yamlover:ontos:colors:yellow')?.format, 'x-yamlover-onto');
  s.close();
  rmSync(root, { recursive: true, force: true });
  // a `yamlover` key pointing ELSEWHERE is a user override — no graft happens
  const root2 = mkdtempSync(join(tmpdir(), 'yo-override-'));
  mkdirSync(join(root2, '.yo'));
  writeFileSync(join(root2, '.yo', 'body.yo'), 'local:\n  hi: 1\nyamlover: *local\n');
  const s2 = new Store(':memory:');
  s2.indexDocument(walkDir(root2));
  assert.equal(s2.node(':yamlover:ontos:colors:yellow'), null);
  s2.close();
  rmSync(root2, { recursive: true, force: true });
});

test('settings.yo is indexed as a HIDDEN node (x-yamlover-config); body.yo doubles as a DUMB raw node', () => {
  // the config file is openable/editable at :.yo:settings.yo by the settings editor,
  // but hidden from the TOC (IMPORTS.md). body/meta remain consumed overlays AND are
  // additionally inspectable as raw-text nodes (hidden, not secret — read-only).
  const root = mkdtempSync(join(tmpdir(), 'yo-settingsnode-'));
  mkdirSync(join(root, '.yo'));
  writeFileSync(join(root, '.yo', 'settings.yo'), '!!<*yamlover:$defs:config>\ntags: *:: ontos\n');
  writeFileSync(join(root, '.yo', 'body.yo'), 'extra: 1\n');
  writeFileSync(join(root, 'name'), 'Alice\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  assert.equal(s.node(':.yo:settings.yo')?.format, 'x-yamlover-config');
  assert.equal(s.node(':.yo')?.meta?.hidden, true); // parent overlay node is hidden
  assert.equal(s.node(':.yo:body.yo')?.value, 'extra: 1\n'); // the raw source, NEVER a second parse
  assert.equal(s.node(':.yo:body.yo:extra'), null); // …no children — dumb by construction
  assert.equal(s.node(':extra')?.value, 1); // …and the overlay is still applied to the parent
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test('~- membership in a body overlay: stored as a keyless back edge; !!set / uniqueItems mark sets', () => {
  const root = mkdtempSync(join(tmpdir(), 'yo-backseq-'));
  mkdirSync(join(root, '.yo'));
  writeFileSync(join(root, '.yo', 'body.yo'),
    'items:\n- plain\nmember:\n  name: m\n  ~- *: items\nfixed: !!set\n- *: member\n');
  writeFileSync(join(root, '.yo', 'meta.yo'), 'properties:\n  items:\n    uniqueItems: true\n');
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
  // docs/language/pointers/scopes: inside the yamlover project, ::X ≡ ::yamlover:X. When the served root IS the
  // project (its own $defs/ is a direct child), the taxonomy is already at :$defs / :tags — so the
  // self-import is NOT materialized a second time (no duplicate :yamlover: subtree); the `yamlover`
  // authority is absorbed VIRTUALLY by the resolver back to the project root (graft-virtualize).
  const dir = mkdtempSync(join(tmpdir(), 'yamlover-walk-'));
  mkdirSync(join(dir, '$defs'));
  writeFileSync(join(dir, '$defs', 'thing'), 'type: object\n');
  mkdirSync(join(dir, 'ontos'));
  writeFileSync(join(dir, 'ontos', 'red.yo'), 'Red things\n');
  // a material whose pointer uses the self-import (graft-scope) spelling the client emits
  writeFileSync(join(dir, 'data.yo'), 'ref: *::yamlover:ontos:red.yo\n');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(dir));
  // the real taxonomy is at the root…
  assert.ok(s.node(':$defs:thing'));
  assert.ok(s.node(':ontos:red.yo'));
  // …and NO duplicate self-import subtree is materialized
  assert.equal(s.node(':yamlover'), null);
  assert.equal(s.node(':yamlover:ontos:red.yo'), null);
  // the `::yamlover:…` pointer resolves VIRTUALLY to the REAL node (absorbed self-import)
  const inb = s.relationships(':ontos:red.yo').in.filter((e) => e.kind === 'ref');
  assert.equal(inb.length, 1);
  assert.equal(inb[0].from, ':data.yo');
  s.close();
  rmSync(dir, { recursive: true, force: true });
});

test('.yo is indexed as a HIDDEN subtree: sidecars resolve, overlays read raw, the db is skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'yo-hidden-'));
  const dir = join(root, 'pics');
  mkdirSync(join(dir, '.yo', 'thumbnails'), { recursive: true });
  writeFileSync(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  writeFileSync(join(dir, '.yo', 'thumbnails', 't.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0, 1, 2, 3]));
  writeFileSync(join(dir, '.yo', 'index.db'), 'PRETEND DB'); // must NEVER be indexed (the db would index itself)
  writeFileSync(join(dir, '.yo', 'body.yo'), `"pic.png":\n  yamlover-thumbnails:\n    [256, 256]: *:.yo:thumbnails:t.jpg\n`);
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  // the `.yo` node exists, is flagged hidden, and is a real child of :pics (resolvable)
  assert.equal(s.node(':pics:.yo')?.meta?.hidden, true);
  assert.ok(s.children(':pics').map((c) => c.label).includes('.yo'));
  // its derived sidecar is indexed + addressable; the overlay is a DUMB raw-text node
  // (inspectable, never a second parse); the index db is NOT indexed (it would index itself)
  assert.equal(s.node(':pics:.yo:thumbnails:t.jpg')?.type, 'blob');
  assert.equal(s.node(':pics:.yo:index.db'), null);
  assert.equal(typeof s.node(':pics:.yo:body.yo')?.value, 'string');
  assert.equal(s.node(':pics:.yo:body.yo:pic.png'), null); // dumb — no children
  // the DOCUMENT-relative pointer `*:.yo:thumbnails:t.jpg` resolved (nothing dangling)
  assert.deepEqual(s.dangling(), []);
  s.close();
  rmSync(root, { recursive: true, force: true });
});

test('hidden by name: dot-keys and legacy technical keys are stamped hidden, TOC-pruned, yet resolvable', () => {
  const root = mkdtempSync(join(tmpdir(), 'yo-dotkeys-'));
  const s = new Store(':memory:');
  try {
    writeFileSync(
      join(root, 'page.yo'),
      'title: Page\n.secret: hush\nvisible: here\nyo:\n  fragments:\n    frag1: note\nyamlover-thumbnails:\n  "a.png": [2, 2]\n',
    );
    s.indexDocument(walkDir(root));
    // the naming rule stamps the flag; ordinary keys stay unflagged
    assert.equal(s.node(':page.yo:.secret')?.meta?.hidden, true);
    assert.equal(s.node(':page.yo:yo')?.meta?.hidden, true);
    assert.equal(s.node(':page.yo:yamlover-thumbnails')?.meta?.hidden, true);
    assert.equal(s.node(':page.yo:visible')?.meta?.hidden, undefined);
    // the TOC prunes hidden subtrees whole…
    const labels = s.toc(':page.yo').map((n) => n.label);
    assert.ok(labels.includes('visible'));
    for (const gone of ['.secret', 'yo', 'yamlover-thumbnails', 'fragments']) assert.ok(!labels.includes(gone), gone);
    // …yet every hidden node resolves when addressed directly (hidden, not secret)
    assert.equal(s.node(':page.yo:.secret')?.value, 'hush');
    assert.equal(s.node(':page.yo:yo:fragments:frag1')?.value, 'note');
  } finally {
    s.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a .yo holding an overlay carries its raw node; an index-db-only .yo adds NO node', () => {
  const root = mkdtempSync(join(tmpdir(), 'yo-hidden2-'));
  mkdirSync(join(root, '.yo'), { recursive: true });
  writeFileSync(join(root, 'a'), 'Alice\n');
  writeFileSync(join(root, '.yo', 'body.yo'), 'a: !!<format: text/plain>\n');
  writeFileSync(join(root, '.yo', 'index.db'), 'DB');
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  // the overlay is inspectable as a hidden raw node — but hidden plumbing keeps the dir's
  // shape: no TOC row, no visible children (plain dirs read the same as before)
  assert.equal(s.node(':.yo')?.meta?.hidden, true);
  assert.equal(typeof s.node(':.yo:body.yo')?.value, 'string');
  assert.ok(!s.toc(':', 1).some((n) => n.label === '.yo'));
  s.close();
  rmSync(root, { recursive: true, force: true });

  // an index-db-only .yo (no overlay, no sidecars) still adds nothing
  const bare = mkdtempSync(join(tmpdir(), 'yo-hidden3-'));
  mkdirSync(join(bare, '.yo'), { recursive: true });
  writeFileSync(join(bare, 'a'), 'Alice\n');
  writeFileSync(join(bare, '.yo', 'index.db'), 'DB');
  const s2 = new Store(':memory:');
  s2.indexDocument(walkDir(bare));
  assert.equal(s2.node(':.yo'), null);
  s2.close();
  rmSync(bare, { recursive: true, force: true });
});

test('dir/index.yo: the overlay is a plain `index.yo`, CONSUMED rather than listed', () => {
  // the second overlay flavor (docs/language/concretes/03-yamlover/01-dir/01-dir_index_yo):
  // everything `.yo/body.yo` says, said by a file inside the directory it controls.
  const root = mkdtempSync(join(tmpdir(), 'yo-indexyo-'));
  try {
    const dir = join(root, 'julia');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'name'), 'Julia\n');
    writeFileSync(join(dir, 'index.yo'), 'A person\nage: 42\n- *: name\n');
    const s = new Store(':memory:');
    s.indexDocument(walkDir(root));
    assert.equal(s.node(':julia')?.value, 'A person'); // the overlay's SCALAR self-value
    assert.equal(s.node(':julia:age')?.value, 42);     // an overlay-only key
    assert.equal(s.node(':julia:name')?.value, 'Julia');
    assert.equal(s.node(':julia:index.yo'), null);     // never an entry
    assert.ok(!s.children(':julia').map((c) => c.label).includes('index.yo'));
    assert.deepEqual(s.dangling(), []);                // `- *: name` granted the position
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('both overlays present: `.yo/body.yo` WINS and the index.yo stops being data (duplicate-overlay)', () => {
  const root = mkdtempSync(join(tmpdir(), 'yo-dupoverlay-'));
  try {
    const dir = join(root, 'julia');
    mkdirSync(join(dir, '.yo'), { recursive: true });
    writeFileSync(join(dir, '.yo', 'body.yo'), 'from the marker\n');
    writeFileSync(join(dir, 'index.yo'), 'from the file\n');
    const s = new Store(':memory:');
    s.indexDocument(walkDir(root));
    assert.equal(s.node(':julia')?.value, 'from the marker');
    // the loser is an ordinary member again — visible, so the tree still reads while the
    // doctor reports the violation
    assert.equal(s.node(':julia:index.yo')?.value, 'from the file');
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an UNPARSABLE overlay costs its own directory, never the walk', () => {
  // A syntax error in one `index.yo` used to throw out of the whole walk — a single bad file left
  // the entire tree unindexed. It now degrades: the directory keeps its filesystem children and
  // loses only what the overlay said, and the reason is reported through `onFileError`.
  const root = mkdtempSync(join(tmpdir(), 'yo-badoverlay-'));
  try {
    const dir = join(root, 'julia');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'name'), 'Julia\n');
    writeFileSync(join(dir, 'index.yo'), '- **bold** is not a pointer\n'); // `*` opens a pointer
    writeFileSync(join(root, 'sibling'), 'unaffected\n');
    const errors: string[] = [];
    const s = new Store(':memory:');
    s.indexDocument(walkDir(root, { onFileError: (rel, e) => errors.push(`${rel}: ${(e as Error).message}`) }));
    assert.equal(s.node(':julia:name')?.value, 'Julia'); // children still index
    assert.equal(s.node(':sibling')?.value, 'unaffected'); // and so does the rest of the tree
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^julia\/index\.yo: pointer:/);
    // the degraded directory WEARS the reason: meta.parseError names the file and the message,
    // so a UI can show the failure and the server's write gate can refuse re-serialization
    const pe = s.node(':julia')?.meta?.parseError as { file: string; message: string };
    assert.equal(pe?.file, 'julia/index.yo');
    assert.match(pe?.message ?? '', /^pointer:/);
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an UNPARSABLE data file degrades to its raw text and wears the reason', () => {
  // Same degradation contract as the overlay case, at the data-file site: the fallback scalar
  // keeps the user's bytes verbatim, `meta.parseError` names the file and the parser's message,
  // and `documentRoot` STAYS — the file still owns its bytes, so the raw-source rescue view
  // resolves it and an edit addressed at it lands on the write gate instead of the parent.
  const root = mkdtempSync(join(tmpdir(), 'yo-badfile-'));
  try {
    writeFileSync(join(root, 'broken.yo'), '- **bold** is not a pointer\n');
    const errors: string[] = [];
    const s = new Store(':memory:');
    s.indexDocument(walkDir(root, { onFileError: (rel) => errors.push(rel) }));
    const row = s.node(':broken.yo');
    assert.equal(row?.value, '- **bold** is not a pointer\n'); // raw text, untouched
    const pe = row?.meta?.parseError as { file: string; message: string };
    assert.equal(pe?.file, 'broken.yo');
    assert.match(pe?.message ?? '', /^pointer:/);
    assert.equal(row?.meta?.documentRoot, true);
    assert.deepEqual(errors, ['broken.yo']);
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an UNPARSABLE .yo/meta.yo surfaces on its directory', () => {
  // The third degradation site: the property table is lost, the children index unformatted,
  // and the directory wears the reason. (When the BODY is also broken, the body's error wins
  // the single parseError slot — the body is what a mediated write would re-serialize.)
  const root = mkdtempSync(join(tmpdir(), 'yo-badmeta-'));
  try {
    const dir = join(root, 'julia');
    mkdirSync(join(dir, '.yo'), { recursive: true });
    writeFileSync(join(dir, 'name'), 'Julia\n');
    writeFileSync(join(dir, '.yo', 'meta.yo'), '- **bold** is not a pointer\n');
    const s = new Store(':memory:');
    s.indexDocument(walkDir(root, {}));
    assert.equal(s.node(':julia:name')?.value, 'Julia');
    const pe = s.node(':julia')?.meta?.parseError as { file: string; message: string };
    assert.equal(pe?.file, 'julia/.yo/meta.yo');
    assert.match(pe?.message ?? '', /^pointer:/);
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ANCHORED members route through the items schema — a bannerless member folds the same in every face', () => {
  // the reported face split: a member born WITHOUT its own `!!<…>` banner got no format at
  // all (items propagation skipped keyed entries; anchored members are keyed) — the read
  // view called it a chunk while the editor's shape fold called it a chapter. Anchored
  // members ARE the chapter's body ("ordinal, not keyed"): the items schema routes them.
  //
  // STORAGE IS SHAPE: a DIRECTORY-backed member is a container whatever its body momentarily
  // holds — a bare-title body is a titled CHILDLESS subchapter (the T→Done shape), which no
  // value shape could otherwise distinguish from a chunk. A FILE-backed scalar member stays
  // a chunk: files are leaves.
  const dir = mkdtempSync(join(tmpdir(), 'yamlover-anchored-schema-'));
  try {
    mkdirSync(join(dir, '.yo'));
    writeFileSync(
      join(dir, '.yo', 'body.yo'),
      '!!<*::yamlover:$defs:chapter>\nBook\n- intro prose\n- *: omni_member\n- *: title_member\n- *: note.yo\n',
    );
    // a BANNERLESS omni member (title + description) — container-shaped → the chapter branch
    mkdirSync(join(dir, 'omni_member', '.yo'), { recursive: true });
    writeFileSync(join(dir, 'omni_member', '.yo', 'body.yo'), 'json/key\ndescription: Double quoted string\n');
    // a BANNERLESS bare-title DIR member — childless, but its directory is container shape
    mkdirSync(join(dir, 'title_member', '.yo'), { recursive: true });
    writeFileSync(join(dir, 'title_member', '.yo', 'body.yo'), 'link to json/code\n');
    // a FILE member holding a bare scalar — a leaf → the chunk branch
    writeFileSync(join(dir, 'note.yo'), 'just a line\n');
    const s = new Store(':memory:');
    s.indexDocument(walkDir(dir));
    assert.equal(s.node(':omni_member')?.format, 'x-yamlover-chapter'); // folds as a SUBCHAPTER everywhere
    assert.equal(s.node(':title_member')?.format, 'x-yamlover-chapter'); // titled childless — STILL a subchapter
    assert.equal(s.node(':title_member')?.value, 'link to json/code');   // its title survives T→Done
    assert.equal(s.node(':note.yo')?.format, 'text/marklower');          // a file scalar folds as a CHUNK
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ownerNodePath: an overlay file collapses to the directory that consumes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'yo-owner-'));
  try {
    mkdirSync(join(root, 'a', '.yo'), { recursive: true });
    writeFileSync(join(root, 'a', '.yo', 'body.yo'), 'A\n');
    mkdirSync(join(root, 'b'));
    writeFileSync(join(root, 'b', 'index.yo'), 'B\n');
    // layout violation (duplicate-overlay): body.yo wins, so this index.yo is NOT the overlay
    mkdirSync(join(root, 'c', '.yo'), { recursive: true });
    writeFileSync(join(root, 'c', '.yo', 'body.yo'), 'C\n');
    writeFileSync(join(root, 'c', 'index.yo'), 'shadowed\n');
    writeFileSync(join(root, 'plain.md'), 'P\n');
    mkdirSync(join(root, '.yo'), { recursive: true });
    writeFileSync(join(root, '.yo', 'body.yo'), 'R\n');

    assert.equal(ownerNodePath(root, 'a/.yo/body.yo'), 'a');
    assert.equal(ownerNodePath(root, 'b/index.yo'), 'b');
    assert.equal(ownerNodePath(root, 'c/index.yo'), 'c/index.yo'); // shadowed — stays itself
    assert.equal(ownerNodePath(root, 'plain.md'), 'plain.md');
    assert.equal(ownerNodePath(root, '.yo/body.yo'), '.yo/body.yo'); // the served root is not a movable node
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
