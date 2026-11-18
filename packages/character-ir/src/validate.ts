import type {
  CharacterIR,
  Diagnostic,
  ElementIR,
  ProjectIR,
  SegmentIR,
  ShapeIR,
  TimelineIR,
} from "./types.js";
import { IR_VERSION } from "./types.js";
import { frameCountOf } from "./timeline.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function finite(...values: number[]): boolean {
  return values.every((v) => Number.isFinite(v));
}

function validateSegments(
  path: string,
  start: { x: number; y: number },
  segments: SegmentIR[],
  errors: string[],
): void {
  if (!finite(start.x, start.y)) errors.push(`${path}.start is not finite`);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    const p = `${path}.segments[${i}]`;
    if (!finite(s.to.x, s.to.y)) errors.push(`${p}.to is not finite`);
    if (s.k === "Q" && !finite(s.c.x, s.c.y)) errors.push(`${p}.c is not finite`);
    if (s.k === "C" && !finite(s.c1.x, s.c1.y, s.c2.x, s.c2.y)) {
      errors.push(`${p}.c1/c2 is not finite`);
    }
  }
}

function validateShape(shape: ShapeIR, errors: string[], warnings: string[]): void {
  const path = `shapes.${shape.id}`;
  if (!finite(shape.bounds.x, shape.bounds.y, shape.bounds.width, shape.bounds.height)) {
    errors.push(`${path}.bounds is not finite`);
  }
  if (shape.bounds.width < 0 || shape.bounds.height < 0) {
    errors.push(`${path}.bounds has negative size`);
  }
  for (let i = 0; i < shape.regions.length; i++) {
    const region = shape.regions[i]!;
    if (region.fill < -1 || region.fill >= shape.fills.length) {
      errors.push(`${path}.regions[${i}].fill index ${region.fill} out of range`);
    }
    if (!region.outer.closed) warnings.push(`${path}.regions[${i}].outer is not closed`);
    validateSegments(`${path}.regions[${i}].outer`, region.outer.start, region.outer.segments, errors);
    if (region.outer.segments.length < 2) {
      warnings.push(`${path}.regions[${i}].outer has fewer than 2 segments`);
    }
    region.holes.forEach((hole, hi) => {
      if (!hole.closed) warnings.push(`${path}.regions[${i}].holes[${hi}] is not closed`);
      validateSegments(
        `${path}.regions[${i}].holes[${hi}]`,
        hole.start,
        hole.segments,
        errors,
      );
    });
  }
  for (let i = 0; i < shape.strokePaths.length; i++) {
    const sp = shape.strokePaths[i]!;
    if (sp.stroke < 0 || sp.stroke >= shape.strokes.length) {
      errors.push(`${path}.strokePaths[${i}].stroke index ${sp.stroke} out of range`);
    }
    validateSegments(`${path}.strokePaths[${i}]`, sp.start, sp.segments, errors);
  }
}

function validateElement(
  element: ElementIR,
  path: string,
  project: ProjectIR,
  errors: string[],
  warnings: string[],
): void {
  if (!finite(element.matrix.a, element.matrix.b, element.matrix.c, element.matrix.d, element.matrix.tx, element.matrix.ty)) {
    errors.push(`${path}.matrix is not finite`);
  }
  if (element.kind === "instance") {
    if (!element.characterId) {
      errors.push(`${path}.characterId missing for instance`);
    } else if (!project.library[element.characterId]) {
      warnings.push(`${path}.characterId ${element.characterId} not found in library`);
    }
  }
  if (element.kind === "shape") {
    if (!element.shapeId) {
      errors.push(`${path}.shapeId missing for shape`);
    } else if (!project.shapes[element.shapeId]) {
      errors.push(`${path}.shapeId ${element.shapeId} not found in shapes`);
    }
  }
}

function validateTimeline(
  timeline: TimelineIR,
  path: string,
  project: ProjectIR,
  errors: string[],
  warnings: string[],
): void {
  if (timeline.layers.length === 0) warnings.push(`${path}.layers is empty`);
  const computed = frameCountOf(timeline);
  if (computed > timeline.frameCount) {
    warnings.push(
      `${path}.frameCount ${timeline.frameCount} is smaller than computed ${computed}`,
    );
  }
  const seenLayerIndices = new Set<number>();
  timeline.layers.forEach((layer, li) => {
    // layers are stored bottom-to-top in IR while index is the original XFL
    // top-to-bottom index, so indices may decrease.
    if (seenLayerIndices.has(layer.index)) {
      errors.push(`${path}.layers[${li}].index ${layer.index} is duplicated`);
    }
    seenLayerIndices.add(layer.index);
    let lastFrameIndex = -1;
    layer.frames.forEach((frame, fi) => {
      const fp = `${path}.layers[${li}].frames[${fi}]`;
      if (frame.index <= lastFrameIndex) errors.push(`${fp}.index is not increasing`);
      lastFrameIndex = frame.index;
      if (!Number.isInteger(frame.index) || frame.index < 0) {
        errors.push(`${fp}.index must be a non-negative integer`);
      }
      if (!Number.isInteger(frame.duration) || frame.duration < 1) {
        errors.push(`${fp}.duration must be >= 1`);
      }
      if (frame.index + frame.duration > timeline.frameCount + 1) {
        warnings.push(`${fp} extends past timeline.frameCount`);
      }
      frame.elements.forEach((element, ei) => {
        validateElement(element, `${fp}.elements[${ei}]`, project, errors, warnings);
      });
      if (frame.tween) {
        if (frame.tween.toFrame <= frame.index) {
          errors.push(`${fp}.tween.toFrame must be after frame.index`);
        }
        const next = layer.frames.find((f) => f.index === frame.tween!.toFrame);
        if (!next) warnings.push(`${fp}.tween.toFrame ${frame.tween.toFrame} has no keyframe`);
      }
    });
  });
}

function validateCharacter(
  character: CharacterIR,
  path: string,
  project: ProjectIR,
  errors: string[],
  warnings: string[],
): void {
  if (character.kind === "symbol") {
    validateTimeline(character.timeline, `${path}.timeline`, project, errors, warnings);
  }
}

export function validateProjectIR(project: ProjectIR): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (project.irVersion !== IR_VERSION) {
    errors.push(`irVersion ${String(project.irVersion)} is not ${IR_VERSION}`);
  }
  if (!finite(project.stage.width, project.stage.height, project.stage.frameRate)) {
    errors.push("stage dimensions/frameRate are not finite");
  }
  if (project.stage.width <= 0 || project.stage.height <= 0) {
    errors.push("stage dimensions must be positive");
  }
  if (project.stage.frameRate <= 0) errors.push("stage.frameRate must be positive");
  if (project.scenes.length === 0) warnings.push("project has no scenes");

  for (const [id, shape] of Object.entries(project.shapes)) {
    if (shape.id !== id) errors.push(`shapes.${id}.id does not match its key`);
    validateShape(shape, errors, warnings);
  }
  for (const [id, character] of Object.entries(project.library)) {
    if (character.id !== id) errors.push(`library.${id}.id does not match its key`);
    validateCharacter(character, `library.${id}`, project, errors, warnings);
  }
  project.scenes.forEach((scene, si) => {
    validateTimeline(scene.timeline, `scenes[${si}].timeline`, project, errors, warnings);
    if (scene.frameCount !== scene.timeline.frameCount) {
      warnings.push(`scenes[${si}].frameCount differs from its timeline.frameCount`);
    }
  });

  for (const diagnostic of project.diagnostics) {
    if (diagnostic.level === "error") {
      warnings.push(`diagnostic error: ${diagnostic.code}: ${diagnostic.message}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function countDiagnostics(diagnostics: Diagnostic[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of diagnostics) counts[d.code] = (counts[d.code] ?? 0) + 1;
  return counts;
}
