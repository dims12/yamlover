// The `.eml` renderer's MIME reader (client/renderers/mime.ts).
//
// The cases are the ones a twenty-year-old Cyrillic mailbox actually contains: koi8-r and
// windows-1251 bodies, base64 and quoted-printable, RFC 2047 encoded words in Subject,
// multipart/alternative and multipart/related with inline images.

import { describe, it, expect } from "vitest";
import {
  attachmentsOf,
  decodeBytes,
  decodeWords,
  headerOf,
  parseEml,
  partText,
  pickBody,
  walkParts,
} from "../src/client/renderers/mime";

/** Build a message from a latin1 string, the way the blob arrives. */
const eml = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** Raw bytes spliced in, for a body in a legacy charset. */
const withBytes = (head: string, body: number[]): Uint8Array =>
  Uint8Array.from([...Array.from(head, (c) => c.charCodeAt(0) & 0xff), ...body]);

describe("mime: headers", () => {
  it("keeps every header in source order, duplicates included", () => {
    const m = parseEml(eml("Received: a\r\nReceived: b\r\nSubject: hi\r\n\r\nbody\r\n"));
    expect(m.headers.map(([k]) => k)).toEqual(["Received", "Received", "Subject"]);
    expect(m.headers[0][1]).toBe("a");
    expect(m.headers[1][1]).toBe("b");
  });

  it("unfolds continuation lines", () => {
    const m = parseEml(eml("Received: from a\r\n\tby b\r\n  for c\r\nSubject: x\r\n\r\n."));
    expect(headerOf(m.headers, "received")).toBe("from a by b for c");
  });

  it("tolerates a bare-LF message", () => {
    const m = parseEml(eml("Subject: x\nFrom: a@b\n\nthe body"));
    expect(headerOf(m.headers, "subject")).toBe("x");
    expect(partText(m)).toBe("the body");
  });

  it("finds headers case-insensitively", () => {
    const m = parseEml(eml("CONTENT-TYPE: text/plain\r\n\r\nx"));
    expect(headerOf(m.headers, "content-type")).toBe("text/plain");
  });
});

describe("mime: encoded words (RFC 2047)", () => {
  it("decodes a base64 koi8-r subject", () => {
    // "Привет" in koi8-r, base64
    expect(decodeWords("=?koi8-r?B?8NLJ18XU?=")).toBe("Привет");
  });

  it("decodes quoted-printable words, with _ as space", () => {
    expect(decodeWords("=?utf-8?Q?a_b=C3=A9?=")).toBe("a bé");
  });

  it("leaves ordinary text alone and does not choke on a broken word", () => {
    expect(decodeWords("plain subject")).toBe("plain subject");
    expect(decodeWords("=?nosuchcharset?B?%%%?=")).toContain("=?");
  });
});

describe("mime: bodies", () => {
  it("decodes a windows-1251 body", () => {
    const body = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]; // "Привет"
    const m = parseEml(
      withBytes("Content-Type: text/plain; charset=windows-1251\r\n\r\n", body),
    );
    expect(partText(m)).toBe("Привет");
  });

  it("undoes base64", () => {
    const m = parseEml(
      eml("Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\naGVsbG8=\r\n"),
    );
    expect(partText(m).trim()).toBe("hello");
  });

  it("undoes quoted-printable, including soft line breaks", () => {
    const m = parseEml(
      eml("Content-Transfer-Encoding: quoted-printable\r\n\r\na=3Db and=\r\n more\r\n"),
    );
    expect(partText(m).trim()).toBe("a=b and more");
  });

  it("falls back rather than throwing on an unknown charset", () => {
    expect(decodeBytes(Uint8Array.from([104, 105]), "no-such-charset")).toBe("hi");
  });
});

describe("mime: multipart", () => {
  const alternative =
    "Subject: t\r\nMIME-Version: 1.0\r\n" +
    "Content-Type: multipart/alternative; boundary=BB\r\n\r\n" +
    "preamble, ignored\r\n" +
    "--BB\r\nContent-Type: text/plain\r\n\r\nplain body\r\n" +
    "--BB\r\nContent-Type: text/html\r\n\r\n<p>rich body</p>\r\n" +
    "--BB--\r\nepilogue, ignored\r\n";

  it("splits the parts and drops preamble and epilogue", () => {
    const m = parseEml(eml(alternative));
    expect(m.parts).toHaveLength(2);
    expect(m.parts.map((p) => p.contentType)).toEqual(["text/plain", "text/html"]);
  });

  it("picks the html alternative as the body and keeps the text too", () => {
    const m = parseEml(eml(alternative));
    const body = pickBody(m);
    expect(body.html && partText(body.html).trim()).toBe("<p>rich body</p>");
    expect(body.text && partText(body.text).trim()).toBe("plain body");
    expect(attachmentsOf(m, body)).toHaveLength(0);
  });

  it("lists a named part as an attachment, with its filename", () => {
    const m = parseEml(
      eml(
        "Content-Type: multipart/mixed; boundary=BB\r\n\r\n" +
          "--BB\r\nContent-Type: text/plain\r\n\r\nhi\r\n" +
          '--BB\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename="pic.png"\r\n' +
          "Content-Transfer-Encoding: base64\r\n\r\naGk=\r\n--BB--\r\n",
      ),
    );
    const atts = attachmentsOf(m, pickBody(m));
    expect(atts).toHaveLength(1);
    expect(atts[0].filename).toBe("pic.png");
    expect(atts[0].contentType).toBe("image/png");
  });

  it("descends nested multiparts", () => {
    const m = parseEml(
      eml(
        "Content-Type: multipart/mixed; boundary=OUT\r\n\r\n" +
          "--OUT\r\nContent-Type: multipart/alternative; boundary=IN\r\n\r\n" +
          "--IN\r\nContent-Type: text/plain\r\n\r\ninner text\r\n--IN--\r\n" +
          "--OUT--\r\n",
      ),
    );
    const body = pickBody(m);
    expect(body.text && partText(body.text).trim()).toBe("inner text");
    expect(walkParts(m).length).toBeGreaterThan(2);
  });

  it("reads an RFC 2231 encoded filename", () => {
    const m = parseEml(
      eml(
        "Content-Type: multipart/mixed; boundary=BB\r\n\r\n--BB\r\n" +
          "Content-Type: application/pdf\r\n" +
          "Content-Disposition: attachment; filename*=utf-8''%D1%84%D0%B0%D0%B9%D0%BB.pdf\r\n\r\nx\r\n--BB--\r\n",
      ),
    );
    expect(m.parts[0].filename).toBe("файл.pdf");
  });
});

describe("mime: robustness", () => {
  it("a headerless blob still yields a part rather than throwing", () => {
    expect(() => parseEml(eml("just some bytes"))).not.toThrow();
  });

  it("truncated base64 shows what is there instead of failing", () => {
    const m = parseEml(eml("Content-Transfer-Encoding: base64\r\n\r\n!!!not base64!!!"));
    expect(typeof partText(m)).toBe("string");
  });

  it("a multipart whose closing boundary is missing keeps the parts it found", () => {
    const m = parseEml(
      eml("Content-Type: multipart/mixed; boundary=BB\r\n\r\n--BB\r\nContent-Type: text/plain\r\n\r\nhi\r\n"),
    );
    expect(m.parts).toHaveLength(1);
  });

  it("an empty message does not throw", () => {
    expect(() => parseEml(new Uint8Array(0))).not.toThrow();
  });
});
