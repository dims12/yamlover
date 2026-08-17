// Generate the parity golden that `tests/ts_parity.rs` asserts against.
//
//   node tools/parser/rust/tests/gen-ts-parity.mjs > tools/parser/rust/tests/ts-parity.json
//
// Sections, all adversarial:
//
//   escaping — keyText / flowKeyText / keyPortion / dq. Every branch, plus the characters
//     that mean something to one emitter and nothing to another (`:` is in keyPortion's
//     escape set and out of keyText's; `/` is the reverse).
//   scalars / splits / unquotes / folds — plainScalar, splitKV, unquoteKey, foldLines.
//     These decide the RAW-FIRST LAW: the serializer re-emits an authored spelling only
//     after proving it reparses to the same value, so a divergence here silently changes
//     what a document says.
//
// Add a case here rather than writing a Rust-only unit test whenever a new question comes
// up — a case in this file is checked against BOTH implementations, and a Rust-only test
// only ever proves Rust agrees with itself.
//
// Control characters are written as \u escapes, never as literal bytes: this file must stay
// text so a golden diff is reviewable.

import { keyText, flowKeyText, dq } from '../../ts/src/serialize-common.ts';
import { keyPortion } from '../../ts/src/pointer.ts';
import { plainScalar, splitKV, unquoteKey, foldLines } from '../../ts/src/yamlover.ts';

const escapingCases = [
  // empty / whitespace / padding
  '', ' ', 'a', 'abc', ' a', 'a ', 'a b', 'a\tb',
  // digits — a bare numeric key is a POSITION claim
  '1', '007', '1a', '0', '-1', '-0', '1.5',
  // the keyless marker and its neighbours
  '-', '-a', '-:', '--', 'a-b', '- ',
  // the null key and the parent step
  '~', '..', '.', '...', '.a',
  // quotes
  "'q", '"q', 'a"b', "it's", "a 'b'", "''", '""',
  // colon / solidus — the two that differ between the emitters
  'a:b', 'a: b', 'a::b', ':', ':: x', 'a/b', '/a', 'a//b',
  // backslash
  'a\\b', '\\', 'a\\\\b',
  // pointer metachars
  'a*b', 'a&b', 'a#b', 'a?b', 'a!b', 'a(b)', 'a<b>', 'a=b', 'a|b',
  'a[0]', 'a]b', 'a[b', '{}', '[]', '{a}',
  // control characters and DEL — DEL forces a keyText quote but dq leaves it literal
  'a\nb', 'a\rb', 'a\u0000b', 'a\u0001b', 'a\u001fb', 'a\u007fb', 'a\bb', 'a\fb',
  // non-ASCII: bare in block, quoted in FLOW (JS \w is ASCII-only)
  'имя', 'Алиса', 'Москва', '🐱', 'a🐱b', 'café', 'ß',
  // word-like odds and ends, and the shapes a mail importer will actually emit
  '$defs', 'x.y', 'a_b', 'null', 'true', 'false', '0x10', 'chapter', 'body.yo',
  'MESSAGES.TBB', 'message.eml', '00001-Тема письма.yo', 'Received', 'X-Mailer',
  'dims2000@mtu-net.ru', '$JUNK$', 'Архивные папки',
];

const scalarCases = [
  // the null / boolean words, in every accepted casing, and their near misses
  '', '~', 'null', 'Null', 'NULL', 'nul', 'NuLL',
  'true', 'True', 'TRUE', 'false', 'False', 'FALSE', 'tru', 'TrUe',
  // YAML float specials — yamlover follows YAML, not json5's Infinity/NaN words
  '.inf', '-.inf', '+.inf', '.Inf', '.INF', '.nan', '.NaN', '.NAN', '-.nan',
  'Infinity', '-Infinity', 'NaN',
  // decimals, in every authored spelling the raw-first law must preserve
  '0', '1', '-1', '+7', '-0', '1.0', '1.5', '.5', '5.', '007',
  '1e3', '1E3', '1e+3', '1e-3', '1.5e10', '-2.5E-4',
  // hex
  '0x10', '0x1F', '0xff', '-0xff', '+0x1', '0X10', '0x', '0xzz',
  // near-numbers that must stay strings
  '1.2.3', '1e', '.', '..', '1 2', '--1', '1-', '- 1', '1_000', '1,5',
  // strings, including the ones that look structural
  'abc', 'a b', 'a: b', 'a:b', '#x', 'a #x', 'имя', '🐱', ' padded ',
];

const splitCases = [
  'key: value', 'key:', 'key:value', 'no colon here', '',
  'a: b: c', "'a: b': v", '"a: b": v', 'a : b', 'key:  spaced',
  // a leading flow token is scanned WHOLE before the colon hunt
  '{a: 1}', '{a: [1]}', '[1, 2]', '[256, 256]: *x', '{a: 1}: v', '{unterminated: 1',
  "['a: b']: v", '{}: 12', '[]: v',
  // sigils and markers
  '- item', '-: item', '*ptr: v', '&anchor: v', '~: v', '~key: *p',
];

const unquoteCases = [
  'abc', "'a b'", "'it''s'", '"a\\nb"', '"a\\tb"', '"\\u0041"', '"\\x41"',
  'a\\*b', 'a\\:b', '\\.\\.', "''", '""', "'", '"', ' padded ', '"a\\\\b"',
  '"unterminated', "'q", 'имя', "'имя'",
];

const foldCases = [
  [], ['a'], ['a', 'b'], ['a', '', 'b'], ['', 'a'], ['a', ''],
  ['a', 'b', '', 'c', 'd'], ['', '', 'a'], ['one', 'two', 'three'],
];

/** JSON cannot hold NaN / ±Infinity / -0 — encode them the way canon.ts does. */
function encodeValue(v) {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { t: 'num', special: 'nan' };
    if (v === Infinity) return { t: 'num', special: 'inf' };
    if (v === -Infinity) return { t: 'num', special: '-inf' };
    if (Object.is(v, -0)) return { t: 'num', special: '-0' };
    return { t: 'num', v };
  }
  if (v === null) return { t: 'null' };
  if (typeof v === 'boolean') return { t: 'bool', v };
  return { t: 'str', v };
}

const escaping = {};
for (const c of escapingCases) {
  escaping[c] = {
    keyText: keyText(c),
    flowKeyText: flowKeyText(c),
    keyPortion: keyPortion(c),
    dq: dq(c),
  };
}

const scalars = {};
for (const c of scalarCases) scalars[c] = encodeValue(plainScalar(c).value);

const splits = {};
for (const c of splitCases) {
  const r = splitKV(c);
  splits[c] = r === null ? null : { key: r.key, rest: r.rest };
}

const unquotes = {};
for (const c of unquoteCases) {
  try {
    unquotes[c] = { ok: unquoteKey(c) };
  } catch {
    unquotes[c] = { threw: true };
  }
}

const folds = foldCases.map((lines) => ({ lines, out: foldLines(lines) }));

process.stdout.write(
  JSON.stringify({ escaping, scalars, splits, unquotes, folds }, null, 1) + '\n',
);
