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

/** Milliseconds an entry is held locally so it can be undone before it is sent. */
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
