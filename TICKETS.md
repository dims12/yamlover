# TICKETS — tasks, tickets & study cards

A **task** (a.k.a. ticket) is a yamlover node of a defined shape: a readable document that
also carries planning state and can evolve through a lifecycle. The same shape, with chunks
tagged as a quiz, doubles as an **Anki-like study card** with spaced-repetition scheduling.

The whole feature is built by **reuse**, not by inventing parallel machinery:

| concern | reuses |
|---|---|
| body (title, description, positional chunks + subtasks) | `$defs/chapter` (`CHAPTER.md`, `$defs/chapter`) |
| lifecycle state (backlog → done, due, postponed) | **tags** + **tag applications** (`ANNOTATIONS.md`, `$defs/tag`) |
| transitions / state machine | the tag **or-graph** — `next:` ref edges between state tags |
| planning fields, scheduling fields | **parametrized annotations** (`additionalProperties: true`) |
| boards, decks | directory views + the **unified change flow** (SSE) |
| "what should the AI do next" | the **query language** (`QUERY.md`) |

Companion specs: `YAMLOVER.md` (omni, chapters), `CHAPTER.md` (the model `task` extends) /
`MARKLOWER.md` (the prose a task body is written in), `ANNOTATIONS.md` (fragments + tag
applications), `META.md` / `TYPES.md` (`$defs`, facets, `variant`), `SEPARATOR.md` / `URIs.md`
(the `::` project scope, `*` deref, ref vs contain), `QUERY.md` (selecting tasks).

---

## 1. The `task` schema

A task **IS-A chapter** (CHAPTER.md): it EXTENDS `$defs/chapter` with `allOf: [*chapter]`,
inheriting the optional `title`/`description` and the omni **positional body** — where its
subchapter recursion means **subtasks** (a task tree) — **plus** a handful of **optional**
structured fields for planning and automation. It carries **no `state` field**: state is a tag
application (§2), so the entire tag / board machinery is reused.

Every planning field is optional — *defaults-never-constraints* (`settings.yamlover` ethos): an
untouched task is just a titled note; it becomes a tracked ticket the moment it is tagged with a
state, and a study card the moment its body chunks are tagged as a quiz.

```yamlover
# $defs/task — attach with  !!<*yamlover:$defs:task>
allOf:
  - *:: yamlover: $defs: chapter        # a task IS-A chapter (title/description + omni body)
type: variant
items:                                 # narrow the body recursion to SUBTASKS (the task tree)
  anyOf:
    - *:: yamlover: $defs: task
    - *:: yamlover: $defs: chunk
properties:
  priority:     {type: string}         # free ordinal: low | normal | high | urgent (advisory)
  due:          {type: string, format: date-time}
  assignee:     {type: string}         # a name, or a pointer to a person / agent node
  depends:                             # "blocked-by" edges → other tasks (ref, the DAG)
    type: array
    items: *:: yamlover: $defs: task
  estimate:     {type: string}         # free: "2h", "3pt"
  # answer / solution: {schema}        # DEFERRED — grading-as-validation, see §6
```

`allOf` is the (provisional) JSON-Schema way to say "a task is a chapter plus more"; because
`task ⊆ chapter`, narrowing the body union to `task | chunk` intersects with the inherited
`chapter | chunk` to exactly `task | chunk` — subtasks, not subchapters.

A minimal task as a standalone file:

```yamlover
# write-tickets-spec.yamlover
!!<*yamlover:$defs:task>
title: Write the TICKETS spec
description: Draft `TICKETS.md` reusing chapters + tags.
priority: high
assignee: claude
- Capture the task schema and the state-as-tag model.
- Include the Anki / SM-2 section.
yamlover-annotations:
- *::tags:workflow:dev:in-progress        # ← the current state (see §2)
```

Subtasks are positional body elements that are themselves tasks (a `- title: …` element with its
own body); a flat **board** is instead a *directory of task files* (§5). Both are valid and
composable.

---

## 2. State is a tag — the workflow taxonomy

A task's lifecycle position is **one tag application** on the task root
(`yamlover-annotations`), pointing into a **workflow**: a tag whose contained sub-tags are its
**states**. The states ship in the project tag taxonomy (`settings.yamlover` → `tags.location`),
reached in project scope as `*::tags:workflow:<name>:<state>`.

```yamlover
# tags/.yamlover/body.yamlover  (excerpt)
workflow: Lifecycles
  dev: !!<*yamlover:$defs:workflow> Software task lifecycle
    initial: *::tags:workflow:dev:backlog          # ref → the start state
    backlog:     !!omni Captured, not yet refined
      color: "#9399b2"
      next: *::tags:workflow:dev:ready
    ready:       !!omni Refined, ready to pick up
      next: *::tags:workflow:dev:in-progress
    in-progress: !!omni Being worked on
      next:                                         # several successors ⇒ a sequence of refs
      - *::tags:workflow:dev:done
      - *::tags:workflow:dev:cancelled
    done:        !!omni Completed                   # no `next:` ⇒ TERMINAL (derived)
      color: "#a6e3a1"
    cancelled:   !!omni Dropped
      color: "#f38ba8"
```

### 2.1 Why states-as-tags, and `next:` as ref edges

- **States are ordinary `$defs/tag` nodes.** They get badges, colors, descriptions, the tag
  picker, and `/api/tagged` reverse lookup for free. "Everything is a tag."
- **Transitions are `next:` REF edges, not containment.** Because the value is a *pointer*, the
  entry is a **ref member**, not a contained sub-tag (the contain-vs-ref / `reverse-members-not-type`
  rule). So `done` is cross-linked from `in-progress` in the or-graph **without** being nested
  under it — each state lives once, under the workflow. The board renderer reads `next` as
  transitions; it never shows them as child tags.
- **No `$defs/state` schema is needed.** `initial` (on the workflow) and `next` (on each state)
  are ref edges; **terminal** is *derived* (no outgoing `next`). The only thing that *can't* be a
  bare extra key on a tag is a scalar attribute (a boolean body would be misread as a contained
  sub-tag) — and the structure means we need none.

### 2.2 Transitions are ADVISORY

The engine permits **any** state change — `defaults-never-constraints`. `next:` exists to
**guide**: the board offers the `next` states as the highlighted moves, autocomplete suggests
them, the AI prefers them. A drop onto a non-`next` column is allowed (and may be visually
flagged). Nothing rejects an "illegal" transition.

### 2.3 The current state, derived

A task's **current state** = the single `yamlover-annotations` element that resolves to a state
of a given workflow. By convention a task holds **at most one** state per workflow; if more than
one is present the UI surfaces the most recent and flags it. Changing state = rewrite that one
annotation (remove the old state pointer, add the new) — through the normal annotation write path,
announced over SSE like every other change (`unified-change-flow`).

### 2.4 The `$defs/workflow` marker

```yamlover
# $defs/workflow — a state machine expressed as a TAG whose CONTAINED sub-tags are its states
# (each an ordinary $defs/tag). `initial:` is a ref to the start state; transitions are each
# state's `next:` ref(s); a terminal state has no outgoing `next`. Transitions are ADVISORY.
# format x-yamlover-workflow lets the board renderer recognize it and order its lanes.
# Attach with  !!<*yamlover:$defs:workflow>.
type: variant
format: x-yamlover-workflow
value: {type: string, format: text/marklower}    # the workflow's description (its body)
properties:
  initial: *:: yamlover: $defs: tag               # ref → the start state
additionalProperties: *:: yamlover: $defs: tag    # every other key is a STATE (a plain tag)
```

Multiple workflows coexist (`dev`, `srs`, a publishing pipeline, …). A task may carry a state
from more than one (e.g. a dev state **and** an SRS state) — they are independent annotations.

---

## 3. The agile board renderer

A **directory whose entries are `$defs/task` nodes** gains a **Board view**, beside the existing
directory views (explorer grid, thumbnails gallery — `explorer-renderer`, `extractor-registry`).

- **Lanes** = the workflow's states, in spine order, refined by `next` topology. The board's
  workflow is taken from a `workflow: *::tags:workflow:<name>` key on the directory overlay
  (`.yamlover/body.yamlover`); absent, it is **inferred** from the state tags the tasks actually
  carry. A saved `lanes:` block overrides the seed — each lane is a single tag, or a list of
  tags giving per-tag **sublanes** stacked vertically inside the lane.
- **Cards** = the tasks: title, priority chip, assignee, due, and (when present) the first chunk
  or a thumbnail as a preview.
- **Drag a card between lanes** = a **state change**: rewrite that task's state annotation
  (§2.3) via the annotation write endpoint. `next` lanes are the highlighted drop targets;
  others are allowed (advisory). The move is announced over SSE, so every open surface (the board,
  the task page, any query view) refreshes through `useDiffBump`.
- **Empty-lane / WIP** affordances and ordering within a lane (by `priority`, then `due`) are
  presentation; the data is just tasks + their state annotations.

The same directory still opens as a plain file grid; **Board** is a view toggle, offered when the
directory is task-dense.

---

## 4. Study cards — quiz structure + SM-2 scheduling

An **Anki-like card is a task** whose `chunks` are tagged with a small **card** taxonomy, and
whose review schedule is an **SM-2** state carried on a parametrized annotation. No new node type.

### 4.1 Quiz structure = chunk tags

Chunks already carry their own `yamlover-annotations` (the omni block-scalar form, `ANNOTATIONS.md`
§3). Tag them with the `card` taxonomy:

```yamlover
# tags/.yamlover/body.yamlover  (excerpt)
card: Study-card roles
  question:       The prompt side
  answer:         The single correct answer (Q/A card)
  answer-variant: One option of a multiple-choice card
  correct:        Marks an answer-variant as correct
  hint:           Optional progressive hint
```

A multiple-choice card:

```yamlover
!!<*yamlover:$defs:task>
title: Capital of France
- !!var What is the capital of France?
  yamlover-annotations: [ *::tags:card:question ]
- !!var Paris
  yamlover-annotations: [ *::tags:card:answer-variant, *::tags:card:correct ]
- !!var Lyon
  yamlover-annotations: [ *::tags:card:answer-variant ]
- !!var Marseille
  yamlover-annotations: [ *::tags:card:answer-variant ]
yamlover-annotations:
- tag: *::tags:workflow:srs:review                # ← SM-2 scheduling state (below)
  due:           2026-06-20
  ease:          2.5
  interval:      6
  reps:          3
  lapses:        0
  last-reviewed: 2026-06-14
```

A plain Q/A card is one `question` chunk + one `answer` chunk. Cloze-deletion cards can later
reuse **fragments** (a `cloze` tag on a text fragment) — forward-compatible, out of scope here.

A **deck** is just a directory of card-tasks (or a tag grouping them); the Board view's workflow
is then `srs` instead of `dev`.

### 4.2 SRS state = a parametrized annotation

"Postponed until" is exactly your anticipated case: a **state tag that carries fields**. The SRS
state lives as a *parametrized* `yamlover-annotations` element (`$defs/annotation` already allows
`additionalProperties: true`) into an `srs` workflow:

```yamlover
srs: !!<*yamlover:$defs:workflow> Spaced-repetition lifecycle
  initial: *::tags:workflow:srs:new
  new:       !!omni Never studied
    next: *::tags:workflow:srs:learning
  learning:  !!omni In the short-interval learning steps
    next: *::tags:workflow:srs:review
  review:    !!omni Scheduled by SM-2; carries the due date + algorithm fields
    next: *::tags:workflow:srs:suspended
  suspended: !!omni Excluded from review until un-suspended
```

The scheduling fields ride on the **annotation that applies the `review` state** (so they travel
with this card's application of the state, not with the shared state tag):

| field | meaning |
|---|---|
| `due` | date-time the card next becomes reviewable ("postponed until") |
| `ease` | SM-2 E-Factor, ≥ 1.3 (starts 2.5) |
| `interval` | days until next review |
| `reps` | consecutive successful reviews |
| `lapses` | times graded *again* after leaving learning |
| `last-reviewed` | date-time of the last grade |

### 4.3 The SM-2 algorithm (grading)

A review **grade** maps to an SM-2 quality `q`:

| button | `q` |
|---|---|
| again | 2 (fail) |
| hard  | 3 |
| good  | 4 |
| easy  | 5 |

On grade, recompute the fields on the `review` annotation:

```
if q < 3:                         # "again" — lapse
    reps     = 0
    interval = 1                  # re-enter learning steps
    lapses  += 1
    state    = learning           # (re-point the annotation; ease unchanged here)
else:
    if   reps == 0: interval = 1
    elif reps == 1: interval = 6
    else:           interval = round(interval * ease)
    reps    += 1
    ease     = max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))
    state    = review

due           = today + interval days
last-reviewed = now
```

Grading is an engine action that rewrites the parametrized annotation in place and announces the
diff over SSE — the same write path as any state change. "Due today" cards are then a **query**.

---

## 5. Selecting tasks — boards, queues, and the AI loop

Because tasks, states, due dates, and assignees are all ordinary graph data, **what to work on
next is a query** (`QUERY.md`, colon grammar, `GET /api/query`). Sketches:

- **A column of a board** — tasks in a given state:
  `... !!<*::tags:workflow:dev:in-progress>` (nodes annotated with that state).
- **The AI's queue** — ready work assigned to the agent:
  ready-state tasks whose `assignee` resolves to the agent, ordered by `priority`/`due`.
- **Due cards** — `review`-state cards whose `due ≤ today` (a comparison filter, `QUERY.md` §9).
- **Blocked work** — tasks whose `depends` targets are not yet `done` (reverse axis over the
  blocked-by edges).

This is what makes the structure *agentic*: an AI assistant polls "ready & assigned to me," does
the work, and **advances state** by rewriting the one state annotation (§2.3) — moving the card
across the board, visible live to the human via SSE. The advisory `next:` edges tell the agent
which transition is the expected one.

---

## 6. (DEFERRED) Answers as schemas, solutions as instances

> **Status: deferred.** This recasts grading as *schema validation*, which depends on the
> schema **validator** that `PLAN.md` / `build-plan` currently defers (yamlover is instance-only
> today). The hand-tagged model of §4.1 (`correct` on a chunk) is the shippable subset; this
> section is the target it grows into, and the main motivation to turn validation on. Captured
> now so the `task` schema stays forward-compatible.

**The reframe.** An answer is a **schema** (an ordinary yamlover meta node — `$defs`-flavored),
the response is an **instance**, and **grading is validation** of the instance against the schema.
That collapses many card types into one mechanism, and unifies a quiz *answer* with a dev ticket's
*definition-of-done*: the same field, the same validator, whether the instance is "Paris" or a
code artifact.

A new **optional** field on `$defs/task` (§1) holds it — `answer:` (alias `solution:`), whose
value **is a schema**:

```yamlover
answer: {enum: [Paris, paris]}            # accepted answers — synonyms ok
# or, multiple-choice exactly-one:
answer: {oneOf: [{const: Paris}, {const: Lyon}, {const: Marseille}]}
# or, numeric with tolerance:
answer: {type: number, minimum: 41.5, maximum: 42.5}
# or, a structured / fill-the-form answer:
answer:
  type: object
  properties: {subject: {const: cat}, verb: {const: sat}, object: {const: mat}}
```

**Pick the right combinator** — "alternative answers" is not always `oneOf`:

| combinator | grading rule |
|---|---|
| `const` / `enum` | one correct value (with accepted synonyms) |
| `oneOf` | multiple choice, **exactly one** subschema matches |
| `anyOf` | **any of several** acceptable |
| `minimum` / `maximum` | numeric tolerance band |
| object `properties` | structured answer — instantiating the shape correctly *is* the solution |

**Two payoffs that fit the grain.**
- **Correctness becomes derived, not duplicated.** The `correct` tag (§4.1) is no longer the
  source of truth — the schema is the single oracle; variants may still render as chunks for
  display, but the schema *decides*. Same "derive, don't duplicate" move as `/api/tagged`.
- **Quiz answer ≡ task solution.** A dev task's `solution:` schema describes a valid deliverable;
  a conforming instance = done. "Instantiating the schema" *is* solving the task.

**Instance lifetime.** The response instance is either **ephemeral** (a study-session input,
validated then discarded — only the SM-2 grade of §4.3 is kept) or **persisted** (a task
deliverable that *is* the stored solution). The schema doesn't care which; the surface decides.

---

## 7. New artifacts to add

| artifact | what |
|---|---|
| `$defs/task` | §1 — the task/card schema (chapter + planning fields) |
| `$defs/workflow` | §2.4 — the state-machine marker tag (`x-yamlover-workflow`) |
| `tags/.../workflow/dev`, `…/srs` | seed workflows (states + `next` ref edges) |
| `tags/.../card` | the quiz-role taxonomy (`question`/`answer`/`answer-variant`/`correct`/`hint`) |
| board renderer | §3 — directory view: lanes = states, drag = re-tag, over SSE |
| SM-2 action | §4.3 — grade → rewrite the `review` annotation |
| example | `examples/NN-tickets/` — a board dir + a deck dir, exercising both workflows |

**No `$defs/state`, no `$defs/card`, no `$defs/deck`** — states are plain tags, a card is a task
with tagged chunks, a deck/board is a directory. The design adds one real schema (`task`), one
marker schema (`workflow`), two seed taxonomies, and one renderer.
