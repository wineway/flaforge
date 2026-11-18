#!/usr/bin/env node
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const base = process.env.DEMO_URL ?? "http://127.0.0.1:5173/";
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const failures = [];

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("crash", () => failures.push("page crashed"));

  await page.goto(base);
  await page.waitForFunction(() => window.__xfl?.player);
  const initial = await page.evaluate(() => {
    const { player } = window.__xfl;
    player.pause();
    player.seek(0);
    return { total: player.totalFrames, scene: player.scene.name };
  });
  assert.deepEqual(initial, { total: 11, scene: "Scene 1" });

  await page.locator("#play").click();
  await page.waitForFunction(() => window.__xfl.player.frame > 0);
  await page.evaluate(() => {
    window.__xfl.player.pause();
    window.__xfl.seek(10);
  });
  assert.equal(await page.evaluate(() => window.__xfl.player.frame), 10);

  const canvas = page.locator("#canvas");
  const png = PNG.sync.read(await canvas.screenshot());
  let bluePixels = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i + 2] > 180 && png.data[i] < 100) bluePixels++;
  }
  assert.ok(bluePixels >= 25, `expected a rendered blue square, got ${bluePixels} pixels`);

  const recreated = await page.evaluate(async () => {
    const id = await window.__xfl.recreate("scene:0");
    window.__xfl.player.pause();
    return { id, frame: window.__xfl.player.frame };
  });
  assert.deepEqual(recreated, { id: "scene:0", frame: 0 });

  await page.goto(new URL("?character=Dot&frame=5", base).href);
  await page.waitForFunction(() => window.__xfl?.player);
  const character = await page.evaluate(() => ({
    scene: window.__xfl.player.scene.name,
    frame: window.__xfl.player.frame,
  }));
  assert.deepEqual(character, { scene: "Dot", frame: 5 });
  assert.deepEqual(failures, []);
  console.log("E2E OK");
} finally {
  await browser.close();
}
