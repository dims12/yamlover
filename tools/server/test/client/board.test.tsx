// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import type { NodeJson } from "../../src/client/api";
import { cardMemberPaths } from "../../src/client/renderers/board";

const link = (info: Record<string, unknown>) => ({ $yamloverLink: info });

const node = (value: Record<string, unknown>): NodeJson => ({
  path: ":board",
  type: "object",
  format: "x-yamlover-board",
  concrete: "dir/yamlover",
  title: null,
  description: null,
  value,
});

describe("cardMemberPaths (board cards from the shared projection)", () => {
  it("includes ordinary card members and excludes the board's config keys + nested tag/workflow/board links", () => {
    const n = node({
      // config / taxonomy / graft keys — never cards
      workflow: link({ kind: "object", type: "object", format: "x-yamlover-workflow", path: ":board:workflow" }),
      columns: link({ kind: "array", type: "array", path: ":board:columns", count: 2 }),
      yamlover: link({ kind: "object", type: "object", path: ":board:yamlover" }),
      tags: link({ kind: "object", type: "object", path: ":board:tags" }),
      // a nested tag link is container-tagish → excluded even though its key is not a config key
      "a-tag": link({ kind: "object", type: "object", format: "x-yamlover-tag", path: ":board:a-tag" }),
      // genuine content cards
      "task-1.yamlover": link({ kind: "object", type: "object", format: "x-yamlover-task", path: ":board:task-1.yamlover", count: 4 }),
      "note.md": link({ kind: "scalar", type: "string", path: ":board:note.md", format: "text/markdown" }),
    });
    expect(cardMemberPaths(n)).toEqual([":board:task-1.yamlover", ":board:note.md"]);
  });

  it("drops inert (non-link) members", () => {
    const n = node({ stray: "not a link", "task.yamlover": link({ kind: "object", type: "object", path: ":board:task.yamlover" }) });
    expect(cardMemberPaths(n)).toEqual([":board:task.yamlover"]);
  });
});
