/**
 * PRICE SCOUT — backend v12
 *
 * Serves three static pages from one Sheet: index.html (phone capture), admin.html (desk
 * entry + product/store admin), viewer.html (analysis).
 *
 * DEPLOYING — keeps the same /exec URL, which every page has hard-coded:
 *   Editor → paste → Save → Deploy → Manage deployments → ✏️ → Version: New version → Deploy
 *   NEVER "New deployment" — that mints a new URL and breaks all three pages.
 *
 * ONE-TIME SETUP (already done; here for a rebuild from scratch):
 *   backfillSeq()             stamps Products column O with a monotonic seq
 *   installAnalysisTrigger()  nightly 03:00 buildAnalysis()
 *
 * TWO RULES THAT ARE NOT OBVIOUS AND HAVE EACH ALREADY CAUSED A BUG:
 *  1. Barcodes are stored as NUMBERS, so leading zeros are gone and a UPC-A may arrive as 12
 *     digits or as 13 with a leading zero. Compare through normBarcode(), never raw.
 *  2. Store names must be compared through storeKey(). "eveandboy" and "EVEANDBOY" once became
 *     two separate shops in live data.
 *
 * Nothing depends on row order: sorting any tab is harmless. Columns ARE read by position —
 * new columns go on the far right only.
 */


const CDN_PREFIX = "https://prodenbcdn.azureedge.net/products/";
const PHOTO_FOLDER = "PriceScout Photos";
const ANALYSIS_FILE = "pricescout-analysis.json";  // the one file buildAnalysis() writes/overwrites
// Images live in their OWN file, fetched by the viewer in the background after the page is
// already usable. Folded into the main payload they were 481KB gzipped of a 503KB response —
// a third of the wait, for pictures that are not needed to render a single result.
const IMAGES_FILE = "pricescout-images.json";
const SEQ_COL = 15;              // Products column O — monotonic append counter
const RECENT_OBS_WINDOW = 300;   // fallback only; the cache is the real retry guard
const OBS_CACHE_SEC = 21600;     // 6h — far longer than any realistic retry

/** Store names are matched case- and whitespace-insensitively: typing "eveandboy" must
 *  never create a second row beside "EVEANDBOY". */
function storeKey(name) {
  return String(name == null ? "" : name).trim().toLowerCase().replace(/\s+/g, " ");
}

/** Match the client's normalisation: digits only, no leading zeros. */
function normBarcode(v) {
  return String(v == null ? "" : v).replace(/\D/g, "").replace(/^0+/, "") || "0";
}

// I, L, O, 0, 1 excluded — easy to confuse with each other when copied onto a shelf label.
const STORE_ID_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** New Stores id in the project's existing "S-XXXXXX" format. */
function genStoreId() {
  let s = "";
  for (let i = 0; i < 6; i++) s += STORE_ID_CHARS.charAt(Math.floor(Math.random() * STORE_ID_CHARS.length));
  return "S-" + s;
}

/** One-time: stamps Products column O. Safe to re-run — existing seq values are kept. */
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

/* ================= Sheet menu ================= */
function onOpen() {
  SpreadsheetApp.getUi().createMenu("Price Scout")
    .addItem("เรียงลำดับสินค้ากลับเป็นเดิม", "restoreProductOrder")
    .addItem("อัปเดตข้อมูลวิเคราะห์", "runBuildAnalysis")
    .addToUi();
}

/** Menu + editor entry point for buildAnalysis(). */
function runBuildAnalysis() {
  const n = buildAnalysis();
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");
  const msg = "อัปเดตข้อมูลวิเคราะห์แล้ว: " + n + " รายการ (" + stamp + ")";
  Logger.log(msg);
  // getUi() throws when this is run from the editor's Run button rather than the Sheet menu —
  // and the editor is where people look for it. Log either way, alert only when there is a UI.
  try { SpreadsheetApp.getUi().alert(msg); } catch (err) {}
}

/** Restores the original Products order after someone sorts the tab. Convenience only —
 *  nothing depends on row order. */
function restoreProductOrder() {
  const ui = SpreadsheetApp.getUi();
  const ps = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Products");
  const last = ps.getLastRow(), cols = ps.getLastColumn();
  if (last < 3) { ui.alert("ไม่มีข้อมูลให้เรียง"); return; }
  ps.getRange(2, 1, last - 1, cols).sort({ column: SEQ_COL, ascending: true });
  ui.alert("เรียงลำดับสินค้ากลับเป็นเดิมแล้ว (" + (last - 1) + " รายการ)");
}

/* ================= GET ================= */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "";
  if (action === "summary") return summary();
  if (action === "images") return imagesPayload();
  if (action === "rebuild") return rebuild();
  if (action === "lookup") return lookup(e.parameter.barcode);
  if (action === "prices") return pricesEndpoint(e.parameter.barcode);
  if (action === "stores") return stores();
  if (action === "vocab") return vocab();
  if (action === "needsinfo") return needsInfo(e.parameter.limit);
  if (action === "psearch") return psearch(e.parameter.q, e.parameter.brand, e.parameter.limit);
  return json({ ok: true, msg: "Price Scout API v12" });
}

/** Every form a barcode may appear in, since the Sheet stores them as numbers. */
function barcodeForms(barcode) {
  const key = normBarcode(barcode);
  const forms = [String(barcode).trim(), key];
  if (key.length === 12) forms.push("0" + key);
  if (key.length === 13 && key.charAt(0) === "0") forms.push(key.substring(1));
  return forms.filter(function (v, i, a) { return v && a.indexOf(v) === i; });
}

/** First row in `col` of `sheet` whose text equals any of `forms`, or -1. */
function findRow(sheet, col, forms) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const range = sheet.getRange(2, col, last - 1, 1);
  for (let i = 0; i < forms.length; i++) {
    const hit = range.createTextFinder(forms[i]).matchEntireCell(true).findNext();
    if (hit) return hit.getRow();
  }
  return -1;
}

/** Product identity only — prices are a separate endpoint so the client can fetch both at
 *  once and show the name without waiting on a scan of every observation. */
function lookup(barcode) {
  if (!barcode) return json({ ok: true, found: false });
  const cache = CacheService.getScriptCache();
  const ck = "lk:" + normBarcode(barcode);
  const hit = cache.get(ck);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ps = ss.getSheetByName("Products");
  const forms = barcodeForms(barcode);

  const row = findRow(ps, 1, forms);
  if (row < 0) {
    const miss = JSON.stringify({ ok: true, found: false, barcode: String(barcode) });
    cache.put(ck, miss, 300);        // brief: an unknown barcode may be created moments later
    return ContentService.createTextOutput(miss).setMimeType(ContentService.MimeType.JSON);
  }

  const r = ps.getRange(row, 1, 1, 12).getValues()[0];
  const canonical = String(r[0]);

  const payload = JSON.stringify({ ok: true, found: true, cdn: CDN_PREFIX, p: {
    barcode: canonical, brand: r[1] || "", item: r[2] || "", sku: r[3] || "",
    size: r[4] || "", unit: r[5] || "",
    img: String(r[9] || "").replace(CDN_PREFIX, "~"),
    needs_info: r[11] === "YES"
  }});
  cache.put(ck, payload, 21600);
  return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
}

/** Prices for one barcode, fetched alongside the identity lookup rather than inside it. */
function pricesEndpoint(barcode) {
  if (!barcode) return json({ ok: true, prices: [] });
  const cache = CacheService.getScriptCache();
  const ck = "pr:" + normBarcode(barcode);
  const hit = cache.get(ck);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const payload = JSON.stringify({ ok: true, prices: pricesFor(ss, barcodeForms(barcode)) });
  cache.put(ck, payload, 600);       // short: a price captured now should show up soon
  return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
}

/** Latest price per store per flag for this barcode, newest first. */
function pricesFor(ss, forms) {
  const os = ss.getSheetByName("Observations");
  const last = os.getLastRow();
  if (last < 2) return [];
  const col = os.getRange(2, 4, last - 1, 1);

  const uniq = forms.filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  const rows = {};
  for (let i = 0; i < uniq.length; i++) {
    const found = col.createTextFinder(uniq[i]).matchEntireCell(true).findAll();
    for (let k = 0; k < found.length; k++) rows[found[k].getRow()] = true;
  }
  const rowNums = Object.keys(rows).map(Number).sort(function (a, b) { return b - a; });
  if (!rowNums.length) return [];

  // store_id -> {name, region, channel}
  const st = ss.getSheetByName("Stores");
  const smap = {};
  if (st.getLastRow() > 1) {
    st.getRange(2, 1, st.getLastRow() - 1, 4).getValues().forEach(function (v) {
      smap[String(v[0])] = { name: String(v[1] || v[0]),
                             region: String(v[2] || ""), channel: String(v[3] || "") };
    });
  }

  const tz = Session.getScriptTimeZone();
  const seen = {}, out = [];
  for (let i = 0; i < rowNums.length && out.length < 12; i++) {
    const v = os.getRange(rowNums[i], 1, 1, 8).getValues()[0];
    const sid = String(v[2] || ""), flag = String(v[5] || "normal");
    const dedupe = sid + "|" + flag;
    if (seen[dedupe]) continue;             // rows are newest-first, so the first wins
    seen[dedupe] = true;
    const meta = smap[sid] || { name: sid, region: "", channel: "" };
    out.push({ store: meta.name, region: meta.region, channel: meta.channel,
               price: Number(v[4]), flag: flag,
               date: (v[1] instanceof Date) ? Utilities.formatDate(v[1], tz, "yyyy-MM-dd")
                                            : String(v[1] || "").slice(0, 10) });
  }
  return out;
}

/** The store list. Tiny tab; the picker caches this and refreshes it on open. */
function stores() {
  const st = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Stores");
  if (st.getLastRow() < 2) return json({ ok: true, s: [] });
  const v = st.getRange(2, 1, st.getLastRow() - 1, 4).getValues();
  const s = v.filter(function (r) { return r[0] && r[1]; })
             .map(function (r) { return [String(r[0]), String(r[1]),
                                         String(r[2] || ""), String(r[3] || "")]; });
  return json({ ok: true, s: s });
}

/** Brand list + category tree for the admin dropdowns. Cached an hour; the scan touches
 *  every row and the vocabulary barely changes. */
function vocab() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get("vocab");
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);

  const ps = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Products");
  const last = ps.getLastRow();
  const brandSet = {}, tree = {};
  if (last > 1) {
    // B..I in one call covers brand (B) and the three category columns (G, H, I) together
    const v = ps.getRange(2, 2, last - 1, 8).getValues();
    v.forEach(function (r) {
      const brand = String(r[0] || "").trim();
      if (brand) brandSet[brand] = true;
      const c1 = String(r[5] || "").trim(), c2 = String(r[6] || "").trim(), c3 = String(r[7] || "").trim();
      if (!c1 || !c2) return;
      if (!tree[c1]) tree[c1] = {};
      if (!tree[c1][c2]) tree[c1][c2] = [];
      if (c3 && tree[c1][c2].indexOf(c3) < 0) tree[c1][c2].push(c3);
    });
  }
  Object.keys(tree).forEach(function (c1) {
    Object.keys(tree[c1]).forEach(function (c2) { tree[c1][c2].sort(); });
  });

  const payload = JSON.stringify({ ok: true, brands: Object.keys(brandSet).sort(), tree: tree });
  // Serving uncached beats failing the request if the vocabulary ever outgrows the ~100KB
  // per-key cache limit.
  try { cache.put("vocab", payload, 3600); } catch (err) {}
  return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
}

/**
 * The review queue: products still missing a brand, or explicitly flagged needs_info = YES.
 * Never cached — an admin who just fixed a row must see it drop off the very next fetch.
 */
function needsInfo(limitParam) {
  let limit = Number(limitParam) || 300;
  if (limit < 1) limit = 300;
  if (limit > 1000) limit = 1000;

  const ps = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Products");
  const last = ps.getLastRow();
  const tz = Session.getScriptTimeZone();
  const out = [];
  if (last > 1) {
    // Two narrow reads to decide WHICH rows qualify, then full rows for only those. Reading
    // all 14 columns of 21k+ products to find a handful was the slow part; brand (B) and
    // needs_info (L) are all the filter needs.
    const n = last - 1;
    const brands = ps.getRange(2, 2, n, 1).getValues();
    const flags  = ps.getRange(2, 12, n, 1).getValues();
    const rows = [];
    for (let i = 0; i < n && rows.length < limit; i++) {
      const needs = flags[i][0] === "YES";
      if (needs || !String(brands[i][0] || "").trim()) rows.push({ row: i + 2, needs: needs });
    }
    rows.forEach(function (hit) {
      const r = ps.getRange(hit.row, 1, 1, 13).getValues()[0];   // A..M
      if (!r[0]) return;
      out.push({
        barcode: String(r[0]), brand: r[1] || "", item: r[2] || "", sku: r[3] || "",
        size: r[4] || "", unit: r[5] || "", c1: r[6] || "", c2: r[7] || "", c3: r[8] || "",
        img: String(r[9] || "").replace(CDN_PREFIX, "~"),
        first_seen: (r[12] instanceof Date) ? Utilities.formatDate(r[12], tz, "yyyy-MM-dd") : String(r[12] || ""),
        needs_info: hit.needs
      });
    });
  }
  return json({ ok: true, cdn: CDN_PREFIX, p: out });
}

/** Free-text product search. Stops at `limit` rather than filtering the whole tab. */
function psearch(q, brandFilter, limitParam) {
  let limit = Number(limitParam) || 50;
  if (limit < 1) limit = 50;
  if (limit > 200) limit = 200;

  const needle = String(q || "").trim().toLowerCase();
  const bf = brandFilter ? String(brandFilter).trim().toLowerCase() : "";
  const ps = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Products");
  const last = ps.getLastRow();
  const out = [];
  if (last > 1) {
    const v = ps.getRange(2, 1, last - 1, 6).getValues();    // A..F: barcode, brand, item, sku, size, unit
    for (let i = 0; i < v.length && out.length < limit; i++) {
      const r = v[i];
      const brand = String(r[1] || "");
      if (bf && brand.toLowerCase() !== bf) continue;
      const hay = (brand + " " + String(r[2] || "") + " " + String(r[3] || "")).toLowerCase();
      if (needle && hay.indexOf(needle) < 0) continue;
      out.push({ barcode: String(r[0]), brand: brand, item: r[2] || "", sku: r[3] || "",
                 size: r[4] || "", unit: r[5] || "" });
    }
  }
  return json({ ok: true, p: out });
}

/* ---- precomputed analysis, built on a schedule and served from Drive ---- */

/** Interns repeated strings (brands, categories) so the payload ships indexes, not text. */
function makeDict() {
  const m = {}, arr = [];
  return {
    idx: function (v) { v = String(v || ""); if (!(v in m)) { m[v] = arr.length; arr.push(v); } return m[v]; },
    arr: arr
  };
}

/** Middle value of a numeric array that is ALREADY sorted ascending; the mean of the two
 *  middle values when the count is even. */
function median(sorted) {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return (n % 2) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Round to 2 decimal places — prices. */
function round2(x) {
  return Math.round(x * 100) / 100;
}

/**
 * Does the expensive Products+Observations read/join ONCE and writes a small, image-free
 * summary to Drive for ?action=summary to serve. Two bulk getValues() calls total, then pure
 * in-memory work — no getRange inside a loop — so this stays well inside the 6-minute limit
 * even at 26k products x 45k observations.
 *
 * Joins observations to products through normBarcode() on BOTH sides, or a 12-digit UPC-A
 * observation never matches its 13-digit product row and vanishes from analysis silently.
 */
function buildAnalysis() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = Session.getScriptTimeZone();

  const B = makeDict(), C1 = makeDict(), C2 = makeDict(), C3 = makeDict();

  // ---- Products, read once: barcode, brandIdx, item, sku, c1Idx, c2Idx, c3Idx, needsInfo01 ----
  const ps = ss.getSheetByName("Products");
  const pLast = ps.getLastRow();
  const base = [];
  const imgs = [];         // index-aligned with base[]; written to its own file
  const pIdxByNorm = {};   // normBarcode(barcode) -> index into base[] / the final row array
  if (pLast > 1) {
    const v = ps.getRange(2, 1, pLast - 1, 12).getValues();
    v.forEach(function (r) {
      const bc = String(r[0]); if (!bc) return;
      pIdxByNorm[normBarcode(bc)] = base.length;
      base.push([bc, B.idx(r[1]), r[2] || "", r[3] || "",
        C1.idx(r[6]), C2.idx(r[7]), C3.idx(r[8]), r[11] === "YES" ? 1 : 0]);
      imgs.push(String(r[9] || "").replace(CDN_PREFIX, "~"));
    });
  }

  // ---- Observations, read once.
  //
  // Aggregation is per (product, STORE), keeping only the LATEST price each shop quoted —
  // not every price ever recorded. Revisiting a shop must REPLACE its previous price, not add
  // a second vote: otherwise a product priced twice at the same store counts double, and a
  // long-superseded price keeps dragging `ref` down for good. With the seed data (one
  // observation per product per store) both give the same answer, so this only starts to
  // matter once field visits accumulate — which is exactly when it would be hardest to spot.
  // ----
  const os = ss.getSheetByName("Observations");
  const oLast = os.getLastRow();
  // product index -> { normal:{storeId:{price,at}}, promo:{storeId:{price,at}} }
  const acc = {};
  if (oLast > 1) {
    const v = os.getRange(2, 1, oLast - 1, 8).getValues();
    v.forEach(function (r) {
      if (r[4] === "" || r[4] == null) return;
      const pi = pIdxByNorm[normBarcode(r[3])];
      if (pi === undefined) return;
      const price = Number(r[4]);
      if (isNaN(price)) return;
      const flag = String(r[5] || "normal");
      if (flag !== "normal" && flag !== "promo") return;   // short_shelf_life is not a shelf price
      const sid = String(r[2] || "");
      const at = (r[1] instanceof Date) ? r[1].getTime() : 0;
      let a = acc[pi];
      if (!a) a = acc[pi] = { normal: {}, promo: {} };
      const bucket = a[flag];
      const prev = bucket[sid];
      if (!prev || at >= prev.at) bucket[sid] = { price: price, at: at };
    });
  }

  // ---- Combine: every product appears, with zeros when it has no observations, so the
  // viewer's search can still find it. ----
  const p = base.map(function (row, i) {
    const a = acc[i];
    let ref = 0, lo = 0, hi = 0, ns = 0, pd = 0;
    if (a) {
      const latest = Object.keys(a.normal).map(function (sid) { return a.normal[sid].price; });
      if (latest.length) {
        const sorted = latest.slice().sort(function (x, y) { return x - y; });
        lo = sorted[0];                          // cheapest shop
        hi = sorted[sorted.length - 1];          // priciest shop
        ref = round2(median(sorted));
        ns = latest.length;                      // one entry per store, so this IS the store count
      }
      const promos = Object.keys(a.promo).map(function (sid) { return a.promo[sid].price; });
      if (promos.length && ref) {
        pd = Math.round((1 - Math.min.apply(null, promos) / ref) * 1000) / 1000;
      }
    }
    return row.concat([ref, lo, hi, ns, pd]);
  });

  // ---- Stores: store_id, name, region, channel ----
  const st = ss.getSheetByName("Stores");
  let s = [];
  if (st.getLastRow() > 1) {
    const v = st.getRange(2, 1, st.getLastRow() - 1, 4).getValues();
    s = v.filter(function (r) { return r[0]; })
         .map(function (r) { return [String(r[0]), String(r[1] || r[0]),
                                     String(r[2] || ""), String(r[3] || "")]; });
  }

  const payload = {
    ok: true,
    generated: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm"),
    brands: B.arr, c1: C1.arr, c2: C2.arr, c3: C3.arr,
    s: s, p: p
  };

  writeDriveJson(ANALYSIS_FILE, JSON.stringify(payload));
  // Index-aligned with payload.p, so the viewer needs no barcode keys to join them — position
  // is the join. Written in the same pass so the two files can never disagree.
  writeDriveJson(IMAGES_FILE, JSON.stringify({
    ok: true, generated: payload.generated, cdn: CDN_PREFIX, img: imgs
  }));
  return p.length;
}

/** A named file inside PHOTO_FOLDER, or null. */
function findDriveFile(folder, fileName) {
  const files = folder.getFilesByName(fileName);
  return files.hasNext() ? files.next() : null;
}

/** Overwrites in place — Drive allows duplicate filenames, and a second copy would leave the
 *  reader at the mercy of whichever the iterator returns first. */
function writeDriveJson(fileName, content) {
  const folders = DriveApp.getFoldersByName(PHOTO_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(PHOTO_FOLDER);
  const existing = findDriveFile(folder, fileName);
  if (existing) existing.setContent(content);
  // "application/json" as a literal, NOT MimeType.JSON — that member does not exist in Apps
  // Script's MimeType enum, so it evaluates to undefined and createFile throws
  // "Argument cannot be null: mimeType". createFile accepts a MIME type string directly.
  else folder.createFile(fileName, content, "application/json");
}

/** Serves the prebuilt payload from Drive. Never recomputes except when the file is missing
 *  — recomputing per request is the 60s problem this endpoint exists to avoid. */
function summary() { return servePrebuilt(ANALYSIS_FILE); }

/**
 * Image URLs only, index-aligned with summary's `p` array. Its own endpoint so the viewer can
 * paint results first and let pictures arrive afterwards.
 */
function imagesPayload() { return servePrebuilt(IMAGES_FILE); }

function servePrebuilt(fileName) {
  let folders = DriveApp.getFoldersByName(PHOTO_FOLDER);
  let folder = folders.hasNext() ? folders.next() : null;
  let file = folder ? findDriveFile(folder, fileName) : null;
  if (!file) {
    buildAnalysis();     // nothing built yet (or the file was deleted): build both once
    folders = DriveApp.getFoldersByName(PHOTO_FOLDER);
    folder = folders.hasNext() ? folders.next() : null;
    file = folder ? findDriveFile(folder, fileName) : null;
  }
  if (!file) return json({ ok: false, error: fileName + " missing after build" });
  return ContentService.createTextOutput(file.getBlob().getDataAsString())
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * On-demand rebuild for the viewer's button. Deliberately does NOT take doPost's script lock:
 * this runs for tens of seconds and would stall price saves coming off a phone in a shop. A
 * cache flag prevents overlap instead; a race costs duplicated work, not corrupted data.
 */
function rebuild() {
  const cache = CacheService.getScriptCache();
  if (cache.get("rebuilding")) {
    return json({ ok: false, busy: true, error: "กำลังอัปเดตอยู่แล้ว" });
  }
  cache.put("rebuilding", "1", 300);
  try {
    const n = buildAnalysis();
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm");
    return json({ ok: true, n: n, generated: stamp });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    cache.remove("rebuilding");
  }
}

/** One-time: run by hand from the editor. Clears the old trigger first so re-running
 *  reschedules rather than stacking a second daily build. */
function installAnalysisTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "buildAnalysis") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("buildAnalysis").timeBased().atHour(3).everyDays(1).create();
}

/* ================= POST ================= */
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
 * Lookups read once per request, not once per record.
 *
 * Retry detection is cache-first: scanning "the last N rows" would assume Observations is
 * still in insertion order, and a sorted tab would then hide a retry and admit a duplicate.
 * The row scan below is only a fallback for a cache eviction.
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
      .forEach(function (r) { if (r[0] !== "" && r[0] != null) codes[normBarcode(r[0])] = true; });
  }

  const sh = ss.getSheetByName("Stores");
  const srows = sh.getLastRow() > 1
    ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : [];
  const storeIds  = srows.map(function (r) { return String(r[0]); });
  const storeKeys = srows.map(function (r) { return storeKey(r[1]); });

  return { cache: cache, recentIds: recentIds, codes: codes, storeIds: storeIds,
           storeKeys: storeKeys, nextSeq: maxSeq(ps) + 1 };
}

/** True when this obs_id has already been written. Cache first, row scan as a fallback. */
function alreadyWritten(ctx, id) {
  if (ctx.cache.get("obs:" + id)) return true;
  return ctx.recentIds.indexOf(id) >= 0;
}

function writeOne(ss, d, ctx) {
  const ts = d.ts ? new Date(d.ts) : new Date();

  // If this store name already exists, the row is NOT re-added — but the caller invented its
  // own store_id, which would orphan every observation it writes — an observation whose
  // store_id does not resolve is dropped from analysis silently. Hand back the canonical id.
  let canonicalStore = "";
  if (d.new_store && d.new_store.store_id && d.new_store.store) {
    const at = ctx.storeKeys.indexOf(storeKey(d.new_store.store));
    if (at < 0) {
      ss.getSheetByName("Stores")
        .appendRow([d.new_store.store_id, d.new_store.store, "", "", "created from app"]);
      ctx.storeKeys.push(storeKey(d.new_store.store));
      ctx.storeIds.push(d.new_store.store_id);
    } else {
      canonicalStore = ctx.storeIds[at] || "";
      if (canonicalStore && canonicalStore !== d.new_store.store_id) d.store_id = canonicalStore;
    }
  }

  if (d.new_product && d.barcode) {
    const key = normBarcode(d.barcode);          // zero-padded UPC-A no longer duplicates
    if (!ctx.codes[key]) {
      let img = "";
      if (d.new_product.photo) img = savePhoto(d.new_product.photo, "prod_" + key);
      const np = d.new_product;
      // needs_info is ALWAYS "YES" here. Earlier this was set only when no name was supplied,
      // so typing a description at the desk marked the product complete — but a description is
      // a hint, not data: brand, size, unit and categories are all still missing. Clearing the
      // flag is the admin's explicit "I finished this" signal, and nothing else should set it.
      ss.getSheetByName("Products").appendRow(["'" + String(d.barcode), np.brand || "",
        np.item || "", np.sku || "", "", "", "", "", "", img,
        "field_scan", "YES", ts, "", ctx.nextSeq++]);
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
    return { id: id, status: "written", store_id: canonicalStore || undefined };
  }

  if (d.type === "tunsong") {
    const tid = d.ts_id || ("T-" + ts.getTime());
    ss.getSheetByName("Tunsong").appendRow([tid, ts, d.store_id || "",
      "'" + String(d.barcode || ""), d.price, d.info_source || "",
      d.confidence || "", d.notes || ""]);
    return { id: tid, status: "written" };
  }

  if (d.type === "updateProduct") return updateProduct(ss, d);
  if (d.type === "updateStore") return updateStore(ss, d);
  if (d.type === "createStore") return createStore(ss, d, ctx);
  if (d.type === "uploadImage") return uploadImage(ss, d);

  return { id: d.obs_id || d.ts_id || "", status: "unknown_type" };
}

/**
 * Edits a Products row in place. Only keys PRESENT in `fields` are written: an absent key
 * leaves the cell alone, an explicit "" clears it — hence `in`, not truthiness.
 */
function updateProduct(ss, d) {
  const ps = ss.getSheetByName("Products");
  const row = findRow(ps, 1, barcodeForms(d.barcode));
  if (row < 0) return { id: d.barcode, status: "not_found" };

  const fields = d.fields || {};
  const BJ_KEYS = ["brand", "item", "sku", "size", "unit",
                    "category_1", "category_2", "category_3", "image_url"];  // columns B..J, in order
  if (BJ_KEYS.some(function (k) { return k in fields; })) {
    const range = ps.getRange(row, 2, 1, 9);
    const cur = range.getValues()[0];
    BJ_KEYS.forEach(function (k, i) {
      if (!(k in fields)) return;
      // size is a numeric column; a form hands us strings, and "150" stored as text sorts and
      // compares wrongly in the Sheet forever after.
      cur[i] = (k === "size" && fields[k] !== "" && !isNaN(fields[k]))
        ? Number(fields[k]) : fields[k];
    });
    range.setValues([cur]);
  }
  if ("notes" in fields) ps.getRange(row, 14).setValue(fields.notes);
  if (d.clear_needs_info) ps.getRange(row, 12).setValue("");

  // Both caches must go: "lk:" or lookup keeps serving the pre-edit product for 6 hours, and
  // "vocab" or a brand/category the admin just introduced is missing from their own dropdown.
  CacheService.getScriptCache().removeAll(["lk:" + normBarcode(d.barcode), "vocab"]);
  return { id: d.barcode, status: "updated" };
}

/**
 * Edits an existing Stores row in place. A rename that collides with another row's storeKey()
 * is refused outright — silently merging two shops would corrupt every price comparison that
 * groups by store, and there is no way to undo it from the data alone.
 */
function updateStore(ss, d) {
  const st = ss.getSheetByName("Stores");
  const last = st.getLastRow();
  if (last < 2) return { id: d.store_id, status: "not_found" };

  const ids = st.getRange(2, 1, last - 1, 1).getValues().flat().map(String);
  const idx = ids.indexOf(String(d.store_id));
  if (idx < 0) return { id: d.store_id, status: "not_found" };
  const row = idx + 2;

  const fields = d.fields || {};
  if ("store" in fields) {
    const keys = st.getRange(2, 2, last - 1, 1).getValues().flat().map(storeKey);
    const newKey = storeKey(fields.store);
    const clash = keys.some(function (k, i) { return i !== idx && k === newKey; });
    if (clash) return { id: d.store_id, status: "duplicate_name" };
  }

  const BE_KEYS = ["store", "region", "channel", "notes"];  // columns B..E, in order
  if (BE_KEYS.some(function (k) { return k in fields; })) {
    const range = st.getRange(row, 2, 1, 4);
    const cur = range.getValues()[0];
    BE_KEYS.forEach(function (k, i) { if (k in fields) cur[i] = fields[k]; });
    range.setValues([cur]);
  }
  return { id: d.store_id, status: "updated" };
}

/**
 * Creates a Stores row directly, for the admin page's "add store" flow. Until v9 a store could
 * only appear as a side effect of an observation POST carrying `new_store`.
 *
 * Compares on storeKey(), not the raw name — "eveandboy" and "EVEANDBOY" must resolve to the
 * same row, and this exact bug has already happened once in production data. When the shop
 * already exists, the caller gets back the EXISTING row's store_id rather than the one it
 * asked for: a second id for the same shop orphans its observations, which are then dropped
 * from analysis silently.
 */
function createStore(ss, d, ctx) {
  const name = String(d.store || "").trim();
  if (!name) return { id: "", status: "invalid" };

  const key = storeKey(name);
  const at = ctx.storeKeys.indexOf(key);
  if (at >= 0) return { id: ctx.storeIds[at] || "", status: "exists" };

  // A caller-supplied id that already belongs to a DIFFERENT shop is refused, not written:
  // two rows sharing one store_id means only one survives the id->store map, so the other
  // shop's observations vanish from analysis with no error anywhere.
  let id = String(d.store_id || "").trim();
  if (!id || ctx.storeIds.indexOf(id) >= 0) {
    do { id = genStoreId(); } while (ctx.storeIds.indexOf(id) >= 0);
  }

  ss.getSheetByName("Stores").appendRow([id, name, d.region || "", d.channel || "",
    d.notes || "created from admin"]);
  ctx.storeKeys.push(key);
  ctx.storeIds.push(id);
  return { id: id, status: "created" };
}

/** Saves a captured photo to Drive and points the product's image_url at it. */
function uploadImage(ss, d) {
  const ps = ss.getSheetByName("Products");
  const row = findRow(ps, 1, barcodeForms(d.barcode));
  if (row < 0) return { id: d.barcode, status: "not_found" };

  const url = savePhoto(d.photo, "prod_" + normBarcode(d.barcode));
  ps.getRange(row, 10).setValue(url);
  CacheService.getScriptCache().remove("lk:" + normBarcode(d.barcode));
  return { id: d.barcode, status: "updated", url: url };
}

/* ================= helpers ================= */
function savePhoto(dataUrl, name) {
  const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) return "";
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name + ".jpg");
  const folders = DriveApp.getFoldersByName(PHOTO_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(PHOTO_FOLDER);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w600";
}
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}