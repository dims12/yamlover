import { createContext, useContext } from "react";

/**
 * The editing lock signal. `NodeView` owns the lock (locked by default, re-locked on navigation) and
 * provides this context; the chapter renderer reads `unlocked` to switch between its read-only page
 * and the in-memory model editor (chapter.tsx `ChapterEditor`). Writes are no longer routed through
 * the context — the editor's model owns them, syncing to the server in the background.
 */
export interface EditingApi {
  unlocked: boolean;
}

export const EditingContext = createContext<EditingApi>({ unlocked: false });

export function useEditing(): EditingApi {
  return useContext(EditingContext);
}
