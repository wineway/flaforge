import type { ProjectIR } from "@flaforge/ir";
import type { Container } from "pixi.js";
import { XflPlayer, type XflPlayerOptions } from "./player.js";

export type CharacterAssemblyOptions = Omit<XflPlayerOptions, "characterId" | "autoPlay"> & {
  characterId: string;
  /** Frame to evaluate on creation (default 0). */
  frame?: number;
};

/**
 * A character's layer tree, built by the production Pixi backend and left
 * paused. Unlike XflPlayer this is meant to be composed by an external
 * director: the caller can reparent layers, change transforms and never
 * advance the FLA timeline. The timeline is only used to produce the initial
 * element tree at `frame`.
 */
export class CharacterAssembly {
  readonly player: XflPlayer;

  private constructor(player: XflPlayer) {
    this.player = player;
  }

  static async create(
    project: ProjectIR,
    options: CharacterAssemblyOptions,
  ): Promise<CharacterAssembly> {
    const player = await XflPlayer.create(project, {
      ...options,
      characterId: options.characterId,
      autoPlay: false,
      loop: false,
    });
    player.pause();
    player.seek(options.frame ?? 0);
    return new CharacterAssembly(player);
  }

  get root(): Container {
    return this.player.root;
  }

  get layers(): Map<string, Container> {
    return this.player.layerContainers;
  }

  get bounds(): { x: number; y: number; width: number; height: number } {
    return this.player.bounds;
  }

  get frame(): number {
    return this.player.frame;
  }

  seek(frame: number): void {
    this.player.seek(frame);
  }

  destroy(): void {
    this.player.destroy();
  }
}

export async function buildCharacterAssembly(
  project: ProjectIR,
  options: CharacterAssemblyOptions,
): Promise<CharacterAssembly> {
  return CharacterAssembly.create(project, options);
}
