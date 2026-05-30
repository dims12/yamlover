import path from "node:path";
import { fileURLToPath } from "node:url";

// The repo root, three levels up from tools/server/test/.
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Absolute path of an example fixture, e.g. ex("04-object-in-dir"). */
export const ex = (name: string): string => path.join(REPO, "examples", name);
