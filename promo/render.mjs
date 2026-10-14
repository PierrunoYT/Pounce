// Renders launch.html to an MP4: headless Chrome draws each frame via seek(t) on the GPU, sound.mjs
// synthesizes the soundtrack from the page's audioCues(), and ffmpeg encodes both (NVENC when available).
// Usage: node promo/render.mjs [out.mp4] [fps]
//        node promo/render.mjs out.png [seconds]   -> one 2x still (hero caption) at that time
// Needs Node 22+ (built-in WebSocket), Chrome or Edge, and ffmpeg on PATH. No npm packages.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { synthesize, wav } from "./sound.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] ?? join(here, "pounce-launch.mp4"));
const still = out.toLowerCase().endsWith(".png");
const fps = Number(process.argv[3] ?? 60);
const stillAt = Number(process.argv[3] ?? 9.4);
const [W, H] = [1920, 1080];
const PORT = 9333;

const browser = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => p && existsSync(p));
if (!browser) throw new Error("Chrome or Edge not found; set CHROME to its path");

const profile = mkdtempSync(join(tmpdir(), "pounce-render-"));
const chrome = spawn(browser, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, "--force-device-scale-factor=1", "--hide-scrollbars",
  "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-angle=d3d11",
  "--no-first-run", "--no-default-browser-check", "about:blank",
], { stdio: "ignore" });

try {
  const ws = await connect();
  const send = rpc(ws);
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: still ? 2 : 1, mobile: false });
  await send("Page.enable");
  await send("Page.navigate", { url: pathToFileURL(join(here, "launch.html")).href + (still ? "#render-hero" : "#render") });
  await waitFor(send, "document.readyState === 'complete' && typeof seek === 'function'");
  await send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
  const gpu = await send("Runtime.evaluate", { returnByValue: true, expression: `(() => {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
  })()` });
  console.log(`renderer: ${gpu.result.value}`);
  if (still) {
    await send("Runtime.evaluate", { expression: `seek(${stillAt})` });
    const { data } = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(out, Buffer.from(data, "base64"));
    console.log(`wrote ${out} (t = ${stillAt} s)`);
  } else {
    await renderVideo(send);
  }
  ws.close();
} finally {
  chrome.kill();
  await new Promise((r) => setTimeout(r, 500));
  rmSync(profile, { recursive: true, force: true });
}

async function renderVideo(send) {
  const total = (await send("Runtime.evaluate", { expression: "TOTAL", returnByValue: true })).result.value;
  const cues = (await send("Runtime.evaluate", { expression: "audioCues()", returnByValue: true })).result.value;
  const audio = join(profile, "soundtrack.wav");
  writeFileSync(audio, wav(synthesize(cues, total)));

  const nvenc = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout.includes("h264_nvenc");
  const video = nvenc
    ? ["-c:v", "h264_nvenc", "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", "18", "-b:v", "0"]
    : ["-c:v", "libx264", "-preset", "slow", "-crf", "16"];
  console.log(`encoder: ${video[1]}`);
  const ffmpeg = spawn("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-", "-i", audio,
    ...video, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((ok, fail) => ffmpeg.on("close", (c) => (c === 0 ? ok() : fail(new Error(`ffmpeg exited ${c}`)))));

  const frames = Math.round(total * fps);
  for (let i = 0; i < frames; i++) {
    await send("Runtime.evaluate", { expression: `seek(${i / fps})` });
    const { data } = await send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
    if (!ffmpeg.stdin.write(Buffer.from(data, "base64"))) await new Promise((r) => ffmpeg.stdin.once("drain", r));
    if (i % fps === 0) process.stdout.write(`${Math.round((i / frames) * 100)}%`);
  }
  ffmpeg.stdin.end();
  await done;
  console.log(`wrote ${out} (${frames} frames @ ${fps} fps, ${cues.length} sound cues)`);
}

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = pages.find((p) => p.type === "page");
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
        return ws;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("could not reach headless Chrome");
}

function rpc(ws) {
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.fail(new Error(msg.error.message)) : p.ok(msg.result);
  };
  return (method, params = {}) => new Promise((ok, fail) => {
    pending.set(++id, { ok, fail });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function waitFor(send, expr) {
  for (let i = 0; i < 100; i++) {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (r.result.value) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${expr}`);
}
