import { describe, it, expect } from "vitest";
import fs from "node:fs"; import path from "node:path";
import { createHandlers } from "./helpers";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";
import { buildChapterModel, snapshotChapter, diffChapter, newProsePart } from "../src/client/renderers/chapter-model";

const DEFS = {
  "$defs/chapter": "type: variant\nproperties:\n  title:\n    type: string\n  description:\n    type: string\nitems:\n  anyOf:\n    - *//yamlover/$defs/chapter\n    - *//yamlover/$defs/chunk\n",
  "$defs/chunk": "type: [string, binary]\nformat: text/marklower\n",
};
// a document with COMMENTS and hand-quoting that a reserializer would destroy
const SRC = `!!<*yamlover/$defs/chapter>
# a hand-written comment that must survive
title: "The Handbook"
- Hello **world**
- |
  first line
  second line
- title: Sub
  - First
`;
// The editor's whole loop against a real tree: /api/json → buildChapterModel → diffChapter →
// /api/edit → reindex. It is the only test that pins the CLIENT's escaping and absolute-index
// bookkeeping against the SERVER's splicer; the unit tests each know only their own half.
describe("the editor round-trip", () => {
  it("model → diff → /api/edit → reindexed, with comments intact", async () => {
    const root = tmpTree({ "doc/.yamlover/body.yamlover": SRC, ...DEFS });
    const h = createHandlers(root, { gitignore: false }); await h.ready;
    const read = () => fs.readFileSync(path.join(root, "doc", ".yamlover", "body.yamlover"), "utf8");

    // annotate the first chunk (abs 1) — the overlay must survive the prose edit below
    const tag = await callBody(h, "POST", "/api/tag", { name: "imp" });
    await callBody(h, "POST", "/api/annotate", { target: ":doc[1]", tag: tag.json.path });

    // 1. build the model exactly as the client does (depth 1)
    const node: any = call(h, "/api/json", { path: ":doc", depth: "1" }).json;
    const model = buildChapterModel(node);
    const committed = snapshotChapter(model);

    // 2. the user: renames the title, edits chunk 0, splits chunk 1, deletes nothing
    model.title = "Renamed";
    expect(model.chunks[0].editable).toBe(false); // annotated → omni marker → read-only (MINITODO 026)
    model.chunks[1].text = "one\ntwo";
    model.chunks.splice(2, 0, newProsePart("a fresh paragraph"));

    // 3. diff → edit
    const edits = diffChapter(committed, model);
    const r = await callBody(h, "POST", "/api/edit", { edits });
    expect(r.status).toBe(200);

    // 4. the document reads back as intended, and the comment + annotation survived
    const after: any = call(h, "/api/json", { path: ":doc", depth: "3" }).json;
    expect(after.title).toBe("Renamed");
    expect(read()).toContain("# a hand-written comment that must survive");
    expect(read()).toContain("yamlover-annotations:");
    const b = (after.value.$yamloverMixed.entries as any[]).filter((e) => e.key == null).map((e) => e.value);
    expect(b[0].$yamloverMixed.value).toBe("Hello **world**"); // annotated chunk, overlay intact
    expect(b[1]).toBe("one\ntwo");
    expect(b[2]).toBe("a fresh paragraph");

    // 5. a SECOND round using the same model (absIndex was assigned by the diff)
    const committed2 = snapshotChapter(model);
    model.chunks[2].text = "edited again";
    const edits2 = diffChapter(committed2, model);
    expect((await callBody(h, "POST", "/api/edit", { edits: edits2 })).status).toBe(200);
    const after2: any = call(h, "/api/json", { path: ":doc", depth: "3" }).json;
    const b2 = (after2.value.$yamloverMixed.entries as any[]).filter((e) => e.key == null).map((e) => e.value);
    expect(b2[2]).toBe("edited again");
  });
});
