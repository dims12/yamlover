import { describe, it, expect } from "vitest";
import { createHandlers } from "../src/server/engine-api";
import { tmpTree } from "./helpers";
import { call } from "./http";

// A scalar's decoded VALUE loses its authored spelling — `"~"` (a string) and `~` (null) both project
// to distinct values, but `0xff`→255, `True`→true, a quoted `"~"`→"~" all render ambiguously if shown
// bare. The projection carries the authored SOURCE token (`raw`) in the comment sidecar, but ONLY when
// it differs from the plain decoded form, so the renderer can show it faithfully (CONCRETES.md
// §Scalar representation). Plain `Rex`/`42` carry nothing.
describe("scalar raw representation (comment sidecar)", () => {
  it("carries raw for representation-significant scalars only, value unchanged", async () => {
    const src = 'humans:\n  - name: "~"\n    plain: Rex\n    id: 0xff\n    n: 42\n    b: True\n    nul: ~\n';
    const root = tmpTree({ "d.yamlover": src });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const j = call(h, "/api/json", { path: ":d.yamlover", depth: ".inf" }).json as { value: any; comments: Record<string, { raw?: string }> };
    const c = j.comments;

    expect(j.value.humans[0].name).toBe("~"); // still the STRING "~", not null
    expect(j.value.humans[0].id).toBe(255);
    expect(j.value.humans[0].nul).toBeNull();

    expect(c["/humans[0]/name"]?.raw).toBe('"~"'); // quoted → distinguishable from null
    expect(c["/humans[0]/id"]?.raw).toBe("0xff"); // hex spelling kept
    expect(c["/humans[0]/b"]?.raw).toBe("True"); // casing kept
    expect(c["/humans[0]/nul"]?.raw).toBe("~"); // tilde null kept
    expect(c["/humans[0]/plain"]?.raw).toBeUndefined(); // plain string → nothing
    expect(c["/humans[0]/n"]?.raw).toBeUndefined(); // plain decimal → nothing
  });
});
