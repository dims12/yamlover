// @vitest-environment jsdom
// DropConfirm — the unified drop confirmation popup (anchored at the drop point).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DropConfirm, useDropConfirm } from "../../src/client/DropConfirm";
import type { DropPlan } from "../../src/drop-policy";

afterEach(cleanup);

const plan: DropPlan = { kind: "move-node", from: ":a:x", to: ":b:x", description: 'Move "x" into "b"' };

describe("DropConfirm", () => {
  it("shows the plan description and a kind-labeled confirm button at the drop point", () => {
    render(<DropConfirm x={40} y={60} plan={plan} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('Move "x" into "b"')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move" })).toBeTruthy();
    const el = screen.getByRole("dialog");
    expect(el.style.left).toBe("40px");
    expect(el.style.top).toBe("60px");
  });

  it("confirms on the button and on Enter", () => {
    const onConfirm = vi.fn();
    render(<DropConfirm x={0} y={0} plan={plan} onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it("cancels on the button, Escape, and an outside mousedown", () => {
    const onCancel = vi.fn();
    render(<DropConfirm x={0} y={0} plan={plan} onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.body);
    expect(onCancel).toHaveBeenCalledTimes(3);
    // a mousedown INSIDE the popup is not a cancel
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onCancel).toHaveBeenCalledTimes(3);
  });
});

function Owner({ run }: { run: () => void | Promise<void> }) {
  const { request, element } = useDropConfirm();
  return (
    <div>
      <button onClick={() => request(10, 20, plan, run)}>open</button>
      {element}
    </div>
  );
}

describe("useDropConfirm", () => {
  it("opens on request, runs only on confirm, and closes after", () => {
    const run = vi.fn();
    render(<Owner run={run} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("open"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancel closes without running", () => {
    const run = vi.fn();
    render(<Owner run={run} />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(run).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("alerts when the confirmed run rejects", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<Owner run={() => Promise.reject(new Error("target already exists"))} />);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    await Promise.resolve(); // let the rejection propagate
    await Promise.resolve();
    expect(alert).toHaveBeenCalledWith(expect.stringContaining("target already exists"));
    alert.mockRestore();
  });
});
