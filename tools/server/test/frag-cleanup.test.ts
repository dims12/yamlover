import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call, callBody } from "./http";

const TAG = "::yamlover:tags:colors:yellow";
const TAG2 = "::yamlover:tags:colors:green";

describe("untagging the last tag deletes the empty fragment", () => {
  it("removes the fragment node (host + sibling fragments stay)", async () => {
    const root = tmpTree({ "docs/pic.png": "\x89PNG binary" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    // two fragments on the same image; one of them carries two tags
    const f1 = await callBody(h, "POST", "/api/fragment", { target: ":docs:pic.png", selector: { type: "rect", x: 1, y: 1, w: 5, h: 5 } });
    await callBody(h, "POST", "/api/annotate", { target: f1.json.fragmentPath, tag: TAG });
    await callBody(h, "POST", "/api/annotate", { target: f1.json.fragmentPath, tag: TAG2 });
    const f2 = await callBody(h, "POST", "/api/fragment", { target: ":docs:pic.png", selector: { type: "rect", x: 9, y: 9, w: 5, h: 5 } });
    await callBody(h, "POST", "/api/annotate", { target: f2.json.fragmentPath, tag: TAG });

    const fragNode = (slug: string) => call(h, "/api/json", { path: `:docs:pic.png:yamlover-fragments:${slug}` });

    // remove ONE of f1's two tags → f1 still exists (one tag left)
    await callBody(h, "DELETE", `/api/annotate?target=${encodeURIComponent(f1.json.fragmentPath)}&tag=${encodeURIComponent(":yamlover:tags:colors:yellow")}`, {});
    expect(fragNode(f1.json.slug).status).toBe(200); // still there

    // remove f1's LAST tag → the whole fragment node disappears
    await callBody(h, "DELETE", `/api/annotate?target=${encodeURIComponent(f1.json.fragmentPath)}&tag=${encodeURIComponent(":yamlover:tags:colors:green")}`, {});
    expect(fragNode(f1.json.slug).status).toBe(404); // gone

    // sibling f2 (and the image host) untouched
    expect(fragNode(f2.json.slug).status).toBe(200);
    expect(call(h, "/api/json", { path: ":docs:pic.png" }).status).toBe(200);
    expect(fs.existsSync(path.join(root, "docs", "pic.png"))).toBe(true);
    h.close();
  });

  it("untag clears a tag that was applied twice (no leftover duplicate)", async () => {
    // a hand-authored / race-duplicated annotation: the same tag listed twice on one node
    const root = tmpTree({
      ".yamlover/body.yamlover":
        '"pic.png":\n  yamlover-annotations:\n  - *::yamlover:tags:colors:yellow\n  - *::yamlover:tags:colors:yellow\n',
      "pic.png": "\x89PNG binary",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    expect(call(h, "/api/annotations", { path: ":pic.png" }).json.filter((a: { tag?: unknown }) => a.tag)).toHaveLength(2);
    await callBody(h, "DELETE", `/api/annotate?target=${encodeURIComponent(":pic.png")}&tag=${encodeURIComponent(":yamlover:tags:colors:yellow")}`, {});
    expect(call(h, "/api/annotations", { path: ":pic.png" }).json.filter((a: { tag?: unknown }) => a.tag)).toHaveLength(0); // BOTH gone
    h.close();
  });

  it("untags a tag whose NAME contains a space (quoted key — the real-data case)", async () => {
    // mirrors /tmp/yamlover-examples: an image fragment tagged with space-named tags, stored as
    // quoted pointers (`*::yamlover:tags:'fifth tag'`).
    const root = tmpTree({
      "pics/.yamlover/body.yamlover":
        '"photo.png":\n  yamlover-fragments:\n    abc123: !!<*::yamlover:$defs:fragment>\n' +
        "      type: \"rect\"\n      x: 1\n      y: 2\n      w: 3\n      h: 4\n" +
        "      yamlover-annotations:\n      - *::yamlover:tags:'fifth tag'\n      - *::yamlover:tags:'forth tag'\n",
      "pics/photo.png": "\x89PNG binary",
      // a local taxonomy defining the two space-named tags so they resolve as tag nodes
      "tags.yamlover": "'fifth tag': !!<*::yamlover:$defs:tag>\n'forth tag': !!<*::yamlover:$defs:tag>\n",
    });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const FRAG = ":pics:photo.png:yamlover-fragments:abc123";
    const tagged = () => call(h, "/api/annotations", { path: ":pics:photo.png" }).json.filter((a: { tag?: unknown }) => a.tag);
    expect(tagged()).toHaveLength(2);

    // remove "fifth tag" — the space-named one that used to be undeletable
    await callBody(h, "DELETE", `/api/annotate?target=${encodeURIComponent(FRAG)}&tag=${encodeURIComponent(":yamlover:tags:fifth tag")}`, {});
    expect(tagged()).toHaveLength(1);
    expect(tagged()[0].tag.path).toContain("forth");

    // remove the last one → fragment deleted
    await callBody(h, "DELETE", `/api/annotate?target=${encodeURIComponent(FRAG)}&tag=${encodeURIComponent(":yamlover:tags:forth tag")}`, {});
    expect(tagged()).toHaveLength(0);
    expect(call(h, "/api/json", { path: FRAG }).status).toBe(404);
    h.close();
  });

  it("removing the only fragment's last tag drops the yamlover-fragments key entirely", async () => {
    const root = tmpTree({ "docs/pic.png": "\x89PNG binary" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const f = await callBody(h, "POST", "/api/fragment", { target: ":docs:pic.png", selector: { type: "rect", x: 1, y: 1, w: 5, h: 5 } });
    await callBody(h, "POST", "/api/annotate", { target: f.json.fragmentPath, tag: TAG });
    await callBody(h, "DELETE", `/api/annotate?target=${encodeURIComponent(f.json.fragmentPath)}&tag=${encodeURIComponent(":yamlover:tags:colors:yellow")}`, {});
    expect(call(h, "/api/json", { path: ":docs:pic.png:yamlover-fragments" }).status).toBe(404);
    h.close();
  });
});
