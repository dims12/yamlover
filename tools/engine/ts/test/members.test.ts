// The concrete/type/format split + the `members:` schema clause (docs/meta, docs/meta/members):
// - meta.yo `members:` (legacy `properties:` read forever) declares per-member concrete/type/format
// - an explicit `concrete:` DECODES: languages (yamlover/stream…), codecs (base64,
//   binary/int<w>/<e>), charset texts (text/utf-8) — format never selects decoding again
// - in a schema, `members:` fuses properties (keyed clauses) + prefixItems (keyless clauses),
//   with the sibling `others:` sweeping the unmatched (legacy additionalProperties/items)
// The legacy spellings keep their own pins in walk.test.ts — this file pins the NEW reader.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkDir } from '../src/walk.ts';
import { Store } from '../src/store.ts';

function tmpTree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'yo-members-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function indexed(root: string): Store {
  const s = new Store(':memory:');
  s.indexDocument(walkDir(root));
  return s;
}

test('meta.yo members: spelling is read; members wins over properties per key', () => {
  const root = tmpTree({
    '.yo/meta.yo': [
      'properties:',
      '  a: { format: text/markdown }',
      '  b: { format: text/markdown }',
      'members:',
      '  b: { format: text/x-plantuml }', // members wins for b; properties still covers a
    ].join('\n'),
    '.yo/body.yo': 'a: |\n  prose\nb: |\n  @startuml\n',
  });
  try {
    const s = indexed(root);
    assert.equal(s.node(':a')?.format, 'text/markdown');
    assert.equal(s.node(':b')?.format, 'text/x-plantuml');
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concrete: yamlover/stream parses a file the extension would keep as bytes', () => {
  const root = tmpTree({
    '.yo/meta.yo': 'members:\n  data.txt: { concrete: yamlover/stream }\n',
    'data.txt': 'name: Alice\nage: 30\n', // .txt → text/plain → bytes, without the declaration
  });
  try {
    const s = indexed(root);
    assert.equal(s.node(':data.txt:name')?.value, 'Alice');
    assert.equal(s.node(':data.txt:age')?.value, 30);
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concrete: yamlover/meta parses a schema document (the concrete twin of format: yamlover/meta)', () => {
  const root = tmpTree({
    '$defs/.yo/meta.yo': 'members:\n  thing: { concrete: yamlover/meta }\n',
    '$defs/thing': 'type: variant\nformat: x-yamlover-thing\n',
    'doc.yo': '!!<*yamlover: $defs: thing>\nthe value\n',
  });
  try {
    const s = indexed(root);
    assert.equal(s.node(':doc.yo')?.format, 'x-yamlover-thing'); // resolves only if $defs/thing PARSED
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concrete: base64 keeps blob identity on the file bytes; format states the meaning', () => {
  const root = tmpTree({
    '.yo/meta.yo': 'members:\n  logo: { concrete: base64, format: image/png }\n',
    'logo': 'iVBORw0KGgo=\n', // base64 text — decode-on-serve is the recorded follow-up
  });
  try {
    const doc = walkDir(root);
    const entry = (doc.root.entries ?? []).find((e) => e.key === 'logo');
    assert.equal(entry?.value.kind, 'blob');
    assert.equal((entry?.value as { format?: string }).format, 'image/png');
    assert.equal(entry?.value.meta?.concrete, 'base64'); // the encode-back provenance stamp
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concrete: binary/int32/le decodes a four-byte file into an integer', () => {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32LE(30);
  const root = tmpTree({
    '.yo/meta.yo': 'members:\n  age: { concrete: binary/int32/le }\n',
    'age': bytes,
  });
  try {
    const doc = walkDir(root);
    const entry = (doc.root.entries ?? []).find((e) => e.key === 'age');
    assert.equal(entry?.value.kind, 'scalar');
    assert.equal((entry?.value as { value?: unknown }).value, 30);
    assert.equal(entry?.value.meta?.concrete, 'binary/int32/le');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('binary/int16/be honors width and endianness; a wrong-length file degrades to bytes + parseError', () => {
  const two = Buffer.alloc(2);
  two.writeInt16BE(-7);
  const root = tmpTree({
    '.yo/meta.yo': 'members:\n  ok: { concrete: binary/int16/be }\n  bad: { concrete: binary/int32/le }\n',
    'ok': two,
    'bad': Buffer.from('too long for int32'),
  });
  try {
    const doc = walkDir(root);
    const ok = (doc.root.entries ?? []).find((e) => e.key === 'ok');
    assert.equal((ok?.value as { value?: unknown }).value, -7);
    const bad = (doc.root.entries ?? []).find((e) => e.key === 'bad');
    assert.equal(bad?.value.kind, 'blob'); // the bytes survive untouched
    assert.ok(bad?.value.meta?.parseError, 'the refusal is stamped, not silent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concrete: text/<charset> decodes to a string; an unknown charset stays bytes', () => {
  const root = tmpTree({
    '.yo/meta.yo': [
      'members:',
      '  greeting: { concrete: text/utf-8, format: text/markdown }',
      '  legacy: { concrete: text/ibm866 }',
      '  mystery.txt: { concrete: text/no-such-charset }',
    ].join('\n'),
    'greeting': '# Привет\n',
    'legacy': Buffer.from([0x8f, 0xe0, 0xa8, 0xa2, 0xa5, 0xe2]), // "Привет" in CP866
    'mystery.txt': 'whatever\n',
  });
  try {
    const s = indexed(root);
    assert.equal(s.node(':greeting')?.value, '# Привет\n');
    assert.equal(s.node(':greeting')?.format, 'text/markdown'); // format rides along, constraint only
    assert.equal(s.node(':legacy')?.value, 'Привет');
    // unknown charset = the declaration is ignored; the legacy chain keeps .txt as bytes
    assert.equal(s.node(':mystery.txt')?.type, 'blob');
    assert.equal(s.node(':mystery.txt')?.format, 'text/plain');
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a STORAGE concrete id (file/binary) is inert on the decode axis', () => {
  const root = tmpTree({
    '.yo/meta.yo': 'members:\n  age: { concrete: file/binary }\n',
    'age': '30',
  });
  try {
    const s = indexed(root);
    assert.equal(s.node(':age')?.value, 30); // the legacy chain decided, as if undeclared
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('schema members:/others: — keyed clause, keyless prefix clauses, and the sweep', () => {
  const root = tmpTree({
    '$defs/rec': [
      'type: variant',
      'members:',
      '  note:',                      // keyed clause ≈ properties
      '    type: string',
      '    format: text/markdown',
      '  - type: string',             // 1st keyless clause ≈ prefixItems[0]
      '    format: text/x-plantuml',
      '  - type: string',             // 2nd keyless clause ≈ prefixItems[1]
      '    format: text/asciidoc',
      'others:',                      // the sweep for everything unmatched
      '  type: string',
      '  format: text/csv',
      '',
    ].join('\n'),
    '$defs/.yo/meta.yo': 'members:\n  rec: { concrete: yamlover/meta }\n',
    'doc.yo': [
      '!!<*yamlover: $defs: rec>',
      'note: keyed member',
      'extra: swept keyed member',
      '- first positional',
      '- second positional',
      '- third positional',
      '',
    ].join('\n'),
  });
  try {
    const doc = walkDir(root);
    const node = (doc.root.entries ?? []).find((e) => e.key === 'doc.yo')!.value;
    const fmt = (key: string | null, nth = 0) =>
      (node.entries ?? []).filter((e) => e.key === key)[nth]?.value.meta?.derivedFormat;
    assert.equal(fmt('note'), 'text/markdown'); // the keyed clause
    assert.equal(fmt('extra'), 'text/csv'); // unmatched keyed → others
    assert.equal(fmt(null, 0), 'text/x-plantuml'); // 1st keyless clause
    assert.equal(fmt(null, 1), 'text/asciidoc'); // 2nd keyless clause
    assert.equal(fmt(null, 2), 'text/csv'); // past the prefix → others
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pattern: true — the clause key is a regexp over member names; an exact clause beats it', () => {
  const root = tmpTree({
    '.yo/meta.yo': [
      'members:',
      "  '^\\d{4}$':",
      '    pattern: true',
      '    concrete: text/utf-8',
      '    format: text/x-yamlover',
      "  '0001': { concrete: yamlover/stream }", // exact wins over the matching pattern (digit-only names are quoted — bare would be a position)
    ].join('\n'),
    '0000': 'name: Alice\n', // extensionless: pattern says text — ONE string, not a subtree
    '0001': 'name: Alice\n',
    'other': 'name: Alice\n', // no clause: the legacy chain parses it
  });
  try {
    const s = indexed(root);
    // digit-only names are QUOTED in paths — a bare `:0000` would be position 0 (docs/language/pointers)
    assert.equal(s.node(":'0000'")?.value, 'name: Alice\n');
    assert.equal(s.node(":'0000'")?.format, 'text/x-yamlover');
    assert.equal(s.node(":'0001':name")?.value, 'Alice'); // the exact clause parsed it
    assert.equal(s.node(':other:name')?.value, 'Alice');
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pattern matching SEARCHES the name (JSON Schema patternProperties); author order, first match wins', () => {
  const root = tmpTree({
    '.yo/meta.yo': [
      'members:',
      "  '\\d{4}':", // unanchored: matches anywhere in the name
      '    pattern: true',
      '    format: text/markdown',
      "  'case':", // ALSO matches case0000.note — but it is stated second
      '    pattern: true',
      '    format: text/csv',
    ].join('\n'),
    '.yo/body.yo': 'case0000.note: |\n  prose\nplain.note: |\n  prose\n',
  });
  try {
    const s = indexed(root);
    assert.equal(s.node(':case0000.note')?.format, 'text/markdown'); // first matching clause supplies ALL of it
    assert.ok(s.node(':plain.note')?.format == null); // no digits anywhere → unmatched
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a clause\'s nested members: reaches the SUBDIRECTORY\'s files', () => {
  const root = tmpTree({
    '.yo/meta.yo': [
      'members:',
      "  '^\\d{4}$':",
      '    pattern: true',
      '    members:', // describes each matching subdirectory's own members
      '      in.yo: { concrete: text/utf-8, format: text/x-yamlover }',
      '      ir.json: { concrete: text/utf-8, format: text/x-json }',
    ].join('\n'),
    '0000/in.yo': 'name: Alice\n', // .yo would parse — the inherited clause mounts it as TEXT
    '0000/ir.json': '{"kind": "scalar"}\n',
    '0000/notes.yo': 'still: parsed\n', // no nested clause → untouched
  });
  try {
    const s = indexed(root);
    assert.equal(s.node(":'0000':in.yo")?.value, 'name: Alice\n');
    assert.equal(s.node(":'0000':in.yo")?.format, 'text/x-yamlover');
    assert.equal(s.node(":'0000':ir.json")?.value, '{"kind": "scalar"}\n');
    assert.equal(s.node(":'0000':notes.yo:still")?.value, 'parsed');
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a subdirectory\'s OWN meta.yo beats the inherited clause — the closest declaration wins', () => {
  const root = tmpTree({
    '.yo/meta.yo': [
      'members:',
      "  '^\\d{4}$':",
      '    pattern: true',
      '    members:',
      '      in.yo: { concrete: text/utf-8, format: text/x-yamlover }',
    ].join('\n'),
    '0000/in.yo': 'name: Alice\n',
    '0001/.yo/meta.yo': 'members:\n  in.yo: { concrete: yamlover/stream }\n', // overrides the inherited text mount
    '0001/in.yo': 'name: Alice\n',
  });
  try {
    const s = indexed(root);
    assert.equal(s.node(":'0000':in.yo")?.value, 'name: Alice\n'); // inherited: text
    assert.equal(s.node(":'0001':in.yo:name")?.value, 'Alice'); // own meta: parsed
    s.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unparsable pattern regexp drops its clause and stamps the directory, never the walk', () => {
  const root = tmpTree({
    '.yo/meta.yo': [
      'members:',
      "  '([':", // not a regexp
      '    pattern: true',
      '    format: text/markdown',
      '  age: { concrete: binary/int32/le }', // the well-formed clause still applies
    ].join('\n'),
    'age': Buffer.from([30, 0, 0, 0]),
  });
  try {
    const doc = walkDir(root);
    assert.ok(doc.root.meta?.parseError, 'the bad pattern is told, not swallowed');
    const age = (doc.root.entries ?? []).find((e) => e.key === 'age');
    assert.equal((age?.value as { value?: unknown }).value, 30);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('others: routes an anyOf union structurally, like the legacy items sweep', () => {
  const root = tmpTree({
    '$defs/chap': [
      'type: variant',
      'members:',
      '  description:',
      '    type: string',
      '    format: text/marklower',
      'others:',
      '  anyOf:',
      '    - *:: yamlover: $defs: chap',
      '    - *:: yamlover: $defs: piece',
      '',
    ].join('\n'),
    '$defs/piece': 'type: [string, binary]\nformat: text/marklower\n',
    '$defs/.yo/meta.yo': 'members:\n  chap: { concrete: yamlover/meta }\n  piece: { concrete: yamlover/meta }\n',
    'doc.yo': [
      '!!<*yamlover: $defs: chap>',
      'A Title',
      'description: the subtitle',
      '- a prose chunk',
      '- Sub Title',
      '  - nested chunk',
      '',
    ].join('\n'),
  });
  try {
    const doc = walkDir(root);
    const node = (doc.root.entries ?? []).find((e) => e.key === 'doc.yo')!.value;
    const keyless = (n: typeof node) => (n.entries ?? []).filter((e) => e.key == null);
    assert.equal(node.meta?.derivedFormat, 'x-yamlover-chap');
    assert.equal((node.entries ?? []).find((e) => e.key === 'description')?.value.meta?.derivedFormat,
      'text/marklower');
    assert.equal(keyless(node)[0]?.value.meta?.derivedFormat, 'text/marklower'); // leaf → piece branch
    const sub = keyless(node)[1]?.value;
    assert.equal(sub?.meta?.derivedFormat, 'x-yamlover-chap'); // container → the recursion
    assert.equal(keyless(sub)[0]?.value.meta?.derivedFormat, 'text/marklower'); // and it recurses
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
