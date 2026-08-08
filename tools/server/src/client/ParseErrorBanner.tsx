import type { NodeJson } from "./api";

/** The face of a DEGRADED node (`NodeJson.parseError`): its source failed to parse, so what
 *  the page shows is the fallback — a data file's raw text, a directory's plain mapping.
 *  Rendered wherever the node appears (the direct page, an embedded subchapter), so a broken
 *  file never poses as merely empty; the file is named root-relative, the message is the
 *  parser's own. Editing is shut while it shows — fixing the file on disk clears it. */
export function ParseErrorBanner({ error }: { error: NonNullable<NodeJson["parseError"]> }) {
  return (
    <div className="parse-error" role="alert">
      <span className="parse-error-file">{error.file}</span> failed to parse — shown degraded, read-only.
      <div className="parse-error-msg">{error.message}</div>
    </div>
  );
}
