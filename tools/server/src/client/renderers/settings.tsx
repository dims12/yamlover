// The SETTINGS editor — the project config (`:.yamlover:settings.yamlover`, IMPORTS.md), rendered
// in the main pane when you navigate to that node (the gear button does). It is the FIRST of the
// "editor renderers": a renderer that not only displays a node but EDITS it and persists, then lets
// the unified SSE change-flow refresh every surface (the board renderer is the other example).
//
// The config file is engine-owned and carries hand-authored COMMENTS, so the source of truth on
// save is the RAW text (a structural form that rewrote the file would lose them). Layout: a parsed
// SUMMARY (uri / exports / locations / last tag) over a raw-source <textarea> with Save. Source +
// parsed settings come from GET /api/config; Save → POST /api/config (validate + write + reindex).

import { useCallback, useEffect, useState } from "react";
import { fetchConfig, saveConfig, ConfigSettings } from "../api";
import { useDiffBump, touchesYamlover } from "../live";

export function SettingsView() {
  const [source, setSource] = useState<string>("");
  const [settings, setSettings] = useState<ConfigSettings | null>(null);
  const [filePath, setFilePath] = useState<string>(":.yamlover:settings.yamlover");
  const [state, setState] = useState<"loading" | "ready" | "saving">("loading");
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const bump = useDiffBump(touchesYamlover); // re-fetch when the config (or any .yamlover) changes

  useEffect(() => {
    let live = true;
    fetchConfig()
      .then((c) => {
        if (!live) return;
        // a pending local edit (dirty) must not be clobbered by a background refresh
        setSource((cur) => (dirty ? cur : c.source));
        setSettings(c.settings);
        setFilePath(c.path);
        setState((s) => (s === "loading" ? "ready" : s));
      })
      .catch((e) => live && setError(String(e.message || e)));
    return () => {
      live = false;
    };
  }, [bump]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    setState("saving");
    setError(null);
    try {
      const { settings } = await saveConfig(source);
      setSettings(settings);
      setDirty(false);
      setState("ready");
    } catch (e) {
      setError(String((e as Error).message || e));
      setState("ready");
    }
  }, [source]);

  return (
    <div className="settings-view">
      <header className="settings-head">
        <span className="settings-title">⚙ Project configuration</span>
        <span className="settings-path">{filePath}</span>
      </header>

      {state === "loading" ? (
        <div className="settings-dim">loading…</div>
      ) : (
        <>
          {settings && (
            <dl className="settings-summary">
              <dt>URI</dt>
              <dd>{settings.uri ?? <span className="settings-dim">— (no declared identity)</span>}</dd>
              <dt>Exports</dt>
              <dd>
                {settings.exports.length ? (
                  settings.exports.map((x) => (
                    <code key={x} className="settings-chip">
                      {x}
                    </code>
                  ))
                ) : (
                  <span className="settings-dim">— (nothing exported)</span>
                )}
              </dd>
              <dt>Tags location</dt>
              <dd>
                <code>{settings.tags}</code>
              </dd>
              <dt>Annotations location</dt>
              <dd>
                <code>{settings.annotations}</code>
              </dd>
              <dt>Sidecars</dt>
              <dd>
                <code>{settings.sidecars}</code>
              </dd>
              <dt>Last tag</dt>
              <dd>{settings.annotationTag ? <code>{settings.annotationTag}</code> : <span className="settings-dim">— (none yet)</span>}</dd>
            </dl>
          )}

          <label className="settings-raw-label">Source — settings.yamlover</label>
          <textarea
            className="settings-raw"
            spellCheck={false}
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setDirty(true);
            }}
          />
          {error && <div className="settings-error">{error}</div>}
          <div className="settings-actions">
            <span className="settings-dim">Defaults, never constraints — a node works wherever it lives.</span>
            <button type="button" className="settings-save" onClick={save} disabled={state !== "ready" || !dirty}>
              {state === "saving" ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
