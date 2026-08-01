// <YamloverEditor> — the SOURCE projection of the MPS-inspired projectional editor, behind the
// UNLOCKED yamlover data view: the model drawn as rows of yamlover tokens, edited with the typing
// grammar (keys.ts) — `- ` / `key:` decisions, quote modes, block headers, pointers, meta tags.
//
// Everything that is not drawing lives in host.ts (the fetch, the model, the ops, the actions, the
// focus machinery), because a second projection — the chapter page — draws the same model as prose
// and headings. This file is only the cells and their layout.

import { FlowCells, KrRows, MetaTagCell, NodeCells, PointerCell, RootHole, ScalarCell, YedCtx } from "./cells";
import { useYedHost } from "./host";
import { flowIsSeq } from "./model";

export function YamloverEditor({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const { root, version, act, ctx, rootEl } = useYedHost(path, onNavigate);

  if (!root) return <div className="code yed">…</div>;
  const last = root.entries[root.entries.length - 1];
  const tailIsHole = !!last && !last.decided && !last.committed;
  return (
    <YedCtx.Provider value={ctx}>
      <div className="code yed" ref={rootEl} data-version={version}>
        {(root.metaTag !== null || root.setTag || root.yoTag) && (
          <div className="yed-row"><MetaTagCell node={root} /></div>
        )}
        {root.kind === "scalar" ? (
          <div className="yed-row"><ScalarCell node={root} entryId={null} /></div>
        ) : root.kind === "pointer" ? (
          <div className="yed-row"><PointerCell node={root} entryId={null} /></div>
        ) : root.kind === "container" && root.jsonp && root.entries.length > 0 ? (
          // the whole document as a K&R token: the opener has a row, the elements and the closer
          // get their own (KrRows). Same cells, same grammar — only spread.
          <>
            <div className="yed-row"><span className="punct">{flowIsSeq(root) ? "[" : "{"}</span></div>
            <KrRows node={root} />
          </>
        ) : root.kind === "container" && root.flow ? (
          // the whole document as a flow container (`{` / `[` typed in the root hole)
          <div className="yed-row"><FlowCells node={root} /></div>
        ) : root.kind === "container" && root.entries.length === 0 && !root.selfValue ? (
          // an EMPTY document: one hole, the whole typing grammar applied to the root
          <div className="yed-row"><RootHole node={root} /></div>
        ) : (
          <>
            <NodeCells node={root} />
            {root.kind === "container" && !tailIsHole && (
              // the append affordance: one click opens a fresh entry hole at the end
              <div className="yed-row">
                <button
                  type="button"
                  className="yed-tail"
                  title="add an entry"
                  onClick={() => (last ? act.enterAfter(last.id) : act.enterInto(root.id))}
                >＋</button>
              </div>
            )}
          </>
        )}
      </div>
    </YedCtx.Provider>
  );
}
