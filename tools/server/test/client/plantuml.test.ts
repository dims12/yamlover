import { describe, it, expect } from "vitest";
import { inflateSync } from "fflate";
import { plantumlUrl } from "../../src/client/renderers/plantuml";

// Reverse of the renderer's PlantUML base64 variant (`0-9 A-Z a-z - _`), used to
// prove the encoded URL inflates back to the original source.
function decode6bit(c: string): number {
  const o = c.charCodeAt(0);
  if (o >= 48 && o < 58) return o - 48;
  if (o >= 65 && o < 91) return o - 65 + 10;
  if (o >= 97 && o < 123) return o - 97 + 36;
  if (c === "-") return 62;
  if (c === "_") return 63;
  return 0;
}
function decode64(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const c1 = decode6bit(s[i]), c2 = decode6bit(s[i + 1] ?? "0");
    const c3 = decode6bit(s[i + 2] ?? "0"), c4 = decode6bit(s[i + 3] ?? "0");
    out.push(((c1 << 2) | (c2 >> 4)) & 0xff, ((c2 << 4) | (c3 >> 2)) & 0xff, ((c3 << 6) | c4) & 0xff);
  }
  return new Uint8Array(out);
}

describe("plantumlUrl", () => {
  it("points an /svg/ request at a PlantUML server", () => {
    const url = plantumlUrl("@startuml\nA -> B\n@enduml");
    expect(url).toMatch(/\/plantuml\/svg\/[0-9A-Za-z_-]+$/);
  });

  it("deflate+encodes the source so the server can inflate it back", () => {
    const source = "@startuml\nBob -> Alice : hello\n@enduml";
    const encoded = plantumlUrl(source).split("/svg/")[1];
    const restored = new TextDecoder().decode(inflateSync(decode64(encoded)));
    // inflate yields the exact source (trailing padding bytes are ignored by the
    // DEFLATE stream length), so a diagram renders what the chunk actually holds
    expect(restored.startsWith(source)).toBe(true);
  });
});
