/**
 * QUERY evaluator cases (PLAN.md 3g) — the acceptance corpus, in the COLON grammar
 * (SEPARATOR.md) with every M-ruling applied. Consumed by query.test.ts:
 *
 *   for (const c of CASES) assert.deepEqual(evalQuery(store(c), c.q, c.from), c.expect);
 *
 * Result paths are COMPACT COLON store paths (M4): `:team:alice:age`, root `:`.
 *
 * ── Semantics encoded here (the rulings) ──────────────────────────────────────────────
 * O1  Result ORDER is walk/entry order: members arrive in their container's document
 *     order, a deref'd member keeps its position; dedup by path keeps the FIRST hit.
 * O2  Wildcards ENUMERATE anchor-created entries: `?` sees keyed anchor grafts, `[?]`
 *     sees those plus ordinal (`&…[]`) memberships — appended after the container's own
 *     entries. `[n]` never addresses an anchor-created entry (no position claims).
 * M1  No edge-kind test in v1 — member-vs-subtag splits use node-shape matchers.
 * M2  `..` = the spine parent (≤1); `?..` = ALL parents (holders of contain/ref edges
 *     into me + containers I'm an ordinal member of); `key..` = the parent who knows me
 *     as `key`; `[]..` = keyless holders only.
 * M4  Matchers: `!!<…>` carries META vocabulary (`type:`, `format:`) or a schema
 *     pointer (`!!<*…>` — conformance, equivalent to the derived x-yamlover-<name>
 *     format). Scalar matchers: bare numbers/true/false/null test the value; STRING
 *     value tests are always spelled with `=` (`=female`, `='Анна Каренина'`) because a
 *     bare word (and a quoted portion) is a KEY step. Comparisons: > >= < <= != .
 *     A portion `TEST key` (space-split) tests the current node, then steps.
 */

export interface QueryCase {
  /** The query text — a bare colon-form pointer/query expression (no `*`). */
  q: string;
  fixture: 'inline' | '06-tour' | '58-genealogy' | '67-pdf-tags' | 'graft';
  /** Context node (compact colon store path); default = the fixture's root `:`. */
  from?: string;
  /** Compact colon result paths, in walk order, deduped. [] = ∅. */
  expect: string[];
  note?: string;
}

/** A small self-contained document for the simple cases (parseYamlover this text). */
export const INLINE_FIXTURE = `team:
  alice:
    age: 31
    pet: *: pets[0]
  bob:
    age: 9
    pet: *: pets[1]
pets:
  - name: Rex
    species: dog
  - name: Mia
    species: cat
thirty: 30
  &: tags: whole[]
tags:
  whole: Whole numbers
`;

/** The graft fixture is a TEMP project tree (built by query.test.ts):
 *    $defs/tag                     — "type: object\nformat: x-yamlover-tag\n"
 *    tags/.yamlover/body.yamlover  — a palette: yellow + green tags with explicit colors
 *    data.yamlover                 — "x: 1\n"
 *  walkDir grafts the self-import key `yamlover` → {$defs, tags} into the root. */

export const CASES: QueryCase[] = [
  // ════ 1. Pointers are the singleton fragment — |result| ≤ 1 ════
  { q: 'team: alice: age', fixture: 'inline', expect: [':team:alice:age'] },
  { q: ': pets[1]: species', fixture: 'inline', expect: [':pets[1]:species'],
    note: 'document scope + integer key' },
  { q: '[1]', fixture: 'inline', expect: [':pets'],
    note: 'bare position at the root: entry 1 of the root mapping' },
  { q: 'team: zoe', fixture: 'inline', expect: [],
    note: '∅ (a dangling diagnostic, not an error)' },
  { q: '..', fixture: 'inline', from: ':team:alice', expect: [':team'],
    note: 'the SPINE parent (M2 — unambiguous, link-legal)' },
  { q: 'age', fixture: 'inline', from: ':team:alice', expect: [':team:alice:age'] },
  { q: '..: bob: age', fixture: 'inline', from: ':team:alice', expect: [':team:bob:age'] },
  { q: 'team: alice: pet', fixture: 'inline', expect: [':pets[0]'],
    note: 'implicit deref: the result is the TARGET node' },
  { q: 'team: alice: pet: name', fixture: 'inline', expect: [':pets[0]:name'] },

  // ════ 2. Wildcards `?` / `[?]` ════
  { q: 'team: ?', fixture: 'inline', expect: [':team:alice', ':team:bob'] },
  { q: 'team: ?: age', fixture: 'inline', expect: [':team:alice:age', ':team:bob:age'] },
  { q: 'pets: ?', fixture: 'inline', expect: [],
    note: 'pets has only keyless entries' },
  { q: 'pets[?]', fixture: 'inline', expect: [':pets[0]', ':pets[1]'] },
  { q: 'pets[?]: name', fixture: 'inline', expect: [':pets[0]:name', ':pets[1]:name'] },
  { q: 'team: ?: pet', fixture: 'inline', expect: [':pets[0]', ':pets[1]'] },
  { q: '?', fixture: 'inline', expect: [':team', ':pets', ':thirty', ':tags'],
    note: 'a query may open with a wildcard' },
  { q: '?: age', fixture: 'inline', from: ':team', expect: [':team:alice:age', ':team:bob:age'] },
  { q: ': tags: whole[?]', fixture: 'inline', expect: [':thirty'],
    note: 'O2: [?] sees the ordinal (&…[]) membership appended by /thirty' },
  { q: 'team: alice[?]', fixture: 'inline', expect: [':team:alice:age', ':pets[0]'],
    note: 'all entries in order: contain (age), then the deref’d ref (pet)' },
  { q: ': tags: whole[0]', fixture: 'inline', expect: [],
    note: 'O2: [n] never addresses an anchor-created member (no position claims)' },

  // ════ 3. `...` recursive descent (contain-only, descendant-or-self, pre-order) ════
  { q: '...: !!<type: string>', fixture: 'inline',
    expect: [':pets[0]:name', ':pets[0]:species', ':pets[1]:name', ':pets[1]:species', ':tags:whole'],
    note: 'string scalars on the spine (ages and /thirty are integers)' },
  { q: '...: !!<type: integer>', fixture: 'inline',
    expect: [':team:alice:age', ':team:bob:age', ':thirty'],
    note: '/thirty stays an integer — its ordinal anchor never changes its kind' },
  { q: 'team: ...: !!<type: integer>', fixture: 'inline',
    expect: [':team:alice:age', ':team:bob:age'] },
  { q: ': ...: !!<type: object>', fixture: 'inline',
    expect: [':', ':team', ':team:alice', ':team:bob', ':pets[0]', ':pets[1]', ':tags'],
    note: 'descendant-or-SELF; pets itself is an ARRAY (dropped) but its ITEMS are objects' },
  { q: ': ...: !!<type: array>', fixture: 'inline', expect: [':pets'] },
  { q: 'thirty: ...', fixture: 'inline', expect: [':thirty'],
    note: 'descent from a leaf is just self' },

  // ════ 4. The uplink family (M2) — replaces the old `~` axis ════
  { q: ': thirty: []..', fixture: 'inline', expect: [':tags:whole'],
    note: '"which containers hold me keyless" — the ordinal anchor walked backwards' },
  { q: ': tags: whole: ?..', fixture: 'inline', expect: [':tags'],
    note: 'ALL parents of whole: only the spine (the membership edge leaves whole)' },
  { q: ': pets[0]: ?..', fixture: 'inline', expect: [':pets', ':team:alice'],
    note: 'all parents: the spine holder first, then ref holders' },
  { q: ': pets[0]: pet..', fixture: 'inline', expect: [':team:alice'],
    note: 'the parent who knows me as `pet`' },
  { q: ': pets[0]: ..', fixture: 'inline', expect: [':pets'],
    note: 'spine only — unambiguous' },

  // ════ 5. Matchers ════
  { q: 'team: ?: !!<type: object>', fixture: 'inline', expect: [':team:alice', ':team:bob'] },
  { q: ': thirty: !!<type: integer>', fixture: 'inline', expect: [':thirty'] },
  { q: ': thirty: !!<type: object>', fixture: 'inline', expect: [] },
  { q: '...: !!<type: binary>', fixture: 'inline', expect: [],
    note: 'no blobs in the inline fixture (cf. 67-pdf-tags below)' },
  { q: 'team: ?: age: >10', fixture: 'inline', expect: [':team:alice:age'],
    note: 'standalone scalar matcher: test without moving' },
  { q: 'team: ?: age: <10', fixture: 'inline', expect: [':team:bob:age'] },
  { q: 'team: ?: age: 31', fixture: 'inline', expect: [':team:alice:age'],
    note: 'bare number = equality test' },
  { q: 'team: ?: age: !=31', fixture: 'inline', expect: [':team:bob:age'] },
  { q: 'pets[?]: species: =cat', fixture: 'inline', expect: [':pets[1]:species'],
    note: 'string equality is ALWAYS spelled with = (a bare word is a key step)' },
  { q: ': thirty: 30 ..', fixture: 'inline', expect: [':'],
    note: 'combo portion: value-test the current node (30 ✓ on /thirty), then step (up)' },

  // ════ 6. 06-tour ════
  { q: ': pets[?]: name', fixture: '06-tour',
    expect: [':pets[0]:name', ':pets[1]:name', ':pets[2]:name'] },
  { q: ': playlist[?]', fixture: '06-tour',
    expect: [':playlist[0]', ':playlist[1]', ':playlist:title', ':playlist[3]', ':pets[0]'],
    note: 'O1 entry order: encore (a deref’d member) keeps its 5th position' },
  { q: ': playlist: ?', fixture: '06-tour', expect: [':playlist:title', ':pets[0]'] },
  { q: ': rating[?]', fixture: '06-tour',
    expect: [':rating[0]', ':rating[1]', ':rating:scale', ':humans[0]'],
    note: 'omni fields in entry order; author deref’d last' },
  { q: ': rating: 5 scale', fixture: '06-tour', expect: [':rating:scale'],
    note: 'the user’s combo: an omni node with value 5 AND key scale; walk continues' },
  { q: ': rating: !!<type: variant>', fixture: '06-tour', expect: [':rating'],
    note: 'META’s name for value-plus-fields' },
  { q: 'chief', fixture: '06-tour', expect: [':boss'],
    note: 'the &: chief anchor grafts boss as a ROOT key — plain lookup finds it' },
  { q: '?', fixture: '06-tour', from: ':team', expect: [':boss'],
    note: 'team’s only keyed entry is lead → deref’d to :boss' },
  { q: ': boss: lead..', fixture: '06-tour', expect: [':team'] },
  { q: ': boss: chief..', fixture: '06-tour', expect: [':'],
    note: 'the anchor-created edge walked backwards: the root holds boss as chief' },
  { q: ': boss: ?..', fixture: '06-tour', expect: [':', ':team'],
    note: 'spine (:), the anchor graft (also :, deduped), team.lead' },
  { q: ': pets[1]: ?..', fixture: '06-tour', expect: [':pets', ':humans[0]', ':'],
    note: 'spine first, then ref holders in EDGE order (manager precedes feline in the walk)' },
  { q: ': fan: []..', fixture: '06-tour', expect: [':favorites', ':crew'],
    note: 'both ordinal-anchor memberships (&: favorites[] / &: crew[])' },
  { q: ': favorites[?]', fixture: '06-tour', expect: [':pets[0]', ':fan'],
    note: 'own entry first, then the anchored member (O2)' },
  { q: ': weird: ...: !!<type: integer>', fixture: '06-tour',
    expect: [':weird:cat:dog:n', ':weird:cat/dog'],
    note: 'store paths join RAW keys — a key containing ":" embeds bare (the known, ' +
          'inherited store-path ambiguity); cat/dog rides bare too' },
  { q: ': weird: cat\\:dog: n', fixture: '06-tour', expect: [':weird:cat:dog:n'],
    note: 'the QUERY escapes the literal colon; the store path is raw' },

  // ════ 7. 58-genealogy — the DAG via uplinks ════
  { q: ': adam: cain: enoch: enoch..', fixture: '58-genealogy',
    expect: [':adam:cain', ':adam:azura'],
    note: 'both parents: spine father + the maternal edge (&: adam: azura: enoch)' },
  { q: ': eve: ?', fixture: '58-genealogy',
    expect: [':adam:cain', ':adam:seth', ':adam:azura'] },
  { q: ': adam: ?', fixture: '58-genealogy',
    expect: [':adam:cain', ':adam:seth', ':adam:azura'] },
  { q: ': adam: cain: cain..', fixture: '58-genealogy', expect: [':adam', ':eve'],
    note: 'containment and refs are ONE relation kind: the spine father also knows him as cain' },
  { q: ': adam: azura: ?..', fixture: '58-genealogy', expect: [':adam', ':eve'],
    note: 'her two parents: containment + eve’s ref (both-ways pair folds to one)' },
  { q: ': adam: azura: ..', fixture: '58-genealogy', expect: [':adam'],
    note: 'spine only' },
  { q: ': eve: ?: ?..', fixture: '58-genealogy', expect: [':adam', ':eve'],
    note: 'fan-out, then up, then dedup: every child’s parents collapse to one pair' },

  // ════ 8. 67-pdf-tags — tag idioms over real blobs ════
  { q: ': tags: genre: humor: deadpan: ?..: ?..: !!<type: binary>', fixture: '67-pdf-tags',
    expect: [':1105-2_abstract_Is the sequence of earthquake in southern California, with aftershocks removed, Poissonian.pdf',
             ':1110.2832v2.pdf', ':jaba00061-0143a.pdf'],
    note: 'members of a tag (embedded model): tag ← yamlover-annotations array ← paper, binaries only' },
  { q: ': tags: genre: brevity: ?: !!<*:: yamlover: $defs: tag>', fixture: '67-pdf-tags',
    expect: [':tags:genre:brevity:shortest-paper', ':tags:genre:brevity:one-word-answer',
             ':tags:genre:brevity:empty-body'],
    note: 'SUB-TAGS via schema-conformance (M1: no edge test — node shape decides)' },
  { q: ': tags: genre: brevity: ?: !!<type: binary>', fixture: '67-pdf-tags', expect: [],
    note: 'brevity links no papers directly' },
  { q: ': tags: genre: ?: ?: !!<*:: yamlover: $defs: tag>', fixture: '67-pdf-tags',
    expect: [':tags:genre:brevity:shortest-paper', ':tags:genre:brevity:one-word-answer',
             ':tags:genre:brevity:empty-body', ':tags:genre:humor:deadpan',
             ':tags:genre:humor:satire'],
    note: 'two wildcard levels: every sub-sub-tag under genre' },
  { q: ': jaba00061-0143a.pdf: yamlover-annotations: [?]: !!<format: x-yamlover-tag>', fixture: '67-pdf-tags',
    expect: [':tags:field:psychology:behavior-analysis', ':tags:genre:brevity:empty-body',
             ':tags:genre:humor:deadpan'],
    note: '"tags applied to this node" — its yamlover-annotations members (FORWARD, embedded model), format-filtered' },
  { q: ': jaba00061-0143a.pdf: ?..', fixture: '67-pdf-tags',
    expect: [':'],
    note: 'reverse axis on a tagged blob: its only parent is the containment root — tags are now DOWNSTREAM (via yamlover-annotations), not parents' },
  { q: ': ...: !!<type: binary>', fixture: '67-pdf-tags',
    expect: [':1105-2_abstract_Is the sequence of earthquake in southern California, with aftershocks removed, Poissonian.pdf',
             ':1110.2832v2.pdf', ':Chemical-Free.pdf', ':S0002-9904-1966-11654-3.pdf',
             ':jaba00061-0143a.pdf'],
    note: 'every blob, in walk (filesystem) order; the tags/graft subtrees hold none' },

  // ════ 9. The self-import graft (synthetic project fixture) ════
  // The fixture IS a project root (its own $defs/tags), so the `yamlover` self-import is
  // DE-MATERIALIZED (walk.ts) and `:: yamlover: X` is ABSORBED to the REAL `:X` — no duplicate
  // `:yamlover:…` nodes. So `::X` and `::yamlover:X` reach the SAME node, not distinct copies.
  { q: ':: yamlover: tags: colors: ?', fixture: 'graft',
    expect: [':tags:colors:yellow', ':tags:colors:green'],
    note: 'the palette enumerated through the (virtual) self-import key → the real nodes' },
  { q: ':: yamlover: tags: ...: !!<format: x-yamlover-tag>', fixture: 'graft',
    expect: [':tags', ':tags:colors', ':tags:colors:yellow', ':tags:colors:green'],
    note: 'THE TAG-PICKER QUERY: descendant-or-self, format-filtered (color scalars drop)' },
  { q: ':: yamlover: tags: colors: ?: color', fixture: 'graft',
    expect: [':tags:colors:yellow:color', ':tags:colors:green:color'] },
  { q: ':: tags: colors: yellow', fixture: 'graft', expect: [':tags:colors:yellow'],
    note: 'self-import synonymy: ::X and ::yamlover:X now reach the SAME real node ' +
          '(graft de-materialized — no duplicate :yamlover: subtree)' },
  { q: ':: nowhere: x', fixture: 'graft', expect: [],
    note: '∅ + an external/dangling diagnostic — never an error' },
];
