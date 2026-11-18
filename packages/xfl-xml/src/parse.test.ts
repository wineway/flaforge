import { describe, expect, it } from "vitest";
import {
  parseXflSymbolXml,
  parseXml,
} from "./index.js";

describe("typed XFL AST", () => {
  it("rejects DTDs", () => {
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY e "x">]><DOMDocument/>')).toThrow(/DTD/);
  });

  it("reports malformed XML with a useful error", () => {
    expect(() => parseXml("<DOMDocument><unclosed></DOMDocument>", { source: "bad.xml" })).toThrow(
      /bad\.xml is not valid XML/,
    );
  });

  it("preserves unknown elements for diagnostics", () => {
    const symbol = parseXflSymbolXml(`<DOMSymbolItem name="x"><timeline><DOMTimeline name="x"><layers><DOMLayer name="l"><frames><DOMFrame index="0"><elements><DOMFancyNewThing/></elements></DOMFrame></frames></DOMLayer></layers></DOMTimeline></timeline></DOMSymbolItem>`);
    expect(symbol.timeline!.layers[0]!.frames[0]!.elements[0]!.kind).toBe("unknown");
  });
});
