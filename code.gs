/**
 * PRICE SCOUT — backend v6
 * = v5 + single-barcode lookup and a stores endpoint.
 *
 * WHY v6: the capture page no longer downloads the product master. It resolves one barcode
 * at a time while the user is typing the price, so the round trip is hidden rather than
 * waited on. `delta` and the `seq` column stay — they cost nothing and the viewer may use
 * them later.
 *
 * WHAT CHANGED FROM v4, AND WHY
 *  1. Retries no longer duplicate rows. v4 appended unconditionally, so a POST that reached
 *     the Sheet but whose response was lost — what a weak signal does — was retried and
 *     written twice. A repeated obs_id now reports "duplicate" instead.
 *  2. An unknown `type` no longer silently succeeds. v4 wrote nothing and still returned
 *     ok:true, so the client discarded the row. That was silent data loss.
 *  3. Zero-padded barcodes no longer create duplicate Products rows. The Sheet stores
 *     barcodes as numbers, so a 12-digit UPC-A is 773602335374; a phone reporting
 *     0773602335374 did not match. Both sides now normalise before comparing.
 *  4. POST accepts {type:"batch", items:[...]} — a shop's worth of queued rows in one call.
 *  5. GET ?action=delta&after_seq=N returns only products added since the caller's snapshot.
 *
 * NOTHING DEPENDS ON ROW ORDER. delta keys on the `seq` column and retry detection keys on
 * the cache, so sorting any tab is harmless. People sort spreadsheets; assuming otherwise
 * is a defect waiting to happen.
 *
 * FIRST-TIME SETUP: run backfillSeq() ONCE from the editor before deploying.
 *
 * TO UPDATE WITHOUT BREAKING THE CAPTURE PAGE (keeps the same /exec URL):
 * 1. Apps Script editor → select all → paste this file → Save
 * 2. Deploy → Manage deployments → ✏️ (edit) → Version: "New version" → Deploy
 *    (Do NOT create a "New deployment" — that makes a new URL.)
 */

const CDN_PREFIX = "https://prodenbcdn.azureedge.net/products/";
const PHOTO_FOLDER = "PriceScout Photos";
const FLAGS = ["normal", "promo", "short_shelf_life"];
const SEQ_COL = 15;              // Products column O — monotonic append counter
const RECENT_OBS_WINDOW = 300;   // fallback only; the cache is the real retry guard
const OBS_CACHE_SEC = 21600;     // 6h — far longer than any realistic retry

/** Match the client's normalisation: digits only, no leading zeros. */
function normBarcode(v) {
  return String(v == null ? "" : v).replace(/\D/g, "").replace(/^0+/, "") || "0";
}

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

/* ================= Sheet menu ================= */
function onOpen() {
  SpreadsheetApp.getUi().createMenu("Price Scout")
    .addItem("เรียงลำดับสินค้ากลับเป็นเดิม", "restoreProductOrder")
    .addToUi();
}

/**
 * Put Products back in its original order after someone has sorted it.
 * With `seq` in place nothing breaks when the tab is sorted — this is convenience.
 */
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
  if (action === "bootstrap") return bootstrap();
  if (action === "viewdata") return viewdata();
  if (action === "delta") return delta(e.parameter.after_seq);
  if (action === "lookup") return lookup(e.parameter.barcode);
  if (action === "stores") return stores();
  return json({ ok: true, msg: "Price Scout API v6" });
}

/* ---- capture page: products (light) + stores ---- */
function bootstrap() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ps = ss.getSheetByName("Products");
  let products = [];
  if (ps.getLastRow() > 1) {
    const v = ps.getRange(2, 1, ps.getLastRow() - 1, 10).getValues();
    // size and unit are appended LAST so indexes 0-4 keep their meaning for older clients
    products = v.map(r => [String(r[0]), r[1] || "", r[2] || "", r[3] || "",
      String(r[9] || "").replace(CDN_PREFIX, "~"), r[4] || "", r[5] || ""]).filter(r => r[0]);
  }
  const st = ss.getSheetByName("Stores");
  let stores = [];
  if (st.getLastRow() > 1) {
    const v = st.getRange(2, 1, st.getLastRow() - 1, 2).getValues();
    stores = v.filter(r => r[0] && r[1]).map(r => [String(r[0]), String(r[1])]);
  }
  return json({ ok: true, cdn: CDN_PREFIX, seq: maxSeq(ps), p: products, s: stores });
}

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

/**
 * One barcode -> one product, or found:false. Normalises both sides, so a UPC-A scanned as
 * a zero-padded EAN-13 still resolves. Reads column A once (~26k cells, well under a second)
 * and then only the matching row.
 */
function lookup(barcode) {
  const key = normBarcode(barcode || "");
  if (!key) return json({ ok: true, found: false });
  const ps = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Products");
  const last = ps.getLastRow();
  if (last < 2) return json({ ok: true, found: false });

  const codes = ps.getRange(2, 1, last - 1, 1).getValues();
  let row = -1;
  for (let i = 0; i < codes.length; i++) {
    if (normBarcode(codes[i][0]) === key) { row = i + 2; break; }
  }
  if (row < 0) return json({ ok: true, found: false, barcode: String(barcode) });

  const r = ps.getRange(row, 1, 1, 12).getValues()[0];
  return json({ ok: true, found: true, p: {
    barcode: String(r[0]), brand: r[1] || "", item: r[2] || "", sku: r[3] || "",
    size: r[4] || "", unit: r[5] || "",
    img: String(r[9] || "").replace(CDN_PREFIX, "~"), cdn: CDN_PREFIX,
    needs_info: r[11] === "YES"
  }});
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

/* ---- viewer page: everything, dictionary-compressed ---- */
function viewdata() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = Session.getScriptTimeZone();
  const day = d => (d instanceof Date) ? Utilities.formatDate(d, tz, "yyyy-MM-dd") : String(d || "").slice(0, 10);

  // dictionaries
  const dict = list => { const m = {}, arr = []; return {
    idx: v => { v = String(v || ""); if (!(v in m)) { m[v] = arr.length; arr.push(v); } return m[v]; },
    arr: arr }; };
  const B = dict(), C1 = dict(), C2 = dict(), C3 = dict();

  // Products: barcode, brandIdx, item, sku, c1, c2, c3, img
  const ps = ss.getSheetByName("Products");
  const pIdxByBarcode = {};
  let p = [];
  if (ps.getLastRow() > 1) {
    const v = ps.getRange(2, 1, ps.getLastRow() - 1, 12).getValues();
    v.forEach(r => {
      const bc = String(r[0]); if (!bc) return;
      pIdxByBarcode[bc] = p.length;
      p.push([bc, B.idx(r[1]), r[2] || "", r[3] || "",
        C1.idx(r[6]), C2.idx(r[7]), C3.idx(r[8]),
        String(r[9] || "").replace(CDN_PREFIX, "~"),
        r[11] === "YES" ? 1 : 0]);
    });
  }

  // Stores: store_id, name, region, channel
  const st = ss.getSheetByName("Stores");
  const sIdxById = {};
  let s = [];
  if (st.getLastRow() > 1) {
    const v = st.getRange(2, 1, st.getLastRow() - 1, 4).getValues();
    v.forEach(r => {
      if (!r[0]) return;
      sIdxById[String(r[0])] = s.length;
      s.push([String(r[1] || r[0]), String(r[2] || ""), String(r[3] || "")]);
    });
  }

  // Observations: pIdx, sIdx, price, flagIdx, date
  const os = ss.getSheetByName("Observations");
  let o = [];
  if (os.getLastRow() > 1) {
    const v = os.getRange(2, 1, os.getLastRow() - 1, 8).getValues();
    v.forEach(r => {
      const pi = pIdxByBarcode[String(r[3])], si = sIdxById[String(r[2])];
      if (pi === undefined || si === undefined || r[4] === "" || r[4] == null) return;
      let f = FLAGS.indexOf(String(r[5] || "normal")); if (f < 0) f = 0;
      o.push([pi, si, Number(r[4]), f, day(r[1])]);
    });
  }

  // Tunsong: pIdx, sIdx, price, info_source, confidence, date
  const ts = ss.getSheetByName("Tunsong");
  let t = [];
  if (ts && ts.getLastRow() > 1) {
    const v = ts.getRange(2, 1, ts.getLastRow() - 1, 8).getValues();
    v.forEach(r => {
      const pi = pIdxByBarcode[String(r[3])], si = sIdxById[String(r[2])];
      if (pi === undefined || si === undefined || r[4] === "" || r[4] == null) return;
      t.push([pi, si, Number(r[4]), String(r[5] || ""), String(r[6] || ""), day(r[1])]);
    });
  }

  return json({ ok: true, cdn: CDN_PREFIX, brands: B.arr, c1: C1.arr, c2: C2.arr, c3: C3.arr,
                p: p, s: s, o: o, t: t, generated: day(new Date()) });
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
      .forEach(function (r) { if (r[0] !== "" && r[0] != null) codes[normBarcode(r[0])] = true; });
  }

  const sh = ss.getSheetByName("Stores");
  const srows = sh.getLastRow() > 1
    ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : [];
  const storeIds   = srows.map(function (r) { return String(r[0]); });
  const storeNames = srows.map(function (r) { return String(r[1]); });

  return { cache: cache, recentIds: recentIds, codes: codes, storeIds: storeIds,
           storeNames: storeNames, nextSeq: maxSeq(ps) + 1 };
}

/** True when this obs_id has already been written. Cache first, row scan as a fallback. */
function alreadyWritten(ctx, id) {
  if (ctx.cache.get("obs:" + id)) return true;
  return ctx.recentIds.indexOf(id) >= 0;
}

function writeOne(ss, d, ctx) {
  const ts = d.ts ? new Date(d.ts) : new Date();

  // If this store name already exists, the row is NOT re-added — but the caller invented its
  // own store_id, which would orphan every observation it writes (viewdata drops rows whose
  // store_id does not resolve, silently). Hand back the canonical id so the client can adopt it.
  let canonicalStore = "";
  if (d.new_store && d.new_store.store_id && d.new_store.store) {
    const at = ctx.storeNames.indexOf(d.new_store.store);
    if (at < 0) {
      ss.getSheetByName("Stores")
        .appendRow([d.new_store.store_id, d.new_store.store, "", "", "created from app"]);
      ctx.storeNames.push(d.new_store.store);
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
    return { id: id, status: "written", store_id: canonicalStore || undefined };
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

/* ================= helpers ================= */
function savePhoto(dataUrl, name) {
  const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) return "";
  const blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name + ".jpg");
  const folders = DriveApp.getFoldersByName(PHOTO_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(PHOTO_FOLDER);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w400";
}
function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}