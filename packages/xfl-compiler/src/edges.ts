import type { SegmentIR, Vec2 } from "@flaforge/ir";
import { closeEnough } from "@flaforge/ir";
import type { DiagnosticSink } from "./diagnostics.js";

export interface EdgeSubpath {
  start: Vec2;
  segments: SegmentIR[];
}

export interface EdgeParseStats {
  moves: number;
  lines: number;
  quads: number;
  cubics: number;
  unknownTokens: number;
  subpathStyleIds: number[];
}

interface TokenReader {
  text: string;
  pos: number;
}

function skipSpace(reader: TokenReader): void {
  while (reader.pos < reader.text.length) {
    const c = reader.text[reader.pos]!;
    if (c === " " || c === "\n" || c === "\r" || c === "\t" || c === "," || c === ";") {
      reader.pos++;
    } else {
      break;
    }
  }
}

function readNumber(reader: TokenReader): number | null {
  skipSpace(reader);
  let pos = reader.pos;
  let sign = 1;
  if (reader.text[pos] === "+" || reader.text[pos] === "-") {
    if (reader.text[pos] === "-") sign = -1;
    pos++;
  }
  if (reader.text[pos] === "#") {
    pos++;
    let start = pos;
    while (pos < reader.text.length && /[0-9a-fA-F]/.test(reader.text[pos]!)) pos++;
    const intPart = reader.text.slice(start, pos);
    let fraction = 0;
    if (reader.text[pos] === ".") {
      pos++;
      start = pos;
      while (pos < reader.text.length && /[0-9a-fA-F]/.test(reader.text[pos]!)) pos++;
      const fracPart = reader.text.slice(start, pos);
      if (fracPart.length > 0) fraction = Number.parseInt(fracPart, 16) / 16 ** fracPart.length;
    }
    if (intPart.length === 0) return null;
    let integer = Number.parseInt(intPart, 16);
    // JPEXS writes negative integer parts as the low 24 bits of a two's
    // complement long (e.g. -30 -> "#FFFFE2.80"). Detect the 0x800000..0xFFFFFF
    // range and sign-extend it.
    if (sign === 1 && intPart.length >= 6 && integer >= 0x800000) {
      integer -= 0x1000000;
    }
    reader.pos = pos;
    return sign * (integer + fraction);
  }
  const start = pos;
  let sawDigit = false;
  while (pos < reader.text.length && /[0-9]/.test(reader.text[pos]!)) {
    pos++;
    sawDigit = true;
  }
  if (reader.text[pos] === ".") {
    pos++;
    while (pos < reader.text.length && /[0-9]/.test(reader.text[pos]!)) {
      pos++;
      sawDigit = true;
    }
  }
  // Scientific notation is not used by Animate, but tolerate it.
  if (reader.text[pos] === "e" || reader.text[pos] === "E") {
    const save = pos;
    pos++;
    if (reader.text[pos] === "+" || reader.text[pos] === "-") pos++;
    let expDigits = false;
    while (pos < reader.text.length && /[0-9]/.test(reader.text[pos]!)) {
      pos++;
      expDigits = true;
    }
    if (!expDigits) pos = save;
  }
  if (!sawDigit) return null;
  const raw = reader.text.slice(start, pos);
  reader.pos = pos;
  const value = Number(raw);
  return Number.isFinite(value) ? sign * value : null;
}

function twipsToPx(value: number): number {
  const px = value / 20;
  return Math.abs(px) < 1e-9 ? 0 : px;
}

/**
 * Parse an XFL `Edge.edges` string.
 *
 * Verified commands (JPEXS XFLConverter.convertShapeEdge):
 *   ! x y          moveTo
 *   | x y          lineTo
 *   [ cx cy x y    quadraticCurveTo
 * `/` is not emitted by JPEXS; we accept 6 numbers as a cubic and 4 as a
 * quadratic fallback, with a diagnostic.
 * `S<n>` is an Animate 23 private marker after `!`; it is skipped.
 */
export function parseEdgeString(
  input: string,
  sink: DiagnosticSink,
  path: string,
  stats: EdgeParseStats,
): EdgeSubpath[] {
  const reader: TokenReader = { text: input, pos: 0 };
  const subpaths: EdgeSubpath[] = [];
  let current: EdgeSubpath | null = null;

  const flush = () => {
    if (current && current.segments.length > 0) {
      dedupeSubpath(current);
      if (current.segments.length > 0) subpaths.push(current);
    }
    current = null;
  };

  while (reader.pos < reader.text.length) {
    skipSpace(reader);
    if (reader.pos >= reader.text.length) break;
    const c = reader.text[reader.pos]!;
    if (c === "!" || c === "|" || c === "[" || c === "/") {
      reader.pos++;
      if (c === "!") {
        flush();
        const x = readNumber(reader);
        const y = readNumber(reader);
        if (x === null || y === null) {
          sink.warnOnce("EDGE_MALFORMED_MOVE", "malformed moveTo in Edge.edges", path);
          continue;
        }
        current = { start: { x: twipsToPx(x), y: twipsToPx(y) }, segments: [] };
        stats.moves++;
        // Animate 23 writes a private S<n> marker right after the move.
        skipSpace(reader);
        if (reader.text[reader.pos] === "S") {
          const save = reader.pos;
          let p = reader.pos + 1;
          let digits = "";
          while (p < reader.text.length && /[0-9]/.test(reader.text[p]!)) {
            digits += reader.text[p]!;
            p++;
          }
          if (digits.length > 0) {
            const value = Number.parseInt(digits, 10);
            stats.subpathStyleIds.push(value);
            sink.infoOnce(
              "EDGE_SUBPATH_STYLE_MARKER",
              `ignored Animate private S<n> subpath marker (first value ${value})`,
              path,
            );
            reader.pos = p;
          } else {
            reader.pos = save;
          }
        }
        continue;
      }
      if (!current) {
        sink.warnOnce("EDGE_NO_MOVE", "edge command without a preceding moveTo", path);
        const x = readNumber(reader);
        const y = readNumber(reader);
        if (x === null || y === null) continue;
        current = { start: { x: twipsToPx(x), y: twipsToPx(y) }, segments: [] };
        stats.moves++;
        continue;
      }
      if (c === "|") {
        const x = readNumber(reader);
        const y = readNumber(reader);
        if (x === null || y === null) {
          sink.warnOnce("EDGE_MALFORMED_LINE", "malformed lineTo in Edge.edges", path);
          continue;
        }
        current.segments.push({ k: "L", to: { x: twipsToPx(x), y: twipsToPx(y) } });
        stats.lines++;
      } else if (c === "[") {
        const cx = readNumber(reader);
        const cy = readNumber(reader);
        const x = readNumber(reader);
        const y = readNumber(reader);
        if (cx === null || cy === null || x === null || y === null) {
          sink.warnOnce("EDGE_MALFORMED_QUAD", "malformed quadraticCurveTo in Edge.edges", path);
          continue;
        }
        current.segments.push({
          k: "Q",
          c: { x: twipsToPx(cx), y: twipsToPx(cy) },
          to: { x: twipsToPx(x), y: twipsToPx(y) },
        });
        stats.quads++;
      } else {
        // '/': undocumented in the sample. Try a cubic first, then quadratic.
        const values: number[] = [];
        for (let i = 0; i < 6; i++) {
          const before = reader.pos;
          const value = readNumber(reader);
          if (value === null) {
            reader.pos = before;
            break;
          }
          values.push(value);
        }
        if (values.length >= 2 && values.length < 4) {
          current.segments.push({
            k: "L",
            to: { x: twipsToPx(values[0]!), y: twipsToPx(values[1]!) },
          });
          stats.lines++;
          sink.infoOnce(
            "EDGE_SLASH_LINE",
            "'/' edge command with 2 numbers is treated as a lineTo (sample-derived)",
            path,
          );
        } else if (values.length >= 6) {
          current.segments.push({
            k: "C",
            c1: { x: twipsToPx(values[0]!), y: twipsToPx(values[1]!) },
            c2: { x: twipsToPx(values[2]!), y: twipsToPx(values[3]!) },
            to: { x: twipsToPx(values[4]!), y: twipsToPx(values[5]!) },
          });
          stats.cubics++;
          sink.warnOnce(
            "EDGE_CUBIC_COMMAND",
            "'/' edge command is treated as a cubic curve (semantics unverified)",
            path,
          );
        } else if (values.length >= 4) {
          current.segments.push({
            k: "Q",
            c: { x: twipsToPx(values[0]!), y: twipsToPx(values[1]!) },
            to: { x: twipsToPx(values[2]!), y: twipsToPx(values[3]!) },
          });
          stats.quads++;
          sink.warnOnce(
            "EDGE_SLASH_QUAD",
            "'/' edge command with 4 numbers is treated as a quadratic curve",
            path,
          );
        } else {
          sink.warnOnce("EDGE_UNKNOWN_COMMAND", "unknown edge command '/'", path);
          stats.unknownTokens++;
        }
      }
      continue;
    }
    if (/[0-9#+\-.]/.test(c)) {
      const value = readNumber(reader);
      if (value === null) {
        reader.pos++;
        stats.unknownTokens++;
      } else {
        sink.warnOnce("EDGE_STRAY_NUMBER", "stray number in Edge.edges", path);
      }
      continue;
    }
    // Cubics-only syntax and other private tokens.
    reader.pos++;
    stats.unknownTokens++;
  }
  flush();
  return subpaths;
}

function dedupeSubpath(subpath: EdgeSubpath): void {
  const segments: SegmentIR[] = [];
  let current = subpath.start;
  for (const segment of subpath.segments) {
    if (closeEnough(current, segment.to, 1e-5)) {
      if (segment.k === "L") continue;
      if (segment.k === "Q" && closeEnough(current, segment.c, 1e-5)) continue;
      if (
        segment.k === "C" &&
        closeEnough(current, segment.c1, 1e-5) &&
        closeEnough(current, segment.c2, 1e-5)
      ) {
        continue;
      }
    }
    segments.push(segment);
    current = segment.to;
  }
  subpath.segments = segments;
}

export function formatEdgeStats(stats: EdgeParseStats): string {
  return `${stats.moves} moves, ${stats.lines} lines, ${stats.quads} quads, ${stats.cubics} cubics`;
}
