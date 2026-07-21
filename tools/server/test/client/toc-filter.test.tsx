// @vitest-environment jsdom
// The filtered TOC: while the breadcrumb machine is not idle, the left pane swaps to the
// server's pruned tree (matches + ancestors, pre-expanded), match rows marked, selection
// suppressed during editing, row clicks routed through the machine. The Host mirrors
// App.tsx's left-pane wiring exactly.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import { useState } from "react";

vi.mock("../../src/client/api", () => ({
  query: vi.fn().mockResolvedValue([]),
  queryTree: vi.fn().mockResolvedValue([]),
  queryFilter: vi.fn(),
  fetchTree: vi.fn(),
}));
import { fetchTree, queryFilter, TreeNode } from "../../src/client/api";
import { Breadcrumb, useBreadcrumb } from "../../src/client/Breadcrumb";
import { Tree } from "../../src/client/Tree";
import { TocFilterSession, useTocFilterSession } from "../../src/client/toc-filter-session";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  vi.mocked(queryFilter).mockReset();
  vi.mocked(fetchTree).mockReset();
});

const n = (path: string, label: string, hasChildren = false, children: TreeNode[] = [], match?: boolean): TreeNode =>
  ({ path, label, type: "object", format: null, concrete: null, hasChildren, children, ...(match ? { match } : {}) });

// the normal (unfiltered) tree App owns
const NORMAL = n(":", "root", true, [n(":team", "team", true), n(":pets", "pets", true)]);
// the pruned filter tree the server returns for a query matching :team:alice
const PRUNED = n(":", "root", true, [n(":team", "team", true, [n(":team:alice", "alice", true, [], true)])]);

const selectSpy = vi.fn();

// The latest render's session — the eviction test claims it as "another host".
let lastSession: TocFilterSession;

// Mirrors App.tsx's wiring exactly: ONE TocFilterSession owns the filtered-TOC state, the
// breadcrumb drives it, TOC clicks route to the active owner.
function Host() {
  const [current, setCurrent] = useState(":pets");
  const session = useTocFilterSession();
  lastSession = session;
  const api = useBreadcrumb({
    current,
    select: (p) => {
      selectSpy(p);
      setCurrent(p);
    },
    session,
  });
  const filtering = session.filter !== null;
  return (
    <div>
      <Breadcrumb current={current} rootLabel="root" api={api} />
      <output data-testid="mode">{api.state.mode}</output>
      <div data-testid="toc">
        <Tree
          node={filtering ? session.filter!.root : NORMAL}
          current={api.state.mode === "editing" ? "" : current}
          filterMode={filtering}
          onSelect={(p) => (session.active ? session.pick(p) : selectSpy(p))}
          onLoadChildren={filtering ? session.loadChildren : async () => {}}
        />
        {filtering && session.filter!.truncated && <div className="toc-filter-note">first matches only (capped)</div>}
      </div>
    </div>
  );
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(500));
const cells = () => Array.from(document.querySelectorAll<HTMLElement>(".crumb-cell"));
const toc = () => within(screen.getByTestId("toc")); // the breadcrumb cells echo node names — scope tree queries

describe("filtered TOC", () => {
  beforeEach(() => selectSpy.mockReset());

  it("typing swaps the TOC to the pruned tree — expanded to the match, match marked, selection off", async () => {
    vi.useFakeTimers();
    vi.mocked(queryFilter).mockResolvedValue({ root: PRUNED, matches: [":team:alice"], truncated: false });
    render(<Host />);
    expect(toc().getByText("pets")).toBeTruthy(); // normal tree before editing
    const cell = cells()[0];
    fireEvent.focus(cell);
    cell.textContent = "ali";
    fireEvent.input(cell);
    await settle();
    // pruned tree in: pets gone, the ancestor chain expanded down to alice without any clicks
    expect(toc().queryByText("pets")).toBeNull();
    const alice = toc().getByText("alice").closest(".tree-row") as HTMLElement;
    expect(alice.className).toContain("match");
    expect(document.querySelector(".tree-row.selected")).toBeNull(); // editing: no selection
  });

  it("clicking a match row selects it and keeps the filter; the truncated note shows when capped", async () => {
    vi.useFakeTimers();
    vi.mocked(queryFilter).mockResolvedValue({ root: PRUNED, matches: [":team:alice"], truncated: true });
    render(<Host />);
    const cell = cells()[0];
    fireEvent.focus(cell);
    cell.textContent = "ali";
    fireEvent.input(cell);
    await settle();
    expect(toc().getByText("first matches only (capped)")).toBeTruthy();
    fireEvent.click(toc().getByText("alice"));
    expect(selectSpy).toHaveBeenCalledWith(":team:alice");
    expect(screen.getByTestId("mode").textContent).toBe("filtered");
    expect(toc().getByText("alice")).toBeTruthy(); // filter stays on
  });

  it("a match's server-shipped children render below it without any click", async () => {
    vi.useFakeTimers();
    // the server now ships a match's real children one level deep in the filter tree
    const withKids = n(":", "root", true, [
      n(":team", "team", true, [n(":team:alice", "alice", true, [n(":team:alice:age", "age")], true)]),
    ]);
    vi.mocked(queryFilter).mockResolvedValue({ root: withKids, matches: [":team:alice"], truncated: false });
    render(<Host />);
    const cell = cells()[0];
    fireEvent.focus(cell);
    cell.textContent = "ali";
    fireEvent.input(cell);
    await settle();
    // alice (the match) arrives expanded and its child row is already visible
    expect(toc().getByText("age")).toBeTruthy();
    expect(fetchTree).not.toHaveBeenCalled(); // no lazy load was needed
  });

  it("a match row's chevron loads its REAL children into the pruned tree", async () => {
    vi.useFakeTimers();
    vi.mocked(queryFilter).mockResolvedValue({ root: PRUNED, matches: [":team:alice"], truncated: false });
    vi.mocked(fetchTree).mockResolvedValue(n(":team:alice", "alice", true, [n(":team:alice:age", "age")]));
    render(<Host />);
    const cell = cells()[0];
    fireEvent.focus(cell);
    cell.textContent = "ali";
    fireEvent.input(cell);
    await settle();
    const aliceRow = toc().getByText("alice").closest(".tree-row") as HTMLElement;
    const chevron = aliceRow.querySelector("button")!;
    await act(async () => {
      fireEvent.click(chevron);
    });
    expect(fetchTree).toHaveBeenCalledWith(":team:alice", 1);
    expect(toc().getByText("age")).toBeTruthy();
  });

  it("leaving the filter closes branches the filter sprang open — no stale open chevron", async () => {
    vi.useFakeTimers();
    vi.mocked(queryFilter).mockResolvedValue({ root: PRUNED, matches: [":team:alice"], truncated: false });
    render(<Host />);
    const cell = cells()[0];
    fireEvent.focus(cell);
    cell.textContent = "ali";
    fireEvent.input(cell);
    await settle();
    // the filter sprang :team open (it holds the pruned chain down to alice)
    const openTeam = toc().getByText("team").closest(".tree-row")!.querySelector("button")!;
    expect(openTeam.className).toContain("open");
    fireEvent.keyDown(cell, { key: "Escape" }); // back to idle — the normal tree returns
    await settle();
    // :team survives the tree swap as the same component instance, but its normal-tree
    // children are not loaded — its chevron must reset to closed, not linger open
    const team = toc().getByText("team").closest(".tree-row")!.querySelector("button")!;
    expect(team.className).not.toContain("open");
    expect(team.getAttribute("aria-label")).toBe("expand");
  });

  it("a chevron is NON-FOCUSING — expanding/collapsing never blurs the cells nor stops the search", async () => {
    vi.useFakeTimers();
    vi.mocked(queryFilter).mockResolvedValue({ root: PRUNED, matches: [":team:alice"], truncated: false });
    render(<Host />);
    const cell = cells()[0];
    fireEvent.focus(cell);
    cell.textContent = "ali";
    fireEvent.input(cell);
    await settle();
    const chevron = toc().getByText("team").closest(".tree-row")!.querySelector("button")!;
    // mousedown is default-prevented, so the browser never moves focus off the query cell
    expect(fireEvent.mouseDown(chevron)).toBe(false);
    fireEvent.click(chevron); // toggling the branch is browsing, not a commit
    await settle();
    expect(screen.getByTestId("mode").textContent).toBe("editing"); // the search is still on
  });

  it("another host claiming the filter session EVICTS the breadcrumb — its edit is abandoned", async () => {
    vi.useFakeTimers();
    vi.mocked(queryFilter).mockResolvedValue({ root: PRUNED, matches: [":team:alice"], truncated: false });
    render(<Host />);
    const cell = cells()[0];
    fireEvent.focus(cell);
    cell.textContent = "ali";
    fireEvent.input(cell);
    await settle();
    expect(screen.getByTestId("mode").textContent).toBe("editing");
    expect(toc().getByText("alice")).toBeTruthy(); // the breadcrumb's filter is on
    // a reference cell / tag picker begins its own session — the breadcrumb must let go
    const onPick = vi.fn();
    let handle!: ReturnType<TocFilterSession["begin"]>;
    act(() => {
      handle = lastSession.begin({ onPick });
    });
    await settle();
    expect(screen.getByTestId("mode").textContent).toBe("idle"); // evicted → abandoned
    // TOC clicks now route to the NEW owner, not the breadcrumb and not navigation
    fireEvent.click(toc().getByText("pets")); // the normal tree is back (new owner has no filter yet)
    expect(onPick).toHaveBeenCalledWith(":pets");
    expect(selectSpy).not.toHaveBeenCalled();
    act(() => handle.end());
  });

  it("clicking an ancestor (non-match) row regresses to idle and the normal tree returns", async () => {
    vi.useFakeTimers();
    vi.mocked(queryFilter).mockResolvedValue({ root: PRUNED, matches: [":team:alice"], truncated: false });
    render(<Host />);
    const cell = cells()[0];
    fireEvent.focus(cell);
    cell.textContent = "ali";
    fireEvent.input(cell);
    await settle();
    fireEvent.click(toc().getByText("team")); // an ancestor row, not a match
    expect(selectSpy).toHaveBeenCalledWith(":team");
    expect(screen.getByTestId("mode").textContent).toBe("idle");
    expect(toc().getByText("pets")).toBeTruthy(); // normal tree restored
    expect(cells().map((c) => c.textContent)).toEqual(["team"]); // breadcrumb = plain path
  });
});

