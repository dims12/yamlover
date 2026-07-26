// yed2 entry — `npm run debug-editor`. No server: the corpus is inlined at build time.
import { createRoot } from "react-dom/client";
import { DebugEditorPage } from "../src/client/yed2/page";
import "./yed2.css";

// every corpus document, keyed by a readable name (repo-relative)
const raw: Record<string, string> = {};
for (const [p, src] of Object.entries(import.meta.glob("../../../edit-examples/*/out.yamlover", { eager: true, query: "?raw", import: "default" }))) {
  raw["edit-examples/" + p.split("/").slice(-2, -1)[0]] = src as string;
}
for (const [p, src] of Object.entries(import.meta.glob("../../../test-examples/*/in.yamlover", { eager: true, query: "?raw", import: "default" }))) {
  raw["test-examples/" + p.split("/").slice(-2, -1)[0]] = src as string;
}

createRoot(document.getElementById("root")!).render(<DebugEditorPage corpus={raw} />);
