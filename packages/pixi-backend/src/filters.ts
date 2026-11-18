import {
  BlurFilter,
  ColorMatrixFilter,
  type Container,
  type Filter,
} from "pixi.js";
import { BevelFilter, DropShadowFilter, GlowFilter } from "pixi-filters";
import type { ColorTransformIR, FilterIR } from "@flaforge/ir";

function hexToNumber(hex: string): number {
  const clean = hex.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(clean)) return Number.parseInt(clean, 16);
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return Number.parseInt(
      `${clean[0]!}${clean[0]!}${clean[1]!}${clean[1]!}${clean[2]!}${clean[2]!}`,
      16,
    );
  }
  return 0;
}

export interface FilterBuildResult {
  filters: Filter[];
  /** Approximations that the caller may log once. */
  notes: string[];
}

export function buildFilters(ast: FilterIR[] | undefined): FilterBuildResult {
  const filters: Filter[] = [];
  const notes: string[] = [];
  if (!ast) return { filters, notes };
  for (const filter of ast) {
    switch (filter.kind) {
      case "glow": {
        // XFL blurX/blurY are a glow radius; pixi-filters calls it distance.
        filters.push(
          new GlowFilter({
            distance: Math.max(filter.blurX, filter.blurY),
            outerStrength: filter.strength,
            innerStrength: filter.inner ? filter.strength : 0,
            color: hexToNumber(filter.color),
            alpha: filter.alpha,
            quality: Math.max(0.01, Math.min(1, filter.quality)),
            knockout: filter.knockout,
          }),
        );
        notes.push("glow parameters are approximate (pixi-filters mapping)");
        break;
      }
      case "blur": {
        const strength = Math.max(0.01, (filter.blurX + filter.blurY) / 2);
        filters.push(
          new BlurFilter({ strength, quality: Math.max(1, Math.min(10, filter.quality * 4)) }),
        );
        break;
      }
      case "drop-shadow": {
        const radians = (filter.angle * Math.PI) / 180;
        filters.push(
          new DropShadowFilter({
            offset: {
              x: Math.cos(radians) * filter.distance,
              y: Math.sin(radians) * filter.distance,
            },
            color: hexToNumber(filter.color),
            alpha: filter.alpha * filter.strength,
            shadowOnly: filter.knockout || filter.hideObject,
            blur: Math.max(1, (filter.blurX + filter.blurY) / 2),
            quality: Math.max(1, Math.min(10, filter.quality * 4)),
          }),
        );
        notes.push("drop shadow parameters are approximate");
        break;
      }
      case "bevel": {
        filters.push(
          new BevelFilter({
            rotation: filter.angle,
            thickness: Math.max(1, filter.distance || filter.blurX || 2),
            lightColor: hexToNumber(filter.highlightColor),
            shadowColor: hexToNumber(filter.shadowColor),
          }),
        );
        notes.push("bevel parameters are approximate");
        break;
      }
      case "adjust-color": {
        const colorMatrix = new ColorMatrixFilter();
        colorMatrix.matrix = filter.colorMatrix as unknown as typeof colorMatrix.matrix;
        filters.push(colorMatrix);
        break;
      }
      case "unsupported":
        notes.push(`unsupported filter ${filter.name}`);
        break;
    }
  }
  return { filters, notes };
}

export function colorMatrixForTransform(
  transform: ColorTransformIR,
): ColorMatrixFilter | null {
  const {
    redMultiplier,
    greenMultiplier,
    blueMultiplier,
    alphaMultiplier,
    redOffset,
    greenOffset,
    blueOffset,
    alphaOffset,
  } = transform;
  const hasOffset =
    redOffset !== 0 || greenOffset !== 0 || blueOffset !== 0 || alphaOffset !== 0;
  const hasMultiplier =
    redMultiplier !== 1 ||
    greenMultiplier !== 1 ||
    blueMultiplier !== 1 ||
    alphaMultiplier !== 1;
  if (!hasOffset && !hasMultiplier) return null;
  const filter = new ColorMatrixFilter();
  const matrix = [
    redMultiplier, 0, 0, 0, redOffset / 255,
    0, greenMultiplier, 0, 0, greenOffset / 255,
    0, 0, blueMultiplier, 0, blueOffset / 255,
    0, 0, 0, alphaMultiplier, alphaOffset / 255,
  ];
  filter.matrix = matrix as unknown as typeof filter.matrix;
  return filter;
}

export function applyFilters(
  container: Container,
  filters: Filter[] | undefined,
  signature: string,
  state: { signature?: string; filters?: Filter[] },
): void {
  const next = filters ?? [];
  if (state.signature === signature) return;
  for (const old of state.filters ?? []) old.destroy();
  state.filters = next;
  state.signature = signature;
  container.filters = next.length > 0 ? next : [];
}

export function releaseFilters(state: { filters?: Filter[]; signature?: string }): void {
  for (const filter of state.filters ?? []) filter.destroy();
  state.filters = undefined;
  state.signature = undefined;
}
