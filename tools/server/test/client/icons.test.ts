import { describe, it, expect } from "vitest";
import { typeIcon } from "../../src/client/icons";

describe("typeIcon", () => {
  it("picks an icon by type when there is no format", () => {
    expect(typeIcon("object", null).glyph).toBe("{}");
    expect(typeIcon("array", null).glyph).toBe("[]");
    expect(typeIcon("integer", null).glyph).toBe("#");
    expect(typeIcon("boolean", null).cls).toBe("t-bool");
  });

  it("lets format win over type", () => {
    expect(typeIcon("string", "date").glyph).toBe("📅");
    expect(typeIcon("string", "email").glyph).toBe("✉️");
    expect(typeIcon("binary", "image/png").glyph).toBe("🖼️");
  });

  it("falls back for an unknown type", () => {
    expect(typeIcon("weird", null).glyph).toBe("•");
  });
});
