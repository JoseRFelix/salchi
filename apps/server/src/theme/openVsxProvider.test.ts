import { describe, expect, it } from "vitest";

import { parseJsonc } from "./openVsxProvider.ts";

describe("parseJsonc", () => {
  it("parses plain JSON", () => {
    expect(parseJsonc('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("strips line and block comments", () => {
    const input = `{
      // a line comment
      "name": "Night Owl", /* inline */
      /* block
         comment */
      "type": "dark"
    }`;
    expect(parseJsonc(input)).toEqual({ name: "Night Owl", type: "dark" });
  });

  it("tolerates trailing commas", () => {
    expect(parseJsonc('{"colors":{"editor.background":"#000",},}')).toEqual({
      colors: { "editor.background": "#000" },
    });
  });

  it("preserves comment-like sequences inside strings", () => {
    const input = '{"url":"https://example.com//path","glob":"/* not a comment */"}';
    expect(parseJsonc(input)).toEqual({
      url: "https://example.com//path",
      glob: "/* not a comment */",
    });
  });

  it("handles escaped quotes within strings", () => {
    expect(parseJsonc('{"q":"a \\"quoted\\" word"}')).toEqual({ q: 'a "quoted" word' });
  });
});
