import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/client/api", () => ({ queryTree: vi.fn() }));
import { queryTree } from "../../src/client/api";
import {
  childQuery, joinPortions, joinPortionsScoped, portionsFromPath, quoteKey, rankKeys, splitQueryPortions, treeCandidateProvider,
} from "../../src/client/query-complete";
import type { TreeNode } from "../../src/client/api";

describe("quoteKey", () => {
  it("passes plain keys through and quotes the rest", () => {
    expect(quoteKey("alice")).toBe("alice");
    expect(quoteKey("plugin-react")).toBe("plugin-react");
    expect(quoteKey("true")).toBe("'true'"); // bare literal would value-test
    expect(quoteKey("31")).toBe("'31'");
    expect(quoteKey("?")).toBe("'?'"); // bare matcher
    expect(quoteKey("with space")).toBe("'with space'");
    expect(quoteKey("a:b")).toBe("'a:b'");
    expect(quoteKey("it's")).toBe("'it''s'");
    expect(quoteKey("me..")).toBe("'me..'"); // would read as an up-key
  });
});

describe("rankKeys", () => {
  it("prefix matches first, then substrings; non-matches drop", () => {
    expect(rankKeys(["balice", "alice", "bob"], "al")).toEqual(["alice", "balice"]);
    expect(rankKeys(["b", "a"], "")).toEqual(["b", "a"]); // empty prefix keeps order
  });
});

describe("splitQueryPortions / portionsFromPath / joinPortions", () => {
  it("splits on top-level colons, quotes and !!<…> atomic", () => {
    expect(splitQueryPortions(": team: alice")).toEqual(["team", "alice"]);
    expect(splitQueryPortions("'a:b': x")).toEqual(["'a:b'", "x"]);
    expect(splitQueryPortions("a: !!<type: integer>: b")).toEqual(["a", "!!<type: integer>", "b"]);
    expect(splitQueryPortions("pets[0]: name")).toEqual(["pets[0]", "name"]);
  });

  it("is tolerant mid-edit: an unterminated !!< or quote owns the rest", () => {
    expect(splitQueryPortions("a: !!<type: int")).toEqual(["a", "!!<type: int"]);
    expect(splitQueryPortions("a: 'unclosed: x")).toEqual(["a", "'unclosed: x"]);
  });

  it("portionsFromPath folds numeric segments into the preceding cell", () => {
    expect(portionsFromPath(":pets[0]:name")).toEqual(["pets[0]", "name"]);
    expect(portionsFromPath(":")).toEqual([]);
    expect(portionsFromPath(":a:b")).toEqual(["a", "b"]);
    expect(portionsFromPath("[0]:x")).toEqual(["[0]", "x"]); // leading ordinal: its own cell
  });

  it("portionsFromPath quotes keys that would misparse; joinPortions round-trips", () => {
    expect(portionsFromPath(":true:31")).toEqual(["'true'", "'31'"]);
    expect(joinPortions(["pets[0]", "name"])).toBe(": pets[0]: name");
    expect(joinPortions([])).toBe(":");
    expect(joinPortions(["a", "", "b"])).toBe(": a: b"); // empty append cell skipped
    // round-trip: path → cells → query text → portions
    expect(splitQueryPortions(joinPortions(portionsFromPath(":team:alice")))).toEqual(["team", "alice"]);
  });

  it("joinPortionsScoped spells every rung of the scope ladder; empty cells collapse to the opener", () => {
    expect(joinPortionsScoped(["a", "b"], 0)).toBe("a: b"); // current scope: bare
    expect(joinPortionsScoped(["a", "b"], 1)).toBe(": a: b");
    expect(joinPortionsScoped(["a", "b"], 2)).toBe(":: a: b");
    expect(joinPortionsScoped(["a", "b"], 3)).toBe("::: a: b");
    expect(joinPortionsScoped([], 0)).toBe(""); // the asking node itself
    expect(joinPortionsScoped([], 1)).toBe(":");
    expect(joinPortionsScoped([], 2)).toBe("::");
    expect(joinPortionsScoped(["", ""], 0)).toBe(""); // empty append cells skipped at every rung
    expect(joinPortionsScoped(["a", ""], 1)).toBe(": a");
    // ladder 1 IS the breadcrumb's joinPortions
    expect(joinPortionsScoped(["pets[0]", "name"], 1)).toBe(joinPortions(["pets[0]", "name"]));
  });

  it("childQuery steps ? from any context spelling", () => {
    expect(childQuery("")).toBe("?"); // bare current scope: the asking node's children
    expect(childQuery(":")).toBe(": ?");
    expect(childQuery("::")).toBe(":: ?");
    expect(childQuery(": team")).toBe(": team: ?");
    expect(childQuery("a: b")).toBe("a: b: ?");
  });
});

describe("treeCandidateProvider", () => {
  const n = (path: string, label: string): TreeNode => ({ path, label, type: "object", format: null, concrete: null, hasChildren: false, children: [] });
  // braces matter: mockReset() returns the mock, and a beforeEach RETURN value is run
  // as a cleanup hook — the mock itself would be invoked after every test
  beforeEach(() => {
    vi.mocked(queryTree).mockReset();
  });

  it("lists the context's real children as TreeNode candidates, deduped, with portion inserts", async () => {
    vi.mocked(queryTree).mockResolvedValue([n(":team:alice", "alice"), n(":team:alice", "alice"), n(":pets[0]", "Rex"), n(":team:has space", "has space")]);
    const p = treeCandidateProvider(":");
    const cands = await p(": team", "");
    expect(queryTree).toHaveBeenCalledWith(": team: ?", ":");
    const keys = cands.filter((c) => c.kind === "key");
    expect(keys.map((k) => k.insert)).toEqual(["alice", "[0]", "'has space'"]);
    expect(keys[0].kind === "key" && keys[0].node.label).toBe("alice"); // whole TreeNode kept (icons)
  });

  it("a bare-opener context queries that scope root's children; a bare-current context asks ? at the node", async () => {
    vi.mocked(queryTree).mockResolvedValue([]);
    await treeCandidateProvider(":")(":", "");
    expect(queryTree).toHaveBeenCalledWith(": ?", ":");
    await treeCandidateProvider(":team")("", "");
    expect(queryTree).toHaveBeenCalledWith("?", ":team"); // current scope: children of `at`
  });

  it("ranks by prefix against label OR insert; operators filter by prefix", async () => {
    vi.mocked(queryTree).mockResolvedValue([n(":x:balice", "balice"), n(":x:alice", "alice"), n(":x:bob", "bob")]);
    const cands = await treeCandidateProvider(":")(": x", "al");
    const keys = cands.filter((c) => c.kind === "key");
    expect(keys.map((k) => k.insert)).toEqual(["alice", "balice"]);
    expect(cands.filter((c) => c.kind === "operator")).toEqual([]); // nothing starts with "al"
  });

  it("value-test / meta / index prefixes get operators only; fetch failures degrade to operators", async () => {
    const p = treeCandidateProvider(":");
    const ops = await p(": x", ">1");
    expect(queryTree).not.toHaveBeenCalled();
    expect(ops.every((c) => c.kind === "operator")).toBe(true);
    vi.mocked(queryTree).mockRejectedValue(new Error("400"));
    const degraded = await p(": x", "");
    expect(degraded.every((c) => c.kind === "operator")).toBe(true);
    expect(degraded.some((c) => c.insert === "?")).toBe(true);
  });
});
