// @vitest-environment jsdom
// THE YED MOUNT, end to end — the @yamlover/yed editor rendered by the server's wrapper against a
// REAL handler over a REAL temp tree (the edit-corpus harness's transport): load via GET
// /api/source, keystrokes through the package's cells, the debounced single-emplace flush, and
// the assertion is WHAT CAME OUT ON DISK.
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { createHandlers, tmpTree } from "./helpers";
import { captureAlerts, installFetch, settleOps } from "./edit-corpus-harness";
import { YedEditor, yedSourceEditor } from "../src/client/renderers/yed-editor";

afterEach(cleanup);

/** Type through yed's REAL key plumbing (its cells are <input>s: keydown first; a printable the
 *  grammar left alone lands via onChange). `⏎` = Enter, `⇤` = Shift-Tab, `→`/`←` = arrows,
 *  `⌫` = Backspace (caret parked at the end, so it eats the last character). */
function typeKeys(script: string): void {
  for (const ch of script) {
    const el = document.activeElement;
    expect(el && el !== document.body, `the caret fell off the editor before ${JSON.stringify(ch)}`).toBeTruthy();
    const key = ch === "⏎" ? "Enter" : ch === "⇤" ? "Tab" : ch === "→" ? "ArrowRight" : ch === "←" ? "ArrowLeft"
      : ch === "⌫" ? "Backspace" : ch;
    const input = el as HTMLInputElement;
    const before = input instanceof HTMLInputElement ? input.value : "";
    if (key === "Backspace" && input instanceof HTMLInputElement) input.setSelectionRange(before.length, before.length);
    const defaulted = fireEvent.keyDown(input, { key, shiftKey: ch === "⇤" });
    if (defaulted && input instanceof HTMLInputElement) {
      if (key === "Backspace") fireEvent.change(input, { target: { value: before.slice(0, -1) } });
      else if (key.length === 1) fireEvent.change(input, { target: { value: before + key } });
    }
  }
}

describe("the yed mount — real server, real file", () => {
  async function mount(initial: string): Promise<{ root: string; bodyPath: string; alerts: string[]; done: () => void }> {
    const root = tmpTree({ "note.yo": initial });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const restoreFetch = installFetch(h);
    const alerts = captureAlerts();
    const { container, unmount } = render(<YedEditor path=":note.yo" onNavigate={() => {}} />);
    await waitFor(() => expect(container.querySelector("[data-testid=y2-doc]")).toBeTruthy(), { timeout: 3000 });
    return {
      root,
      bodyPath: path.join(root, "note.yo"),
      alerts: alerts.messages,
      done: () => { unmount(); restoreFetch(); alerts.restore(); },
    };
  }

  it("typing into a FRESH document lands on disk through the emplace flush", async () => {
    const m = await mount("");
    try {
      typeKeys("key1: value1→");
      await settleOps();
      expect(m.alerts, `the server rejected the flush: ${m.alerts.join(" | ")}`).toEqual([]);
      expect(fs.readFileSync(m.bodyPath, "utf8")).toBe("key1: value1\n");
    } finally { m.done(); }
  });

  it("an EXISTING document loads, takes an edit, and keeps its other entries", async () => {
    const m = await mount("a: 1\nb: 2\n");
    try {
      typeKeys("z: 9→"); // the initial hole sits at the document's first row
      await settleOps();
      expect(m.alerts).toEqual([]);
      expect(fs.readFileSync(m.bodyPath, "utf8")).toBe("z: 9\na: 1\nb: 2\n");
    } finally { m.done(); }
  });

  it("a REFERENCE typed through the PICK kit lands COMPACT on disk (the isPointerValue gate)", async () => {
    const m = await mount("pets:\n  - one\n  - two\n");
    try {
      typeKeys("k: *"); // `k: ` names the pair; `*` mounts the query kit over the hole
      const cell = await waitFor(() => {
        const c = document.querySelector<HTMLElement>(".y2-ptrwrap .crumb-cell");
        expect(c, "the kit did not mount over the `*` hole").toBeTruthy();
        return c!;
      });
      cell.textContent = "pets[1]"; // the legacy alias spelling — the reduce respells it
      fireEvent.input(cell);
      fireEvent.keyDown(cell, { key: "Enter" });
      await waitFor(() => expect(fs.readFileSync(m.bodyPath, "utf8")).toContain("*pets:1"), { timeout: 3000 });
      await settleOps();
      expect(m.alerts, `the server rejected the pointer flush: ${m.alerts.join(" | ")}`).toEqual([]);
      expect(fs.readFileSync(m.bodyPath, "utf8")).toBe("k: *pets:1\npets:\n  - one\n  - two\n");
    } finally { m.done(); }
  });
});

// An EMPTY TREE is the coldest start there is: no file, no body, the mount is the DIRECTORY root,
// and every path the editor can name is the document root itself. It is also the first thing a new
// user sees, so the very first keystrokes have to survive.
describe("the yed mount on an EMPTY TREE — the document root is the only address", () => {
  async function mountEmpty() {
    const root = tmpTree({});
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const restoreFetch = installFetch(h);
    const alerts = captureAlerts();
    const { container, unmount } = render(<YedEditor path=":" onNavigate={() => {}} />);
    await waitFor(() => expect(container.querySelector("[data-testid=y2-doc]")).toBeTruthy(), { timeout: 3000 });
    return {
      bodyPath: path.join(root, ".yo", "body.yo"),
      alerts: alerts.messages,
      done: () => { unmount(); restoreFetch(); alerts.restore(); },
    };
  }

  it("typing a flow token and ERASING it CLEARS the document (the explicit root clear)", async () => {
    const m = await mountEmpty();
    try {
      typeKeys("["); // the grammar auto-closes it to `[]` and flushes an emplace at the root
      await settleOps();
      expect(m.alerts, `the flow token was rejected: ${m.alerts.join(" | ")}`).toEqual([]);
      expect(fs.readFileSync(m.bodyPath, "utf8")).toBe("[]\n");

      typeKeys("⌫"); // …and erasing it flushes the root CLEAR (an explicitly empty emplace)
      await settleOps();
      expect(m.alerts, `erasing it was rejected: ${m.alerts.join(" | ")}`).toEqual([]);
      // the DELETION PERSISTS — the silent no-op here was the reported divergence (the TOC
      // kept the old tree and every later op mis-addressed the stale document)
      expect(fs.readFileSync(m.bodyPath, "utf8")).toBe("");
    } finally { m.done(); }
  });
});

describe("the rollout flag — yed by DEFAULT, legacy one query-param away", () => {
  it("defaults to yed; localStorage and the query param flip it (param wins)", () => {
    window.history.replaceState({}, "", "/");
    window.localStorage.removeItem("yedEditor");
    expect(yedSourceEditor()).toBe(true);
    window.localStorage.setItem("yedEditor", "legacy");
    expect(yedSourceEditor()).toBe(false);
    window.history.replaceState({}, "", "/?yedEditor=yed");
    expect(yedSourceEditor()).toBe(true);          // the param overrides the stored escape
    window.history.replaceState({}, "", "/?yedEditor=legacy");
    window.localStorage.removeItem("yedEditor");
    expect(yedSourceEditor()).toBe(false);
    window.history.replaceState({}, "", "/");
  });
});
