// The demo hash is both the lookup key and the unguessable capability token in the
// URL — 128 bits of entropy means the link can't be enumerated, so possessing it IS
// the authorization to use that demo.

import { randomBytes } from "node:crypto";

/** A fresh 128-bit demo hash, base64url (22 chars, URL-safe, no padding). */
export const newHash = () => randomBytes(16).toString("base64url");

const HASH_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Whether `s` is a syntactically valid demo hash (base64url, sane length). */
export const isHash = (s) => typeof s === "string" && HASH_RE.test(s);
