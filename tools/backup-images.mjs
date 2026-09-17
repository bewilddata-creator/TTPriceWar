#!/usr/bin/env node
/**
 * Backs up product images into the TTPriceWar-images repo as img/<key>.jpg (max 300px, white
 * background), key = normBarcode(barcode). The pages show the original URL first and fall back
 * to this copy when it fails to load. See RUNBOOK-images.md for when and how to run it.
 *
 *   cd tools && npm install          (once)
 *   node tools/backup-images.mjs --dry-run      what would happen, downloads nothing
 *   node tools/backup-images.mjs                back up everything new or changed, then push
 *
 * Options: --limit N (stop after N attempts, for testing), --no-push (commit locally only),
 *          --host TEXT (only image URLs whose host contains TEXT, e.g. --host tops),
 *          --retry-failed (also retry products that already failed 3 times), --repo PATH
 *
 * Reads the PREBUILT analysis (?action=summary + ?action=images), so products added since the
 * last buildAnalysis are invisible to it — rebuild first.
 *
 * Only downloads what is missing or whose source URL changed (manifest.tsv keeps a hash of the
 * URL each file came from), so reruns are cheap. Safe to Ctrl+C: finished images are committed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normBarcode } from "../core.js";

const API_URL = "https://script.google.com/macros/s/AKfycbz0PQVtM46QOMu7aWOKV56Q-A3R6Fp45V42sBslG1AhZfQ_S3RyQGOg1Zp5toMgQtyaGg/exec";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MAX_PX = 300;
const JPEG_QUALITY = 0.72;
// Sites known to reject downloads that don't come from a real, visible browser. Anything else
// that answers with a non-image is retried through the same browser automatically.
const BROWSER_ONLY_HOSTS = ["tops.co.th", "bigc-cs.com"];
const FETCH_CONCURRENCY = 8;
const BROWSER_DELAY_MS = 300;       // between browser downloads — stay polite, avoid a block
const COMMIT_EVERY = 1000;          // images per commit
const PUSH_EVERY_MS = 10 * 60e3;    // GitHub Pages rebuilds on each push; it soft-limits 10/hour
const GIVE_UP_AFTER = 3;            // failed attempts at the SAME url before later runs skip it
const PAGES_LIMIT_MB = 1024;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const DRY = flag("--dry-run"), NO_PUSH = flag("--no-push"), RETRY_FAILED = flag("--retry-failed");
const LIMIT = Number(opt("--limit", Infinity));
const HOST = opt("--host", "");
const REPO = resolve(opt("--repo", join(here, "..", "..", "TTPriceWar-images")));
const IMG_DIR = join(REPO, "img");
const MANIFEST = join(REPO, "manifest.tsv");
const FAILURES = join(REPO, "failures.tsv");

const log = (...a) => console.log(...a);
const git = (...a) => execFileSync("git", ["-C", REPO, ...a], { encoding: "utf8" }).trim();
const hashUrl = u => createHash("sha1").update(u).digest("hex").slice(0, 12);
const hostOf = u => { try { return new URL(u).hostname; } catch { return "?"; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- state files (TSV: one line per product, sorted, so git diffs stay small) ----------
function readTsv(file) {
  const m = new Map();
  if (!existsSync(file)) return m;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    const [key, ...rest] = line.split("\t");
    m.set(key, rest);
  }
  return m;
}
function writeTsv(file, m) {
  const keys = [...m.keys()].sort();
  writeFileSync(file, keys.map(k => [k, ...m.get(k)].join("\t")).join("\n") + (keys.length ? "\n" : ""));
}

// ---------- source list ----------
async function getJson(action) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API_URL}?action=${action}`, { redirect: "follow" });
      const text = await res.text();
      const d = JSON.parse(text);   // Drive occasionally answers with an HTML error page
      if (d.ok) return d;
      throw new Error(d.error || "ok:false");
    } catch (e) {
      if (attempt === 3) throw new Error(`action=${action} failed: ${e.message}`);
      await sleep(3000 * attempt);
    }
  }
}

async function loadProducts() {
  const [sum, imgs] = await Promise.all([getJson("summary"), getJson("images")]);
  if (sum.generated !== imgs.generated || sum.p.length !== imgs.img.length) {
    throw new Error(`summary (${sum.generated}, ${sum.p.length}) and images (${imgs.generated}, ${imgs.img.length}) disagree — rebuild analysis and rerun`);
  }
  const byKey = new Map();
  sum.p.forEach((row, i) => {
    const raw = imgs.img[i];
    if (!raw) return;
    const key = normBarcode(row[0]);
    if (key === "0" || byKey.has(key)) return;   // first row wins, same as buildAnalysis
    byKey.set(key, { key, barcode: String(row[0]), url: raw.replace("~", imgs.cdn) });
  });
  return { generated: sum.generated, total: sum.p.length, items: [...byKey.values()] };
}

// ---------- download ----------
function looksLikeImage(buf) {
  if (buf.length < 64) return false;
  const b = buf, s = (o, n) => b.subarray(o, o + n).toString("latin1");
  return (b[0] === 0xff && b[1] === 0xd8)            // jpeg
    || s(0, 8) === "\x89PNG\r\n\x1a\n"
    || s(0, 4) === "GIF8"
    || (s(0, 4) === "RIFF" && s(8, 4) === "WEBP")
    || s(4, 4) === "ftyp"                            // avif / heic
    || s(0, 5) === "<?xml" || s(0, 4) === "<svg";
}

async function fetchDirect(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "user-agent": UA, accept: "image/*,*/*;q=0.8" } });
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.status === 404 || res.status === 410) return { gone: `HTTP ${res.status}` };
    if (res.ok && looksLikeImage(buf)) return { buf };
    return { blocked: `HTTP ${res.status}${res.ok ? " not an image" : ""}` };
  } catch (e) {
    return { blocked: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(t);
  }
}

let visible = null;   // a real Chrome window, opened only if some site needs it
async function fetchViaBrowser(chromium, url) {
  if (!visible) {
    log("  opening a Chrome window for sites that block scripts — leave it alone until the run ends");
    const browser = await chromium.launch({ executablePath: CHROME, headless: false });
    visible = { browser, page: await browser.newPage() };
  }
  try {
    const res = await visible.page.goto(url, { timeout: 30000 });
    const buf = res ? await res.body() : Buffer.alloc(0);
    if (res && res.ok() && looksLikeImage(buf)) return { buf };
    return { error: `browser: HTTP ${res ? res.status() : "no response"}` };
  } catch (e) {
    return { error: `browser: ${e.message.split("\n")[0]}` };
  }
}

// ---------- resize: in headless Chrome, which decodes webp/avif/svg and handles transparency ----------
async function makeResizer(chromium) {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const resize = buf => page.evaluate(async ({ b64, maxPx, q }) => {
    try {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      let bmp;
      try {
        bmp = await createImageBitmap(new Blob([bytes]));
      } catch {
        // SVG can't go through createImageBitmap directly
        const img = new Image();
        img.src = URL.createObjectURL(new Blob([bytes], { type: "image/svg+xml" }));
        await img.decode();
        bmp = img;
      }
      const w0 = bmp.width, h0 = bmp.height;
      if (w0 < 20 || h0 < 20) return { error: `too small (${w0}x${h0})` };
      const k = Math.min(1, maxPx / Math.max(w0, h0));
      const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
      const c = new OffscreenCanvas(w, h), g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);   // transparent PNGs would turn black as JPEG
      g.imageSmoothingQuality = "high";
      g.drawImage(bmp, 0, 0, w, h);
      const out = new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg", quality: q })).arrayBuffer());
      let s = "";
      for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
      return { b64: btoa(s), w, h };
    } catch (e) {
      return { error: `decode failed: ${e.message || e}` };
    }
  }, { b64: buf.toString("base64"), maxPx: MAX_PX, q: JPEG_QUALITY });
  return { resize, close: () => browser.close() };
}

// ---------- main ----------
async function main() {
  if (!existsSync(join(REPO, ".git"))) {
    throw new Error(`images repo not found at ${REPO} — clone it: gh repo clone bewilddata-creator/TTPriceWar-images`);
  }
  mkdirSync(IMG_DIR, { recursive: true });
  if (!DRY && !NO_PUSH) git("pull", "--ff-only", "-q");

  log("reading product list from the analysis payload…");
  const { generated, total, items } = await loadProducts();
  const manifest = readTsv(MANIFEST);     // key → [urlHash, width, height, bytes, savedAt]
  const failures = readTsv(FAILURES);     // key → [urlHash, tries, reason, url]
  log(`analysis built ${generated}: ${total.toLocaleString()} products, ${items.length.toLocaleString()} with an image URL`);

  let upToDate = 0, givenUp = 0;
  const todo = [];
  for (const it of items) {
    if (HOST && !hostOf(it.url).includes(HOST)) continue;
    const h = hashUrl(it.url);
    const m = manifest.get(it.key);
    if (m && m[0] === h && existsSync(join(IMG_DIR, it.key + ".jpg"))) { upToDate++; continue; }
    const f = failures.get(it.key);
    if (f && f[0] === h && Number(f[1]) >= GIVE_UP_AFTER && !RETRY_FAILED) { givenUp++; continue; }
    todo.push({ ...it, hash: h, changed: !!m });
  }
  const viaBrowser = it => BROWSER_ONLY_HOSTS.some(d => hostOf(it.url).endsWith(d));
  const byHost = {};
  todo.forEach(it => { const hh = hostOf(it.url); byHost[hh] = (byHost[hh] || 0) + 1; });
  log(`already backed up: ${upToDate.toLocaleString()} · to do: ${todo.length.toLocaleString()}`
    + ` (${todo.filter(t => t.changed).length} changed URL) · skipped after ${GIVE_UP_AFTER} failures: ${givenUp}`);
  Object.entries(byHost).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([hh, n]) => log(`  ${String(n).padStart(6)}  ${hh}${BROWSER_ONLY_HOSTS.some(d => hh.endsWith(d)) ? "  (Chrome window)" : ""}`));
  if (DRY || !todo.length) { if (!todo.length) log("nothing to do"); return; }

  const { chromium } = await import("playwright-core").catch(() => {
    throw new Error("playwright-core missing — run: cd tools && npm install");
  });
  const resizer = await makeResizer(chromium);

  let stop = false, saved = 0, failed = 0, sinceCommit = 0, lastPush = Date.now(), attempts = 0;
  const reasons = {};
  process.on("SIGINT", () => { if (stop) process.exit(130); stop = true; log("\nstopping after current downloads… (Ctrl+C again to quit without saving)"); });

  const persist = () => { writeTsv(MANIFEST, manifest); writeTsv(FAILURES, failures); };
  const commit = (final) => {
    persist();
    git("add", "-A", "img", "manifest.tsv", "failures.tsv");
    if (git("status", "--porcelain")) {
      git("commit", "-q", "-m", `Backup ${saved} images (analysis ${generated})`);
    }
    if (!NO_PUSH && (final || Date.now() - lastPush > PUSH_EVERY_MS)) {
      log("  pushing to GitHub…");
      git("push", "-q");
      lastPush = Date.now();
    }
    sinceCommit = 0;
  };

  const record = async (it, got) => {
    let reason = got.gone || got.error || got.blocked;
    if (got.buf) {
      const r = await resizer.resize(got.buf);
      if (r.b64) {
        const out = Buffer.from(r.b64, "base64");
        writeFileSync(join(IMG_DIR, it.key + ".jpg"), out);
        manifest.set(it.key, [it.hash, r.w, r.h, out.length, new Date().toISOString().slice(0, 10)]);
        failures.delete(it.key);
        saved++; sinceCommit++;
        if (sinceCommit >= COMMIT_EVERY) commit(false);
        return;
      }
      reason = r.error;
    }
    const prev = failures.get(it.key);
    const tries = prev && prev[0] === it.hash ? Number(prev[1]) + 1 : 1;
    failures.set(it.key, [it.hash, tries, reason.replace(/\s+/g, " ").slice(0, 80), it.url]);
    reasons[reason] = (reasons[reason] || 0) + 1;
    failed++;
  };

  const started = Date.now();
  const progress = () => {
    const done = saved + failed;
    const rate = done / ((Date.now() - started) / 1000 || 1);
    const left = todo.length - done;
    process.stdout.write(`\r  ${done.toLocaleString()}/${todo.length.toLocaleString()} · saved ${saved} · failed ${failed} · ~${Math.ceil(left / Math.max(rate, 0.1) / 60)} min left   `);
  };

  // Pass 1: plain downloads, in parallel. Anything a site refuses joins the browser queue.
  const direct = todo.filter(it => !viaBrowser(it)).slice(0, LIMIT);
  const browserQueue = todo.filter(viaBrowser);
  const directSet = new Set(direct);
  attempts = direct.length;
  let next = 0;
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, async () => {
    while (!stop && next < direct.length) {
      const it = direct[next++];
      const got = await fetchDirect(it.url);
      if (got.blocked) browserQueue.push(it);
      else await record(it, got);
      progress();
    }
  }));

  // Pass 2: one at a time through a real Chrome window.
  for (const it of browserQueue) {
    if (stop || attempts >= LIMIT) break;
    if (!directSet.has(it)) attempts++;
    await record(it, await fetchViaBrowser(chromium, it.url));
    progress();
    await sleep(BROWSER_DELAY_MS);
  }

  log("");
  await resizer.close();
  if (visible) await visible.browser.close();
  commit(true);

  const mb = readdirSync(IMG_DIR).reduce((s, f) => s + statSync(join(IMG_DIR, f)).size, 0) / 1048576;
  log(`\ndone in ${Math.round((Date.now() - started) / 60000)} min — saved ${saved}, failed ${failed}`);
  Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([r, n]) => log(`  ${String(n).padStart(5)}  ${r}`));
  if (failed) log(`  details per product: ${FAILURES}`);
  log(`backup size: ${mb.toFixed(0)} MB of GitHub Pages' ${PAGES_LIMIT_MB} MB limit (${Math.round(mb / PAGES_LIMIT_MB * 100)}%)`);
  if (mb > PAGES_LIMIT_MB * 0.8) log("WARNING: over 80% of the limit — see RUNBOOK-images.md, 'Running out of space'");
}

main().catch(e => {
  console.error("\nERROR:", e.message);
  process.exit(1);
});
