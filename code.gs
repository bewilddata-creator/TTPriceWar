/**
 * PRICE SCOUT — backend v10
 * = v9 + a precomputed analysis payload so the viewer stops timing out.
 *
 * WHY v10: ?action=viewdata takes 60s and returns 4.65MB against the live data (26,289
 * products x 12 cols + 45,167 observations x 8 cols, read and joined on every single request),
 * and the viewer page never finishes loading it. Most of that weight is product image URLs
 * (1.41MB raw) that the viewer only ever shows one of at a time. buildAnalysis() does the
 * expensive read-and-join ONCE, folds each product's observations down to the few numbers a
 * list/search view actually needs (ref price, range, store count, promo depth — no image URL),
 * and writes the result to a Drive file. GET ?action=summary then just serves that file's
 * content — reading a ~2MB file is fast, which is the entire point, so it must never recompute
 * on the request path except the very first time the file does not exist yet. A daily trigger
 * (installAnalysisTrigger, run once by hand) and a Sheet menu item both call buildAnalysis() to
 * keep the file fresh. `viewdata` is untouched: viewer.html still calls it until it is rebuilt
 * to use `summary`, and removing or reshaping it now would break the live page.
 *
 * WHY v9: until now a store could only come into being as a side effect of an observation
 * POST carrying `new_store` — the admin page had no way to add one directly. POST
 * {type:"createStore", store_id, store, region, channel, notes} fills that gap. It reuses
 * storeKey() rather than comparing raw names, so "eveandboy" and "EVEANDBOY" resolve to the
 * same row instead of creating a duplicate — that exact bug has already happened once in
 * production data — and it hands back the EXISTING row's store_id when the shop is already
 * known, because inventing a second id for the same shop orphans observations (`viewdata`
 * drops rows whose store_id does not resolve, silently). A `store_id` the caller omits is
 * generated server-side in the project's existing "S-XXXXXX" format.
 *
 * WHY v8: the admin screen needs to browse and fix the product master without ever touching
 * row order or column position. Four additions:
 *  1. GET vocab — brand list + category_1/2/3 tree, for dropdowns. Cached 1h; the scan behind
 *     it touches the whole Products tab, and the vocabulary barely changes hour to hour.
 *  2. GET needsinfo — the review queue (needs_info = YES, or brand still blank). Never cached:
 *     an admin who just fixed a row must see it drop off the list on the next fetch.
 *  3. GET psearch — free-text product search for the "attach existing product" flow.
 *  4. POST updateProduct / updateStore / uploadImage — edit a row in place through the same
 *     batch mechanism as obs/tunsong. updateProduct and uploadImage evict the `lk:` cache
 *     entry for that barcode, or `lookup` keeps serving the pre-edit product for up to 6h.
 *     updateStore refuses a rename that collides with another store's storeKey() — that would
 *     silently merge two shops in every aggregate downstream.
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
const ANALYSIS_FILE = "pricescout-analysis.json";  // the one file buildAnalysis() writes/overwrites
const FLAGS = ["normal", "promo", "short_shelf_life"];
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
    .addItem("อัปเดตข้อมูลวิเคราะห์", "runBuildAnalysis")
    .addToUi();
}

/**
 * Menu entry point for buildAnalysis(). Reports the product count and the timestamp that got
 * written into the payload so whoever ran it can see the job actually did something, without
 * having to go open the Drive file.
 */
function runBuildAnalysis() {
  const ui = SpreadsheetApp.getUi();
  const n = buildAnalysis();
  const tz = Session.getScriptTimeZone();
  const stamp = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm");
  ui.alert("อัปเดตข้อมูลวิเคราะห์แล้ว: " + n + " รายการ (" + stamp + ")");
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
  if (action === "summary") return summary();
  if (action === "rebuild") return rebuild();
  if (action === "delta") return delta(e.parameter.after_seq);
  if (action === "lookup") return lookup(e.parameter.barcode);
  if (action === "prices") return pricesEndpoint(e.parameter.barcode);
  if (action === "stores") return stores();
  if (action === "vocab") return vocab();
  if (action === "needsinfo") return needsInfo(e.parameter.limit);
  if (action === "psearch") return psearch(e.parameter.q, e.parameter.brand, e.parameter.limit);
  return json({ ok: true, msg: "Price Scout API v10" });
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
 * One barcode -> the product plus what other shops charge for it.
 *
 * Uses Sheets' native TextFinder rather than pulling 26,289 barcodes into JS on every scan.
 * TextFinder runs inside Sheets and returns only matching cells, so cost tracks the number
 * of hits, not the size of the tab. Barcodes are searched in every form they may appear in,
 * because the Sheet stores them as numbers and a UPC-A may be scanned as 12 digits or as 13
 * with a leading zero.
 */
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

/**
 * Product identity only. Prices live at ?action=prices so the two run in PARALLEL from the
 * client: the name appears as soon as identity resolves instead of waiting on a scan of
 * 45,165 observation rows. Results are cached — the product master barely changes.
 */
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

/**
 * Brand list + category_1/2/3 tree, for the admin's dropdowns. One scan of Products columns
 * B, G, H, I, cached for an hour — the vocabulary changes rarely and the scan touches every
 * row, so paying for it on every keystroke would be wasteful.
 */
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
    const v = ps.getRange(2, 1, last - 1, 14).getValues();   // A..N in one call
    for (let i = 0; i < v.length && out.length < limit; i++) {
      const r = v[i];
      const brand = r[1] || "";
      const needs = r[11] === "YES";
      if (!needs && String(brand).trim()) continue;           // neither condition met
      out.push({
        barcode: String(r[0]), brand: brand, item: r[2] || "", sku: r[3] || "",
        size: r[4] || "", unit: r[5] || "", c1: r[6] || "", c2: r[7] || "", c3: r[8] || "",
        img: String(r[9] || "").replace(CDN_PREFIX, "~"),
        first_seen: (r[12] instanceof Date) ? Utilities.formatDate(r[12], tz, "yyyy-MM-dd") : String(r[12] || ""),
        needs_info: needs
      });
    }
  }
  return json({ ok: true, cdn: CDN_PREFIX, p: out });
}

/**
 * Free-text product search for the "attach existing product" flow. Reads barcode/brand/item/
 * sku/size/unit once, then stops as soon as `limit` matches are found rather than filtering
 * the whole tab and slicing — with 26k+ rows the difference matters.
 */
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

/* ---- precomputed analysis payload: v10's fix for viewdata's 60s/4.65MB response ---- */

/** Same string-interning approach as viewdata's local `dict`, pulled out as its own instance
 *  so buildAnalysis() can use it without touching viewdata's working code. */
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
 * Unlike viewdata's join (raw String(barcode) on both sides, which silently drops a row when a
 * 12-digit UPC-A observation meets a 13-digit product barcode or vice versa), this joins on
 * normBarcode() on both sides, so that class of row is no longer lost.
 *
 * Returns the number of products written, so the menu item and the trigger log can report it.
 */
function buildAnalysis() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tz = Session.getScriptTimeZone();

  const B = makeDict(), C1 = makeDict(), C2 = makeDict(), C3 = makeDict();

  // ---- Products, read once: barcode, brandIdx, item, sku, c1Idx, c2Idx, c3Idx, needsInfo01 ----
  const ps = ss.getSheetByName("Products");
  const pLast = ps.getLastRow();
  const base = [];
  const pIdxByNorm = {};   // normBarcode(barcode) -> index into base[] / the final row array
  if (pLast > 1) {
    const v = ps.getRange(2, 1, pLast - 1, 12).getValues();
    v.forEach(function (r) {
      const bc = String(r[0]); if (!bc) return;
      pIdxByNorm[normBarcode(bc)] = base.length;
      base.push([bc, B.idx(r[1]), r[2] || "", r[3] || "",
        C1.idx(r[6]), C2.idx(r[7]), C3.idx(r[8]), r[11] === "YES" ? 1 : 0]);
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

  writeAnalysisFile(JSON.stringify(payload));
  return p.length;
}

/** The ANALYSIS_FILE inside PHOTO_FOLDER, or null if neither exists yet. */
function findAnalysisFile(folder) {
  const files = folder.getFilesByName(ANALYSIS_FILE);
  return files.hasNext() ? files.next() : null;
}

/** Overwrites the existing analysis file's content rather than creating a second one — Drive
 *  happily keeps duplicate file names, and a second copy would leave `summary` at the mercy of
 *  whichever one the folder iterator happens to return first. */
function writeAnalysisFile(content) {
  const folders = DriveApp.getFoldersByName(PHOTO_FOLDER);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(PHOTO_FOLDER);
  const existing = findAnalysisFile(folder);
  if (existing) existing.setContent(content);
  // "application/json" as a literal, NOT MimeType.JSON — that member does not exist in Apps
  // Script's MimeType enum, so it evaluates to undefined and createFile throws
  // "Argument cannot be null: mimeType". createFile accepts a MIME type string directly.
  else folder.createFile(ANALYSIS_FILE, content, "application/json");
}

/**
 * Serves the precomputed analysis payload straight from Drive. Reading a ~2MB file is fast —
 * that is the entire reason this endpoint exists — so it must NOT recompute on every request;
 * buildAnalysis() only runs here the very first time, before the file exists at all. Not backed
 * by CacheService: the payload is around 2MB and CacheService caps out around 100KB per key.
 */
function summary() {
  let folders = DriveApp.getFoldersByName(PHOTO_FOLDER);
  let folder = folders.hasNext() ? folders.next() : null;
  let file = folder ? findAnalysisFile(folder) : null;
  if (!file) {
    buildAnalysis();     // first run ever: nothing to serve yet, so build it once
    folders = DriveApp.getFoldersByName(PHOTO_FOLDER);
    folder = folders.hasNext() ? folders.next() : null;
    file = folder ? findAnalysisFile(folder) : null;
  }
  if (!file) return json({ ok: false, error: "analysis file missing after build" });
  return ContentService.createTextOutput(file.getBlob().getDataAsString())
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Rebuilds the analysis file on demand, so the viewer can offer a button instead of making
 * someone open the Sheet.
 *
 * Deliberately does NOT take the script lock that doPost uses. buildAnalysis runs for tens of
 * seconds, and holding that lock would stall every price save coming off a phone in a shop —
 * the one thing that must never wait on analysis. A short CacheService flag stops two rebuilds
 * overlapping instead; the worst case if it races is duplicated work, not corrupted data,
 * because the file is written whole.
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

/**
 * One-time setup, same as backfillSeq() above: run this ONCE by hand from the Apps Script
 * editor after deploying v10. It is never called from onOpen or any endpoint, so it cannot fire
 * on its own. Deletes any existing trigger on the same handler first, so running it again after
 * a redeploy updates the schedule instead of stacking a second daily run on top of the first.
 */
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
  // own store_id, which would orphan every observation it writes (viewdata drops rows whose
  // store_id does not resolve, silently). Hand back the canonical id so the client can adopt it.
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

  if (d.type === "updateProduct") return updateProduct(ss, d);
  if (d.type === "updateStore") return updateStore(ss, d);
  if (d.type === "createStore") return createStore(ss, d, ctx);
  if (d.type === "uploadImage") return uploadImage(ss, d);

  return { id: d.obs_id || d.ts_id || "", status: "unknown_type" };
}

/**
 * Edits an existing Products row in place. Only keys present in `fields` are written — an
 * absent key must leave the cell untouched, but an explicit "" DOES clear it, so the check
 * below is `in`, not truthiness. Columns B..J are contiguous, so a touched field there costs
 * one read + one write no matter how many of the nine keys are present; notes (N) sits past
 * the seq/source/first_seen columns and is written separately only when supplied.
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
 * asked for: inventing a second id for the same shop orphans observations, and `viewdata`
 * drops rows whose store_id does not resolve, silently. ctx.storeKeys/storeIds were already
 * read once in newWriteContext and are updated here too, so a batch with several createStore
 * items stays consistent within one request without re-reading the sheet.
 */
function createStore(ss, d, ctx) {
  const name = String(d.store || "").trim();
  if (!name) return { id: "", status: "invalid" };

  const key = storeKey(name);
  const at = ctx.storeKeys.indexOf(key);
  if (at >= 0) return { id: ctx.storeIds[at] || "", status: "exists" };

  // A caller-supplied id that already belongs to a DIFFERENT shop is refused, not written:
  // two Stores rows sharing one store_id makes viewdata's id->store map keep only one of
  // them, so the other shop's observations vanish from analysis with no error anywhere.
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