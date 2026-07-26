// The keystroke-script parser, shared with the corpus format (`{Enter}` named keys, `{{` a literal
// `{`) — a PURE copy for node-environment suites (the harness version pulls in @testing-library).
export type Stroke = { ch: string } | { key: string; shift?: boolean };

const NAMED = new Set(["Enter", "Tab", "ShiftTab", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export function parseScript(script: string): Stroke[] {
  const src = script.replace(/\n$/, "");
  const out: Stroke[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{" && src[i + 1] === "{") { out.push({ ch: "{" }); i++; continue; }
    if (c === "{") {
      const close = src.indexOf("}", i);
      if (close < 0) throw new Error(`unterminated { at ${i}`);
      const raw = src.slice(i + 1, close);
      if (!NAMED.has(raw)) throw new Error(`unknown key {${raw}}`);
      out.push(raw === "ShiftTab" ? { key: "Tab", shift: true } : { key: raw });
      i = close;
      continue;
    }
    out.push({ ch: c });
  }
  return out;
}
