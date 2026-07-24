import { describe, it, expect } from "vitest";
import {
  allowedChildConcretes, defaultChildConcrete, deriveDirEditRoute, deriveMemberEncoding,
  nextItemName, nextMemberName, requiredChildLanguage, subchapterMaterializes,
} from "../src/concrete-rules";

// The PURE concrete inheritance rules (concrete-rules.ts) — no I/O, no index. DEFAULTS inherit
// the storage family (a directory-concrete parent keeps children directory-concrete);
// OBLIGATIONS lock the language (a file document's interior speaks that file's language).
// Member encoding: keyed container → "dir"; untagged ordinal container → "dir-seq" (a
// sequential item directory + a body pointer-array element); everything else → "body".

describe("defaultChildConcrete (the inheritance rule)", () => {
  it("a directory-concrete parent keeps its children directory-concrete", () => {
    expect(defaultChildConcrete("dir/yamlover")).toBe("dir/yamlover");
    expect(defaultChildConcrete("dir")).toBe("dir/yamlover");
  });

  it("file and inline parents keep children inline in their source", () => {
    expect(defaultChildConcrete("yamlover")).toBe("yamlover");
    expect(defaultChildConcrete("file/yamlover")).toBe("yamlover");
    expect(defaultChildConcrete("file/json5p")).toBe("yamlover");
    expect(defaultChildConcrete(null)).toBe("yamlover");
  });
});

describe("subchapterMaterializes (the deferred Tab-wrap rule)", () => {
  it("mirrors the inheritance rule: dir documents materialize, file documents stay inline", () => {
    expect(subchapterMaterializes("dir/yamlover")).toBe(true);
    expect(subchapterMaterializes("file/yamlover")).toBe(false);
    expect(subchapterMaterializes(null)).toBe(false);
  });
});

describe("allowedChildConcretes (the obligatory set)", () => {
  it("a document CHILD may be inline, a linked file, or a linked directory", () => {
    expect(allowedChildConcretes("yamlover", "child")).toEqual(["yamlover", "file/yamlover", "dir/yamlover"]);
    expect(allowedChildConcretes("dir/yamlover", "child")).toEqual(["yamlover", "file/yamlover", "dir/yamlover"]);
  });

  it("a plain-directory MEMBER has no source to be inline in — file or directory only", () => {
    expect(allowedChildConcretes("dir", "member")).toEqual(["file/yamlover", "dir/yamlover"]);
  });
});

describe("requiredChildLanguage (the language lock)", () => {
  it("a file document's interior speaks that file's language — no switching", () => {
    expect(requiredChildLanguage("file/json5p")).toBe("json5p");
    expect(requiredChildLanguage("file/json")).toBe("json");
    expect(requiredChildLanguage("file/yamlover")).toBe("yamlover");
    expect(requiredChildLanguage("file/yaml")).toBe("yaml");
  });
});

describe("deriveMemberEncoding", () => {
  it("routes a keyed container to a nested directory", () => {
    expect(deriveMemberEncoding({ keyed: true, container: true })).toBe("dir");
  });

  it("routes an UNTAGGED ordinal container to a sequential item directory", () => {
    expect(deriveMemberEncoding({ keyed: false, container: true })).toBe("dir-seq");
    expect(deriveMemberEncoding({ keyed: false, container: true, tagged: false })).toBe("dir-seq");
  });

  it("a TAGGED ordinal container is content — it stays in the body", () => {
    expect(deriveMemberEncoding({ keyed: false, container: true, tagged: true })).toBe("body");
  });

  it("scalars stay in the body, keyed or ordinal", () => {
    expect(deriveMemberEncoding({ keyed: true, container: false })).toBe("body");
    expect(deriveMemberEncoding({ keyed: false, container: false })).toBe("body");
  });
});

describe("deriveDirEditRoute", () => {
  const fresh = { hasBody: false, indexedAsDocument: false };
  const established = { hasBody: true, indexedAsDocument: true };
  const halfDisk = { hasBody: true, indexedAsDocument: false }; // body born mid-batch
  const halfIndex = { hasBody: false, indexedAsDocument: true }; // served root, no body yet

  it("passes both directory encodings through in EVERY target state", () => {
    for (const target of [fresh, established, halfDisk, halfIndex]) {
      expect(deriveDirEditRoute(target, { keyed: true, container: true })).toBe("dir");
      expect(deriveDirEditRoute(target, { keyed: false, container: true })).toBe("dir-seq");
    }
  });

  it("body children route by the target state: document only when disk AND index agree", () => {
    const scalar = { keyed: false, container: false };
    expect(deriveDirEditRoute(established, scalar)).toBe("document");
    expect(deriveDirEditRoute(fresh, scalar)).toBe("body");
    expect(deriveDirEditRoute(halfDisk, scalar)).toBe("body");
    expect(deriveDirEditRoute(halfIndex, scalar)).toBe("body");
    expect(deriveDirEditRoute(established)).toBe("document"); // no child (emplace onto the dir)
    expect(deriveDirEditRoute(fresh)).toBe("body");
  });
});

describe("nextItemName", () => {
  it("starts at item01 and increments past the max existing item<N>", () => {
    expect(nextItemName([])).toBe("item01");
    expect(nextItemName(["item01", "item02"])).toBe("item03");
    expect(nextItemName(["item02"])).toBe("item03"); // gaps are not refilled — max + 1
  });

  it("an unpadded user name still advances the counter (never a collision)", () => {
    expect(nextItemName(["item5"])).toBe("item06");
  });

  it("widens naturally past item99", () => {
    expect(nextItemName(["item99"])).toBe("item100");
  });

  it("ignores names that are not item<N>", () => {
    expect(nextItemName(["items", "item", "item-3", "anyfile01", "item2x"])).toBe("item01");
  });
});

// Order-numbered generated member names: the number is COSMETIC (listings sort roughly in body
// order); order itself is the body pointer-array's data. An existing member is NEVER renamed —
// a between-insert slots a SUB-NUMBER between its neighbors.
describe("nextMemberName", () => {
  it("appends: item family past the max, title family numbered from 01", () => {
    expect(nextMemberName([], "item")).toBe("item01");
    expect(nextMemberName([], "title", { title: "Введение" })).toBe("01-Введение");
    expect(nextMemberName(["01-Введение", "02-Обзор"], "title", { title: "Итоги" })).toBe("03-Итоги");
    expect(nextMemberName(["item99"], "item")).toBe("item100"); // widens naturally
  });

  it("slots BETWEEN neighbors with a sub-number, never renumbering", () => {
    expect(nextMemberName(["item01", "item02"], "item", { prevName: "item01", nextName: "item02" })).toBe("item01-1");
    expect(nextMemberName(["01-A", "02-B"], "title", { prevName: "01-A", nextName: "02-B", title: "Новая" })).toBe("01-1-Новая");
    expect(nextMemberName(["01-A", "03-C"], "title", { prevName: "01-A", nextName: "03-C", title: "B" })).toBe("02-B");
    expect(nextMemberName(["item01", "item01-1"], "item", { prevName: "item01-1", nextName: undefined })).toBe("item02");
  });

  it("the prev|prev-1 edge deepens with a zero segment", () => {
    expect(nextMemberName(["01-A", "01-1-B"], "title", { prevName: "01-A", nextName: "01-1-B", title: "X" })).toBe("01-0-1-X");
  });

  it("a head insert numbers before the first neighbor", () => {
    expect(nextMemberName(["02-B"], "title", { nextName: "02-B", title: "A" })).toBe("01-A");
    expect(nextMemberName(["01-A"], "title", { nextName: "01-A", title: "Z" })).toBe("00-Z"); // degrades, still sorts first
  });

  it("unnumbered legacy neighbors count as open ends", () => {
    expect(nextMemberName(["Введение", "02-B"], "title", { prevName: "Введение", nextName: "02-B", title: "X" })).toBe("01-X");
  });

  it("uniqueness is guaranteed IN-SCHEME — never a `-N` collision suffix", () => {
    // an orphan (unreferenced) dir already holds the computed name: the key deepens instead
    expect(nextMemberName(["01-A", "02-B", "03-C"], "title", { prevName: "02-B", title: "C" })).toBe("03-1-C");
    expect(nextMemberName(["item01", "item02", "item03"], "item", { prevName: "item02" })).toBe("item03-1");
  });

  it("the title tail is pointer-safe (whitespace to underscores, metachars stripped)", () => {
    expect(nextMemberName([], "title", { title: "Заголовок части" })).toBe("01-Заголовок_части");
  });
});
