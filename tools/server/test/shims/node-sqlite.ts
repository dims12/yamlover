// Test-only shim: vite 5 (vitest) predates the `node:sqlite` builtin and tries to bundle it
// as a file. The vitest config aliases `node:sqlite` here; we hand back the real builtin at
// runtime (Node ≥22.3). The app itself runs under plain Node and never sees this file.
const sqlite = process.getBuiltinModule("node:sqlite");

export const DatabaseSync = sqlite.DatabaseSync;
export default sqlite;
