/**
 * PRICE SCOUT — backend v4
 * = v3 (capture endpoints unchanged) + "viewdata" endpoint for the viewer page.
 *
 * TO UPDATE WITHOUT BREAKING THE CAPTURE PAGE (keeps the same /exec URL):
 * 1. Apps Script editor → select all → paste this file → Save
 * 2. Deploy → Manage deployments → ✏️ (edit) → Version: "New version" → Deploy
 *    (Do NOT create a "New deployment" — that makes a new URL.)
 */

const CDN_PREFIX = "https://prodenbcdn.azureedge.net/products/";
const PHOTO_FOLDER = "PriceScout Photos";
const FLAGS = ["normal", "promo", "short_shelf_life"];

/* ================= GET ================= */
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || "";
  if (action === "bootstrap") return bootstrap();
  if (action === "viewdata") return viewdata();
  return json({ ok: true, msg: "Price Scout API v4" });
}

/* ---- capture page: products (light) + stores ---- */
function bootstrap() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ps = ss.getSheetByName("Products");
  let products = [];
  if (ps.getLastRow() > 1) {
    const v = ps.getRange(2, 1, ps.getLastRow() - 1, 10).getValues();
    products = v.map(r => [String(r[0]), r[1] || "", r[2] || "", r[3] || "",
      String(r[9] || "").replace(CDN_PREFIX, "~")]).filter(r => r[0]);
  }
  const st = ss.getSheetByName("Stores");
  let stores = [];
  if (st.getLastRow() > 1) {
    const v = st.getRange(2, 1, st.getLastRow() - 1, 2).getValues();
    stores = v.filter(r => r[0] && r[1]).map(r => [String(r[0]), String(r[1])]);
  }
  return json({ ok: true, cdn: CDN_PREFIX, p: products, s: stores });
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

/* ================= POST (unchanged from v3) ================= */
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const d  = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ts = d.ts ? new Date(d.ts) : new Date();

    if (d.new_store && d.new_store.store_id && d.new_store.store) {
      const sh = ss.getSheetByName("Stores");
      const names = sh.getLastRow() > 1 ? sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues().flat() : [];
      if (names.indexOf(d.new_store.store) < 0)
        sh.appendRow([d.new_store.store_id, d.new_store.store, "", "", "created from app"]);
    }

    if (d.new_product && d.barcode) {
      const ps = ss.getSheetByName("Products");
      const codes = ps.getLastRow() > 1 ? ps.getRange(2, 1, ps.getLastRow() - 1, 1).getValues().flat().map(String) : [];
      if (codes.indexOf(String(d.barcode)) < 0) {
        let img = "";
        if (d.new_product.photo) img = savePhoto(d.new_product.photo, "prod_" + d.barcode);
        const np = d.new_product;
        const hasNames = (np.brand || np.item);
        ps.appendRow(["'" + String(d.barcode), np.brand || "", np.item || "", np.sku || "",
                      "", "", "", "", "", img, "field_scan", hasNames ? "" : "YES", ts, ""]);
      }
    }

    if (d.type === "obs") {
      ss.getSheetByName("Observations").appendRow([
        d.obs_id || ("O-" + ts.getTime()), ts, d.store_id || "", "'" + String(d.barcode || ""),
        d.price, d.flag || "normal", d.source || "scan", d.by || ""
      ]);
    } else if (d.type === "tunsong") {
      ss.getSheetByName("Tunsong").appendRow([
        d.ts_id || ("T-" + ts.getTime()), ts, d.store_id || "", "'" + String(d.barcode || ""),
        d.price, d.info_source || "", d.confidence || "", d.notes || ""
      ]);
    }
    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
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