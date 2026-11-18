import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@flaforge/container": r("./packages/xfl-container/src/index.ts"),
      "@flaforge/xml": r("./packages/xfl-xml/src/index.ts"),
      "@flaforge/compiler": r("./packages/xfl-compiler/src/index.ts"),
      "@flaforge/ir": r("./packages/character-ir/src/index.ts"),
      "@flaforge/pixi": r("./packages/pixi-backend/src/index.ts"),
      "@flaforge/cli": r("./packages/cli/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
  },
});
