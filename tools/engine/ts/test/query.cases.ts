// QUERY evaluator cases (PLAN.md 3g) — hand-derived expected results, NOT yet executed.
//
// This file is DATA, deliberately named so the test glob (*.test.ts) ignores it: the
// evaluator does not exist yet. The future query.test.ts will consume it as
//
//   for (const c of CASES) assert.deepEqual(evalQuery(fixture(c), c.q, c.from).map(r => r.path), c.expect);
//
// Every expectation below is hand-traced against QUERY.md §4-§6 and the CURRENT corpus
// (post anchor-refactor: reverse edges are authored as `&` path anchors; the deprecated
// `~` forms still parse). Cases run simple → complex. `expect: []` means ∅ (which per
// §5 may carry a dangling/external DIAGNOSTIC — noted per case, not modeled here).
//
// ── OPEN SPEC QUESTIONS these cases surface (decide before implementing) ──────────────
// (O1) RESULT ORDER: §5 says results sort by DOCUMENT order; §8's own examples list
//      `/playlist[?]` with the deref'd `/pets[0]` LAST (entry order) although /pets
//      precedes /playlist in the document. Cases below marked `open: 'O1'` use the §8
//      (entry/fan-out) order and also state the §5 order in the note. Pick one.
// (O2) ANCHORS vs WILDCARDS: §5 says wildcards match ENTRIES only — `?` never yields an
//      anchor-created key — yet `[?]` explicitly includes reverse-projected (ordinal-
//      anchor) members. That asymmetry (keyed anchor grafts invisible to `?`/`[?]`,
//      ordinal anchor members visible to `[?]`) is kept here as spec'd; confirm it.
// (O3) STALE WORDING (post ANCHOR_REFACTOR): §5 "a declared & anchor wins over a sibling
//      key" and §6's `chief` row describe the deleted precedence rule. Anchors are real
//      keys now; the RESULTS below are unchanged, the mechanism is plain path lookup
//      through the anchor-created key. QUERY.md needs that wording refreshed.

export interface QueryCase {
  /** The query text — a bare pointer expression (no `*`; §1.2). */
  q: string;
  fixture: 'inline' | '06-tour' | '58-genealogy' | '67-pdf-tags' | 'repo-root';
  /** Context node the query is asked at (canonical path); default = the document root. */
  from?: string;
  /** Canonical result paths, in expected order. [] = ∅. */
  expect: string[];
  note?: string;
  /** References an open question above. */
  open?: 'O1' | 'O2' | 'O3';
}

/** A small self-contained document for the simple cases (parseYamlover this text).
 *  Includes a pointer entry (deref), an ordinal anchor (the tagged-scalar shape),
 *  and keyed/keyless containers. */
export const INLINE_FIXTURE = `team:
  alice:
    age: 31
    pet: */pets[0]
  bob:
    age: 9
    pet: */pets[1]
pets:
  - name: Rex
    species: dog
  - name: Mia
    species: cat
thirty: 30
  &/tags/whole[]
tags:
  whole: Whole numbers
`;

export const CASES: QueryCase[] = [
  // ════ 1. Pointers are the singleton fragment (§6) — every result has |r| ≤ 1 ════
  { q: 'team/alice/age', fixture: 'inline', expect: ['/team/alice/age'],
    note: 'plain key walk; the scalar 31' },
  { q: '/pets[1]/species', fixture: 'inline', expect: ['/pets[1]/species'],
    note: 'document scope + integer key' },
  { q: '[1]', fixture: 'inline', expect: ['/pets'],
    note: 'bare position at the root: entry 1 of the root mapping' },
  { q: 'team/zoe', fixture: 'inline', expect: [],
    note: '∅ + a DANGLING diagnostic (§5 empty-vs-error) — never an evaluation error' },
  { q: '..', fixture: 'inline', from: '/team/alice', expect: ['/team'],
    note: 'parent scope from a non-root context' },
  { q: 'age', fixture: 'inline', from: '/team/alice', expect: ['/team/alice/age'],
    note: 'current scope = the context node' },
  { q: '../bob/age', fixture: 'inline', from: '/team/alice', expect: ['/team/bob/age'] },
  { q: 'team/alice/pet', fixture: 'inline', expect: ['/pets[0]'],
    note: 'implicit dereference: the result is the TARGET node, canonical path /pets[0]' },
  { q: 'team/alice/pet/name', fixture: 'inline', expect: ['/pets[0]/name'],
    note: 'stepping THROUGH a pointer entry, transitively' },

  // ════ 2. Wildcards: `?` (keyed) and `[?]` (all positions) — §4.1 ════
  { q: 'team/?', fixture: 'inline', expect: ['/team/alice', '/team/bob'] },
  { q: 'team/?/age', fixture: 'inline', expect: ['/team/alice/age', '/team/bob/age'] },
  { q: 'pets/?', fixture: 'inline', expect: [],
    note: 'pets has only keyless entries — the keyed wildcard finds nothing' },
  { q: 'pets[?]', fixture: 'inline', expect: ['/pets[0]', '/pets[1]'] },
  { q: 'pets[?]/name', fixture: 'inline', expect: ['/pets[0]/name', '/pets[1]/name'] },
  { q: 'team/?/pet', fixture: 'inline', expect: ['/pets[0]', '/pets[1]'],
    note: 'fan-out + deref: two walks, two distinct targets' },
  { q: '?', fixture: 'inline', expect: ['/team', '/pets', '/thirty', '/tags'],
    note: 'a query may OPEN with a wildcard (qseg at scope position, §3)' },
  { q: '?/age', fixture: 'inline', from: '/team', expect: ['/team/alice/age', '/team/bob/age'] },
  { q: '/tags/whole[?]', fixture: 'inline', expect: ['/thirty'],
    open: 'O2',
    note: 'the ordinal anchor on /thirty (`&/tags/whole[]`) makes /thirty a member of ' +
          '/tags/whole; [?] includes reverse-projected members (§4.1)' },
  { q: 'team/alice[?]', fixture: 'inline', expect: ['/team/alice/age', '/pets[0]'],
    note: 'all entries: contain (age) and deref’d ref (pet); entry order == document order here' },

  // ════ 3. `...` recursive descent (contain-only, descendant-or-self) — §4.2 ════
  { q: '...[scalar]', fixture: 'inline',
    expect: ['/team/alice/age', '/team/bob/age', '/pets[0]/name', '/pets[0]/species',
             '/pets[1]/name', '/pets[1]/species', '/thirty', '/tags/whole'],
    note: 'every scalar on the spine, pre-order; pet REFS are never crossed by descent. ' +
          'NB /thirty is a scalar — its ordinal anchor does not change its kind' },
  { q: 'team/...[scalar]', fixture: 'inline', expect: ['/team/alice/age', '/team/bob/age'] },
  { q: '/...[mapping]', fixture: 'inline',
    expect: ['/', '/team', '/team/alice', '/team/bob', '/pets', '/pets[0]', '/pets[1]', '/tags'],
    note: 'descendant-or-SELF: the root itself matches' },
  { q: 'thirty/...', fixture: 'inline', expect: ['/thirty'],
    note: 'descent from a leaf is just self' },

  // ════ 4. `~` reverse axis — §4.3 (over the normalized graph: forward ≡ ~ ≡ anchor) ════
  { q: '/thirty/~-', fixture: 'inline', expect: ['/tags/whole'],
    note: '"which containers hold me, keyless" — the ordinal anchor, walked backwards' },
  { q: '/tags/whole/~?', fixture: 'inline', expect: ['/tags'],
    note: 'incoming edges INTO whole: only the spine parent (the membership edge points ' +
          'whole → thirty, not into whole)' },
  { q: '/pets[0]/~?', fixture: 'inline', expect: ['/team/alice', '/pets'],
    note: 'find-usages incl. the spine parent; document order (/team/alice precedes /pets)' },
  { q: '/pets[0]/~pet', fixture: 'inline', expect: ['/team/alice'],
    note: 'keyed reverse: who holds a pet-labelled edge landing here' },
  { q: '/pets[0]/~?[ref]', fixture: 'inline', expect: ['/team/alice'],
    note: 'the [ref] filter drops the containment parent' },

  // ════ 5. Filters — §4.4 (non-navigating tests; chained brackets AND) ════
  { q: 'team/?[mapping]', fixture: 'inline', expect: ['/team/alice', '/team/bob'] },
  { q: '/thirty[scalar]', fixture: 'inline', expect: ['/thirty'] },
  { q: '/thirty[mapping]', fixture: 'inline', expect: [] },
  { q: '...[blob]', fixture: 'inline', expect: [],
    note: 'no blobs in the inline fixture (cf. the 67-pdf-tags case below)' },
  { q: 'team/alice[?][ref]', fixture: 'inline', expect: ['/pets[0]'],
    note: 'via-edge filter: only the pet entry arrived through a ref' },
  { q: 'team/alice[?][contain]', fixture: 'inline', expect: ['/team/alice/age'] },

  // ════ 6. 06-tour — wildcards/omni/anchors on the canonical tour (QUERY.md §8) ════
  { q: '/pets[?]/name', fixture: '06-tour',
    expect: ['/pets[0]/name', '/pets[1]/name', '/pets[2]/name'],
    note: 'Rex, Whiskers, Bubbles' },
  { q: '/pets/?', fixture: '06-tour', expect: [] },
  { q: '/playlist[?]', fixture: '06-tour',
    expect: ['/playlist[0]', '/playlist[1]', '/playlist/title', '/playlist[3]', '/pets[0]'],
    open: 'O1',
    note: '§8 order (entry order; encore deref’d to /pets[0] last). §5 document order ' +
          'would instead put /pets[0] FIRST — /pets precedes /playlist in the file' },
  { q: '/playlist/?', fixture: '06-tour', expect: ['/playlist/title', '/pets[0]'],
    open: 'O1' },
  { q: '/rating[?]', fixture: '06-tour',
    expect: ['/rating[0]', '/rating[1]', '/rating/scale', '/humans[0]'],
    open: 'O1',
    note: 'an omni node: positional + keyed fields; author deref’d to /humans[0]. ' +
          '§5 document order would put /humans[0] first' },
  { q: 'chief', fixture: '06-tour', expect: ['/boss'],
    open: 'O3',
    note: 'the &/chief anchor grafts boss as a ROOT key; from the root context the plain ' +
          'name reaches it (no namespace, no precedence — just the anchor-created key)' },
  { q: '/boss/~lead', fixture: '06-tour', expect: ['/team'] },
  { q: '/boss/~chief', fixture: '06-tour', expect: ['/'],
    note: 'the anchor-created edge, walked backwards: the root holds boss as `chief`' },
  { q: '/boss/~?', fixture: '06-tour', expect: ['/', '/team'],
    note: 'containment from /, ref via the anchor-created chief key (also from /, deduped), ' +
          'ref via team.lead' },
  { q: '/pets[1]/~?', fixture: '06-tour', expect: ['/', '/pets', '/humans[0]'],
    note: 'feline + secondPet both bind / (dedup); manager binds /humans[0]; spine /pets' },
  { q: '/pets[1]/~?[ref]', fixture: '06-tour', expect: ['/', '/humans[0]'],
    note: 'spine parent filtered out; / kept (feline/secondPet are refs)' },
  { q: '/fan/~-', fixture: '06-tour', expect: ['/favorites', '/crew'],
    note: 'both memberships are ordinal anchors on fan (`&/favorites[]`, `&/crew[]`); ' +
          'normalization invisibility: indistinguishable from forward authoring' },
  { q: '/favorites[?]', fixture: '06-tour', expect: ['/pets[0]', '/fan'],
    open: 'O2',
    note: 'own entry first, then the anchor-appended member' },
  { q: '/weird/...[scalar]', fixture: '06-tour', expect: ['/weird/cat\\/dog/n'],
    note: 'escaping in RESULT paths mirrors pointer escaping' },
  { q: '/weird/cat\\/dog/n', fixture: '06-tour', expect: ['/weird/cat\\/dog/n'],
    note: 'the literal-key pointer, as a singleton query' },

  // ════ 7. 58-genealogy — the DAG via the reverse axis (QUERY.md §8) ════
  { q: '/adam/cain/enoch/~enoch', fixture: '58-genealogy',
    expect: ['/adam/cain', '/adam/azura'],
    note: 'both parents: spine father + the maternal edge (authored as &/adam/azura/enoch)' },
  { q: '/eve/?', fixture: '58-genealogy',
    expect: ['/adam/cain', '/adam/seth', '/adam/azura'],
    note: 'her children, deref’d through her forward * edges' },
  { q: '/adam/?', fixture: '58-genealogy',
    expect: ['/adam/cain', '/adam/seth', '/adam/azura'] },
  { q: '/adam/cain/~cain', fixture: '58-genealogy', expect: ['/eve'],
    note: 'keyed reverse through the anchor-authored edge (&/eve/cain on cain)' },
  { q: '/adam/azura/~?', fixture: '58-genealogy', expect: ['/adam', '/eve'],
    note: 'her two parents: containment + eve’s ref (the both-ways pair folds to one edge)' },
  { q: '/adam/azura/~?[ref]', fixture: '58-genealogy', expect: ['/eve'] },
  { q: '/adam/...[mapping]', fixture: '58-genealogy',
    expect: ['/adam', '/adam/cain', '/adam/azura'],
    note: 'enoch and seth are null SCALARS carrying only anchors — anchors never change ' +
          'kind, so the [mapping] filter drops them; azura owns a ref entry → mapping' },
  { q: '/eve/?/~?', fixture: '58-genealogy', expect: ['/adam', '/eve'],
    note: 'fan-out then reverse then DEDUP: every child’s parents collapse to one pair' },

  // ════ 8. 67-pdf-tags — tags/membership idioms over real blobs (QUERY.md §7/§8) ════
  { q: '/tags/genre/humor/deadpan/?[ref]', fixture: '67-pdf-tags',
    expect: ['/jaba00061-0143a.pdf', '/1110.2832v2.pdf',
             '/1105-2_abstract_Is the sequence of earthquake in southern California, with aftershocks removed, Poissonian.pdf'],
    open: 'O1',
    note: 'members of a tag (slug order: writers-block, superluminal, earthquakes). ' +
          '§5 document order would be 1105…, 1110…, jaba…' },
  { q: '/tags/genre/brevity/?[contain]', fixture: '67-pdf-tags',
    expect: ['/tags/genre/brevity/shortest-paper', '/tags/genre/brevity/one-word-answer',
             '/tags/genre/brevity/empty-body'],
    note: 'sub-tags, not members' },
  { q: '/tags/genre/brevity/?[ref]', fixture: '67-pdf-tags', expect: [],
    note: 'brevity links no papers directly — only its sub-tags do' },
  { q: '/tags/genre/?/?[contain]', fixture: '67-pdf-tags',
    expect: ['/tags/genre/brevity/shortest-paper', '/tags/genre/brevity/one-word-answer',
             '/tags/genre/brevity/empty-body', '/tags/genre/humor/deadpan',
             '/tags/genre/humor/satire'],
    note: 'two wildcard levels: every sub-sub-tag under genre (annotation has none)' },
  { q: '/jaba00061-0143a.pdf/~?[ref]', fixture: '67-pdf-tags',
    expect: ['/tags/field/psychology/behavior-analysis', '/tags/genre/brevity/empty-body',
             '/tags/genre/humor/deadpan'],
    note: 'the paper’s three tags — its memberships are authored as keyed anchors ' +
          '(&/tags/…/writers-block) on the blob' },
  { q: '/jaba00061-0143a.pdf/~?[format=x-yamlover-tag]', fixture: '67-pdf-tags',
    expect: ['/tags/field/psychology/behavior-analysis', '/tags/genre/brevity/empty-body',
             '/tags/genre/humor/deadpan'],
    note: 'equivalent spelling of "tags applied to this node" (§7 idiom)' },
  { q: '/jaba00061-0143a.pdf/~?', fixture: '67-pdf-tags',
    expect: ['/', '/tags/field/psychology/behavior-analysis', '/tags/genre/brevity/empty-body',
             '/tags/genre/humor/deadpan'],
    note: 'unfiltered find-usages adds the spine parent (the served root)' },
  { q: '/...[blob]', fixture: '67-pdf-tags',
    expect: ['/1105-2_abstract_Is the sequence of earthquake in southern California, with aftershocks removed, Poissonian.pdf',
             '/1110.2832v2.pdf', '/Chemical-Free.pdf', '/jaba00061-0143a.pdf',
             '/S0002-9904-1966-11654-3.pdf'],
    note: 'document order for a directory concrete = the walker’s (filesystem) order; ' +
          'the tags subtree holds no blobs' },

  // ════ 9. The graft — link scope against the repo root (QUERY.md §8) ════
  { q: '//yamlover/tags/...[format=x-yamlover-tag]', fixture: 'repo-root',
    expect: ['//yamlover/tags', '//yamlover/tags/colors',
             '//yamlover/tags/colors/yellow', '//yamlover/tags/colors/green',
             '//yamlover/tags/colors/sky', '//yamlover/tags/colors/mauve',
             '//yamlover/tags/colors/pink', '//yamlover/tags/colors/peach'],
    note: 'THE TAG-PICKER QUERY (§7): descendant-or-self, format-filtered — the `color` ' +
          'scalars fail the test. Link-scope results keep the //yamlover prefix' },
  { q: '//yamlover/tags/colors/?/color', fixture: 'repo-root',
    expect: ['//yamlover/tags/colors/yellow/color', '//yamlover/tags/colors/green/color',
             '//yamlover/tags/colors/sky/color', '//yamlover/tags/colors/mauve/color',
             '//yamlover/tags/colors/pink/color', '//yamlover/tags/colors/peach/color'],
    note: 'six hex scalars (#f9e2af, #a6e3a1, #89dceb, #cba6f7, #f5c2e7, #fab387)' },
  { q: '//unmounted.example/x', fixture: 'repo-root', expect: [],
    note: '∅ + an EXTERNAL diagnostic (§5): a link is an identifier, not a fetch' },
];

// ── Conformance obligations beyond the cases (QUERY.md §6) ────────────────────────────
// 1. Every pointer case in resolve.test.ts run through evalQuery() must yield the
//    resolver's target as a singleton, or ∅ exactly when the resolver says unresolved.
// 2. |evalQuery(p)| ≤ 1 for every pointer-shaped query p (no qseg/filter productions).
// 4. Normalization invisibility: evaluating any case above over the authored IR and
//    over normalize(buildGraph(doc)) gives identical results — the anchor-vs-forward
//    authoring in 58/67 is the natural stress test.
// 5. Determinism: each case's expect[] is stable across runs and re-indexes.
