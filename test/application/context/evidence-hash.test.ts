import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { semanticSha256 } from "../../../src/application/context/evidence-hash.js";

function raw(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("semanticSha256", () => {
  describe("whitespace and formatting", () => {
    it("ignores formatting whitespace outside strings", () => {
      const a = "fun foo(a:Int,b:Int):Int{return a+b}";
      const b = "fun foo(a: Int, b: Int): Int {\n  return a + b\n}";
      expect(semanticSha256(a)).toBe(semanticSha256(b));
    });

    it("preserves whitespace inside string literals", () => {
      const a = 'val s = "a b c"';
      const b = 'val s = "a  b  c"';
      expect(semanticSha256(a)).not.toBe(semanticSha256(b));
    });

    it("returns a stable 64-char hex digest", () => {
      const hash = semanticSha256("val x = 1");
      expect(hash).toMatch(/^[a-f\d]{64}$/);
      expect(hash).toBe(raw("valx=1"));
    });
  });

  describe("line comments", () => {
    it("strips // line comments (Kotlin/Java)", () => {
      const a = "val x = 1 // set x";
      const b = "val x = 1";
      expect(semanticSha256(a)).toBe(semanticSha256(b));
    });

    it("strips # line comments (properties)", () => {
      const a = "appId=com.example\n# comment\nver=1";
      const b = "appId=com.example\nver=1";
      expect(semanticSha256(a)).toBe(semanticSha256(b));
    });

    it("does not treat # inside a string as a comment", () => {
      const a = 'val tag = "#hashtag"';
      const b = 'val tag = "##hashtag"';
      expect(semanticSha256(a)).not.toBe(semanticSha256(b));
    });

    it("does not treat // inside a string as a comment", () => {
      const a = 'val url = "https://example.com"';
      const b = 'val url = "https://xample.com"';
      expect(semanticSha256(a)).not.toBe(semanticSha256(b));
    });
  });

  describe("block comments", () => {
    it("strips /* */ block comments", () => {
      const a = "val x = 1 /* important */ + 2";
      const b = "val x = 1 + 2";
      expect(semanticSha256(a)).toBe(semanticSha256(b));
    });

    it("strips <!-- --> XML comments", () => {
      const a = "<root><!-- note --><child/></root>";
      const b = "<root><child/></root>";
      expect(semanticSha256(a)).toBe(semanticSha256(b));
    });

    it("does not treat */ inside a string as a comment close", () => {
      const a = 'val s = "*/"';
      const b = 'val s = "*"';
      expect(semanticSha256(a)).not.toBe(semanticSha256(b));
    });
  });

  describe("string escapes", () => {
    it("honors backslash escapes so an escaped quote does not close the string", () => {
      const a = 'val s = "she said \\"hi\\""';
      const b = 'val s = "she said hi"';
      expect(semanticSha256(a)).not.toBe(semanticSha256(b));
    });

    it("keeps an escaped quote inside the string content", () => {
      const a = 'val s = "a\\"b"';
      const b = 'val s = "a\\"b"';
      expect(semanticSha256(a)).toBe(semanticSha256(b));
    });
  });

  describe("Kotlin raw strings", () => {
    it("treats \"\"\" as an opaque literal that preserves content", () => {
      const a = 'val sql = """SELECT * FROM users"""';
      const b = "val sql = \"\"\"SELECT * FROM users\"\"\"";
      expect(semanticSha256(a)).toBe(semanticSha256(b));
    });

    it("does not interpret /* or // inside a raw string as comments", () => {
      const withComment = 'val s = """a /* not comment */ b // not comment"""';
      const literal = 'val s = """a /* X */ b // Y"""';
      expect(semanticSha256(withComment)).not.toBe(semanticSha256(literal));
    });

    it("preserves internal whitespace in raw strings (semantic content)", () => {
      const a = 'val s = """\n    hello\n    """';
      const b = 'val s = """\n  hello\n  """';
      expect(semanticSha256(a)).not.toBe(semanticSha256(b));
    });

    it("does not close a raw string on a single embedded quote", () => {
      const a = 'val s = """say "hi" please"""';
      const b = 'val s = """say "hi" now"""';
      expect(semanticSha256(a)).not.toBe(semanticSha256(b));
    });

    it("detects content changes inside a raw string", () => {
      const a = 'val s = """hello"""';
      const b = 'val s = """world"""';
      expect(semanticSha256(a)).not.toBe(semanticSha256(b));
    });
  });

  describe("XML CDATA", () => {
    it("treats CDATA as an opaque literal preserving content", () => {
      const a = "<x><![CDATA[hello world]]></x>";
      const b = "<x><![CDATA[hello world]]></x>";
      expect(semanticSha256(a)).toBe(semanticSha256(b));
    });

    it("does not interpret // or /* inside CDATA as comments", () => {
      const a = "<x><![CDATA[// not a comment\n/* not either */]]></x>";
      const b = "<x><![CDATA[// X\n/* Y */]]></x>";
      expect(semanticSha256(a)).not.toBe(semanticSha256(b));
    });

    it("preserves whitespace inside CDATA", () => {
      const a = "<x><![CDATA[  spaced  ]]></x>";
      const b = "<x><![CDATA[spaced]]></x>";
      expect(semanticSha256(a)).not.toBe(semanticSha256(b));
    });

    it("detects content changes inside CDATA", () => {
      const a = "<x><![CDATA[foo]]></x>";
      const b = "<x><![CDATA[bar]]></x>";
      expect(semanticSha256(a)).not.toBe(semanticSha256(b));
    });
  });

  describe("semantic change detection", () => {
    it("detects a renamed identifier as a semantic change", () => {
      const a = "fun foo() { bar() }";
      const b = "fun foo() { baz() }";
      expect(semanticSha256(a)).not.toBe(semanticSha256(b));
    });

    it("ignores a comment-only change", () => {
      const a = "fun foo() { bar() } // v1";
      const b = "fun foo() { bar() } // v2";
      expect(semanticSha256(a)).toBe(semanticSha256(b));
    });

    it("ignores a reformatting-only change", () => {
      const a = "fun foo(){bar();baz();}";
      const b = "fun foo() { bar(); baz(); }";
      expect(semanticSha256(a)).toBe(semanticSha256(b));
    });
  });

  describe("Uint8Array input", () => {
    it("accepts a Uint8Array and matches the string form", () => {
      const text = "val x = 1";
      const fromString = semanticSha256(text);
      const fromBytes = semanticSha256(new TextEncoder().encode(text));
      expect(fromBytes).toBe(fromString);
    });
  });
});
