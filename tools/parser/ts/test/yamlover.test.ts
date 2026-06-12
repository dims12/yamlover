import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseYamlover } from '../src/yamlover.ts';
import { serializeYamlover } from '../src/serialize-yamlover.ts';
import { toPlain, isPointer } from '../src/ir.ts';
import type { Mapping } from '../src/ir.ts';

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, '..', '..', '..', '..', 'examples');

const asMap = (n: unknown) => n as Mapping;
const entry = (m: Mapping, k: string) => m.entries.find((e) => e.key === k)!;

test('block mapping with scalars', () => {
  const d = parseYamlover('name: Alice\nage: 30\nadmin: true\nnote: ~');
  assert.deepEqual(toPlain(d.root), { name: 'Alice', age: 30, admin: true, note: null });
});

test('nested block mapping', () => {
  const d = parseYamlover('user:\n  name: Alice\n  age: 30\n');
  assert.deepEqual(toPlain(d.root), { user: { name: 'Alice', age: 30 } });
});

test('block sequence of scalars', () => {
  const d = parseYamlover('- a\n- 2\n- true\n');
  assert.deepEqual(toPlain(d.root), ['a', 2, true]);
});

test('compact sequence of mappings', () => {
  const d = parseYamlover('pets:\n  - name: Rex\n    species: dog\n  - name: Whiskers\n    species: cat\n');
  assert.deepEqual(toPlain(d.root), { pets: [{ name: 'Rex', species: 'dog' }, { name: 'Whiskers', species: 'cat' }] });
});

test('block sequence at the SAME indent as its key (zero-indent seq)', () => {
  // YAML allows `key:` then `- …` at the parent's column (the 57-image-with-markup shape)
  const d = parseYamlover('markup:\n- x: 1\n  y: 2\n- x: 3\n  y: 4\nother: 9\n');
  assert.deepEqual(toPlain(d.root), { markup: [{ x: 1, y: 2 }, { x: 3, y: 4 }], other: 9 });
});

test('flow mapping and sequence', () => {
  const d = parseYamlover('a: {x: 1, y: 2}\nb: [1, 2, 3]\n');
  assert.deepEqual(toPlain(d.root), { a: { x: 1, y: 2 }, b: [1, 2, 3] });
});

test('pointer value → ref edge with parsed base/steps (unquoted)', () => {
  const d = parseYamlover('manager: */pets[1]/name\n');
  const e = entry(asMap(d.root), 'manager');
  assert.equal(e.edge, 'ref');
  assert.ok(isPointer(e.value));
  assert.deepEqual((e.value as any).base, { scope: 'document' });
  assert.deepEqual((e.value as any).steps, [
    { sel: 'key', name: 'pets' }, { sel: 'index', n: 1 }, { sel: 'key', name: 'name' },
  ]);
});

test('& path anchor on a block value; * reaches the anchor-created key', () => {
  const d = parseYamlover('boss: &/chief\n  name: Rex\nteam:\n  lead: */chief\n');
  const boss = entry(asMap(d.root), 'boss').value as Mapping;
  assert.deepEqual(boss.meta?.anchors?.map((a) => a.path.raw), ['/chief']);
  assert.equal(boss.meta?.anchors?.[0].ordinal, undefined);
  const lead = entry(asMap(entry(asMap(d.root), 'team').value as Mapping), 'lead');
  assert.equal(lead.edge, 'ref');
  assert.deepEqual((lead.value as any).steps, [{ sel: 'key', name: 'chief' }]);
});

test('& anchors: own-line, multiple, ordinal []', () => {
  // the two-line tagged-scalar file (URIs.md §&) — order-free
  const a = parseYamlover('30\n&//tags/whole[]\n').root as any;
  assert.equal(a.value, 30);
  assert.deepEqual(a.meta.anchors.map((x: any) => [x.path.raw, x.ordinal === true]), [['//tags/whole', true]]);
  const b = parseYamlover('&//tags/whole[]\n30\n').root as any;
  assert.equal(b.value, 30);
  assert.equal(b.meta.anchors.length, 1);
  // multiple anchors on their own lines inside a node's block
  const c = parseYamlover('child:\n  &/p/kid\n  &/q/kid\n  x: 1\n');
  const child = entry(asMap(c.root), 'child').value as Mapping;
  assert.deepEqual(child.meta?.anchors?.map((x) => x.path.raw), ['/p/kid', '/q/kid']);
  assert.equal(child.entries.length, 1);
  // a position may not be claimed
  assert.throws(() => parseYamlover('12\n&/seq[3]\n'), /may not claim a position/);
});

test('~ back-edge key (sigil outside the key)', () => {
  const d = parseYamlover('adam:\n  cain:\n    ~cain: */eve\n');
  const cain = entry(asMap(entry(asMap(d.root), 'adam').value as Mapping), 'cain');
  const back = entry(cain.value as Mapping, 'cain');
  assert.equal(back.edge, 'back');
  assert.deepEqual((back.value as any).base, { scope: 'document' });
});

test('escaping: literal key with slash, and \\.\\.', () => {
  const d = parseYamlover('weird:\n  cat\\/dog:\n    n: 1\nref: *weird/cat\\/dog/n\ndots: *\\.\\.\n');
  // the literal key is "cat/dog"
  const weird = entry(asMap(d.root), 'weird').value as Mapping;
  assert.equal(weird.entries[0].key, 'cat/dog');
  const ref = entry(asMap(d.root), 'ref');
  assert.deepEqual((ref.value as any).steps, [
    { sel: 'key', name: 'weird' }, { sel: 'key', name: 'cat/dog' }, { sel: 'key', name: 'n' },
  ]);
  const dots = entry(asMap(d.root), 'dots');
  assert.deepEqual((dots.value as any).steps, [{ sel: 'key', name: '..' }]);
});

test('block scalar | (literal) preserves newlines and a leading #', () => {
  const d = parseYamlover('md: |\n  # Heading\n  line two\nother: 1\n');
  assert.equal((toPlain(d.root) as any).md, '# Heading\nline two\n');
  assert.equal((toPlain(d.root) as any).other, 1); // block ended at the dedent
});

test('block scalar > (folded) joins lines; blank → newline', () => {
  const d = parseYamlover('p: >\n  a\n  b\n\n  c\n');
  assert.equal((toPlain(d.root) as any).p, 'a b\n\nc\n');
});

test('quoted scalars: trailing comment stripped, # inside the string kept', () => {
  const d = parseYamlover(
    [
      'plain: just text         # a comment',
      "single: 'a # b'          # not a comment inside ''",
      'double: "x # y"          # nor inside \"\"',
      'esc: "she said \\"hi\\"" # \\" must NOT end the string early',
    ].join('\n'),
  );
  const m = toPlain(d.root) as any;
  assert.equal(m.plain, 'just text');
  assert.equal(m.single, 'a # b'); // `#` inside single quotes is literal
  assert.equal(m.double, 'x # y'); // `#` inside double quotes is literal
  assert.equal(m.esc, 'she said "hi"'); // \" is an escaped quote, the comment is still stripped
});

test('block scalar in a sequence item', () => {
  const d = parseYamlover('chunks:\n- |\n  one\n  two\n- second\n');
  assert.deepEqual(toPlain(d.root), { chunks: ['one\ntwo\n', 'second'] });
});

test('block scalar chomping: clip (default) vs strip (-)', () => {
  assert.equal((toPlain(parseYamlover('a: |\n  x\n').root) as any).a, 'x\n');
  assert.equal((toPlain(parseYamlover('b: |-\n  x\n').root) as any).b, 'x');
});

test('schema tag !!<…> on the document root attaches a schema ref', () => {
  const d = parseYamlover('!!<*yamlover/$defs/chapter>\ntitle: T\nchunks:\n- a\n- b\n');
  const ptr = asMap(d.root).meta?.schema;
  assert.ok(ptr && isPointer(ptr), 'root has a schema pointer');
  assert.deepEqual((ptr as any).steps.map((s: any) => s.name ?? s.sel), ['yamlover', '$defs', 'chapter']);
  assert.deepEqual(toPlain(d.root), { title: 'T', chunks: ['a', 'b'] });
});

test('schema tag !!<…> on a value attaches to that node', () => {
  const d = parseYamlover('doc: !!<*yamlover/$defs/chapter>\n  title: T\n');
  const doc = entry(asMap(d.root), 'doc').value as Mapping;
  assert.ok(doc.meta?.schema && isPointer(doc.meta.schema));
  assert.deepEqual(toPlain(doc), { title: 'T' });
});

test('inline schema tag !!<format: …> attaches an inline schema Node (not a pointer)', () => {
  const d = parseYamlover('chunks:\n- !!<format: text/x-plantuml> |\n    @startuml\n    @enduml\n');
  const chunk = (entry(asMap(d.root), 'chunks').value as Mapping).entries[0].value as Scalar;
  const sch = chunk.meta?.schema;
  assert.ok(sch && !isPointer(sch), 'schema is an inline Node');
  assert.deepEqual(toPlain(sch as any), { format: 'text/x-plantuml' });
  assert.equal(chunk.value, '@startuml\n@enduml\n'); // the block scalar after the tag
});

test('parses examples/60-simple-chapter.yamlover (tagged file)', () => {
  const d = parseYamlover(readFileSync(join(examples, '60-simple-chapter.yamlover'), 'utf8'), '60');
  assert.ok(asMap(d.root).meta?.schema, 'root tagged with chapter schema');
  assert.deepEqual(asMap(d.root).entries.map((e) => e.key), ['title', 'chunks', 'children']);
});

test('parses examples/05-tour.yaml (YAML anchors/aliases)', () => {
  const d = parseYamlover(readFileSync(join(examples, '05-tour.yaml'), 'utf8'), '05-tour.yaml');
  const pets = entry(asMap(d.root), 'pets').value as Mapping;
  assert.equal(pets.array, true);
  assert.equal(pets.entries.length, 3);
  // `&whiskers` reads as a PATH anchor on pets[1] (current-scope key "whiskers")
  assert.deepEqual((pets.entries[1].value as any).meta?.anchors?.map((a: any) => a.path.raw), ['whiskers']);
  // humans[0].manager parses as a current-scope pointer; resolving it CROSS-scope is the
  // documented YAML divergence (YAMLOVER.md §3) — the 06 twin uses */pets[1]
  const humans = entry(asMap(d.root), 'humans').value as Mapping;
  const mgr = entry(humans.entries[0].value as Mapping, 'manager');
  assert.equal(mgr.edge, 'ref');
  assert.deepEqual((mgr.value as any).steps, [{ sel: 'key', name: 'whiskers' }]);
});

test('parses examples/06-tour.yamlover (full pointer layer)', () => {
  const d = parseYamlover(readFileSync(join(examples, '06-tour.yamlover'), 'utf8'), '06-tour.yamlover');
  const root = asMap(d.root);
  // boss carries the `&/chief` path anchor (a real document-root key, no namespace)
  assert.deepEqual((entry(root, 'boss').value as any).meta?.anchors?.map((a: any) => a.path.raw), [': chief']);
  // a representative set of edges
  assert.equal(entry(root, 'feline').edge, 'ref');
  assert.equal(entry(root, 'topDog').edge, 'ref');
  assert.equal(entry(root, 'secondName').edge, 'ref');
  // the reverse edge deep in adam.cain is anchor-spelled: &/eve/cain on the cain node
  const cain = entry(asMap(entry(root, 'adam').value as Mapping), 'cain').value as Mapping;
  assert.deepEqual(cain.meta?.anchors?.map((a) => a.path.raw), [': eve: cain']);
  // fan's memberships are ordinal anchors (were `~-`)
  const fan = entry(root, 'fan').value as Mapping;
  assert.deepEqual(fan.meta?.anchors?.map((a) => a.path.raw + (a.ordinal ? '[]' : '')), [': favorites[]', ': crew[]']);
  // escaping: `\:` yields the literal key "cat:dog"; `/` rides bare in colon portions
  assert.deepEqual((entry(root, 'ref').value as any).steps, [
    { sel: 'key', name: 'weird' }, { sel: 'key', name: 'cat:dog' }, { sel: 'key', name: 'n' },
  ]);
  assert.deepEqual((entry(root, 'slsh').value as any).steps, [
    { sel: 'key', name: 'weird' }, { sel: 'key', name: 'cat/dog' },
  ]);
  // partially ordered, partially keyed: `playlist` mixes keyless and keyed entries
  const playlist = entry(root, 'playlist').value as Mapping;
  assert.equal(playlist.array, false); // has string keys → not a pure array projection
  assert.deepEqual(playlist.entries.map((e) => e.key), [null, null, 'title', null, 'encore']);
  // unified node: `rating` is a scalar (value 5) that ALSO carries positional + keyed fields
  const rating = entry(root, 'rating').value as Scalar;
  assert.equal(rating.kind, 'scalar');
  assert.equal(rating.value, 5);
  assert.deepEqual(rating.entries?.map((e) => e.key), [null, null, 'scale', 'author']);
});

test('one ordered container mixes keyless (positional) and keyed entries', () => {
  const d = parseYamlover('m: !!mix\n  - a\n  - b\n  title: T\n  - c\n  count: 2\n');
  const m = entry(asMap(d.root), 'm').value as Mapping;
  assert.equal(m.array, false);
  assert.deepEqual(m.entries.map((e) => e.key), [null, null, 'title', null, 'count']);
  assert.deepEqual(m.entries.map((e) => (e.value as any).value), ['a', 'b', 'T', 'c', 2]);
  // a pure sequence is still array=true; a pure mapping array=false
  assert.equal((entry(asMap(parseYamlover('s:\n  - a\n  - b\n').root), 's').value as Mapping).array, true);
  assert.equal((entry(asMap(parseYamlover('o:\n  x: 1\n  y: 2\n').root), 'o').value as Mapping).array, false);
});

test('a node can be a scalar AND carry positional + keyed fields (unified node)', () => {
  const d = parseYamlover('rating: !!omni 5\n  - solid\n  - good\n  scale: 10\n');
  const r = entry(asMap(d.root), 'rating').value as Scalar;
  assert.equal(r.kind, 'scalar');
  assert.equal(r.value, 5); // it keeps its scalar value …
  assert.deepEqual(r.entries?.map((e) => e.key), [null, null, 'scale']); // … and has fields
  assert.deepEqual(r.entries?.map((e) => (e.value as any).value), ['solid', 'good', 10]);
  // toPlain: self-value under $value; keyless fields under their position
  assert.deepEqual(toPlain(r), { $value: 5, '0': 'solid', '1': 'good', scale: 10 });
});

test('an !!omni node may have a block-scalar value plus fields (deeper content, shallower fields)', () => {
  const d = parseYamlover('rating: !!omni |\n      Multi-line\n      review text\n  - solid\n  scale: 10\n');
  const r = entry(asMap(d.root), 'rating').value as Scalar;
  assert.equal(r.kind, 'scalar');
  assert.equal(r.value, 'Multi-line\nreview text\n'); // block scalar bounded by its content indent
  assert.deepEqual(r.entries?.map((e) => e.key), [null, 'scale']); // shallower lines = fields
  assert.deepEqual(r.entries?.map((e) => (e.value as any).value), ['solid', 10]);
  // a plain (untagged) block scalar is unaffected — no fields attached
  const plain = entry(asMap(parseYamlover('msg: |\n  hello\n  world\nother: 1\n').root), 'msg').value as Scalar;
  assert.equal(plain.value, 'hello\nworld\n');
  assert.equal(plain.entries, undefined);
});

test('a root-level type tag (no preceding key) tags the document root', () => {
  const r = parseYamlover('!!omni 5\n- solid\n- recommended\nscale: 10\n').root as Scalar;
  assert.equal(r.kind, 'scalar');
  assert.equal(r.value, 5);
  assert.deepEqual(r.entries?.map((e) => e.key), [null, null, 'scale']);
});

test('omni is the default: untagged mixing and scalar+fields are legal (tags are no-ops)', () => {
  // keyed+keyless in one untagged container (was: required !!mix)
  const m = entry(asMap(parseYamlover('m:\n  - a\n  title: T\n').root), 'm').value as Mapping;
  assert.deepEqual(m.entries.map((e) => e.key), [null, 'title']);
  // scalar value + fields, untagged
  const r = entry(asMap(parseYamlover('r: 5\n  x: 1\n').root), 'r').value as Mapping & { value?: unknown };
  assert.equal(r.value, 5);
  assert.equal(r.entries?.length, 1);
  assert.equal(r.entries?.[0].key, 'x');
  // the value line may sit anywhere in the block — and at most ONE is allowed
  const root = parseYamlover('- one\n30\ntwo: three\n').root as Mapping & { value?: unknown };
  assert.equal(root.value, 30);
  assert.deepEqual(root.entries?.map((e) => e.key), [null, 'two']);
  assert.throws(() => parseYamlover('30\n40\n'), /at most one scalar value line/);
  // pure seq / map / scalar unchanged
  parseYamlover('s:\n  - a\n  - b\n');
  parseYamlover('o:\n  x: 1\n');
  parseYamlover('n: 5\n');
});

// ---- `~-` keyless back-edges (reverse positional membership) + `!!set` ----------

test('~- entry: a keyless back-edge with a pointer value (URIs.md §~-)', () => {
  const d = parseYamlover('my_node:\n  name: x\n  ~- */some/other/location\n');
  const my = asMap(entry(asMap(d.root), 'my_node').value);
  const back = my.entries.find((e) => e.edge === 'back')!;
  assert.equal(back.key, null);
  assert.ok(isPointer(back.value));
  assert.equal((back.value as { raw: string }).raw, '/some/other/location');
  // the reverse declaration is NOT an owned member: no !!mix needed, not an array
  assert.equal(my.array, false);
});

test('~- entries do not make a node look like a sequence, but real items still do', () => {
  const list = parseYamlover('- a\n- b\n~- */elsewhere\n');
  const m = asMap(list.root);
  assert.equal(m.array, true); // owned entries are all keyless
  assert.equal(m.entries.filter((e) => e.edge === 'back').length, 1);
  const backOnly = asMap(parseYamlover('~- */elsewhere\n').root);
  assert.equal(backOnly.array, false); // membership declarations alone are not a sequence
});

test('~- requires a pointer; the sigil must sit tight', () => {
  assert.throws(() => parseYamlover('a:\n  ~- not_a_pointer\n'), /needs a pointer/);
  assert.throws(() => parseYamlover('a:\n  x: 1\n  ~ - */x\n'), /sit tight/); // entry position
  assert.throws(() => parseYamlover('a:\n  ~ key: */x\n'), /sit tight/);
  // value position is untouched YAML: a lone `~ -…` line is a plain scalar
  assert.deepEqual(toPlain(parseYamlover('a: ~ - x\n').root), { a: '~ - x' });
});

test('~ in value position is still YAML null', () => {
  assert.deepEqual(toPlain(parseYamlover('a: ~\n').root), { a: null });
});

test('!!set tags a container with set semantics (NodeMeta.set)', () => {
  const d = parseYamlover('members: !!set\n- *a\n- *b\n');
  const members = entry(asMap(d.root), 'members').value;
  assert.ok(!isPointer(members) && members.meta?.set === true);
  // lone root tag form
  const root = parseYamlover('!!set\n- 1\n- 2\n').root;
  assert.equal(root.meta?.set, true);
  assert.deepEqual(toPlain(root), [1, 2]);
});

// ---- the colon round (SEPARATOR.md): `:` separators, the scope ladder, dual window ----

test('colon paths: the scope ladder — bare, :, ::, :::', () => {
  const d = parseYamlover([
    'a: *tiny: object',                              // current scope
    'b: *: pets[1]: name',                           // document root
    'c: *:: $defs: tag',                             // project root / import key
    'd: *::: yamlover.inthemoon.net: $defs: tag',    // the world (AWS-like URI)
  ].join('\n') + '\n');
  const at = (k: string) => entry(asMap(d.root), k).value as any;
  assert.deepEqual(at('a').base, { scope: 'current' });
  assert.deepEqual(at('a').steps.map((s: any) => s.name), ['tiny', 'object']);
  assert.deepEqual(at('b').base, { scope: 'document' });
  assert.deepEqual(at('b').steps, [{ sel: 'key', name: 'pets' }, { sel: 'index', n: 1 }, { sel: 'key', name: 'name' }]);
  assert.deepEqual(at('c').base, { scope: 'link', authority: '$defs' });
  assert.deepEqual(at('d').base, { scope: 'link', authority: 'yamlover.inthemoon.net', world: true });
});

test('colon paths: spacing is styling; quoted spacey portions; \\: escape; / is literal', () => {
  const spaced = parseYamlover('x: *: tags: y\n').root as Mapping;
  const compact = parseYamlover('x: *:tags:y\n').root as Mapping;
  assert.deepEqual((entry(spaced, 'x').value as any).steps, (entry(compact, 'x').value as any).steps);
  const q = parseYamlover("t: *: tags: 'дорожный знак'\n").root as Mapping;
  assert.deepEqual((entry(q, 't').value as any).steps.map((s: any) => s.name), ['tags', 'дорожный знак']);
  assert.throws(() => parseYamlover('t: *: tags: дорожный знак\n'), /must be quoted/);
  const e = parseYamlover('t: *sched: 09\\:30\nu: *formats: text/html\n').root as Mapping;
  assert.deepEqual((entry(e, 't').value as any).steps.map((s: any) => s.name), ['sched', '09:30']);
  assert.deepEqual((entry(e, 'u').value as any).steps.map((s: any) => s.name), ['formats', 'text/html']);
});

test('colon anchors: own-line form runs to end of line', () => {
  const d = parseYamlover('fan:\n  &: favorites[]\n  name: Bob\nthirty: 30\n  &:: tags: whole[]\n');
  const fan = entry(asMap(d.root), 'fan').value as Mapping;
  assert.deepEqual(fan.meta?.anchors?.map((a) => [a.path.base.scope, a.ordinal === true]), [['document', true]]);
  const thirty = entry(asMap(d.root), 'thirty').value as any;
  assert.equal(thirty.value, 30);
  assert.deepEqual(thirty.meta.anchors[0].path.base, { scope: 'link', authority: 'tags' });
});

test('colon round-trip: legacy slash input re-emits as colon, IR-equal', () => {
  const src = 'pets:\n  - name: Rex\nref: */pets[0]/name\nanch: &/alias 1\n';
  const doc = parseYamlover(src);
  const out: string = serializeYamlover(doc);
  assert.match(out, /\*: pets\[0\]: name/);
  assert.doesNotMatch(out, /\*\/pets/);
});
