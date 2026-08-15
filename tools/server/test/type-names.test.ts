import { describe, it, expect } from "vitest";
import { displayType } from "../src/type-names";

describe("displayType", () => {
  it("maps JSON Schema names to yamlover spellings", () => {
    expect(displayType("object")).toBe("map");
    expect(displayType("array")).toBe("seq");
    expect(displayType("string")).toBe("str");
    expect(displayType("integer")).toBe("int");
    expect(displayType("number")).toBe("float");
    expect(displayType("boolean")).toBe("bool");
  });

  it("passes yamlover names through", () => {
    expect(displayType("map")).toBe("map");
    expect(displayType("seq")).toBe("seq");
    expect(displayType("str")).toBe("str");
    expect(displayType("kseq")).toBe("kseq");
    expect(displayType("omni")).toBe("omni");
    expect(displayType("null")).toBe("null");
    expect(displayType("binary")).toBe("binary");
  });
});
