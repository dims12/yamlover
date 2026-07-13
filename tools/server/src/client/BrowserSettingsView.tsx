// The BROWSER SETTINGS page — the per-device settings document (browser-settings.ts), shown in
// the same generic editable data view as the project settings node. The document lives in
// localStorage, not on the server, so the round-trips are the STATELESS pair: /api/preview
// projects the text exactly as /api/json projects a node, and edits go through /api/edit-text
// (the same surgical ops as /api/edit) with the result persisted back into localStorage — the
// editing context's `sink` reroutes the scalar leaves' commits here.

import { useCallback, useEffect, useState } from "react";
import { previewSource, editText, type NodeJson, type Edit } from "./api";
import { BROWSER_SETTINGS_PATH, browserSettingsSource, saveBrowserSettings } from "./browser-settings";
import { Render } from "./render";
import { EditingContext } from "./renderers/editing";

export function BrowserSettingsView({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [node, setNode] = useState<NodeJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false); // the editing lock — locked by default

  useEffect(() => {
    document.title = "Browser settings";
    previewSource(browserSettingsSource())
      .then((n) => { setNode(n); setError(null); })
      .catch((e) => setError(String((e as Error).message || e)));
  }, []);

  // F2 enters edit mode, Esc exits — the same keys as the data view (NodeView).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F2" && !unlocked) { e.preventDefault(); setUnlocked(true); }
      else if (e.key === "Escape" && unlocked) { e.preventDefault(); setUnlocked(false); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [unlocked]);

  // The scalar leaves' edit sink: apply the edit to the CURRENT text, persist, re-project. The
  // leaves address nodes by the FULL virtual path (`:.browser:settings.yamlover:width`); the text
  // is its own document, so strip the document prefix before the surgical edit.
  const sink = useCallback(async (edit: Edit): Promise<boolean> => {
    try {
      const rel = edit.path.startsWith(BROWSER_SETTINGS_PATH) ? edit.path.slice(BROWSER_SETTINGS_PATH.length) : edit.path;
      const { source } = await editText(browserSettingsSource(), [{ ...edit, path: rel }]);
      saveBrowserSettings(source);
      setNode(await previewSource(source));
      return true;
    } catch {
      return false; // the field reverts and flags .edit-error; the stored text is untouched
    }
  }, []);

  if (error) return <div className="nodeview"><p className="error">{error}</p></div>;
  if (!node) return <div className="nodeview"><p>…</p></div>;

  return (
    <div className="nodeview">
      <div className="nodehead">
        <div className="nodemeta">
          <span className="tag">{node.type}</span>
          {node.concrete && <span className="tag dim">{node.concrete}</span>}
          <span className="tag dim" title="Stored in this browser's localStorage — not part of any project">this browser</span>
        </div>
        <span className="bar-sep" aria-hidden="true">|</span>
        <button
          className={"lockbtn" + (unlocked ? " unlocked" : "")}
          title={unlocked ? "Editing — click or Esc to finish" : "Read-only — click or F2 to edit"}
          aria-pressed={unlocked}
          onClick={() => setUnlocked((v) => !v)}
        >
          <span className="lockbtn-icon" aria-hidden="true">{unlocked ? "✓" : "✏️"}</span>
          <span className="lockbtn-label">{unlocked ? "Done" : "Edit"}</span>
        </button>
      </div>
      <EditingContext.Provider value={{ unlocked, sink }}>
        <pre className="code">
          <Render
            value={node.value}
            syntax="yaml"
            onNavigate={onNavigate}
            documentPath={BROWSER_SETTINGS_PATH}
            nodePath={BROWSER_SETTINGS_PATH}
            comments={node.comments}
            editable
            concrete={node.concrete}
          />
        </pre>
      </EditingContext.Provider>
    </div>
  );
}
