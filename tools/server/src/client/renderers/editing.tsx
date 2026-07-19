import { createContext, useContext } from "react";
import type { Edit } from "../api";

/**
 * The editing lock signal. `NodeView` owns the lock (locked by default, re-locked on navigation) and
 * provides this context; the chapter renderer reads `unlocked` to switch between its read-only page
 * and the in-memory model editor (chapter.tsx `ChapterEditor`). Writes are no longer routed through
 * the context — the editor's model owns them, syncing to the server in the background.
 */
export interface EditingApi {
  unlocked: boolean;
  /** Turn the lock OFF programmatically — a renderer that just CREATED an object calls this so the
   *  freshly navigated-to page opens straight in editing mode. Absent outside NodeView. */
  unlock?: () => void;
  /** Where a scalar-leaf edit goes when the rendered value has NO file behind it (the browser
   *  settings document): the provider applies the edit to its own source text (via /api/edit-text)
   *  and persists it, resolving true on success. Absent → the default `/api/edit` file path. */
  sink?: (edit: Edit) => Promise<boolean>;
}

export const EditingContext = createContext<EditingApi>({ unlocked: false });

export function useEditing(): EditingApi {
  return useContext(EditingContext);
}
