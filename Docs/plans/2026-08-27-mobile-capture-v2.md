# Mobile Capture v2 (M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the mobile capture page so a known-item price takes four taps and no camera restart, the app opens instantly and works with no signal, and the last entry can be undone.

**Architecture:** Two deployed files instead of one. `core.js` is a plain ES module holding every piece of logic that does not touch the DOM or the network — price keypad, scan de-duplication, catalog decoding, and the outbox that powers undo. `index.html` imports it with `<script type="module">` and owns all rendering. Node imports the same file to test it. Nothing is bundled, transpiled, or built; GitHub Pages serves both files as-is. The product catalog moves from a 7.7-second Apps Script call to a static `data/catalog.json` cached in IndexedDB behind a service worker.

**Tech Stack:** Vanilla ES modules, `BarcodeDetector` with an `html5-qrcode` fallback, IndexedDB, service worker, `node --test` (built in, no packages). Google Sheet + Apps Script backend unchanged.

**Spec:** `Docs/PRD-Price-Scout-v2.md` (sections 5, 6, 10, 11)

## Global Constraints

- **No build step.** No npm install for anything that ships, no bundler, no framework, no transpiler. A commit to `main` is a deploy.
- **Apps Script goes to v5 in Task 4B**, and only there. `code.gs` is committed in this repo; edit it
  here, then hand it to the user to paste. **Never create a new deployment** — deploy via
  Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy. A new deployment mints a new
  `/exec` URL and breaks every page.
- **Nothing may depend on row order.** People sort spreadsheets; assuming otherwise is a defect
  waiting to happen. `delta` keys on a monotonic `seq` column, and the retry check keys on a cache,
  not on the last N rows. Sorting any tab must remain harmless.
- **Products gains column O, `seq`** — the only schema change in M1, at the far right as required.
- **API URL** is `https://script.google.com/macros/s/AKfycbz0PQVtM46QOMu7aWOKV56Q-A3R6Fp45V42sBslG1AhZfQ_S3RyQGOg1Zp5toMgQtyaGg/exec` and is pasted as a `const` in the page. Same URL as `viewer.html`.
- **POST bodies use `Content-Type: text/plain`.** Never `application/json` — Apps Script cannot answer a CORS preflight and the request will fail.
- **Barcodes are strings, and the Sheet lies about it.** Verified against the real export: all
  26,289 Products and 45,165 Observations hold barcodes as **numbers**, so leading zeros are already
  gone. 2,124 products carry 12-digit UPC-A codes that a phone scanner may report as 13 digits with a
  leading zero, and **no** 13-digit code in the Sheet starts with zero — so those lookups miss every
  time unless normalised. Normalise on every lookup (Task 3); write back the catalog's canonical
  form, never the scanned form.
- **`DEVICE`** is a `const` near `API_URL` naming who holds the phone, e.g. `const DEVICE = "Ooa";`.
  It becomes `entered_by`. Identity is out of scope for M1 — one edited constant per device is the
  whole mechanism.
- **IDs**: prefix + `-` + 6 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no I, L, O, 0, 1). Observations use `O-`, stores use `S-`.
- **Observation record shape** is fixed by the backend: `{type:"obs", obs_id, ts, store_id, barcode, price, flag, source, by, new_store?, new_product?}`. `flag` is exactly one of `normal` / `promo` / `short_shelf_life`. `source` is `scan` or `manual`.
- **Never use these as top-level identifiers**: `top`, `name`, `status`, `parent`, `self`, `length`, `history`, `open`, `close`, `origin`, `event`. A top-level `const top` throws "already declared" and silently kills the entire script. This has bitten this project before.
- **Design tokens** (copy verbatim): paper `#FAF9F6`, card `#FFFFFF`, ink `#17191C`, muted `#6E6A61`, line `#E6E2D9`, tag orange `#FF7A1A`, tag deep `#E05E00`, tag ink `#3A1A00`, ok `#0E8A5F`, warn `#C7462B`, amber `#B07100`. Radius 14px cards / 99px pills. Fonts: Noto Sans Thai (UI), IBM Plex Mono (prices and barcodes).
- **UI copy is Thai.** Code and comments are English.
- **Max width 480px**, single column.

---

## File Structure

| File | Responsibility |
|---|---|
| `core.js` | **New.** Pure logic: ids, price keypad, scan de-dup, catalog decode, outbox/undo. No DOM, no `fetch`. |
| `index.html` | **Rewritten.** All markup, styling, camera, rendering, network. Imports `core.js`. |
| `sw.js` | **New.** Service worker: caches the app shell and catalog so the app opens offline. |
| `manifest.webmanifest` | **New.** PWA metadata. |
| `icons/icon-192.png`, `icons/icon-512.png` | **New.** Home-screen icons. |
| `data/catalog.json` | **New.** Static product snapshot — barcode, brand, item, sku. ~1.7 MB raw, ~425 KB gzipped by the CDN. |
| `data/images.json` | **New.** Image URLs, index-aligned to `catalog.json`. Loaded lazily, never blocks. |
| `tools/build-catalog.mjs` | **New.** Regenerates both data files from the live API. Run by hand, never deployed. |
| `tools/make-icons.py` | **New.** Generates the two PNG icons. Dependency-free. Run once. |
| `tests/*.test.mjs` | **New.** `node --test` over `core.js`. Never deployed. |

`viewer.html` is not touched.

---

## Task 1: Catalog build tool and static snapshot

**Files:**
- Create: `tools/build-catalog.mjs`
- Create: `data/catalog.json`, `data/images.json`
- Test: `tests/catalog-data.test.mjs`

**Interfaces:**
- Produces: `data/catalog.json` shaped `{v: "YYYY-MM-DD", n: <count>, seq: <high-water mark>, p: [[barcode, brand, item, sku], ...]}` and `data/images.json` shaped `{v: "YYYY-MM-DD", cdn: "<prefix>", img: ["<compact>", ...]}` where `img[i]` corresponds to `p[i]` and a compact URL begins with `~` standing in for `cdn`.

- [ ] **Step 1: Write the build tool**

```js
// tools/build-catalog.mjs — regenerate the static catalog from the live API.
// Run by hand: node tools/build-catalog.mjs
// Not deployed. Not part of any build step.
import { writeFileSync, mkdirSync } from "node:fs";

const API_URL = "https://script.google.com/macros/s/AKfycbz0PQVtM46QOMu7aWOKV56Q-A3R6Fp45V42sBslG1AhZfQ_S3RyQGOg1Zp5toMgQtyaGg/exec";

const stamp = new Date().toISOString().slice(0, 10);

console.log("fetching bootstrap (this takes ~8s)...");
const res = await fetch(API_URL + "?action=bootstrap");
if (!res.ok) throw new Error("bootstrap failed: " + res.status);
const d = await res.json();
if (!d.ok || !Array.isArray(d.p)) throw new Error("unexpected payload");

// `seq` is delta's starting point. Order-independent, so sorting the Sheet cannot invalidate it.
const catalog = { v: stamp, n: d.p.length, seq: d.seq || 0,
                  p: d.p.map(r => [r[0], r[1], r[2], r[3]]) };
const images = { v: stamp, cdn: d.cdn || "", img: d.p.map(r => r[4] || "") };

mkdirSync("data", { recursive: true });
writeFileSync("data/catalog.json", JSON.stringify(catalog));
writeFileSync("data/images.json", JSON.stringify(images));

console.log(`wrote ${catalog.n} products, stamp ${stamp}`);
```

- [ ] **Step 2: Write the failing test**

```js
// tests/catalog-data.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync("data/catalog.json", "utf8"));
const images = JSON.parse(readFileSync("data/images.json", "utf8"));

test("catalog holds the full product master", () => {
  assert.ok(catalog.n > 26000, "expected >26k products, got " + catalog.n);
  assert.equal(catalog.p.length, catalog.n);
});

test("catalog records the seq high-water mark delta starts from", () => {
  assert.ok(Number.isInteger(catalog.seq) && catalog.seq >= catalog.n,
    "seq must be stamped by backfillSeq before the snapshot is built");
});

test("every catalog row is [barcode, brand, item, sku] with a string barcode", () => {
  for (const r of catalog.p.slice(0, 500)) {
    assert.equal(r.length, 4);
    assert.equal(typeof r[0], "string");
    assert.match(r[0], /^[0-9]+$/);
  }
});

test("barcodes are unique", () => {
  assert.equal(new Set(catalog.p.map(r => r[0])).size, catalog.p.length);
});

test("images align to catalog by index and share its stamp", () => {
  assert.equal(images.img.length, catalog.p.length);
  assert.equal(images.v, catalog.v);
  assert.ok(images.cdn.startsWith("https://"));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test tests/catalog-data.test.mjs`
Expected: FAIL — `ENOENT: no such file or directory, open 'data/catalog.json'`

- [ ] **Step 4: Generate the data files**

Run: `node tools/build-catalog.mjs`
Expected: `wrote 26289 products, stamp 2026-08-27`

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/catalog-data.test.mjs`
Expected: 4 tests pass.

- [ ] **Step 6: Confirm the size win is real**

Run: `gzip -c data/catalog.json | wc -c`
Expected: roughly 400,000–450,000 bytes. If it is above 600 KB, stop — something other than the four intended fields is in the file.

- [ ] **Step 7: Commit**

```bash
git add tools/build-catalog.mjs data/catalog.json data/images.json tests/catalog-data.test.mjs
git commit -m "feat: static product catalog snapshot + build tool"
```

---

## Task 2: core.js — ids and the price keypad

**Files:**
- Create: `core.js`
- Test: `tests/price.test.mjs`

**Interfaces:**
- Produces: `makeId(prefix, rnd?)` → `"O-8FN3TR"`. `priceKey(price, key)` → next price string, where `key` is `"0"`–`"9"`, `"."`, or `"back"`. `priceValue(price)` → positive `number` or `null`.

- [ ] **Step 1: Write the failing test**

```js
// tests/price.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeId, priceKey, priceValue, ID_CHARS } from "../core.js";

test("makeId uses the unambiguous charset and the given prefix", () => {
  const id = makeId("O", () => 0.5);
  assert.match(id, /^O-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.ok(!/[ILO01]/.test(ID_CHARS));
});

test("digits append", () => {
  assert.equal(priceKey("", "1"), "1");
  assert.equal(priceKey("12", "9"), "129");
});

test("a leading zero is replaced, not accumulated", () => {
  assert.equal(priceKey("0", "5"), "5");
  assert.equal(priceKey("", "0"), "0");
});

test("backspace removes one character", () => {
  assert.equal(priceKey("129", "back"), "12");
  assert.equal(priceKey("", "back"), "");
});

test("only one decimal point, and it can open a value", () => {
  assert.equal(priceKey("12", "."), "12.");
  assert.equal(priceKey("12.", "."), "12.");
  assert.equal(priceKey("", "."), "0.");
});

test("at most two decimal places", () => {
  assert.equal(priceKey("12.5", "0"), "12.50");
  assert.equal(priceKey("12.50", "9"), "12.50");
});

test("at most six digits", () => {
  assert.equal(priceKey("123456", "7"), "123456");
});

test("priceValue returns a positive number or null", () => {
  assert.equal(priceValue("129"), 129);
  assert.equal(priceValue("12.50"), 12.5);
  assert.equal(priceValue(""), null);
  assert.equal(priceValue("0"), null);
  assert.equal(priceValue("12."), 12);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/price.test.mjs`
Expected: FAIL — cannot find module `../core.js`.

- [ ] **Step 3: Write the implementation**

```js
// core.js — pure logic for Price Scout capture.
// No DOM, no network, no globals. Imported by index.html and by node tests.

export const ID_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Generate an app-side id, e.g. makeId("O") -> "O-8FN3TR". */
export function makeId(prefix, rnd = Math.random) {
  let out = "";
  for (let i = 0; i < 6; i++) out += ID_CHARS[Math.floor(rnd() * ID_CHARS.length)];
  return prefix + "-" + out;
}

/** Apply one keypad press to the price string. `key` is "0"-"9", "." or "back". */
export function priceKey(price, key) {
  if (key === "back") return price.slice(0, -1);
  if (key === ".") return price.includes(".") ? price : (price || "0") + ".";
  if (!/^[0-9]$/.test(key)) return price;
  if (price === "0") return key;
  const dot = price.indexOf(".");
  if (dot >= 0 && price.length - dot > 2) return price;
  if (price.replace(".", "").length >= 6) return price;
  return price + key;
}

/** The saveable number, or null when the price is not yet valid. */
export function priceValue(price) {
  const n = parseFloat(price);
  return Number.isFinite(n) && n > 0 ? n : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/price.test.mjs`
Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add core.js tests/price.test.mjs
git commit -m "feat: core price keypad and id generation"
```

---

## Task 3: core.js — catalog decoding, barcode normalisation, scan de-duplication

**Files:**
- Modify: `core.js` (append)
- Test: `tests/catalog.test.mjs`

**Interfaces:**
- Produces: `normBarcode(code)` → digits with leading zeros stripped. `decodeCatalog(json)` → `Map`
  holding each product under **both** its exact barcode and its normalised form, each value
  `{barcode, brand, item, sku}` where `barcode` is the catalog's canonical string.
  `findProduct(map, code)` → that record or `null`. `addLocalProduct(map, barcode, fields)`.
  `shouldAcceptScan(last, code, now, windowMs?)` → boolean, `last` is `null` or `{code, at}`.

- [ ] **Step 1: Write the failing test**

```js
// tests/catalog.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { normBarcode, decodeCatalog, findProduct, addLocalProduct, shouldAcceptScan } from "../core.js";

const SAMPLE = { v: "2026-08-27", n: 3, p: [
  ["8859141308566", "MILLE", "Blink Bright Body Primer Cream", "Floral Petals"],
  ["8850123000028", "ODBO", "Blush 3 Colors", ""],
  ["773602335374",  "NYX",  "Butter Gloss", "Cream Brulee"]      // 12-digit UPC-A
]};

test("normBarcode keeps digits and drops leading zeros", () => {
  assert.equal(normBarcode("0773602335374"), "773602335374");
  assert.equal(normBarcode("773602335374"), "773602335374");
  assert.equal(normBarcode(773602335374), "773602335374");
  assert.equal(normBarcode("885-914 1308566"), "8859141308566");
});

test("an exact 13-digit barcode is found", () => {
  const m = decodeCatalog(SAMPLE);
  assert.equal(findProduct(m, "8859141308566").item, "Blink Bright Body Primer Cream");
});

test("a UPC-A scanned as a zero-padded EAN-13 still finds its product", () => {
  // The real failure this prevents: the Sheet holds 773602335374, the phone reports
  // 0773602335374, and without normalisation the app calls a known product new.
  const m = decodeCatalog(SAMPLE);
  const hit = findProduct(m, "0773602335374");
  assert.ok(hit, "zero-padded UPC-A must resolve");
  assert.equal(hit.item, "Butter Gloss");
});

test("the record carries the catalog's canonical barcode, not the scanned one", () => {
  const m = decodeCatalog(SAMPLE);
  assert.equal(findProduct(m, "0773602335374").barcode, "773602335374");
});

test("an unknown barcode returns null", () => {
  assert.equal(findProduct(decodeCatalog(SAMPLE), "9999999999999"), null);
});

test("addLocalProduct makes a field-created product findable immediately, both ways", () => {
  const m = decodeCatalog(SAMPLE);
  addLocalProduct(m, "9999999999999", { brand: "", item: "ครีมซองใหม่", sku: "" });
  assert.equal(findProduct(m, "9999999999999").item, "ครีมซองใหม่");
  assert.equal(findProduct(m, "09999999999999").item, "ครีมซองใหม่");
});

test("the same barcode twice in quick succession is rejected once", () => {
  assert.equal(shouldAcceptScan(null, "111", 1000), true);
  assert.equal(shouldAcceptScan({ code: "111", at: 1000 }, "111", 1500), false);
});

test("the same barcode is accepted again after the window", () => {
  assert.equal(shouldAcceptScan({ code: "111", at: 1000 }, "111", 4000), true);
});

test("a different barcode is always accepted", () => {
  assert.equal(shouldAcceptScan({ code: "111", at: 1000 }, "222", 1010), true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/catalog.test.mjs`
Expected: FAIL — `normBarcode is not a function`.

- [ ] **Step 3: Append the implementation to `core.js`**

```js
/**
 * Barcodes reach us in inconsistent widths. The Sheet stores them as numbers, so any
 * leading zero is already lost, and a UPC-A product may be scanned as 12 digits or as
 * 13 with a leading zero. Normalising to "digits, no leading zeros" was verified against
 * the full 26,289-product master: zero collisions.
 */
export function normBarcode(code) {
  return String(code).replace(/\D/g, "").replace(/^0+/, "") || "0";
}

/** Build a lookup map. Every product is registered under its exact and normalised barcode. */
export function decodeCatalog(json) {
  const m = new Map();
  for (const r of json.p) {
    const rec = { barcode: r[0], brand: r[1], item: r[2], sku: r[3] };
    m.set(r[0], rec);
    const n = normBarcode(r[0]);
    if (!m.has(n)) m.set(n, rec);
  }
  return m;
}

/** Look a scanned code up exactly first, then normalised. Null when genuinely unknown. */
export function findProduct(map, code) {
  return map.get(String(code)) || map.get(normBarcode(code)) || null;
}

/** Register a product created in the field so a rescan finds it this session. */
export function addLocalProduct(map, barcode, fields) {
  const rec = { barcode: String(barcode), brand: fields.brand || "",
                item: fields.item || "", sku: fields.sku || "" };
  map.set(rec.barcode, rec);
  map.set(normBarcode(rec.barcode), rec);
  return map;
}

export const SCAN_WINDOW_MS = 2500;

/** A barcode lingering in the viewfinder must not create a second row. */
export function shouldAcceptScan(last, code, now, windowMs = SCAN_WINDOW_MS) {
  if (!last) return true;
  return !(last.code === code && now - last.at < windowMs);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/catalog.test.mjs`
Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add core.js tests/catalog.test.mjs
git commit -m "feat: catalog lookup with barcode normalisation and scan de-duplication"
```

---

## Task 4: core.js — the outbox (undo window and offline queue)

This is the trickiest logic in M1, so it is fully isolated and fully tested before any UI touches it.

A saved observation is **held** locally for `UNDO_MS` before it is sent. Undo simply drops a held entry — no backend delete is needed, and the API is append-only so no delete exists. After the window it becomes **sending**; on failure it becomes **queued** and is retried when the connection returns.

**Files:**
- Modify: `core.js` (append)
- Test: `tests/outbox.test.mjs`

**Interfaces:**
- Consumes: `makeId` from Task 2.
- Produces: `UNDO_MS`; `buildObs(input)` → the exact POST record; `outboxAdd(outbox, rec, now)`, `outboxUndo(outbox, obsId)`, `outboxDue(outbox, now, undoMs?)`, `outboxMark(outbox, obsId, state)`, `outboxRemove(outbox, obsId)`, `outboxPending(outbox)`. All are pure and return new arrays. An entry is `{rec, at, state}` with `state` in `"held" | "sending" | "queued"`.

- [ ] **Step 1: Write the failing test**

```js
// tests/outbox.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildObs, outboxAdd, outboxUndo, outboxDue, outboxMark,
         outboxRemove, outboxPending, UNDO_MS } from "../core.js";

const base = {
  obsId: "O-8FN3TR", ts: "2026-08-27T10:14:00.000Z", storeId: "S-7KM2QW",
  barcode: "8859141308566", price: 129, flag: "normal", by: "Ooa"
};

test("buildObs produces exactly the record the backend expects", () => {
  assert.deepEqual(buildObs(base), {
    type: "obs", obs_id: "O-8FN3TR", ts: "2026-08-27T10:14:00.000Z",
    store_id: "S-7KM2QW", barcode: "8859141308566", price: 129,
    flag: "normal", source: "scan", by: "Ooa"
  });
});

test("buildObs keeps the barcode a string", () => {
  assert.equal(typeof buildObs({ ...base, barcode: "0012345678905" }).barcode, "string");
});

test("buildObs attaches a new store and a new product only when given", () => {
  const plain = buildObs(base);
  assert.equal("new_store" in plain, false);
  assert.equal("new_product" in plain, false);
  const rich = buildObs({ ...base,
    newStore: { store_id: "S-AAA111", store: "ร้านเจ๊หงษ์" },
    newProduct: { brand: "", item: "ครีมใหม่", sku: "", photo: null } });
  assert.equal(rich.new_store.store, "ร้านเจ๊หงษ์");
  assert.equal(rich.new_product.item, "ครีมใหม่");
});

test("a new entry is held, not sent", () => {
  const ob = outboxAdd([], buildObs(base), 1000);
  assert.equal(ob.length, 1);
  assert.equal(ob[0].state, "held");
  assert.equal(outboxPending(ob), 1);
});

test("undo drops a held entry", () => {
  const ob = outboxAdd([], buildObs(base), 1000);
  assert.equal(outboxUndo(ob, "O-8FN3TR").length, 0);
});

test("undo cannot drop an entry that is already sending", () => {
  let ob = outboxAdd([], buildObs(base), 1000);
  ob = outboxMark(ob, "O-8FN3TR", "sending");
  assert.equal(outboxUndo(ob, "O-8FN3TR").length, 1);
});

test("an entry becomes due only after the undo window", () => {
  const ob = outboxAdd([], buildObs(base), 1000);
  assert.equal(outboxDue(ob, 1000 + UNDO_MS - 1).length, 0);
  assert.equal(outboxDue(ob, 1000 + UNDO_MS).length, 1);
});

test("a queued entry is not re-collected by outboxDue", () => {
  let ob = outboxAdd([], buildObs(base), 1000);
  ob = outboxMark(ob, "O-8FN3TR", "queued");
  assert.equal(outboxDue(ob, 999999).length, 0);
});

test("a sent entry is removed and stops counting as pending", () => {
  const ob = outboxRemove(outboxAdd([], buildObs(base), 1000), "O-8FN3TR");
  assert.equal(ob.length, 0);
  assert.equal(outboxPending(ob), 0);
});

test("the outbox survives a JSON round trip", () => {
  const ob = outboxAdd([], buildObs(base), 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(ob)), ob);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/outbox.test.mjs`
Expected: FAIL — `buildObs is not a function`.

- [ ] **Step 3: Append the implementation to `core.js`**

```js
/** Seconds an entry is held locally so it can be undone before it is sent. */
export const UNDO_MS = 6000;

/** Build the exact observation record the Apps Script backend expects. */
export function buildObs({ obsId, ts, storeId, barcode, price, flag,
                           by, source = "scan", newStore, newProduct }) {
  const rec = {
    type: "obs", obs_id: obsId, ts, store_id: storeId,
    barcode: String(barcode), price, flag, source, by
  };
  if (newStore) rec.new_store = newStore;
  if (newProduct) rec.new_product = newProduct;
  return rec;
}

export function outboxAdd(outbox, rec, now) {
  return [...outbox, { rec, at: now, state: "held" }];
}

/** Undo only ever cancels something still held. Once sending, it is gone. */
export function outboxUndo(outbox, obsId) {
  return outbox.filter(e => !(e.rec.obs_id === obsId && e.state === "held"));
}

/** Held entries whose undo window has expired and which should now be sent. */
export function outboxDue(outbox, now, undoMs = UNDO_MS) {
  return outbox.filter(e => e.state === "held" && now - e.at >= undoMs);
}

export function outboxMark(outbox, obsId, state) {
  return outbox.map(e => e.rec.obs_id === obsId ? { ...e, state } : e);
}

export function outboxRemove(outbox, obsId) {
  return outbox.filter(e => e.rec.obs_id !== obsId);
}

/** Everything not yet confirmed by the server — shown to the user as pending. */
export function outboxPending(outbox) {
  return outbox.length;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/outbox.test.mjs`
Expected: 10 tests pass.

- [ ] **Step 5: Run the whole suite**

Run: `node --test tests/*.test.mjs`
Expected: all tests from Tasks 1–4 pass.

- [ ] **Step 6: Commit**

```bash
git add core.js tests/outbox.test.mjs
git commit -m "feat: outbox with undo window and offline queue"
```

---

## Task 4B: Apps Script v5 — idempotent writes, batching, delta

The client work in Task 8 depends on this. Review of the real v4 turned up three defects that matter
in the field and one free win.

**Defect 1 — retries create duplicate rows.** `doPost` appends unconditionally. When a POST reaches
the Sheet but the response is lost on the way back — precisely what a weak signal does — the client
sees failure, re-queues, retries, and a second identical row lands. `obs_id` is already generated
client-side, so the backend can recognise the repeat. Without this fix, "zero duplicate rows" in the
release gate cannot be honestly claimed.

**Defect 2 — an unknown `type` silently succeeds.** If `d.type` is neither `obs` nor `tunsong`,
v4 falls through every branch, writes nothing, and still returns `{ok:true}` (`code.gs:141-152`).
The client marks the row sent and discards it. That is silent data loss.

**Defect 3 — the new-product check misses zero-padded barcodes.** `code.gs:130-131` compares
`String(d.barcode)` against the raw column values. The Sheet holds numbers, so a 12-digit UPC-A is
`773602335374`; a phone reporting `0773602335374` does not match, and a **duplicate Products row** is
appended. Task 3 fixes the client side; this fixes the backend so it holds even if some other client
sends the padded form. The same mismatch also makes `viewdata` silently drop those observations
(`code.gs:89-90` returns early when the barcode does not resolve), so field prices would vanish from
analysis without any error.

**Free win — `bootstrap` already reads columns A–J** but emits only five fields. Appending `size` and
`unit` **at the end** of each row costs nothing, keeps every existing index valid so the old client
keeps working, and saves a second deployment round when M2 needs them.

**Files:**
- Modify: `code.gs`

**Interfaces:**
- Produces: `GET ?action=delta&after=<n>` → `{ok, n, p: [[barcode, brand, item, sku], ...]}` where `n`
  is the new total product count. `POST {type:"batch", items:[...]}` → `{ok, results:[{id, status}]}`
  with `status` in `"written" | "duplicate" | "unknown_type"`. Single-record POSTs keep working
  exactly as before.

- [ ] **Step 1: Add the shared helpers**

```js
const SEQ_COL = 15;              // Products column O — monotonic append counter
const RECENT_OBS_WINDOW = 300;   // fallback only; the cache is the real retry guard
const OBS_CACHE_SEC = 21600;     // 6h — far longer than any realistic retry

/** Match the client's normalisation: digits only, no leading zeros. */
function normBarcode(v) {
  return String(v == null ? "" : v).replace(/\D/g, "").replace(/^0+/, "");
}
```

- [ ] **Step 1b: Add the `seq` column and its one-time backfill**

`seq` is what makes sorting harmless. It is stamped once per product at append time and never
changes, so a sorted tab still reports exactly the same new rows.

```js
/**
 * One-time setup. Run manually from the Apps Script editor, once, before deploying v5.
 * Safe to run again — rows that already carry a seq keep it.
 */
function backfillSeq() {
  const ps = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Products");
  const last = ps.getLastRow();
  if (last < 2) return;
  ps.getRange(1, SEQ_COL).setValue("seq");
  const cur = ps.getRange(2, SEQ_COL, last - 1, 1).getValues();
  const out = cur.map(function (r, i) { return [Number(r[0]) || (i + 1)]; });
  ps.getRange(2, SEQ_COL, last - 1, 1).setValues(out);
  Logger.log("stamped " + out.length + " products");
}

/** Highest seq in use. Read once per request, never per record. */
function maxSeq(ps) {
  const last = ps.getLastRow();
  if (last < 2) return 0;
  const v = ps.getRange(2, SEQ_COL, last - 1, 1).getValues();
  let m = 0;
  for (let i = 0; i < v.length; i++) { const n = Number(v[i][0]) || 0; if (n > m) m = n; }
  return m;
}
```

- [ ] **Step 1c: Add the restore-order menu**

Sorting is now harmless, so this is a convenience rather than a repair — but people do want the
master back in its original order after sorting to look something up.

```js
function onOpen() {
  SpreadsheetApp.getUi().createMenu("Price Scout")
    .addItem("เรียงลำดับสินค้ากลับเป็นเดิม", "restoreProductOrder")
    .addToUi();
}

function restoreProductOrder() {
  const ui = SpreadsheetApp.getUi();
  const ps = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Products");
  const last = ps.getLastRow(), cols = ps.getLastColumn();
  if (last < 3) { ui.alert("ไม่มีข้อมูลให้เรียง"); return; }
  ps.getRange(2, 1, last - 1, cols).sort({ column: SEQ_COL, ascending: true });
  ui.alert("เรียงลำดับสินค้ากลับเป็นเดิมแล้ว (" + (last - 1) + " รายการ)");
}
```

`onOpen` installs the menu the next time the Sheet is opened.

- [ ] **Step 2: Add the delta endpoint**

Identifying new products by row position is exact and cheap — it reads only the new rows, never all
26,289 — and it sidesteps the date problem entirely (the seed's `first_seen` is the same day the
snapshot was built, so a date cutoff would return the whole catalog).

```js
/**
 * Products whose seq is above the caller's. Order-independent by construction: sorting the
 * tab moves rows around but never changes a seq, so the same set comes back either way.
 * Reads one column, then only the rows that actually qualify — usually none.
 */
function delta(afterSeq) {
  const ps = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Products");
  const last = ps.getLastRow();
  if (last < 2) return json({ ok: true, seq: 0, p: [] });

  const seqs = ps.getRange(2, SEQ_COL, last - 1, 1).getValues();
  const after = Number(afterSeq || 0);
  let top = 0;
  const rows = [];
  for (let i = 0; i < seqs.length; i++) {
    const n = Number(seqs[i][0]) || 0;
    if (n > top) top = n;
    if (n > after) rows.push(i + 2);          // sheet row number
  }
  if (!rows.length) return json({ ok: true, seq: top, p: [] });

  const p = rows.map(function (rowNum) {
    const r = ps.getRange(rowNum, 1, 1, 4).getValues()[0];
    return [String(r[0]), r[1] || "", r[2] || "", r[3] || ""];
  });
  return json({ ok: true, seq: top, p: p });
}
```

Register it in `doGet`, beside the existing actions:

```js
if (action === "delta") return delta(e.parameter.after_seq);
```

- [ ] **Step 3: Add size and unit to bootstrap**

Modify the `products` mapping in `bootstrap()` (`code.gs:30-31`). The two new fields go **last** so
indexes 0–4 keep their meaning and the currently deployed page is unaffected.

```js
    products = v.map(r => [String(r[0]), r[1] || "", r[2] || "", r[3] || "",
      String(r[9] || "").replace(CDN_PREFIX, "~"), r[4] || "", r[5] || ""]).filter(r => r[0]);
```

Also return the current high-water mark, so a snapshot built from this response knows where delta
should start:

```js
  return json({ ok: true, cdn: CDN_PREFIX, seq: maxSeq(ps), p: products, s: stores });
```

- [ ] **Step 4: Rewrite doPost for batching and idempotency**

The lookups that v4 performed per record — all product barcodes, all store names — are hoisted into
a context built once per request. Writing 30 queued rows now costs one HTTP call and one set of
reads instead of thirty of each.

```js
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const d  = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const items = (d.type === "batch" && Array.isArray(d.items)) ? d.items : [d];
    const ctx = newWriteContext(ss);
    const results = items.map(function (item) { return writeOne(ss, item, ctx); });
    const bad = results.filter(function (r) { return r.status === "unknown_type"; });
    return json({ ok: bad.length === 0, results: results });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * Read the lookups once per request rather than once per record.
 *
 * Retry detection is cache-first. Scanning "the last N rows" would depend on Observations
 * still being in insertion order, which no one can guarantee — a sorted tab would hide a
 * retry and let a duplicate through. The cache does not care about order. The row scan is
 * kept only as a fallback for a cache eviction.
 */
function newWriteContext(ss) {
  const cache = CacheService.getScriptCache();
  const os = ss.getSheetByName("Observations");
  const last = os.getLastRow();
  const from = Math.max(2, last - RECENT_OBS_WINDOW);
  const recentIds = last > 1
    ? os.getRange(from, 1, last - from + 1, 1).getValues().flat().map(String)
    : [];

  const ps = ss.getSheetByName("Products");
  const codes = {};
  if (ps.getLastRow() > 1) {
    ps.getRange(2, 1, ps.getLastRow() - 1, 1).getValues()
      .forEach(function (r) { codes[normBarcode(r[0])] = true; });
  }

  const sh = ss.getSheetByName("Stores");
  const storeNames = sh.getLastRow() > 1
    ? sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues().flat().map(String)
    : [];

  return { cache: cache, recentIds: recentIds, codes: codes,
           storeNames: storeNames, nextSeq: maxSeq(ps) + 1 };
}

/** True when this obs_id has already been written. Cache first, row scan as a fallback. */
function alreadyWritten(ctx, id) {
  if (ctx.cache.get("obs:" + id)) return true;
  return ctx.recentIds.indexOf(id) >= 0;
}

function writeOne(ss, d, ctx) {
  const ts = d.ts ? new Date(d.ts) : new Date();

  if (d.new_store && d.new_store.store_id && d.new_store.store) {
    if (ctx.storeNames.indexOf(d.new_store.store) < 0) {
      ss.getSheetByName("Stores")
        .appendRow([d.new_store.store_id, d.new_store.store, "", "", "created from app"]);
      ctx.storeNames.push(d.new_store.store);
    }
  }

  if (d.new_product && d.barcode) {
    const key = normBarcode(d.barcode);          // zero-padded UPC-A no longer duplicates
    if (!ctx.codes[key]) {
      let img = "";
      if (d.new_product.photo) img = savePhoto(d.new_product.photo, "prod_" + key);
      const np = d.new_product;
      const hasNames = (np.brand || np.item);
      ss.getSheetByName("Products").appendRow(["'" + String(d.barcode), np.brand || "",
        np.item || "", np.sku || "", "", "", "", "", "", img,
        "field_scan", hasNames ? "" : "YES", ts, "", ctx.nextSeq++]);
      ctx.codes[key] = true;
    }
  }

  if (d.type === "obs") {
    const id = d.obs_id || ("O-" + ts.getTime());
    if (alreadyWritten(ctx, id)) return { id: id, status: "duplicate" };
    ss.getSheetByName("Observations").appendRow([id, ts, d.store_id || "",
      "'" + String(d.barcode || ""), d.price, d.flag || "normal",
      d.source || "scan", d.by || ""]);
    ctx.recentIds.push(id);
    ctx.cache.put("obs:" + id, "1", OBS_CACHE_SEC);
    return { id: id, status: "written" };
  }

  if (d.type === "tunsong") {
    const tid = d.ts_id || ("T-" + ts.getTime());
    ss.getSheetByName("Tunsong").appendRow([tid, ts, d.store_id || "",
      "'" + String(d.barcode || ""), d.price, d.info_source || "",
      d.confidence || "", d.notes || ""]);
    return { id: tid, status: "written" };
  }

  return { id: d.obs_id || d.ts_id || "", status: "unknown_type" };
}
```

Update the header comment at the top of `code.gs` from v4 to v5 and note what changed.

- [ ] **Step 5: Hand the file to the user and wait for deployment**

The agent cannot deploy this. Tell the user, in these words:

> `code.gs` is updated to v5. Three steps, in this order:
>
> 1. Open the Apps Script editor bound to the Sheet, select all, paste the new file, Save.
> 2. **Run `backfillSeq` once** from the editor's function dropdown. It stamps every existing
>    product with a sequence number in the new column O and takes a few seconds. Nothing else works
>    until this has run. Authorise it if prompted.
> 3. **Deploy → Manage deployments → ✏️ edit → Version: New version → Deploy.**
>    Do not use "New deployment" — it changes the URL and breaks both pages.
>
> Then reopen the Sheet once: a **Price Scout** menu appears with "เรียงลำดับสินค้ากลับเป็นเดิม",
> which restores the product master to its original order after anyone has sorted it.

- [ ] **Step 6: Verify the deployed backend from the command line**

```bash
BASE="https://script.google.com/macros/s/AKfycbz0PQVtM46QOMu7aWOKV56Q-A3R6Fp45V42sBslG1AhZfQ_S3RyQGOg1Zp5toMgQtyaGg/exec"

# curl MUST use -L and MUST NOT use -X POST. /exec answers a POST with a 302; a browser's
# fetch downgrades to GET when following it, and curl only does the same if the method was
# not forced. With -X POST (or --post302) curl re-POSTs to the redirect target and Google
# answers with an HTML "ไม่พบเพจ" page — while doPost has ALREADY run and written the row.

# delta at the current high-water mark returns nothing new, and reports that mark
SEQ=$(curl -sL --max-time 120 "$BASE?action=bootstrap" | python3 -c "import json,sys; print(json.load(sys.stdin)['seq'])")
echo "current seq: $SEQ"
curl -sL --max-time 120 "$BASE?action=delta&after_seq=$SEQ" | head -c 200

# bootstrap now carries 7 fields per product, size and unit last
curl -sL --max-time 120 "$BASE?action=bootstrap" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['p'][0]), d['p'][0])"

# idempotency: the same obs_id twice must write exactly one row
ID="O-TEST$RANDOM"
BODY="{\"type\":\"obs\",\"obs_id\":\"$ID\",\"ts\":\"2026-08-27T10:00:00.000Z\",\"store_id\":\"S-XAJI0Y\",\"barcode\":\"8857128940075\",\"price\":1,\"flag\":\"normal\",\"source\":\"manual\",\"by\":\"test\"}"
curl -sL --max-time 90 -H "Content-Type: text/plain" -d "$BODY" "$BASE"; echo
curl -sL --max-time 90 -H "Content-Type: text/plain" -d "$BODY" "$BASE"; echo

# an unknown type must now report failure instead of silently succeeding
curl -sL --max-time 90 -H "Content-Type: text/plain" -d '{"type":"nonsense"}' "$BASE"; echo
```

Expected: `seq` is 26289, `delta` returns `{"ok":true,"seq":26289,"p":[]}`, and bootstrap rows have
7 fields. The first POST returns `"status":"written"`, **the second returns `"status":"duplicate"`**,
and the Sheet holds exactly one `O-TEST…` row. The nonsense POST returns `"ok":false`.

- [ ] **Step 6b: Prove sorting cannot break anything**

This is the whole point of the `seq` column, so verify it rather than assume it.

1. In the Sheet, sort the **Products** tab by column B (brand), ascending — a realistic thing for
   someone to do while looking something up
2. Re-run `curl -sL --max-time 120 "$BASE?action=delta&after_seq=$SEQ"` — it must still return `"p":[]`, not a pile
   of rows it now believes are new
3. Sort the **Observations** tab by column E (price) and re-POST the duplicate `obs_id` from Step 6 —
   it must still answer `"status":"duplicate"`
4. Use **Price Scout → เรียงลำดับสินค้ากลับเป็นเดิม** and confirm Products returns to its original
   order, with row 2 back to barcode `8857128940075`

**Delete the test row from the Observations tab afterwards.**

- [ ] **Step 7: Commit**

```bash
git add code.gs
git commit -m "feat(backend): v5 — idempotent writes, batch POST, delta endpoint, size/unit"
```

---

## Task 5: App shell — store screen, persisted store, catalog from the static snapshot

Replaces `index.html` entirely. At the end of this task the app loads the catalog fast and remembers the store; there is no camera yet.

**Files:**
- Modify: `index.html` (full rewrite)
- Reference: `viewer.html:191-203` for the IndexedDB helper, copied verbatim

**Interfaces:**
- Consumes: `decodeCatalog`, `findProduct`, `addLocalProduct`, `makeId` from `core.js`.
- Produces: globals used by later tasks — `S` (app state), `$(id)`, `toast(msg, isError)`, `cacheGet(k)`, `cacheSet(k, v)`, `PRODUCTS` (the `Map` from `decodeCatalog`).

- [ ] **Step 1: Write the page head, tokens, and store screen**

Create `index.html` with `<html lang="th">`, the viewport meta from the old file, the Google Fonts link for Noto Sans Thai + IBM Plex Mono, `<link rel="manifest" href="manifest.webmanifest">`, and the CSS custom properties from Global Constraints. Carry over the `header`, `.store-chip`, `.card`, `.tin`, `.recent-stores`, `.big-btn`, `#toast` and `footer` rules from the old `index.html:11-96` unchanged — they are good and already match the design system. Markup for the store screen is unchanged from `index.html:109-115`.

- [ ] **Step 2: Add the module script with state, IndexedDB, and catalog loading**

```html
<script type="module">
import { decodeCatalog, findProduct, addLocalProduct, makeId } from "./core.js";

const API_URL = "https://script.google.com/macros/s/AKfycbz0PQVtM46QOMu7aWOKV56Q-A3R6Fp45V42sBslG1AhZfQ_S3RyQGOg1Zp5toMgQtyaGg/exec";
const CATALOG_URL = "data/catalog.json";

const $ = id => document.getElementById(id);
const S = { store: null, storeId: null, newStore: null, stores: [], recent: [] };
let PRODUCTS = new Map();

// IndexedDB kv cache — same shape as viewer.html so both pages share the db.
function idb(mode, fn){ return new Promise(res=>{
  const r = indexedDB.open('pricescout', 1);
  r.onupgradeneeded = e => e.target.result.createObjectStore('kv');
  r.onerror = () => res(null);
  r.onsuccess = e => { try{
    const tx = e.target.result.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    req.onsuccess = () => res(req.result ?? true);
    req.onerror = () => res(null);
  }catch(err){ res(null) } };
});}
const cacheGet = k => idb('readonly', st => st.get(k));
const cacheSet = (k, v) => idb('readwrite', st => st.put(v, k));

const ls = {
  get(k, d){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d } catch(e) { return d } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)) } catch(e) {} }
};

async function loadCatalog(){
  const cached = await cacheGet('catalog');
  if (cached) {
    PRODUCTS = decodeCatalog(cached);
    setStatus(`พร้อมใช้งาน · ${PRODUCTS.size.toLocaleString()} สินค้า`);
    return;
  }
  setStatus('กำลังโหลดฐานข้อมูลสินค้าครั้งแรก…', true);
  try {
    const res = await fetch(CATALOG_URL);
    const json = await res.json();
    PRODUCTS = decodeCatalog(json);
    await cacheSet('catalog', json);
    setStatus(`พร้อมใช้งาน · ${PRODUCTS.size.toLocaleString()} สินค้า`);
  } catch (e) {
    setStatus('โหลดฐานข้อมูลไม่สำเร็จ — ลองใหม่เมื่อมีสัญญาณ');
  }
}

function setStatus(msg, spinning){
  $('status').textContent = msg;
  $('loadSpin').style.display = spinning ? '' : 'none';
}
</script>
```

- [ ] **Step 3: Add store selection with persistence**

```js
function restoreStore(){
  S.recent = ls.get('ps_recent', []);
  S.stores = ls.get('ps_stores', []);
  const saved = ls.get('ps_store', null);   // NEW in v2: the store survives a reload
  if (saved) { applyStore(saved.name, saved.id); return true; }
  return false;
}

function setStore(){
  const name = $('storeInput').value.trim();
  if (!name) return;
  const known = S.stores.find(s => s.name === name);
  if (known) { applyStore(name, known.id); }
  else {
    const id = makeId('S');
    S.stores.push({ id, name });
    ls.set('ps_stores', S.stores);
    S.newStore = { store_id: id, store: name };  // sent with the next observation
    applyStore(name, id);
  }
}

function applyStore(name, id){
  S.store = name; S.storeId = id;
  ls.set('ps_store', { name, id });
  S.recent = [name, ...S.recent.filter(s => s !== name)].slice(0, 8);
  ls.set('ps_recent', S.recent);
  $('storeChipName').textContent = name;
  $('storeChip').classList.remove('empty');
  $('storeScreen').classList.add('hidden');
  $('captureScreen').classList.remove('hidden');
}
```

Wire `restoreStore()` and `loadCatalog()` into startup, and expose the handlers the markup calls with `window.setStore = setStore` and friends — a module script does not create globals automatically. **This is the single most common way this rewrite breaks:** `onclick="setStore()"` in HTML cannot see a module-scoped function.

- [ ] **Step 4: Verify in a browser**

Run: `python3 -m http.server 8080` then open `http://localhost:8080` in Chrome with device emulation set to a phone.

Check each of these:
1. First load shows "กำลังโหลดฐานข้อมูลสินค้าครั้งแรก…" then "พร้อมใช้งาน · 26,289 สินค้า"
2. In DevTools → Application → IndexedDB → `pricescout` → `kv`, a `catalog` key exists
3. Reload — the catalog message appears immediately with no network request for `catalog.json` (confirm in the Network tab)
4. Pick a store, then reload — **the store screen does not reappear** and the chip still shows the store name
5. The Console is clean. Any "already declared" error means a forbidden global name from Global Constraints was used.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: v2 shell with static catalog, IndexedDB cache, persisted store"
```

---

## Task 6: Continuous scanner

The core of the milestone. The camera starts once and **never stops between items**.

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `shouldAcceptScan`, `SCAN_WINDOW_MS` from `core.js`; `S`, `$`, `toast` from Task 5.
- Produces: `startCamera()`, `stopCamera()`, and calls `onScan(code)` — implemented in Task 7 — for every accepted barcode.

- [ ] **Step 1: Add the viewfinder markup and styles**

A `<video id="cam" playsinline muted>` filling a 16:9 rounded container at the top of the capture screen, with an overlay: a wide horizontal reticle (barcodes are wide, not square), a torch button top-right, and a "พิมพ์เลขเอง" button that reveals the manual `<input>`.

- [ ] **Step 2: Implement detection with the native API and a fallback**

```js
let stream = null, detector = null, scanTimer = null, lastScan = null, scanning = false;

async function startCamera(){
  if (scanning) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }
    });
  } catch (e) { toast('เปิดกล้องไม่ได้ — พิมพ์เลขแทน', true); showManualEntry(); return; }

  const video = $('cam');
  video.srcObject = stream;
  await video.play();
  scanning = true;
  updateTorchButton();

  if ('BarcodeDetector' in window) {
    detector = new BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128']
    });
    scanTimer = setInterval(pollNative, 200);
  } else {
    startFallbackScanner();
  }
}

async function pollNative(){
  if (!scanning || $('cam').readyState < 2) return;
  try {
    const found = await detector.detect($('cam'));
    if (found.length) handleDetection(found[0].rawValue);
  } catch (e) { /* transient decode failures are normal */ }
}

function handleDetection(raw){
  const code = String(raw).trim();
  if (!code) return;
  const now = Date.now();
  if (!shouldAcceptScan(lastScan, code, now)) return;
  lastScan = { code, at: now };
  if (navigator.vibrate) navigator.vibrate(30);
  onScan(code);
}

function stopCamera(){
  scanning = false;
  clearInterval(scanTimer);
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
}
```

The camera is **not** stopped in `handleDetection`. That omission is the entire point of this task — the old page called `stopCam()` on every hit ([index.html:268](index.html#L268)) and paid a cold start per product.

- [ ] **Step 3: Add the html5-qrcode fallback and the small helpers**

Safari before 17 has no `BarcodeDetector`. The fallback owns its own video element, so hide ours and
show its container. Every result goes through `handleDetection`, so de-duplication behaves
identically on both paths.

```js
let fallback = null;

function startFallbackScanner(){
  const tag = document.createElement('script');
  tag.src = 'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js';
  tag.onload = () => {
    $('cam').classList.add('hidden');
    $('reader').classList.remove('hidden');
    fallback = new Html5Qrcode('reader');
    fallback.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 120 } },   // wide box: EAN-13 is wide, not square
      txt => handleDetection(txt),
      () => {}
    ).catch(() => { toast('เปิดกล้องไม่ได้ — พิมพ์เลขแทน', true); showManualEntry(); });
  };
  tag.onerror = () => { toast('โหลดตัวสแกนไม่สำเร็จ — พิมพ์เลขแทน', true); showManualEntry(); };
  document.head.appendChild(tag);
}

function showManualEntry(){
  $('manualRow').classList.remove('hidden');
  $('codeInput').focus();
}

function updateTorchButton(){
  const cap = stream?.getVideoTracks()[0]?.getCapabilities?.();
  $('torchBtn').classList.toggle('hidden', !cap?.torch);
}
```

`stopCamera()` must also stop the fallback — add `if (fallback) { fallback.stop().catch(() => {}); fallback = null; }`.

The manual input calls `handleDetection($('codeInput').value)` on Enter, so a typed barcode takes the
identical path as a scanned one.

- [ ] **Step 4: Add torch and lifecycle handling**

```js
async function toggleTorch(){
  const track = stream?.getVideoTracks()[0];
  if (!track?.getCapabilities?.().torch) { toast('เครื่องนี้ไม่มีไฟฉายในกล้อง', true); return; }
  const on = !track.getSettings().torch;
  await track.applyConstraints({ advanced: [{ torch: on }] });
  $('torchBtn').classList.toggle('on', on);
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else if (S.storeId) startCamera();
});
```

- [ ] **Step 5: Verify on a real phone**

The desktop browser cannot validate this. Commit, wait for GitHub Pages, and open the live URL on the phone.

1. The camera opens once, when the store is chosen
2. Scan a product — it registers, **and the viewfinder keeps running**
3. Scan five different products back to back without touching the screen between them
4. Hold one barcode in frame for ten seconds — it registers **exactly once**
5. The torch button turns the light on and off
6. Switch to another app and back — the camera resumes on its own
7. On an iPhone, confirm which path ran: `'BarcodeDetector' in window` in the console tells you whether the fallback is carrying the load

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: continuous scanning with BarcodeDetector and html5-qrcode fallback"
```

---

## Task 7: Capture — product card, price tag, flags, save

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `priceKey`, `priceValue`, `buildObs`, `makeId`, `findProduct`, `addLocalProduct` from `core.js`; `PRODUCTS`, `S` from Task 5; called by `handleDetection` from Task 6.
- Produces: `DEVICE`, `onScan(code)`, `saveObservation()`, `resetItem()`, and temporary stubs for `pushToOutbox`, `addSessionRow`, `collectNewProduct`.

- [ ] **Step 0: Add `DEVICE` and the stubs this task calls**

Tasks 8 and 9 replace these. They exist now so Task 7 runs standalone and can be reviewed on its own.

```js
const DEVICE = "Ooa";   // who holds this phone; becomes entered_by

// replaced in Task 8
function pushToOutbox(rec){ console.log('outbox', rec); }
function addSessionRow(rec){ /* Task 8 */ }
// replaced in Task 9
function collectNewProduct(){
  return { brand: "", item: ($('newItem')?.value || "").trim(), sku: "", photo: S.photo || null };
}
```

- [ ] **Step 1: Implement `onScan`**

`findProduct` is used rather than a plain `Map.get` so a UPC-A scanned in its zero-padded form still
resolves — see Task 3. `S.code` is set to the **catalog's** barcode so the row written to the Sheet
matches the existing Products key.

```js
function onScan(code){
  const p = findProduct(PRODUCTS, code);
  S.code = p ? p.barcode : String(code);
  S.isNew = !p;
  if (p) showHit(p, S.code); else showMiss(S.code);
  S.price = ''; S.flag = 'normal';
  renderPrice(); renderFlags();
  $('priceCard').classList.remove('hidden');
}
```

- [ ] **Step 2: Render the product and the price tag**

The hit card carries the green left border and shows brand, item, sku; the image slot stays empty until Task 10 fills it. The price tag is the orange rounded tag with the punch-hole dot from `index.html:65-73`, unchanged — it is the app's signature element.

```js
function renderPrice(){
  $('amt').textContent = S.price || '0';
  $('amt').classList.toggle('empty', !S.price);
  $('saveBtn').disabled = priceValue(S.price) === null;
}
function key(k){ S.price = priceKey(S.price, k); renderPrice(); }
```

Wire the keypad buttons to `key('1')` … `key('0')`, `key('.')`, `key('back')`, and expose `window.key = key`.

- [ ] **Step 3: Add physical keyboard support**

```js
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (/^[0-9]$/.test(e.key)) key(e.key);
  else if (e.key === '.') key('.');
  else if (e.key === 'Backspace') key('back');
  else if (e.key === 'Enter' && priceValue(S.price) !== null) saveObservation();
});
```

- [ ] **Step 4: Implement save**

```js
function saveObservation(){
  const price = priceValue(S.price);
  if (price === null) return;
  const rec = buildObs({
    obsId: makeId('O'), ts: new Date().toISOString(), storeId: S.storeId,
    barcode: S.code, price, flag: S.flag, by: DEVICE,
    newStore: S.newStore || undefined,
    newProduct: S.isNew ? collectNewProduct() : undefined
  });
  S.newStore = null;
  if (S.isNew) addLocalProduct(PRODUCTS, S.code, collectNewProduct());
  pushToOutbox(rec);            // Task 8
  addSessionRow(rec);           // Task 8
  toast(`บันทึกแล้ว · ฿${price}`);
  resetItem();
}
```

`resetItem()` clears the price, flags, hit and miss cards and hides `#priceCard`, leaving the viewfinder live and ready for the next barcode. It must **not** touch the camera.

- [ ] **Step 5: Verify on a phone**

1. Scan a known product — brand, item and sku appear, and the price tag shows `0`
2. Tap `1`, `2`, `9` — the tag reads `129` and บันทึกราคา becomes enabled
3. Save — a toast appears, the cards clear, and the camera is still live
4. Scan the next product without touching anything else
5. Count the taps for one known item: **three digits plus save. Four.**
6. On a laptop, type `129` and press Enter — it saves

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat: capture loop — product card, price tag, flags, save"
```

---

## Task 8: Session list, undo, and sending

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: the full outbox API from Task 4, and the batch POST endpoint from Task 4B.
- Produces: `pushToOutbox(rec)`, `addSessionRow(rec)`, `removeSessionRow(obsId)`, `undoEntry(obsId)`, `flushOutbox()`. These replace the Task 7 stubs.

- [ ] **Step 1: Persist and drive the outbox**

```js
let OUTBOX = ls.get('ps_outbox', []);
const persist = () => ls.set('ps_outbox', OUTBOX);

function pushToOutbox(rec){
  OUTBOX = outboxAdd(OUTBOX, rec, Date.now());
  persist(); renderPending();
}

// Everything due goes in ONE request. Coming back from a shop with 30 queued rows is
// one round trip, not thirty.
async function flushOutbox(force){
  const due = force ? OUTBOX.filter(e => e.state !== 'sending')
                    : outboxDue(OUTBOX, Date.now());
  if (!due.length) return;
  const ids = due.map(e => e.rec.obs_id);
  ids.forEach(id => { OUTBOX = outboxMark(OUTBOX, id, 'sending'); });
  persist();
  try {
    const res = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ type: 'batch', items: due.map(e => e.rec) })
    });
    const d = await res.json();
    if (!d.ok) throw new Error('backend rejected');
    for (const r of d.results) {
      // "duplicate" means a previous attempt did land — the row is safely in the Sheet,
      // so it is done, not failed. This is what makes retrying over a bad signal safe.
      if (r.status === 'written' || r.status === 'duplicate') OUTBOX = outboxRemove(OUTBOX, r.id);
      else OUTBOX = outboxMark(OUTBOX, r.id, 'queued');
    }
  } catch (e) {
    ids.forEach(id => { OUTBOX = outboxMark(OUTBOX, id, 'queued'); });
  }
  persist(); renderPending();
}

setInterval(() => flushOutbox(false), 2000);
window.addEventListener('online', () => flushOutbox(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) flushOutbox(true); });
```

Flushing when the page hides is what stops a held entry from being lost if the app is closed inside the undo window.

- [ ] **Step 2: Render the session list with undo**

A collapsible list below the keypad: each row shows time, product name (or the barcode for an unknown one), price and flag. A row still `held` shows a เลิกทำ button; once it is sending or sent the button is replaced by a quiet "ส่งแล้ว". The footer shows `รอส่ง N` whenever `outboxPending(OUTBOX)` is above zero.

Each session row is rendered with `data-obs="<obs_id>"` so it can be pulled out again:

```js
function removeSessionRow(obsId){
  document.querySelector(`#sessionList [data-obs="${obsId}"]`)?.remove();
}

function undoEntry(obsId){
  const before = OUTBOX.length;
  OUTBOX = outboxUndo(OUTBOX, obsId);
  persist();
  if (OUTBOX.length === before) { toast('ส่งไปแล้ว — แก้ใน Sheet', true); return; }
  removeSessionRow(obsId);
  renderPending();
  toast('ยกเลิกรายการแล้ว');
}
```

- [ ] **Step 3: Verify on a phone**

1. Save an entry — it appears in the session list with เลิกทำ
2. Tap เลิกทำ within six seconds — the row disappears and **the row never reaches the Sheet** (check the Sheet)
3. Save another and wait ten seconds — เลิกทำ is gone and the row **is** in the Sheet
4. Turn on airplane mode, save three entries — the footer shows `รอส่ง 3`
5. Turn the connection back on — the count falls to zero, **one** POST goes out carrying all three
   (check the Network tab), and all three rows are in the Sheet, once each
6. Save an entry, then close the tab immediately, reopen, and confirm the entry still sends
7. **Retry safety:** with DevTools throttling set to offline mid-flight, force a send so the request
   leaves but the response never returns; reconnect and let it retry. The Sheet must hold **exactly
   one** row for that `obs_id` — this is Task 4B's idempotency doing its job

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: session list, undo window, resilient sending"
```

---

## Task 9: Unknown product — one-tap capture

The field rule from the PRD: **there is no time to type details.** The price is what matters.

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `S`, `shrink` (carried over from `index.html:372-383`).
- Produces: `collectNewProduct()` → `{brand: "", item, sku: "", photo}`.

- [ ] **Step 1: Replace the three-field miss card with one hint field**

```html
<div class="card miss hidden" id="missCard">
  <div class="headline">สินค้าใหม่ — ยังไม่มีในระบบ</div>
  <input type="text" id="newItem" class="tin" placeholder="ชื่อสินค้า (ไม่ใส่ก็ได้)">
  <button class="chip-btn" style="width:100%;margin-top:8px" onclick="photoInput.click()">📷 ถ่ายรูปสินค้า</button>
  <input type="file" id="photoInput" accept="image/*" capture="environment" class="hidden" onchange="gotPhoto(this)">
  <div class="photo-thumb hidden" id="photoThumb">
    <img id="photoImg" alt=""><button class="rm" onclick="clearPhoto()">ลบรูป</button>
  </div>
  <div class="later-note">ใส่แค่ราคาก็บันทึกได้ — แอดมินจะเติมรายละเอียดให้ทีหลัง</div>
</div>
```

The brand and sku inputs and the brand `datalist` are deleted outright. Save is never blocked by an empty field.

```js
function collectNewProduct(){
  return { brand: "", item: $('newItem').value.trim(), sku: "", photo: S.photo || null };
}
```

The backend already sets `needs_info = YES` when no names are supplied, and saves the photo to Drive.

- [ ] **Step 2: Verify on a phone**

1. Scan a barcode that is not in the catalog — the amber card appears with one field
2. Type only a price and save. **One tap beyond the price.** The Sheet gets a Products row with `needs_info` = YES and an Observations row with the price
3. Scan another unknown, take a photo, save — the Products row has a `drive.google.com/thumbnail` URL in `image_url`
4. Rescan the barcode from step 2 in the same session — it is now recognised, not treated as new

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: one-tap capture for unknown products"
```

---

## Task 10: Lazy product images

Images are more than half the old payload and must never delay a scan.

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `cacheGet`, `cacheSet`, `PRODUCTS`.
- Produces: `imageFor(barcode)` → URL string or `""`.

- [ ] **Step 1: Load images after the app is usable**

```js
let IMAGES = null;   // { cdn, byBarcode: Map }

async function loadImagesLazily(catalogJson){
  const cached = await cacheGet('images');
  const src = cached || await fetch('data/images.json').then(r => r.json()).catch(() => null);
  if (!src) return;
  if (!cached) await cacheSet('images', src);
  const byBarcode = new Map();
  catalogJson.p.forEach((row, i) => {
    const compact = src.img[i];
    if (compact) byBarcode.set(row[0], compact.replace('~', src.cdn));
  });
  IMAGES = { byBarcode };
}

function imageFor(barcode){ return IMAGES?.byBarcode.get(barcode) || ""; }
```

Call it with `requestIdleCallback` (falling back to a `setTimeout` of 2000ms) **after** the first paint, and never `await` it during startup. If it never finishes, every other part of the app still works.

- [ ] **Step 2: Show the image when it is available**

In `showHit`, set the `<img>` only when `imageFor(code)` is non-empty; otherwise hide the element. Keep `onerror="this.style.visibility='hidden'"` — the Eveandboy CDN is hotlinked and can break.

- [ ] **Step 3: Verify**

1. Clear site data, load the page, and watch the Network tab: `catalog.json` loads first and the page becomes usable **before** `images.json` starts
2. Throttle to Slow 3G and confirm scanning works while images are still downloading
3. Scan a known product and confirm its photo appears

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: lazy product images off the critical path"
```

---

## Task 11: PWA — icons, manifest, service worker

**Files:**
- Create: `tools/make-icons.py`, `icons/icon-192.png`, `icons/icon-512.png`, `manifest.webmanifest`, `sw.js`
- Modify: `index.html`

**Interfaces:**
- Produces: an installable app that opens and scans with no network.

- [ ] **Step 1: Generate the icons**

This machine has no PIL, no ImageMagick and no rsvg, so the generator writes PNG bytes directly with
`zlib` and `struct` — no dependencies, nothing to install.

```python
# tools/make-icons.py — generate the PWA icons with no third-party libraries.
# Run once: python3 tools/make-icons.py
import zlib, struct, os

INK  = (0x17, 0x19, 0x1C, 255)   # --ink
TAG  = (0xFF, 0x7A, 0x1A, 255)   # --tag orange
HOLE = (0xFA, 0xF9, 0xF6, 255)   # --paper, for the punch hole

def make(path, size):
    px = [[INK] * size for _ in range(size)]
    x0, x1 = int(size * 0.16), int(size * 0.84)
    y0, y1 = int(size * 0.30), int(size * 0.70)
    r = int((y1 - y0) * 0.30)
    for y in range(y0, y1):
        for x in range(x0, x1):
            dx, dy = min(x - x0, x1 - 1 - x), min(y - y0, y1 - 1 - y)
            if dx < r and dy < r and (r - dx) ** 2 + (r - dy) ** 2 > r * r:
                continue                      # rounded corner
            px[y][x] = TAG
    cx, cy = x0 + int((x1 - x0) * 0.13), (y0 + y1) // 2
    hr = max(2, int(size * 0.035))
    for y in range(cy - hr, cy + hr + 1):
        for x in range(cx - hr, cx + hr + 1):
            if (x - cx) ** 2 + (y - cy) ** 2 <= hr * hr:
                px[y][x] = HOLE               # punch hole

    raw = b"".join(b"\x00" + bytes(v for p in row for v in p) for row in px)
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    blob = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))
    os.makedirs("icons", exist_ok=True)
    with open(path, "wb") as f:
        f.write(blob)
    print("wrote", path, f"{size}x{size}")

make("icons/icon-192.png", 192)
make("icons/icon-512.png", 512)
```

Run: `python3 tools/make-icons.py`
Expected: `icons/icon-192.png` and `icons/icon-512.png` exist. Open both and confirm they show the orange tag on the dark ground.

- [ ] **Step 2: Write the manifest**

```json
{
  "name": "Price Scout",
  "short_name": "Price Scout",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#FAF9F6",
  "theme_color": "#17191C",
  "icons": [
    { "src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}
```

- [ ] **Step 3: Write the service worker**

```js
// sw.js — cache the shell so the app opens with no signal.
const CACHE = 'pricescout-v1';
const SHELL = ['./', './index.html', './core.js', './manifest.webmanifest',
               './data/catalog.json', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;                 // never cache POSTs to the API
  if (url.origin !== self.location.origin) return;        // never cache the API or the CDN
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
```

**`CACHE` must be bumped to `pricescout-v2`, `-v3` and so on whenever the shell changes**, or phones will keep serving the old app forever. Note this in a comment.

- [ ] **Step 4: Register it**

```js
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
```

- [ ] **Step 5: Verify on a phone**

1. Open the live GitHub Pages URL, then "Add to Home Screen"
2. Launch from the home-screen icon — it opens with no browser chrome and the correct icon
3. **Switch on airplane mode and launch it.** The app opens, the catalog is there, and the camera scans. Saved rows show `รอส่ง`
4. Turn the connection back on — everything queued arrives in the Sheet
5. In DevTools → Application → Service Workers, confirm it is activated and running

- [ ] **Step 6: Commit**

```bash
git add tools/make-icons.py icons manifest.webmanifest sw.js index.html
git commit -m "feat: PWA — installable, opens and scans offline"
```

---

## Task 12: Catalog delta, manual refresh, and the release gate

**Files:**
- Modify: `index.html`
- Create: `Docs/SHOP-TEST-M1.md`

- [ ] **Step 1: Add the automatic delta check**

With Task 4B deployed this runs on every open. It reads only rows past the snapshot, so it costs a
few KB and finishes in well under a second — nothing like the 7.7-second full bootstrap. It fails
silently and by design: no signal simply means no new products this session.

```js
async function applyDelta(){
  const known = await cacheGet('catalog');
  if (!known) return;
  try {
    const d = await fetch(`${API_URL}?action=delta&after_seq=${known.seq || 0}`).then(r => r.json());
    if (!d.ok || !d.p.length) return;
    const merged = { v: known.v, n: known.n + d.p.length, seq: d.seq, p: known.p.concat(d.p) };
    PRODUCTS = decodeCatalog(merged);
    await cacheSet('catalog', merged);
    setStatus(`พร้อมใช้งาน · ${PRODUCTS.size.toLocaleString()} สินค้า (+${d.p.length} ใหม่)`);
  } catch (e) { /* offline is normal — the snapshot alone is enough to work */ }
}
```

Call it after `loadCatalog()`, never awaited before the first paint.

- [ ] **Step 1b: Keep a manual full refresh as the escape hatch**

A footer button, รีเฟรชข้อมูล, calling the live `?action=bootstrap` and rebuilding the catalog from
scratch. Needed when Products has been edited rather than appended — delta only sees new rows.

```js
async function refreshCatalog(){   // manual only — costs ~7.7s, never runs on open
  setStatus('กำลังรีเฟรชข้อมูลสินค้า…', true);
  try {
    const d = await fetch(API_URL + '?action=bootstrap').then(r => r.json());
    const json = { v: new Date().toISOString().slice(0, 10), n: d.p.length, seq: d.seq || 0,
                   p: d.p.map(r => [r[0], r[1], r[2], r[3]]) };
    PRODUCTS = decodeCatalog(json);
    await cacheSet('catalog', json);
    setStatus(`อัปเดตแล้ว · ${PRODUCTS.size.toLocaleString()} สินค้า`);
  } catch (e) { setStatus('รีเฟรชไม่สำเร็จ — ลองใหม่เมื่อมีสัญญาณ'); }
}
```

- [ ] **Step 2: Write the shop test checklist**

Create `Docs/SHOP-TEST-M1.md` holding the PRD §11 gate as a printable checklist with a place to write the timing: 20 consecutive known-item observations with the seconds for each, app cold-open time on a repeat visit, an offline capture run, a row-count reconciliation against the Sheet (captured = arrived, no duplicates, correct store on every row), and one unknown-barcode capture.

- [ ] **Step 3: Run the full test suite**

Run: `node --test tests/*.test.mjs`
Expected: every test from Tasks 1–4 passes.

- [ ] **Step 4: Commit**

```bash
git add index.html Docs/SHOP-TEST-M1.md
git commit -m "feat: manual catalog refresh + M1 shop test checklist"
```

- [ ] **Step 5: Run the shop test**

M1 is **not** complete when the code is written. It is complete when `Docs/SHOP-TEST-M1.md` has been filled in from a real TT shop and the median known-item observation is under six seconds with zero lost or duplicated rows. Record the numbers in that file and commit it.

---

## Notes for whoever executes this

- **Apps Script changes live in Task 4B only.** If any other task seems to need a backend change,
  stop — it belongs in v6 with M3. The user deploys `code.gs` by hand; no agent can do it.
- **Deploying is `git push`.** GitHub Pages serves `main` from the root and takes about a minute.
- **The phone is the only real test environment.** Desktop Chrome device emulation cannot validate the camera, the torch, install behaviour, or genuine offline start.
- **The repo is public.** Never commit prices, ทุนส่ง, or anything from the Sheet beyond the product catalog, which is already public retailer data.
