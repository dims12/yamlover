// yed2 — a tiny LINE diff (LCS) for the debug pane: what each edit did to the serialized
// document, visible. No dependency; documents here are small by construction.

export interface DiffLine { type: " " | "-" | "+"; line: string }

export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a === "" ? [] : a.replace(/\n$/, "").split("\n");
  const B = b === "" ? [] : b.replace(/\n$/, "").split("\n");
  // LCS table
  const m = A.length, n = B.length;
  const L: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { out.push({ type: " ", line: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ type: "-", line: A[i] }); i++; }
    else { out.push({ type: "+", line: B[j] }); j++; }
  }
  while (i < m) out.push({ type: "-", line: A[i++] });
  while (j < n) out.push({ type: "+", line: B[j++] });
  return out;
}
