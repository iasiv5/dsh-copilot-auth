/**
 * Capture README preview shots from the live DSH Web GUI.
 *
 * Privacy protocol:
 *   1. UI forced to zh-CN; every frame is CLIPPED to this plugin's own
 *      surfaces (the settings dialog / the manage-models modal) — sidebar
 *      workspace rows, conversation titles, skin wallpaper and foreign
 *      widgets (e.g. quota badges) never enter the frame;
 *   2. destructive actions are never triggered: 退出登录 and 应用更改 are
 *      untouched; the manage-models modal is closed via 取消 only;
 *   3. foreign first-visit notice dialogs are dismissed;
 *   4. the appearance card (浅色/深色/跟随系统) is restored to its original
 *      state after the light-theme shot — switching writes the host theme
 *      preference, so the original selection is put back at the end.
 *
 * Usage:
 *   node scripts/capture-previews.mjs                 # capture into docs/assets
 *   node scripts/capture-previews.mjs --out <dir>     # explicit output override
 *   node scripts/capture-previews.mjs --url <base>    # default http://127.0.0.1:3080
 *
 * Requires: playwright-core (devDependency) with a matching chromium in
 * ~/.cache/ms-playwright, and the plugin installed & authorized on the
 * target instance (the manage-models modal only exists when signed in).
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const baseUrl = option("--url", "http://127.0.0.1:3080");
const outDir = option("--out", "docs/assets");

const VIEWPORT = { width: 1600, height: 1000 };
const WEBP_QUALITY = 0.82;

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
mkdirSync(outDir, { recursive: true });
console.log(`capture output -> ${outDir}`);

/** Convert a PNG buffer to WebP through an in-page canvas (no extra deps). */
async function toWebp(page, pngBuffer, quality = WEBP_QUALITY) {
  const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
  const out = await page.evaluate(async ({ dataUrl, quality }) => {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    return canvas.toDataURL("image/webp", quality);
  }, { dataUrl, quality });
  return Buffer.from(out.split(",", 2)[1], "base64");
}

/** Dismiss the official first-visit notice dialog, if any. */
async function dismissNotices(page) {
  const modal = page.locator('div[role="presentation"]:has(button:has-text("继续"))').first();
  if (await modal.count() === 0) return false;
  await modal.locator("button").last().click();
  try {
    await page.waitForSelector('div[class*="_mask_"]', { state: "detached", timeout: 5_000 });
  } catch {}
  await page.waitForTimeout(600);
  return true;
}

/** Hide banners owned by other plugins (best effort; clips exclude them anyway). */
async function hideForeignBanners(page) {
  return page.evaluate(() => {
    const hidden = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while ((node = walker.nextNode())) {
      const textOnly = node.childNodes.length > 0 && [...node.childNodes].every((n) => n.nodeType === Node.TEXT_NODE);
      const text = textOnly ? node.textContent.trim() : "";
      if (text !== "" && /内测|Internal Testing/i.test(text)) {
        let target = node;
        for (let i = 0; i < 3 && target.parentElement; i += 1) {
          const rect = target.getBoundingClientRect();
          if (rect.width > 600 && rect.height < 90) break;
          target = target.parentElement;
        }
        target.style.display = "none";
        hidden.push(text.slice(0, 30));
      }
    }
    return hidden;
  });
}

/**
 * Rect of the settings dialog: the outermost ancestor of the `anchorText`
 * button that also contains the dialog's 关闭 button and is dialog-sized.
 */
async function settingsRect(page, anchorText) {
  return page.evaluate(({ anchorText }) => {
    const buttons = [...document.querySelectorAll("button")];
    const anchor = buttons.find((b) => b.textContent.trim() === anchorText);
    if (!anchor) return null;
    const close = buttons.filter((b) => b.textContent.trim() === "关闭");
    const vw = window.innerWidth;
    let node = anchor;
    let best = null;
    while (node && node !== document.body) {
      const rect = node.getBoundingClientRect();
      const containsClose = close.some((b) => node.contains(b));
      if (containsClose && rect.width >= 500 && rect.width <= vw * 0.75 && rect.height >= 300) best = rect;
      node = node.parentElement;
    }
    return best ? { x: best.x, y: best.y, width: best.width, height: best.height } : null;
  }, { anchorText });
}

/** Rect of the manage-models modal box (first child of its role=dialog mask). */
async function manageModalRect(page) {
  const box = await page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('div[role="dialog"][aria-modal="true"]')]
      .filter((d) => d.querySelector("h4")?.textContent === "管理模型列表");
    const mask = dialogs[dialogs.length - 1];
    if (!mask) return null;
    const inner = mask.firstElementChild;
    const rect = (inner ?? mask).getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (!box) throw new Error("manage-models modal not found in DOM");
  return box;
}

function padRect(rect, pad, viewport) {
  const x = Math.max(0, Math.floor(rect.x - pad));
  const y = Math.max(0, Math.floor(rect.y - pad));
  const width = Math.min(viewport.width, Math.ceil(rect.x + rect.width + pad)) - x;
  const height = Math.min(viewport.height, Math.ceil(rect.y + rect.height + pad)) - y;
  return { x, y, width, height };
}

async function writeShot(page, name, clip) {
  const png = await page.screenshot({ clip });
  const webp = await toWebp(page, png);
  const file = join(outDir, name);
  writeFileSync(file, webp);
  console.log(`${name}: ${(webp.length / 1024).toFixed(0)} KiB (${clip.width}x${clip.height})`);
}

/** Appearance preference card (host 通用设置): 浅色 / 深色 / 跟随系统. */
function appearanceCard(page, id) {
  const label = { light: "浅色", dark: "深色", system: "跟随系统" }[id];
  return page.getByRole("button", { name: label, exact: true }).first();
}

/** Click an appearance card and verify the preference actually moved. */
async function setAppearance(page, id) {
  for (let i = 0; i < 3; i += 1) {
    await appearanceCard(page, id).click().catch(() => {});
    await page.waitForTimeout(1_000);
    if (await currentAppearance(page) === id) return;
    console.log(`appearance card ${id} click ${i + 1} did not take effect, retrying`);
  }
  throw new Error(`failed to switch appearance to ${id}`);
}

async function currentAppearance(page) {
  return page.evaluate(() => {
    const pressed = [...document.querySelectorAll('button[aria-pressed="true"]')]
      .find((b) => ["浅色", "深色", "跟随系统"].some((t) => b.textContent.includes(t)));
    if (!pressed) return null;
    return pressed.textContent.includes("浅色") ? "light" : pressed.textContent.includes("深色") ? "dark" : "system";
  });
}

async function clickNav(page, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const clicked = await page.evaluate((text) => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
      if (!btn) return false;
      btn.click();
      return true;
    }, label).catch(() => false);
    if (clicked) return;
    if (Date.now() > deadline) throw new Error(`nav button not found: ${label}`);
    await page.waitForTimeout(400);
  }
}

/** Wait until the settings dialog is present in the DOM. */
async function settingsModalOpen(page) {
  return page.evaluate(
    () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "通用设置"),
  ).catch(() => false);
}

/** Open the settings dialog; some clicks get swallowed by tooltip overlays, so retry. */
async function openSettings(page, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    await page.mouse.move(800, 300); // park the pointer away from footer tooltips
    await page.getByRole("button", { name: "设置", exact: true }).first().click();
    for (let w = 0; w < 5; w += 1) {
      if (await settingsModalOpen(page)) {
        await page.waitForTimeout(600);
        return;
      }
      await page.waitForTimeout(400);
    }
    console.log(`settings dialog not open after click ${i + 1}, retrying`);
  }
  await page.screenshot({ path: join(outDir, "debug-settings-missing.png"), fullPage: false });
  throw new Error("settings dialog did not open (see debug-settings-missing.png)");
}

// ---- capture session ----
const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: "dark", locale: "zh-CN" });
const page = await context.newPage();
await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4_000);
const notice = await dismissNotices(page);
if (notice) console.log("dismissed first-visit notice dialog");

// open settings → GHC设置 (authorized state expected on this instance)
await openSettings(page);
// read the appearance preference NOW: the cards live in the 通用设置 section,
// which is the section the settings dialog opens with
const originalAppearance = await currentAppearance(page);
console.log(`original appearance: ${originalAppearance}`);
await clickNav(page, "GHC设置");
await page.waitForSelector('button:has-text("管理模型列表")', { timeout: 15_000 });
await page.waitForTimeout(1_500);
await hideForeignBanners(page);

// 1. GHC settings (dark)
await writeShot(page, "preview-settings-dark.webp", padRect(await settingsRect(page, "GHC设置"), 20, VIEWPORT));

// 2. manage-models modal — open preview, shoot, close via 取消 (no apply)
await page.getByRole("button", { name: "管理模型列表", exact: true }).click();
await page.waitForSelector('h4:has-text("管理模型列表")', { timeout: 30_000 });
await page.waitForSelector('text=/应用后共|无需更改/', { timeout: 30_000 });
await page.waitForTimeout(800);
await writeShot(page, "preview-manage-models.webp", padRect(await manageModalRect(page), 20, VIEWPORT));
await page.getByRole("button", { name: "取消", exact: true }).click();
await page.waitForTimeout(1_000);

// 3. Models section — the GitHub Copilot route and its model list
await clickNav(page, "模型");
await page.waitForTimeout(2_500);
await writeShot(page, "preview-models.webp", padRect(await settingsRect(page, "模型"), 20, VIEWPORT));

// 4. GHC settings (light) — via the host appearance cards, then restore
if (originalAppearance !== "light") {
  await clickNav(page, "通用设置");
  await page.waitForTimeout(800);
  await setAppearance(page, "light");
  await clickNav(page, "GHC设置");
  await page.waitForSelector('button:has-text("管理模型列表")', { timeout: 15_000 });
  await page.waitForTimeout(1_200);
  await writeShot(page, "preview-settings-light.webp", padRect(await settingsRect(page, "GHC设置"), 20, VIEWPORT));
  // restore the original preference
  await clickNav(page, "通用设置");
  await page.waitForTimeout(800);
  await setAppearance(page, originalAppearance);
  console.log(`appearance restored to: ${originalAppearance}`);
}

await context.close();
await browser.close();
console.log("done.");
