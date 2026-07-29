// @vitest-environment jsdom
// THE PARITY GATE — every storage shape the LEGACY editor could unlock must load, take an edit,
// and persist through the YED mount. This suite exists because the mount swap shipped gated only
// against flat standalone files: the corpus isolates the typing grammar BY DESIGN, and the
// NodeView suites mock the api — so "the tests pass" said nothing about the storage matrix.
// A swap must be gated by the SUPERSET of what it replaces; this is that gate. Real handler,
// real temp tree, real debounce; the assertion is the DISK.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { createHandlers, tmpTree } from "./helpers";
import { captureAlerts, installFetch, settleOps } from "./edit-corpus-harness";
import { YedEditor } from "../src/client/renderers/yed-editor";

afterEach(cleanup);

/** Type through yed's real key plumbing (`⏎` Enter, `→` ArrowRight, `⇤` Shift-Tab; printables
 *  land via onChange when the grammar leaves them alone). */
function typeKeys(script: string): void {
  for (const ch of script) {
    const el = document.activeElement;
    expect(el && el !== document.body, `the caret fell off the editor before ${JSON.stringify(ch)}`).toBeTruthy();
    if (ch === "⇤") { fireEvent.keyDown(el as HTMLElement, { key: "Tab", shiftKey: true }); continue; }
    const key = ch === "⏎" ? "Enter" : ch === "→" ? "ArrowRight" : ch;
    const input = el as HTMLInputElement;
    const before = input instanceof HTMLInputElement ? input.value : "";
    const defaulted = fireEvent.keyDown(input, { key });
    if (key.length === 1 && defaulted && input instanceof HTMLInputElement) {
      fireEvent.change(input, { target: { value: before + key } });
    }
  }
}

/** Click a committed token (by its display text), retype it, commit with Enter. */
function retypeToken(text: string, next: string): void {
  const span = Array.from(document.querySelectorAll(".y2-v")).find((el) => el.textContent === text) as HTMLElement;
  expect(span, `no token cell spelled ${JSON.stringify(text)}`).toBeTruthy();
  fireEvent.focus(span);
  const input = document.activeElement as HTMLInputElement;
  expect(input instanceof HTMLInputElement).toBe(true);
  fireEvent.change(input, { target: { value: next } });
  input.setSelectionRange(next.length, next.length);
  fireEvent.keyDown(input, { key: "Enter" });
}

async function mount(files: Record<string, string>, mountPath: string) {
  const root = tmpTree(files);
  const h = createHandlers(root, { gitignore: false });
  await h.ready;
  const restoreFetch = installFetch(h);
  const alerts = captureAlerts();
  const { container, unmount } = render(<YedEditor path={mountPath} onNavigate={() => {}} />);
  await waitFor(() => {
    expect(container.textContent, `load failed: ${container.textContent}`).not.toContain("could not load");
    expect(container.querySelector("[data-testid=y2-doc]")).toBeTruthy();
  }, { timeout: 3000 });
  return {
    root,
    read: (rel: string) => fs.readFileSync(path.join(root, rel), "utf8"),
    exists: (rel: string) => fs.existsSync(path.join(root, rel)),
    alerts: alerts.messages,
    done: () => { unmount(); restoreFetch(); alerts.restore(); },
  };
}

describe("the yed parity gate — every storage shape loads, edits, persists", () => {
  it("1. a flat .yamlover file", async () => {
    const m = await mount({ "note.yamlover": "" }, ":note.yamlover");
    try {
      typeKeys("key1: value1→");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("note.yamlover")).toBe("key1: value1\n");
    } finally { m.done(); }
  });

  it("2. a .yaml file", async () => {
    const m = await mount({ "note.yaml": "a: 1\n" }, ":note.yaml");
    try {
      typeKeys("z: 9→");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("note.yaml")).toBe("z: 9\na: 1\n");
    } finally { m.done(); }
  });

  it("3. a dir-backed document (.yamlover/body.yamlover)", async () => {
    const m = await mount({ "d/.yamlover/body.yamlover": "a: 1\n" }, ":d");
    try {
      typeKeys("z: 9→");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("d/.yamlover/body.yamlover")).toContain("z: 9");
    } finally { m.done(); }
  });

  it("4. a BARE directory — the reported failure: loads, and an edit materializes the body", async () => {
    const m = await mount({ "d/m.yamlover": "1\n" }, ":d");
    try {
      typeKeys("z: 9→");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.exists("d/.yamlover/body.yamlover"), "the backend derives the overlay").toBe(true);
      expect(m.read("d/.yamlover/body.yamlover")).toContain("z: 9");
    } finally { m.done(); }
  });

  it("5. a keyed MEMBER directory — the edit routes to the member's own body", async () => {
    const m = await mount({ "d/m/.yamlover/body.yamlover": "a: 1\n" }, ":d");
    try {
      retypeToken("1", "2");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("d/m/.yamlover/body.yamlover")).toBe("a: 2\n");
    } finally { m.done(); }
  });

  it("6. a node DEEP in a document (positional mount path)", async () => {
    const m = await mount({ "doc.yamlover": "a:\n  b: 1\n" }, ":doc.yamlover:a");
    try {
      typeKeys("z: 9→");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("doc.yamlover")).toContain("z: 9");
      expect(m.read("doc.yamlover")).toContain("b: 1");
    } finally { m.done(); }
  });

  it("7. an OMNI document — the self-value edit keeps its row", async () => {
    const m = await mount({ "o.yamlover": "5\n- one\n" }, ":o.yamlover");
    try {
      retypeToken("5", "6");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("o.yamlover")).toBe("6\n- one\n");
    } finally { m.done(); }
  });

  it("8. a K&R document — an interior edit is a whole-token emplace; the layout survives", async () => {
    const m = await mount({ "k.yamlover": "[\n  1,\n  2\n]\n" }, ":k.yamlover");
    try {
      retypeToken("1", "9");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("k.yamlover")).toBe("[\n  9,\n  2\n]\n");
    } finally { m.done(); }
  });

  it("10. the reported CYCLE: a JSON hierarchy entered, UNWOUND to empty, then YAML entered", async () => {
    const m = await mount({ "note.yamlover": "" }, ":note.yamlover");
    try {
      typeKeys("{a: 1}");                         // a JSON-like hierarchy ({ is a literal here)
      await settleOps();
      expect(m.read("note.yamlover")).toBe("{a: 1}\n");
      // the Backspace ladder to the empty document (text clears ride onChange, like a browser)
      for (let i = 0; i < 60; i++) {
        const doc = document.querySelector("[data-testid=y2-doc]")!;
        if ((doc.textContent ?? "").includes("(empty document)")) break;
        const el = document.activeElement as HTMLInputElement;
        expect(el && el !== document.body, "the ladder lost the caret").toBeTruthy();
        if (el instanceof HTMLInputElement && el.value !== "") fireEvent.change(el, { target: { value: "" } });
        else fireEvent.keyDown(el, { key: "Backspace" });
      }
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("note.yamlover"), "the deletion must PERSIST — the reported gap").toBe("");
      typeKeys("- name: Eurasia→");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]); // 'cannot descend into a scalar element at [0]' — gone
      expect(m.read("note.yamlover")).toBe("- name: Eurasia\n");
    } finally { m.done(); }
  });

  it("11. the reported MID-TYPING flush: `- name: Eurasia` ⏎ ⇤ with a flush between every stroke", async () => {
    // A flush that lands BEFORE Enter commits writes the pending item as a bare `-` — a NULL
    // scalar on disk (block YAML has no empty container). The next flush must then emit the
    // grown item as ONE whole-node replace, never a child insert the splicer cannot take
    // ('edit sync failed: cannot descend into a scalar element at [0]', reported 2026-07-29).
    const m = await mount({ "note.yamlover": "" }, ":note.yamlover");
    try {
      typeKeys("- name: Eurasia");
      await settleOps(); // flush the PENDING state: disk holds `-`
      expect(m.read("note.yamlover")).toBe("-\n");
      typeKeys("⏎");
      await settleOps();
      typeKeys("⇤");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("note.yamlover")).toBe("- name: Eurasia\n");
    } finally { m.done(); }
  });

  it("9. COMMENTS SURVIVE an unrelated edit — the per-node-ops architecture's win", async () => {
    const m = await mount({ "c.yamlover": "# the lead comment\na: 1\nb: 2 # the trailing one\n" }, ":c.yamlover");
    try {
      retypeToken("1", "5");
      await settleOps();
      expect(m.alerts, m.alerts.join(" | ")).toEqual([]);
      expect(m.read("c.yamlover")).toBe("# the lead comment\na: 5\nb: 2 # the trailing one\n");
    } finally { m.done(); }
  });
});
