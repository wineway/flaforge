import { SaxesParser } from "saxes";
import type { XmlNode } from "./ast.js";

export interface XmlParseOptions {
  maxBytes?: number;
  maxDepth?: number;
  /** Human readable source path for error messages. */
  source?: string;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 256;

function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon >= 0 ? name.slice(colon + 1) : name;
}

/**
 * Parse XML into a small ordered tree.
 *
 * XFL needs child order (drawing order, fill/stroke order), unknown nodes for
 * diagnostics, and streaming behavior for 1 MB+ files. We deliberately do not
 * convert XML to a generic JS object.
 */
export function parseXml(text: string, options: XmlParseOptions = {}): XmlNode {
  const source = options.source ?? "<xml>";
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new Error(`${source} exceeds the XML size limit (${maxBytes} bytes)`);
  }
  // XXE / entity expansion guard. saxes does not resolve external entities, but
  // rejecting DTDs outright is simpler and safer.
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    throw new Error(`${source} contains a DTD/ENTITY declaration; refusing to parse`);
  }

  const parser = new SaxesParser({ xmlns: false });
  const rootHolder: { root?: XmlNode } = {};
  const stack: XmlNode[] = [];
  const errors: string[] = [];

  parser.on("opentag", (tag) => {
    const node: XmlNode = {
      name: localName(tag.name),
      attrs: { ...(tag.attributes as Record<string, string>) },
      children: [],
      text: "",
    };
    if (stack.length === 0) {
      if (rootHolder.root) {
        errors.push("multiple root elements");
      } else {
        rootHolder.root = node;
      }
    } else {
      stack[stack.length - 1]!.children.push(node);
    }
    if (stack.length >= maxDepth) {
      throw new Error(`${source} exceeds the XML depth limit (${maxDepth})`);
    }
    stack.push(node);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("text", (value) => {
    const top = stack[stack.length - 1];
    if (top) top.text += value;
  });
  parser.on("cdata", (value) => {
    const top = stack[stack.length - 1];
    if (top) top.text += value;
  });
  parser.on("doctype", () => {
    throw new Error(`${source} contains a DOCTYPE; refusing to parse`);
  });
  parser.on("error", (error) => {
    errors.push(error.message);
  });

  try {
    parser.write(text).close();
  } catch (error) {
    throw new Error(
      `${source} is not valid XML: ${(error as Error).message}` +
        (errors.length ? ` (${errors.join("; ")})` : ""),
    );
  }
  if (!rootHolder.root) {
    throw new Error(`${source} has no root element`);
  }
  if (errors.length > 0) {
    throw new Error(`${source} is not valid XML: ${errors.join("; ")}`);
  }
  return rootHolder.root;
}

export function textOf(node: XmlNode | undefined, recursive = true): string {
  if (!node) return "";
  if (!recursive) return node.text.trim();
  let out = node.text;
  for (const child of node.children) out += textOf(child, true);
  return out.trim();
}

export function findChild(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((child) => child.name === name);
}

export function findChildren(node: XmlNode | undefined, name: string): XmlNode[] {
  return node?.children.filter((child) => child.name === name) ?? [];
}

export function attr(node: XmlNode, name: string): string | undefined {
  return node.attrs[name];
}

export function numAttr(node: XmlNode, name: string, fallback = 0): number {
  const raw = node.attrs[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function intAttr(node: XmlNode, name: string, fallback = 0): number {
  const raw = node.attrs[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

export function boolAttr(node: XmlNode, name: string, fallback = false): boolean {
  const raw = node.attrs[name];
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

export function isBlankText(value: string): boolean {
  return value.trim().length === 0;
}
