import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { callBody, sseCapture } from "./http";

// POST /api/agent-docs — install the bundled LLM-agent guide (AGENTS.md + CLAUDE.md) into the
// served root. Skip-and-report by default; `{ overwrite: true }` rewrites. Synthetic temp trees.

describe("/api/agent-docs (install LLM agent guide)", () => {
  it("creates AGENTS.md and CLAUDE.md at the root when they are missing", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/agent-docs", {});
    expect(r.status).toBe(201);
    expect(r.json.files).toEqual([
      { name: "AGENTS.md", status: "created" },
      { name: "CLAUDE.md", status: "created" },
    ]);
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("yamlover");
    // CLAUDE.md @-imports AGENTS.md so Claude Code loads the same source of truth
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
  });

  it("skips & reports existing files without clobbering them", async () => {
    const root = tmpTree({ "AGENTS.md": "MY EDITS", "CLAUDE.md": "MY EDITS" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/agent-docs", {});
    expect(r.status).toBe(201);
    expect(r.json.files).toEqual([
      { name: "AGENTS.md", status: "exists" },
      { name: "CLAUDE.md", status: "exists" },
    ]);
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("MY EDITS");
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toBe("MY EDITS");
  });

  it("creates only the missing file, leaving the present one untouched", async () => {
    const root = tmpTree({ "AGENTS.md": "MY EDITS" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/agent-docs", {});
    expect(r.json.files).toEqual([
      { name: "AGENTS.md", status: "exists" },
      { name: "CLAUDE.md", status: "created" },
    ]);
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("MY EDITS");
    expect(fs.existsSync(path.join(root, "CLAUDE.md"))).toBe(true);
  });

  it("overwrites existing files when asked", async () => {
    const root = tmpTree({ "AGENTS.md": "MY EDITS", "CLAUDE.md": "MY EDITS" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/agent-docs", { overwrite: true });
    expect(r.json.files).toEqual([
      { name: "AGENTS.md", status: "overwritten" },
      { name: "CLAUDE.md", status: "overwritten" },
    ]);
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).not.toBe("MY EDITS");
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
  });

  it("broadcasts a diff on write, but stays silent when nothing changed", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const sse = sseCapture(h);

    await callBody(h, "POST", "/api/agent-docs", {}); // writes both → a diff
    await callBody(h, "POST", "/api/agent-docs", {}); // all exist → no diff

    const diffs = sse.frames().filter((f) => f.type === "diff");
    expect(diffs.length).toBe(1);
    sse.close();
  });
});
