import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "./helpers";
import { mergeAgentDoc } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { callBody, sseCapture } from "./http";

describe("mergeAgentDoc (marker-fenced merge)", () => {
  it("creates, appends, updates in place, and no-ops", () => {
    const created = mergeAgentDoc(null, "GUIDE v1");
    expect(created.status).toBe("created");
    expect(created.text).toContain("GUIDE v1");

    const appended = mergeAgentDoc("HUMAN RULES\n", "GUIDE v1");
    expect(appended.status).toBe("appended");
    expect(appended.text.startsWith("HUMAN RULES\n")).toBe(true);
    expect(appended.text).toContain("GUIDE v1");

    // reinstalling the SAME guide over the appended file is a no-op
    expect(mergeAgentDoc(appended.text, "GUIDE v1").status).toBe("exists");

    // a newer guide replaces the fenced block in place, keeping the human's text and count
    const updated = mergeAgentDoc(appended.text, "GUIDE v2");
    expect(updated.status).toBe("updated");
    expect(updated.text.startsWith("HUMAN RULES\n")).toBe(true);
    expect(updated.text).toContain("GUIDE v2");
    expect(updated.text).not.toContain("GUIDE v1");
    expect(updated.text.match(/BEGIN yamlover agent guide/g)?.length).toBe(1);
  });
});

// POST /api/agent-docs — install the bundled LLM-agent guide (AGENTS.md + CLAUDE.md) into the
// served root. The guidance is a marker-fenced block: a missing file is created, an existing file
// gets the block appended after the human's own rules, and a reinstall updates it in place — the
// human's text is never clobbered, and an up-to-date file is a no-op. Synthetic temp trees.

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

  it("appends the guide after existing content without clobbering it", async () => {
    const root = tmpTree({ "AGENTS.md": "MY EDITS\n", "CLAUDE.md": "MY EDITS\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/agent-docs", {});
    expect(r.status).toBe(201);
    expect(r.json.files).toEqual([
      { name: "AGENTS.md", status: "appended" },
      { name: "CLAUDE.md", status: "appended" },
    ]);
    const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    expect(agents.startsWith("MY EDITS\n")).toBe(true); // the human's rules stay on top …
    expect(agents).toContain("yamlover"); // … and the bundled guide follows
    expect(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
  });

  it("is idempotent: a reinstall updates the block in place, never duplicating it", async () => {
    const root = tmpTree({ "AGENTS.md": "MY EDITS\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    await callBody(h, "POST", "/api/agent-docs", {}); // appends AGENTS.md, creates CLAUDE.md
    const afterFirst = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");

    const r = await callBody(h, "POST", "/api/agent-docs", {}); // no change
    expect(r.json.files).toEqual([
      { name: "AGENTS.md", status: "exists" },
      { name: "CLAUDE.md", status: "exists" },
    ]);
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe(afterFirst);
    // the marker block appears exactly once
    expect(afterFirst.match(/BEGIN yamlover agent guide/g)?.length).toBe(1);
  });

  it("appends only where content exists; a missing sibling is created", async () => {
    const root = tmpTree({ "AGENTS.md": "MY EDITS\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const r = await callBody(h, "POST", "/api/agent-docs", {});
    expect(r.json.files).toEqual([
      { name: "AGENTS.md", status: "appended" },
      { name: "CLAUDE.md", status: "created" },
    ]);
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("MY EDITS");
    expect(fs.existsSync(path.join(root, "CLAUDE.md"))).toBe(true);
  });

  it("broadcasts a diff on write, but stays silent when nothing changed", async () => {
    const root = tmpTree({ name: "Alice" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const sse = sseCapture(h);

    await callBody(h, "POST", "/api/agent-docs", {}); // writes both → a diff
    await callBody(h, "POST", "/api/agent-docs", {}); // all up to date → no diff

    const diffs = sse.frames().filter((f) => f.type === "diff");
    expect(diffs.length).toBe(1);
    sse.close();
  });
});
