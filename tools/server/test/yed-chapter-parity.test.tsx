// @vitest-environment jsdom
// THE CHAPTER PARITY GATE (Stage 8 of the port plan) — the yed chapter editor over the REAL
// handler, real temp tree, real debounce; the assertion is the DISK (the yed-parity doctrine:
// a swap must be gated by the SUPERSET of what it replaces). This suite carries the disk-level
// scenario classes across the STORAGE MATRIX; the rest of the superset lives in the mapped
// suites below.
//
// ============================== THE SUPERSET CHECKLIST ======================================
// Every legacy `it` of test/client/chapter-projection.test.tsx, mapped to its yed counterpart.
//   MACH = tools/yed/test/chapter-machine.test.ts       DISP = …/chapter-dispatch.test.ts
//   CELLS = …/chapter-cells.test.tsx                    DOM  = …/chapter-dom-typing.test.tsx
//   PROJ = test/client/yed-chapter-projection.test.tsx  HERE = this file (disk)
//
// — structure —
//  1 title h1 + description subtitle            → PROJ "draws the title as an editable h1…"
//  2 prose marklower + subchapter <section>     → PROJ "a subchapter is an inline <section>…"
//  3 opens with the caret in the title          → PROJ "opens with the caret in the title"
// — editing —
//  4 typing = ONE coalesced bare emplace        → PROJ "typing coalesces…" + HERE (matrix)
//  5 Enter splits into a sibling                → PROJ "Enter splits at the caret…" + MACH
//  6 Backspace joins, caret at the junction     → PROJ "Backspace at the start joins…" + MACH joinWalk
//  7 Tab promotes to a subchapter title         → LAW CHANGED (Dmitry): Tab NESTS a plain
//    paragraph; T titles the group — MACH "nest / dedent", DISP rows, DOM
//  8 Enter out of a fresh title MATERIALIZES    → HERE "a wrapped subchapter of a DIR chapter…"
//  9 a FILE chapter re-emplaces the omni inline → HERE "a FILE-concrete chapter never materializes"
// 10 Cyrillic pointer-safe member names         → HERE "a CYRILLIC title keeps its letters"
// 11 a wrap BETWEEN linked members → 01-1-…     → HERE "a wrap BETWEEN two linked members…"
// 12 a NESTED wrap materializes recursively     → HERE "a NESTED wrap inside a freshly born member…"
// 13 Shift-Tab on a MATERIALIZED member nops    → HERE "Shift-Tab on a BORN…"
// 14 Shift-Tab lifts a nested paragraph out     → MACH "nest → dedent round-trips" + PROJ
// 15 merely OPENING writes nothing              → PROJ + HERE "open writes NOTHING (matrix)"
// — tables, per-format chunks —
// 16 a table renders an editable grid           → PROJ "a tagged table draws an editable grid…" + HERE
// 17 a latex chunk opens the LaTeX editor       → chunkModeOf (MACH "enclosingFormat…", format.ts) + LatexCell
// 18 a csv chunk renders READ-ONLY              → chunkModeOf readonly + adapter renderReadonly
// — depth —
// 19-25 window faces / heading navigates / ∞ editable / caret skips read-only / wrap stays
//    editable / Enter materializes + descends / pointer target read-only
//                                               → PROJ "?depth=" describe + HERE births (auto-
//                                                 descend fires from the flush) + MACH atom stops
// — lists and the format bar —
// 26 bullets = editable <ul>, 27 numbered = <ol> → PROJ structure + CELLS list cells
// 28 Ctrl+Alt+3 wraps a paragraph into bullets  → MACH promoteFormat + HERE "formats on the DISK"
// 29 Ctrl+Alt+4 on a list = one meta-only swap  → MACH "retagging a list is ONE meta swap"
// 30 Ctrl+Alt+1 drops the tag                   → LAW SHARPENED: item-local extract (MACH
//                                                 extractListItem — labour never dropped) + HERE
// 31 the bar highlights the active block        → PROJ "the format bar rides the SHARED bus"
// 32 Tab in a list item nests a sublist         → MACH indentEntry + DISP
// — Enter adds VISIBLE paragraphs —
// 33-37 title→description walk / no placeholder cells / body-less Enter creates ONE ¶ / empty-¶
//    visibility / Enter in an empty ¶ advances  → MACH enterWalk + splitProse + CELLS (captions,
//                                                 placeholders) + PROJ walk tests
// — ChapterFormatControl over the bus —
// 38 nothing when unmounted, 39 acts mousedown  → PROJ "the group appears while mounted…"
// — Shift-Tab undoes Tab —
// 40 Tab⇄Shift-Tab round-trip writes NOTHING    → MACH round-trip + HERE "wrap⇄unwrap is DISK-NEUTRAL"
// 41 Shift-Tab splices the body out in order    → MACH "unwrap splices", joinWalk dissolve
// 42 addressing stays correct after round-trip  → PROJ "a structural insert never leaves STALE DOM"
// 43 Tab nests a title under the PREVIOUS chapter→ DISP "Tab on a title whose previous sibling…"
// 44 Tab never conscripts a plain paragraph     → DISP "Tab on a title after a plain paragraph…"
// — the same editor at every level —
// 45 D works one level down                     → PROJ "D makes the focused chunk the description…"
// 46 chunks carry the §/[i] gutter              → PROJ structure + CELLS labels ([i] / key — round 2)
// 47 the editor takes the reading width         → the mount's chapter-page CSS (hands-on, debug page)
// — T and D —
// 48-51 T makes/unmakes the title, D the desc   → PROJ T/D describe + MACH roles + HERE (disk)
// — Up/Down —
// 52 walk title→description→¶ and back          → PROJ "Up/Down walk the flat document order"
// 53 stay put at the edges                      → MACH moveFocus (+ ↓ APPENDS at the very end — round 4)
// — the EMPTY chapter —
// 54 ONE bootstrap ¶, writing nothing           → PROJ "an EMPTY chapter shows one bootstrap…" + HERE
// 55 first typed text creates [0]               → MACH createFirstChunk + HERE stamp test
// — the stamp —
// 56 first batch LEADS with the meta stamp      → PROJ + HERE "a PLAIN folder gains the chapter tag…"
// 57 a zero-op action does NOT stamp            → HERE "a zero-op action…"
// 58 an already-TAGGED chapter never re-stamps  → PROJ "…exactly once" + HERE (second edit)
//
// — behaviors DECIDED during this arc (beyond legacy) —
// 59 Tab=NEST law (plain group, T titles)       → MACH, DISP, DOM
// 60 walk-adjacent joins, title dissolves in    → MACH joinWalk describe
// 61 ¶ in a list is ITEM-LOCAL (labour kept)    → MACH extractListItem
// 62 table creation flow: Tab grows columns     → MACH appendColumn + DISP singleRow rows
// 63 Ctrl+Enter appends a row (anywhere within) → DISP inTable rows + MACH + HERE (disk)
// 64 Enter splits a cell into CHUNKS            → MACH splitCell + DISP
// 65 grid ↑/↓, edge exits, ↓ appends at the end → MACH tableMove + PROJ
// 66 ←/→ walk cells at the cell edges           → DISP ArrowLeft/Right rows
// 67 boot: format/role MATERIALIZES (no idle)   → MACH "boot materialization" + DISP
// 68 source chunks = the SAME yed cells/grammar → PROJ "NON-chapter-typed…" + HERE (disk)
// 69 never-locked: watchdog + legend dry-runs   → MACH corpus sweep + CELLS legend law
// ============================================================================================
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { createHandlers, tmpTree } from "./helpers";
import { captureAlerts, installFetch, settleOps } from "./edit-corpus-harness";
import { YedChapterEditor } from "../src/client/renderers/yed-chapter-editor";
import { ChapterFormatControl } from "../src/client/renderers/chapter-editor/format-control";

afterEach(cleanup);

async function mount(files: Record<string, string>, mountPath: string) {
  const root = tmpTree(files);
  const h = createHandlers(root, { gitignore: false });
  await h.ready;
  const restoreFetch = installFetch(h);
  const alerts = captureAlerts();
  const navigations: string[] = [];
  const { container, unmount } = render(
    <>
      <YedChapterEditor path={mountPath} onNavigate={(p) => navigations.push(p)} />
      <ChapterFormatControl />
    </>,
  );
  await waitFor(() => {
    expect(container.textContent, `load failed: ${container.textContent}`).not.toContain("could not load");
    expect(container.querySelector(".chapter-wysiwyg")).toBeTruthy();
  }, { timeout: 3000 });
  return {
    root, container, navigations,
    read: (rel: string) => fs.readFileSync(path.join(root, rel), "utf8"),
    exists: (rel: string) => fs.existsSync(path.join(root, rel)),
    dirs: (rel: string) => fs.readdirSync(path.join(root, rel), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name),
    alerts: alerts.messages,
    done: () => { unmount(); restoreFetch(); alerts.restore(); },
  };
}

const CHAPTER = "!!<*yamlover: $defs: chapter>\nBook\n- opening\n- fresh\n";

type Mounted = Awaited<ReturnType<typeof mount>>;

const pressRole = (m: { container: HTMLElement }, glyph: "T" | "D"): void => {
  const b = Array.from(m.container.querySelectorAll("button.fmt-btn")).find((x) => x.textContent === glyph) as HTMLElement;
  fireEvent.mouseDown(b);
};
const pressT = (m: { container: HTMLElement }): void => pressRole(m, "T");

/** Type into a marklower prose cell the way the editor sees it: DOM text + input event. */
const typeProse = (p: HTMLElement, text: string): void => {
  p.textContent = text;
  fireEvent.input(p);
};

const prose = (m: Mounted, i: number): HTMLElement =>
  m.container.querySelectorAll(".chunk-body .chapter-prose")[i] as HTMLElement;

describe("the yed chapter parity gate — deferred materialization", () => {
  it("a wrapped subchapter of a DIR chapter materializes as its own subdirectory on first body commit", async () => {
    const m = await mount({ "d/.yo/body.yo": CHAPTER }, ":d");
    try {
      // wrap the second paragraph into a subchapter title…
      const p = m.container.querySelectorAll(".chunk-body .chapter-prose")[1] as HTMLElement;
      fireEvent.focus(p);
      fireEvent.keyDown(p, { key: "Tab" });
      pressT(m);
      const title = m.container.querySelector("section.chapter-sub .chapter-title input.y2-input") as HTMLInputElement;
      expect(title?.value).toBe("fresh");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.dirs("d"), "a wrap alone materializes NOTHING").toEqual([".yo"]);
      // …then Enter walks into the body, creating the first paragraph — THE BIRTH
      fireEvent.keyDown(title, { key: "Enter" });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      const born = m.dirs("d").filter((d) => d !== ".yo");
      expect(born, "the subchapter became its own subdirectory").toEqual(["01-fresh"]);
      expect(m.read("d/01-fresh/.yo/body.yo")).toContain("fresh");
      expect(m.read("d/.yo/body.yo")).toContain("- opening");
      expect(m.read("d/.yo/body.yo")).not.toContain("- fresh\n"); // the inline line left
    } finally { m.done(); }
  });

  it("follow-up edits route into the born member BY KEY (shift-immune), not positionally", async () => {
    const m = await mount({ "d/.yo/body.yo": CHAPTER }, ":d");
    try {
      const p = m.container.querySelectorAll(".chunk-body .chapter-prose")[1] as HTMLElement;
      fireEvent.focus(p);
      fireEvent.keyDown(p, { key: "Tab" });
      pressT(m);
      const title = m.container.querySelector("section.chapter-sub .chapter-title input.y2-input") as HTMLElement;
      fireEvent.keyDown(title, { key: "Enter" });
      await settleOps();
      // the caret sits in the member's fresh first paragraph — type into it
      const sub = m.container.querySelector("section.chapter-sub") as HTMLElement;
      const para = sub.querySelector(".chunk-body .chapter-prose") as HTMLElement;
      para.textContent = "the sub body";
      fireEvent.input(para);
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("d/01-fresh/.yo/body.yo")).toContain("the sub body");
    } finally { m.done(); }
  });

  it("a CYRILLIC title keeps its letters in the member name", async () => {
    const m = await mount({ "d/.yo/body.yo": "!!<*yamlover: $defs: chapter>\nКнига\n- вступление\n- Заголовок_части\n" }, ":d");
    try {
      const p = m.container.querySelectorAll(".chunk-body .chapter-prose")[1] as HTMLElement;
      fireEvent.focus(p);
      fireEvent.keyDown(p, { key: "Tab" });
      pressT(m);
      const title = m.container.querySelector("section.chapter-sub .chapter-title input.y2-input") as HTMLElement;
      fireEvent.keyDown(title, { key: "Enter" });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.dirs("d").filter((d) => d !== ".yo")).toEqual(["01-Заголовок_части"]);
    } finally { m.done(); }
  });

  it("a FILE-concrete chapter never materializes — the omni stays inline in the file", async () => {
    const m = await mount({ "doc.yo": CHAPTER }, ":doc.yo");
    try {
      const p = m.container.querySelectorAll(".chunk-body .chapter-prose")[1] as HTMLElement;
      fireEvent.focus(p);
      fireEvent.keyDown(p, { key: "Tab" });
      pressT(m);
      const title = m.container.querySelector("section.chapter-sub .chapter-title input.y2-input") as HTMLElement;
      fireEvent.keyDown(title, { key: "Enter" });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      const out = m.read("doc.yo");
      expect(out).toContain("- fresh"); // the wrapped title, now an omni entry with a body line
      expect(m.exists("fresh")).toBe(false);
      expect(m.exists("01-fresh")).toBe(false);
    } finally { m.done(); }
  });

  it("Shift-Tab on a BORN (materialized) subchapter is a nop — no verb inlines a document back", async () => {
    const m = await mount({ "d/.yo/body.yo": CHAPTER }, ":d");
    try {
      const p = m.container.querySelectorAll(".chunk-body .chapter-prose")[1] as HTMLElement;
      fireEvent.focus(p);
      fireEvent.keyDown(p, { key: "Tab" });
      pressT(m);
      const title = m.container.querySelector("section.chapter-sub .chapter-title input.y2-input") as HTMLElement;
      fireEvent.keyDown(title, { key: "Enter" });
      await settleOps();
      const before = m.read("d/.yo/body.yo");
      const t2 = m.container.querySelector("section.chapter-sub .chapter-title input.y2-input, section.chapter-sub .chapter-title .chapter-title-text") as HTMLElement;
      fireEvent.focus(t2);
      fireEvent.keyDown(t2, { key: "Tab", shiftKey: true });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("d/.yo/body.yo")).toBe(before);
      expect(m.dirs("d").filter((d) => d !== ".yo")).toEqual(["01-fresh"]);
    } finally { m.done(); }
  });

  it("a wrap BETWEEN two linked members predicts the between-number key (01-1-…)", async () => {
    const m = await mount({
      "d/.yo/body.yo": "!!<*yamlover: $defs: chapter>\nBook\n- *: 01-A\n- middle\n- *: 02-B\n",
      "d/01-A/.yo/body.yo": "A\n- a body\n",
      "d/02-B/.yo/body.yo": "B\n- b body\n",
    }, ":d");
    try {
      // "middle" is the only EDITABLE prose — the pointer members' previews are read-only
      const editables = () => Array.from(m.container.querySelectorAll(".chunk-body .chapter-prose[contenteditable]")) as HTMLElement[];
      await waitFor(() => expect(editables().map((e) => e.textContent)).toContain("middle"));
      const p = editables().find((e) => e.textContent === "middle")!;
      fireEvent.focus(p);
      fireEvent.keyDown(p, { key: "Tab" });
      pressT(m);
      const title = m.container.querySelector("section.chapter-sub .chapter-title input.y2-input") as HTMLElement;
      fireEvent.keyDown(title, { key: "Enter" });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.dirs("d").filter((d) => d !== ".yo").sort()).toEqual(["01-1-middle", "01-A", "02-B"]);
      expect(m.read("d/01-1-middle/.yo/body.yo")).toContain("middle");
    } finally { m.done(); }
  });

  it("a NESTED wrap inside a freshly born member materializes too (recursive, same session)", async () => {
    const m = await mount({ "d/.yo/body.yo": CHAPTER }, ":d");
    try {
      const p = prose(m, 1);
      fireEvent.focus(p);
      fireEvent.keyDown(p, { key: "Tab" });
      pressT(m);
      const title = m.container.querySelector("section.chapter-sub .chapter-title input.y2-input") as HTMLElement;
      fireEvent.keyDown(title, { key: "Enter" });
      await settleOps();
      expect(m.dirs("d").filter((d) => d !== ".yo")).toEqual(["01-fresh"]);
      // inside the born member: type, nest, title, Enter — the SECOND birth, one level down
      const sub = m.container.querySelector("section.chapter-sub") as HTMLElement;
      const para = sub.querySelector(".chunk-body .chapter-prose") as HTMLElement;
      typeProse(para, "deeper");
      fireEvent.keyDown(para, { key: "Tab" });
      pressT(m);
      const inner = sub.querySelector("section.chapter-sub .chapter-title input.y2-input") as HTMLElement;
      expect(inner, "the nested wrap grew its own title cell").toBeTruthy();
      fireEvent.keyDown(inner, { key: "Enter" });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.dirs("d/01-fresh").filter((d) => d !== ".yo")).toEqual(["01-deeper"]);
      expect(m.read("d/01-fresh/01-deeper/.yo/body.yo")).toContain("deeper");
    } finally { m.done(); }
  });
});

// ------------------------------------------------------------------------------------------ //
// The STORAGE MATRIX — the same editor over every concrete a chapter lives in.
// ------------------------------------------------------------------------------------------ //

const MATRIX: { name: string; files: Record<string, string>; mountAt: string; body: string }[] = [
  { name: "flat file", files: { "doc.yo": CHAPTER }, mountAt: ":doc.yo", body: "doc.yo" },
  { name: "dir-backed", files: { "d/.yo/body.yo": CHAPTER }, mountAt: ":d", body: "d/.yo/body.yo" },
  {
    name: "member dir",
    files: {
      "d/.yo/body.yo": "!!<*yamlover: $defs: chapter>\nBook\n- *: 01-part\n",
      "d/01-part/.yo/body.yo": "!!<*yamlover: $defs: chapter>\nPart One\n- member opening\n- member fresh\n",
    },
    mountAt: ":d:01-part", body: "d/01-part/.yo/body.yo",
  },
  {
    name: "deep node",
    files: { "doc.yo": "!!<*yamlover: $defs: chapter>\nBook\n- intro\npart: Part One\n  - part body\n  - part more\n" },
    mountAt: ":doc.yo:part", body: "doc.yo",
  },
];

describe("the yed chapter parity gate — the storage matrix", () => {
  it("merely OPENING writes nothing — every concrete byte-identical after mount + settle", async () => {
    for (const sc of MATRIX) {
      const m = await mount(sc.files, sc.mountAt);
      try {
        await settleOps();
        expect(m.alerts, `${sc.name}: ${m.alerts.join(" | ")}`).toEqual([]);
        for (const [rel, content] of Object.entries(sc.files)) {
          expect(m.read(rel), `${sc.name}: ${rel} must be untouched`).toBe(content);
        }
      } finally { m.done(); }
    }
  }, 30000);

  it("typing lands on the DISK of a flat file, keeping the tag line", async () => {
    const m = await mount({ "doc.yo": CHAPTER }, ":doc.yo");
    try {
      typeProse(prose(m, 0), "opening rewritten");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("doc.yo")).toBe("!!<*yamlover: $defs: chapter>\nBook\n- opening rewritten\n- fresh\n");
    } finally { m.done(); }
  });

  it("typing lands in a MEMBER dir's own body — the parent stays untouched", async () => {
    const files = {
      "d/.yo/body.yo": "!!<*yamlover: $defs: chapter>\nBook\n- *: 01-part\n",
      "d/01-part/.yo/body.yo": "!!<*yamlover: $defs: chapter>\nPart One\n- member opening\n- member fresh\n",
    };
    const m = await mount(files, ":d:01-part");
    try {
      typeProse(prose(m, 0), "member edited");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("d/01-part/.yo/body.yo")).toBe("!!<*yamlover: $defs: chapter>\nPart One\n- member edited\n- member fresh\n");
      expect(m.read("d/.yo/body.yo")).toBe(files["d/.yo/body.yo"]);
    } finally { m.done(); }
  });

  it("typing at a DEEP node lands inside the file — the siblings byte-preserved, no spurious tag", async () => {
    const m = await mount({ "doc.yo": "!!<*yamlover: $defs: chapter>\nBook\n- intro\npart: Part One\n  - part body\n  - part more\n" }, ":doc.yo:part");
    try {
      typeProse(prose(m, 0), "part body edited");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("doc.yo")).toBe("!!<*yamlover: $defs: chapter>\nBook\n- intro\npart: Part One\n  - part body edited\n  - part more\n");
    } finally { m.done(); }
  });
});

// ------------------------------------------------------------------------------------------ //
// The STAMP, disk-level — a plain folder becomes a chapter with its first written batch.
// ------------------------------------------------------------------------------------------ //

describe("the yed chapter parity gate — the stamp on disk", () => {
  it("a PLAIN folder gains the chapter tag with the FIRST written batch — exactly once", async () => {
    const m = await mount({ "d/.yo/body.yo": "- hi\n" }, ":d");
    try {
      typeProse(prose(m, 0), "hello");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      const after = m.read("d/.yo/body.yo");
      expect(after).toMatch(/!!<.*\$defs:\s?chapter>/); // the stamp led the batch
      expect(after).toContain("- hello");
      // …and only ONCE: the next edit never re-stamps
      typeProse(prose(m, 0), "hello there");
      await settleOps();
      const again = m.read("d/.yo/body.yo");
      expect(again.match(/!!</g)?.length, "one tag line, not two").toBe(1);
      expect(again).toContain("- hello there");
    } finally { m.done(); }
  });

  it("a zero-op action (Tab's nest + Shift-Tab back) does NOT stamp — nothing was written to tag", async () => {
    const m = await mount({ "d/.yo/body.yo": "- hi\n- ho\n" }, ":d");
    try {
      const p = prose(m, 0);
      fireEvent.focus(p);
      fireEvent.keyDown(p, { key: "Tab" });
      const nested = m.container.querySelectorAll(".chunk-body .chapter-prose")[0] as HTMLElement;
      fireEvent.keyDown(nested, { key: "Tab", shiftKey: true });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("d/.yo/body.yo"), "the disk never saw the round-trip").toBe("- hi\n- ho\n");
    } finally { m.done(); }
  });
});

// ------------------------------------------------------------------------------------------ //
// Disk-neutral round-trips + fidelity — comments and spellings survive adjacent edits.
// ------------------------------------------------------------------------------------------ //

describe("the yed chapter parity gate — neutrality and fidelity", () => {
  it("Tab's wrap ⇄ Shift-Tab's unwrap is DISK-NEUTRAL on a tagged chapter", async () => {
    const m = await mount({ "d/.yo/body.yo": CHAPTER }, ":d");
    try {
      const p = prose(m, 1);
      fireEvent.focus(p);
      fireEvent.keyDown(p, { key: "Tab" });
      const nested = m.container.querySelectorAll(".chunk-body .chapter-prose")[1] as HTMLElement;
      fireEvent.keyDown(nested, { key: "Tab", shiftKey: true });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("d/.yo/body.yo")).toBe(CHAPTER);
    } finally { m.done(); }
  });

  it("COMMENTS and quoted SPELLINGS survive an edit to a sibling paragraph", async () => {
    const src = "!!<*yamlover: $defs: chapter>\n# a note that must survive\nBook\n- 'quoted paragraph'\n- plain one\n";
    const m = await mount({ "doc.yo": src }, ":doc.yo");
    try {
      typeProse(prose(m, 1), "plain edited");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("doc.yo")).toBe("!!<*yamlover: $defs: chapter>\n# a note that must survive\nBook\n- 'quoted paragraph'\n- plain edited\n");
    } finally { m.done(); }
  });
});

// ------------------------------------------------------------------------------------------ //
// Tables and source chunks on the DISK — the two edit surfaces the port moved onto the diff.
// ------------------------------------------------------------------------------------------ //

const TABLE_DOC =
  "!!<*yamlover: $defs: chapter>\nBook\n" +
  "- !!<*yamlover: $defs: table>\n  header:\n    - Pet\n    - Sound\n  - - dog\n    - woof\n";

describe("the yed chapter parity gate — tables and source chunks on disk", () => {
  it("a cell edit lands at the cell; Tab at the VERY last cell appends a row of the width", async () => {
    const m = await mount({ "doc.yo": TABLE_DOC }, ":doc.yo");
    try {
      const faces = m.container.querySelectorAll("td .yl-cell");
      expect(faces.length).toBe(2);
      fireEvent.focus(faces[0]);
      const input = document.activeElement as HTMLInputElement;
      expect(input.value).toBe("dog");
      fireEvent.change(input, { target: { value: "cat" } });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("doc.yo")).toContain("- - cat\n    - woof\n");
      // Tab from the LAST cell appends a row
      const last = Array.from(m.container.querySelectorAll("td .yl-cell")).find((f) => f.textContent === "woof") as HTMLElement;
      fireEvent.focus(last);
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("doc.yo")).toBe(
        "!!<*yamlover: $defs: chapter>\nBook\n" +
        "- !!<*yamlover: $defs: table>\n  header:\n    - Pet\n    - Sound\n  - - cat\n    - woof\n  - - ''\n    - ''\n",
      );
    } finally { m.done(); }
  });

  it("Ctrl+Enter in a cell appends a row on the DISK", async () => {
    const m = await mount({ "doc.yo": TABLE_DOC }, ":doc.yo");
    try {
      const face = m.container.querySelector("td .yl-cell") as HTMLElement;
      fireEvent.focus(face);
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter", ctrlKey: true });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("doc.yo")).toContain("- - dog\n    - woof\n  - - ''\n    - ''\n");
    } finally { m.done(); }
  });

  it("a table GROWN in a DIR chapter stays one inline content unit — rows never promote to members", async () => {
    // reported (sporadic): "edit sync failed: cannot descend into a scalar element at [0]" on
    // table exit. Reproduced deterministically: the row-array replace in a dir-backed body
    // promoted the row to a `- *: itemNN` member; the next flush's positional cell edit then
    // hit the pointer line. Content is content ALL THE WAY DOWN (concrete-rules): a node inside
    // an inline TAGGED container never promotes.
    const m = await mount({ "d/.yo/body.yo": "!!<*yamlover: $defs: chapter>\nBook\n- first words\n" }, ":d");
    try {
      const p = prose(m, 0);
      fireEvent.focus(p);
      fireEvent.keyDown(p, { key: "Enter", ctrlKey: true }); // THE TABLE GESTURE
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      // grow a column, then a row, then edit the FIRST row's cell — each in its OWN flush
      // (the boundary that used to detonate)
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });
      await settleOps();
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter", ctrlKey: true });
      await settleOps();
      const firstCell = Array.from(m.container.querySelectorAll("td .yl-cell")).find((c) => c.textContent === "first words") as HTMLElement;
      fireEvent.focus(firstCell);
      fireEvent.change(document.activeElement as HTMLInputElement, { target: { value: "edited later" } });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("d/.yo/body.yo")).toBe(
        "!!<*yamlover: $defs: chapter>\nBook\n" +
        "- !!<*yamlover: $defs: table>\n  - - edited later\n    - ''\n  - - ''\n    - ''\n",
      );
      // no `- *: itemNN` pointer inside the table, no phantom member directory
      expect(m.dirs("d")).not.toContain("item01");
    } finally { m.done(); }
  });

  it("a SOURCE chunk's keyed value edits through the yed source cells onto the disk", async () => {
    const src = "!!<*yamlover: $defs: chapter>\nRecipes\n- The stew needs:\n- !!<*yamlover: $defs: recipe>\n  serves: 4\n  time: 20\n";
    const m = await mount({ "doc.yo": src }, ":doc.yo");
    try {
      const source = m.container.querySelector(".chunk-source");
      expect(source, "the data chunk renders SOURCE cells").toBeTruthy();
      const token = Array.from(source!.querySelectorAll(".y2-v")).find((el) => el.textContent === "4") as HTMLElement;
      fireEvent.focus(token);
      const input = document.activeElement as HTMLInputElement;
      fireEvent.change(input, { target: { value: "6" } });
      input.setSelectionRange(1, 1);
      fireEvent.keyDown(input, { key: "Enter" });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("doc.yo")).toBe("!!<*yamlover: $defs: chapter>\nRecipes\n- The stew needs:\n- !!<*yamlover: $defs: recipe>\n  serves: 6\n  time: 20\n");
    } finally { m.done(); }
  });

  it("a SOURCE island SHOWS its !!<…> tag in edit mode — the identity chrome", async () => {
    const src = "!!<*yamlover: $defs: chapter>\nRecipes\n- The stew needs:\n- !!<*yamlover: $defs: recipe>\n  serves: 4\n";
    const m = await mount({ "doc.yo": src }, ":doc.yo");
    try {
      const source = m.container.querySelector(".chunk-source")!;
      // the tag renders as its EDITABLE cell: wrapper chrome + the inner text face
      const tags = Array.from(source.querySelectorAll(".y2-tagtext")).map((el) => el.textContent);
      expect(tags).toContain("*yamlover: $defs: recipe");
    } finally { m.done(); }
  });

  it("RETAGGING an island member through its tag cell lands on disk as the new spelling", async () => {
    const src = "!!<*yamlover: $defs: chapter>\nRecipes\n- intro\n- !!<*yamlover: $defs: recipe>\n  serves: 4\n";
    const m = await mount({ "doc.yo": src }, ":doc.yo");
    try {
      const source = m.container.querySelector(".chunk-source")!;
      const face = source.querySelector(".y2-tagtext") as HTMLElement;
      expect(face?.textContent).toBe("*yamlover: $defs: recipe");
      fireEvent.focus(face);
      const input = document.activeElement as HTMLInputElement;
      expect(input.tagName).toBe("INPUT");
      fireEvent.change(input, { target: { value: "*yamlover: $defs: dish" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("doc.yo")).toContain("!!<*yamlover: $defs: dish>");
      expect(m.read("doc.yo")).not.toContain("$defs: recipe>");
    } finally { m.done(); }
  });

  it("EDITING an anchor through the island's anchor row lands on disk (whole-node emplace)", async () => {
    const src = "!!<*yamlover: $defs: chapter>\nRecipes\n- intro\n- !!yo\n  serves: 4\n    &: index: servings\n";
    const m = await mount({ "doc.yo": src }, ":doc.yo");
    try {
      const source = m.container.querySelector(".chunk-source")!;
      const face = source.querySelector('[data-kind="anchors"] .y2-v') as HTMLElement;
      expect(face?.textContent).toBe(": index: servings");
      fireEvent.focus(face);
      const input = document.activeElement as HTMLInputElement;
      expect(input.tagName).toBe("INPUT");
      fireEvent.change(input, { target: { value: ": index: portions" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      const out = m.read("doc.yo");
      expect(out).toContain("&: index: portions");
      expect(out).not.toContain("servings");
      expect(out).toContain("serves: 4"); // the island's content untouched
    } finally { m.done(); }
  });

  it("Backspace-to-empty inside a SOURCE island keeps the tag ON DISK — never a meta delete", async () => {
    const src = "!!<*yamlover: $defs: chapter>\nRecipes\n- intro\n- !!<*yamlover: $defs: recipe>\n  serves: 4\n";
    const m = await mount({ "doc.yo": src }, ":doc.yo");
    try {
      const source = m.container.querySelector(".chunk-source")!;
      const token = Array.from(source.querySelectorAll(".y2-v")).find((el) => el.textContent === "4") as HTMLElement;
      fireEvent.focus(token);
      // unwind the island: clear the value, then Backspace through key and container
      for (let i = 0; i < 8; i++) {
        const el = document.activeElement as HTMLInputElement;
        if (!el || !source.contains(el)) break;
        if (el.value) fireEvent.change(el, { target: { value: "" } });
        fireEvent.keyDown(el, { key: "Backspace" });
      }
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      const out = m.read("doc.yo");
      // the island's tag line SURVIVES the emptying — the content is gone, the identity is not
      expect(out).toContain("!!<*yamlover: $defs: recipe>");
      expect(out).not.toContain("serves");
    } finally { m.done(); }
  });
});

// ------------------------------------------------------------------------------------------ //
// Roles and formats on the DISK — T/D and the format cycle land as their exact lines.
// ------------------------------------------------------------------------------------------ //

describe("the yed chapter parity gate — roles and formats on disk", () => {
  it("T makes the focused chunk the TITLE, D another the DESCRIPTION — the file shows both", async () => {
    const m = await mount({ "d/.yo/body.yo": "!!<*yamlover: $defs: chapter>\n- alpha\n- beta\n" }, ":d");
    try {
      const p = prose(m, 0);
      fireEvent.focus(p);
      pressRole(m, "T");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("d/.yo/body.yo")).toBe("!!<*yamlover: $defs: chapter>\nalpha\n- beta\n");
      const rest = prose(m, 0); // "beta" is now the first (only) body chunk
      fireEvent.focus(rest);
      pressRole(m, "D");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("d/.yo/body.yo")).toBe("!!<*yamlover: $defs: chapter>\nalpha\ndescription: beta\n");
    } finally { m.done(); }
  });

  it("Ctrl+Alt+3 wraps a paragraph into a bullets list; Ctrl+Alt+1 extracts it back — disk round-trip", async () => {
    const src = "!!<*yamlover: $defs: chapter>\nBook\n- listify me\n- after\n";
    const m = await mount({ "doc.yo": src }, ":doc.yo");
    try {
      const p = prose(m, 0);
      fireEvent.focus(p);
      fireEvent.keyDown(p, { key: "3", ctrlKey: true, altKey: true });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("doc.yo")).toBe("!!<*yamlover: $defs: chapter>\nBook\n- !!<*yamlover: $defs: bullets>\n  - listify me\n- after\n");
      // ¶ is ITEM-LOCAL: the item leaves the (single-item) list, which dissolves — the inverse
      const item = m.container.querySelector("li .chapter-prose, .chunk-body li .chapter-prose, li [contenteditable]") as HTMLElement
        ?? prose(m, 0);
      fireEvent.focus(item);
      fireEvent.keyDown(item, { key: "1", ctrlKey: true, altKey: true });
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("doc.yo")).toBe(src);
    } finally { m.done(); }
  });
});
