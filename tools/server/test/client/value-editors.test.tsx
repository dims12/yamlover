// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";

// value-editors imports `editChunks` from ../api; mock just that (render.tsx only imports TYPES here).
const { editChunks } = vi.hoisted(() => ({ editChunks: vi.fn() }));
vi.mock("../../src/client/api", () => ({ editChunks }));

import { Render } from "../../src/client/render";
import { EditingContext } from "../../src/client/renderers/editing";
import { scalarToSource, acceptsAsScalar } from "../../src/client/renderers/value-editors";

function renderEditable(value: unknown, opts: { doc: string; node: string; concrete: string }) {
  return render(
    <EditingContext.Provider value={{ unlocked: true }}>
      <Render value={value} syntax="yaml" onNavigate={() => {}} documentPath={opts.doc} nodePath={opts.node} editable concrete={opts.concrete} />
    </EditingContext.Provider>,
  );
}

/** Focus an inline field, replace its text, and blur (which commits). */
function edit(field: HTMLElement, text: string) {
  fireEvent.focus(field);
  field.textContent = text;
  fireEvent.blur(field);
}

beforeEach(() => {
  editChunks.mockReset();
  editChunks.mockResolvedValue({ ok: true });
  cleanup();
});

describe("acceptsAsScalar (re-parse: accept only a yamlover scalar)", () => {
  it("accepts scalars — bare words, numbers, booleans, null, quoted strings", () => {
    for (const s of ["Rex", "hello world", "42", "-3.5", "true", "false", "~", "null", '"a, b"', "'a: b'"]) {
      expect(acceptsAsScalar(s)).toBe(true);
    }
  });
  it("refuses non-scalars, bare flow tokens, pointers, and empty input", () => {
    for (const s of ["a, b", "1, 2, 3", "[1, 2]", "{a: 1}", "a: b", "- x", "*x", ""]) {
      expect(acceptsAsScalar(s)).toBe(false);
    }
  });
});

describe("scalarToSource (the field's initial display token)", () => {
  it("null / booleans / numbers are bare; strings bare when safe, else quoted", () => {
    expect(scalarToSource(null, "yaml")).toBe("null");
    expect(scalarToSource(true, "yaml")).toBe("true");
    expect(scalarToSource(42, "yaml")).toBe("42");
    expect(scalarToSource("Rex", "yaml")).toBe("Rex");
    expect(scalarToSource("a, b", "yaml")).toBe('"a, b"'); // comma → quoted so it round-trips as a scalar
  });
});

describe("ScalarLeaf editing → verbatim yamlover source", () => {
  it("threads the colon-ENCODED edit path even through a key containing '/'", async () => {
    renderEditable({ "@vitejs/plugin-react": "18" }, { doc: ":deps", node: ":deps", concrete: "file/yamlover" });
    const field = await screen.findByText('"18"'); // a digit-led string shows quoted
    act(() => edit(field, "19"));
    await waitFor(() => expect(editChunks).toHaveBeenCalled());
    expect(editChunks).toHaveBeenCalledWith([expect.objectContaining({ path: ":deps:%40vitejs%2Fplugin-react", op: "emplace" })]);
  });

  it("sends what you type VERBATIM — `~` becomes null, not the string '~'", async () => {
    renderEditable({ note: "hi" }, { doc: ":x", node: ":x", concrete: "file/yamlover" });
    const field = await screen.findByText("hi");
    act(() => edit(field, "~"));
    await waitFor(() => expect(editChunks).toHaveBeenCalled());
    expect(editChunks).toHaveBeenCalledWith([{ path: ":x:note", op: "emplace", yamlover: "~" }]);
  });

  it("refuses a bare `a, b` (revert + error) but accepts the quoted form", async () => {
    renderEditable({ label: "old" }, { doc: ":x", node: ":x", concrete: "file/yamlover" });
    const field = await screen.findByText("old");
    act(() => edit(field, "a, b"));
    expect(editChunks).not.toHaveBeenCalled();
    expect(field.textContent).toBe("old"); // reverted
    expect(field.classList.contains("edit-error")).toBe(true);
    // the quoted form is accepted and sent verbatim
    act(() => edit(field, '"a, b"'));
    await waitFor(() => expect(editChunks).toHaveBeenCalled());
    expect(editChunks).toHaveBeenCalledWith([{ path: ":x:label", op: "emplace", yamlover: '"a, b"' }]);
  });

  it("refuses a non-scalar (a flow mapping) — no write", async () => {
    renderEditable({ label: "old" }, { doc: ":x", node: ":x", concrete: "file/yamlover" });
    const field = await screen.findByText("old");
    act(() => edit(field, "{a: 1}"));
    expect(editChunks).not.toHaveBeenCalled();
    expect(field.textContent).toBe("old");
  });

  it("an unchanged value is a no-op (no write)", async () => {
    renderEditable({ name: "Alice" }, { doc: ":x", node: ":x", concrete: "file/yamlover" });
    const field = await screen.findByText("Alice");
    act(() => edit(field, "Alice"));
    expect(editChunks).not.toHaveBeenCalled();
  });

  it("edits a number by re-typing yamlover source (type change is allowed)", async () => {
    renderEditable({ age: 4 }, { doc: ":x", node: ":x", concrete: "file/yamlover" });
    const field = await screen.findByText("4");
    act(() => edit(field, "true")); // a source editor: you may change the type
    await waitFor(() => expect(editChunks).toHaveBeenCalled());
    expect(editChunks).toHaveBeenCalledWith([{ path: ":x:age", op: "emplace", yamlover: "true" }]);
  });
});
