import { NodeJson, blobUrl } from "../api";
import { Chunk } from "./registry";

/**
 * Renderer for a legacy `.doc` (Word 97–2003 binary / OLE compound file). Unlike
 * `.docx`, the old binary format has no reliable pure-browser parser, so rather
 * than show a broken conversion we present it honestly: a note and a download link
 * to the raw bytes (served by `/api/blob`). Faithful in-browser rendering would
 * need a server-side conversion step (e.g. LibreOffice), which is out of scope here.
 */
function DocNote({ path }: { path: string }) {
  return (
    <div className="office-fallback">
      <p>
        Legacy <code>.doc</code> (Word 97–2003) isn’t rendered in the browser — the old binary format has no
        reliable client-side parser. Newer <code>.docx</code> files render in full.
      </p>
      <p>
        <a className="descend" href={blobUrl(path)} download>
          ⤓ Download the document
        </a>{" "}
        to open it in an office application.
      </p>
    </div>
  );
}

export function DocView({ node }: { node: NodeJson }) {
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <DocNote path={node.path} />
    </div>
  );
}

export function DocChunk({ chunk }: { chunk: Chunk }) {
  return <DocNote path={chunk.path} />;
}
