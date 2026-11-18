import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const r = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig(({ command }) => ({
  base: "./",
  publicDir: command === "build" ? false : "public",
  plugins: [
    {
      name: "project-license",
      apply: "build",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "LICENSE",
          source: readFileSync(r("../../LICENSE"), "utf8"),
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@flaforge/container": r("../../packages/xfl-container/src/index.ts"),
      "@flaforge/xml": r("../../packages/xfl-xml/src/index.ts"),
      "@flaforge/compiler": r("../../packages/xfl-compiler/src/index.ts"),
      "@flaforge/ir": r("../../packages/character-ir/src/index.ts"),
      "@flaforge/pixi": r("../../packages/pixi-backend/src/index.ts"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    fs: { allow: [r("../..")] },
  },
  build: {
    target: "es2022",
    license: { fileName: "THIRD_PARTY_LICENSES.md" },
  },
}));
