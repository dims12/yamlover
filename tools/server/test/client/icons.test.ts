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

  it("gives custom x-yamlover- formats an icon", () => {
    expect(typeIcon("array", "x-yamlover-chapter").glyph).toBe("§");
    expect(typeIcon("array", "x-yamlover-future").glyph).toBe("🧩");
  });

  it("shows a folder for a plain directory (`dir` concrete), but not other objects", () => {
    expect(typeIcon("object", null, "dir").glyph).toBe("📁"); // a real OS folder
    expect(typeIcon("object", null, "yamlover").glyph).toBe("{}"); // has .yamlover → not a plain folder
    expect(typeIcon("object", null, "yaml-schema/instantiate").glyph).toBe("{}");
    // a format still wins over the dir concrete
    expect(typeIcon("object", "x-yamlover-chapter", "dir").glyph).toBe("§");
  });

  it("falls back for an unknown type", () => {
    expect(typeIcon("weird", null).glyph).toBe("•");
  });
});
