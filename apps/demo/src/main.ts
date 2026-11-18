import { Application } from "pixi.js";
import { XflPlayer } from "@flaforge/pixi";
import type { ProjectIR } from "@flaforge/ir";
import sampleUrl from "./generated/sample.ir.json?url";

const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const viewport = document.querySelector<HTMLElement>(".viewport")!;
const overlay = document.querySelector<HTMLElement>("#overlay")!;
const playButton = document.querySelector<HTMLButtonElement>("#play")!;
const prevButton = document.querySelector<HTMLButtonElement>("#prev")!;
const nextButton = document.querySelector<HTMLButtonElement>("#next")!;
const fitButton = document.querySelector<HTMLButtonElement>("#fit")!;
const diagnosticsButton = document.querySelector<HTMLButtonElement>("#diagnostics")!;
const closeDiagnostics = document.querySelector<HTMLButtonElement>("#close-diagnostics")!;
const diagnosticsPanel = document.querySelector<HTMLElement>("#diagnostics-panel")!;
const diagnosticsList = document.querySelector<HTMLUListElement>("#diagnostics-list")!;
const frameInput = document.querySelector<HTMLInputElement>("#frame")!;
const frameLabel = document.querySelector<HTMLOutputElement>("#frame-label")!;
const sceneSelect = document.querySelector<HTMLSelectElement>("#scene")!;
const zoomInput = document.querySelector<HTMLInputElement>("#zoom")!;

function showError(message: string): void {
  overlay.hidden = false;
  overlay.textContent = message;
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const irUrl = params.get("ir") ?? sampleUrl;
  const response = await fetch(irUrl);
  if (!response.ok) {
    throw new Error(`Could not load ${irUrl} (HTTP ${response.status}).`);
  }
  const project = (await response.json()) as ProjectIR;

  const app = new Application();
  await app.init({
    canvas,
    resizeTo: viewport,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    background: project.stage.backgroundColor ?? "#0d0f14",
    // Required by the Playwright visual tests that read the canvas back.
    preserveDrawingBuffer: true,
  });
  app.ticker.maxFPS = 60;

  let player: XflPlayer | null = null;
  let zoom = 1;
  const characterParam = params.get("character") ?? undefined;
  const fitContent = params.get("fit") === "1";

  function fit(): void {
    if (!player) return;
    const width = app.screen.width;
    const height = app.screen.height;
    const bounds = player.bounds;
    const base = Math.min(width / Math.max(1, bounds.width), height / Math.max(1, bounds.height));
    const scale = base * zoom * (fitContent ? 0.99 : 0.92);
    player.root.scale.set(scale);
    player.root.position.set(
      Math.round(width / 2 - (bounds.x + bounds.width / 2) * scale),
      Math.round(height / 2 - (bounds.y + bounds.height / 2) * scale),
    );
  }

  function syncFrameUI(): void {
    if (!player) return;
    frameInput.max = String(Math.max(0, player.totalFrames - 1));
    frameInput.value = String(player.frame);
    frameLabel.textContent = `${player.frame} / ${player.totalFrames - 1}`;
    playButton.textContent = player.playing ? "Pause" : "Play";
    playButton.classList.toggle("primary", player.playing);
  }

  async function createPlayer(sceneId?: string): Promise<XflPlayer> {
    if (player) {
      app.stage.removeChild(player.root);
      player.destroy();
    }
    const next = await XflPlayer.create(project, {
      sceneId,
      characterId: characterParam,
      fitContent,
      autoPlay: true,
      onDiagnostic: (message) => {
        console.warn("[xfl]", message);
      },
    });
    player = next;
    app.stage.addChild(next.root);
    fit();
    syncFrameUI();
    return next;
  }

  function rebuildSceneSelect(): void {
    sceneSelect.innerHTML = "";
    for (const scene of project.scenes) {
      const option = document.createElement("option");
      option.value = scene.id;
      option.textContent = `${scene.name} (${scene.frameCount}f)`;
      sceneSelect.append(option);
    }
    sceneSelect.value = project.scenes[0]?.id ?? "";
  }

  function renderDiagnostics(): void {
    diagnosticsList.innerHTML = "";
    if (project.diagnostics.length === 0) {
      const item = document.createElement("li");
      item.textContent = "No diagnostics.";
      diagnosticsList.append(item);
      return;
    }
    for (const diagnostic of project.diagnostics) {
      const item = document.createElement("li");
      item.className = diagnostic.level;
      const path = diagnostic.path ? ` — ${diagnostic.path}` : "";
      item.textContent = `[${diagnostic.level}] ${diagnostic.code}: ${diagnostic.message}${path}`;
      diagnosticsList.append(item);
    }
  }

  setText("stage-size", `${project.stage.width}×${project.stage.height} @ ${project.stage.frameRate}fps`);
  setText("fps", `${project.stage.frameRate}`);
  setText("symbol-count", String(Object.values(project.library).filter((item) => item.kind === "symbol").length));
  setText("shape-count", String(Object.keys(project.shapes).length));
  setText("diagnostic-count", String(project.diagnostics.length));
  rebuildSceneSelect();
  renderDiagnostics();
  const initialPlayer = await createPlayer(sceneSelect.value);
  setText("frame-count", String(initialPlayer.totalFrames));
  const initialFrame = Number(params.get("frame"));
  if (params.has("frame") && Number.isFinite(initialFrame) && initialFrame >= 0) {
    initialPlayer.pause();
    initialPlayer.seek(initialFrame);
    syncFrameUI();
  }

  playButton.addEventListener("click", () => {
    player?.toggle();
    syncFrameUI();
  });
  prevButton.addEventListener("click", () => {
    if (!player) return;
    player.pause();
    player.seek(player.frame - 1);
    syncFrameUI();
  });
  nextButton.addEventListener("click", () => {
    if (!player) return;
    player.pause();
    player.seek(player.frame + 1);
    syncFrameUI();
  });
  fitButton.addEventListener("click", () => {
    zoom = 1;
    zoomInput.value = "1";
    fit();
  });
  diagnosticsButton.addEventListener("click", () => {
    diagnosticsPanel.hidden = !diagnosticsPanel.hidden;
  });
  closeDiagnostics.addEventListener("click", () => {
    diagnosticsPanel.hidden = true;
  });
  frameInput.addEventListener("input", () => {
    if (!player) return;
    player.pause();
    player.seek(Number(frameInput.value));
    syncFrameUI();
  });
  zoomInput.addEventListener("input", () => {
    zoom = Number(zoomInput.value);
    fit();
  });
  sceneSelect.addEventListener("change", async () => {
    const next = await createPlayer(sceneSelect.value);
    setText("frame-count", String(next.totalFrames));
  });
  window.addEventListener("resize", fit);

  document.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.code === "Space") {
      event.preventDefault();
      player?.toggle();
      syncFrameUI();
    } else if (event.code === "ArrowLeft") {
      player?.seek(player.frame - 1);
      syncFrameUI();
    } else if (event.code === "ArrowRight") {
      player?.seek(player.frame + 1);
      syncFrameUI();
    }
  });

  app.ticker.add(() => {
    if (!player) return;
    const before = player.frame;
    player.update(app.ticker.deltaMS);
    if (player.frame !== before) syncFrameUI();
  });

  // Expose for e2e/visual tests.
  (window as unknown as { __xfl?: unknown }).__xfl = {
    app,
    project,
    get player() {
      return player;
    },
    seek: (frame: number) => {
      player?.pause();
      player?.seek(frame);
      syncFrameUI();
    },
    recreate: async (sceneId?: string) => {
      const next = await createPlayer(sceneId);
      setText("frame-count", String(next.totalFrames));
      return next.scene.id;
    },
  };
}

main().catch((error: unknown) => {
  console.error(error);
  showError(`Failed to load the XFL demo.\n\n${(error as Error).message}`);
});
