import { describe, it, expect } from "vitest";
import { scalarValue } from "../../src/client/render";

// A string/scalar renderer must show the SELF-VALUE. An omni node (a scalar that also gained
// fields — e.g. a markdown doc with `yamlover-annotations`) projects its page value as a
// `$yamloverMixed` marker; scalarValue peels it so the renderer gets the string, not "[object
// Object]". This is the page-side half of the facet-tolerant dispatch (TYPES.md §9).
describe("scalarValue", () => {
  it("passes a plain scalar through", () => {
    expect(scalarValue("# Hello")).toBe("# Hello");
    expect(scalarValue(42)).toBe(42);
    expect(scalarValue(null)).toBe(null);
  });

  it("peels an omni node's $yamloverMixed marker to its self-value (the [object Object] fix)", () => {
    const omni = {
      $yamloverMixed: {
        kind: "omni",
        value: "# ANNOTATIONS\n\nbody",
        entries: [{ key: "yamlover-annotations", value: { $yamloverLink: {} } }],
      },
    };
    expect(scalarValue(omni)).toBe("# ANNOTATIONS\n\nbody");
  });

  it("leaves a `mix` marker (no self-value) alone", () => {
    const mix = { $yamloverMixed: { kind: "mix", entries: [] } };
    expect(scalarValue(mix)).toBe(mix);
  });
});
