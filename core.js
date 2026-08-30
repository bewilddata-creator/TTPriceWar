// core.js — pure logic for TT Price Wars capture.
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

export const SCAN_WINDOW_MS = 2500;

/** A barcode lingering in the viewfinder must not create a second row. */
export function shouldAcceptScan(last, code, now, windowMs = SCAN_WINDOW_MS) {
  if (!last) return true;
  return !(last.code === code && now - last.at < windowMs);
}

/** Milliseconds an entry is held locally so it can be undone before it is sent.
 *  15s: long enough to notice a mistyped price and act, short enough that a shop's
 *  worth of rows is not still sitting on the phone when the trip ends. */
export const UNDO_MS = 15000;

export const FLAGS = ["normal", "promo", "short_shelf_life", "wholesale"];

/**
 * Build the exact observation record the Apps Script backend expects.
 *
 * `minQty` only travels with a `wholesale` row — a shop's bulk price is meaningless without
 * the quantity that unlocks it. It is deliberately omitted otherwise rather than sent as 0,
 * so a retail row can never be mistaken for a wholesale offer of one piece.
 */
export function buildObs({ obsId, ts, storeId, barcode, price, flag,
                           by, source = "scan", minQty, newStore, newProduct }) {
  const rec = {
    type: "obs", obs_id: obsId, ts, store_id: storeId,
    barcode: String(barcode), price, flag, source, by
  };
  if (flag === "wholesale" && Number(minQty) > 0) rec.min_qty = Number(minQty);
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

/**
 * How well `text` matches `query`. Tiers, best first: exact, prefix, substring, then
 * subsequence (the query's characters appear in order, so "evb" finds "EVEANDBOY").
 * 0 means no match. A fresh browser has no history to fall back on, so the picker has to
 * find a store from a partial or slightly wrong guess.
 */
export function fuzzyScore(text, query) {
  const t = String(text == null ? "" : text).toLowerCase().trim();
  const q = String(query == null ? "" : query).toLowerCase().trim();
  if (!q) return 0.5;
  if (!t) return 0;
  if (t === q) return 3;
  if (t.startsWith(q)) return 2.2;
  if (t.includes(q)) return 1.6;
  let i = 0;
  for (let k = 0; k < t.length && i < q.length; k++) if (t[k] === q[i]) i++;
  return i === q.length ? 1.2 : 0;
}

/** Stores that match `query`, best first. An empty query returns everything. */
export function rankStores(stores, query, limit = 8) {
  return stores
    .map(s => ({ s, score: fuzzyScore(s.name, query) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || String(a.s.name).localeCompare(String(b.s.name)))
    .slice(0, limit)
    .map(x => x.s);
}

/**
 * EAN-13 / UPC-A / EAN-8 check digit. The desk workflow types 13 digits read off a shelf
 * photo, where one wrong character silently creates a phantom product that nobody notices
 * until the data is analysed. This catches most single-digit and transposition errors.
 * Returns true for a valid code, false otherwise. Lengths we do not know are not judged —
 * those return true, so an unusual but real code is never blocked.
 */
export function isValidBarcode(code) {
  const d = String(code == null ? "" : code).replace(/\D/g, "");
  if (![8, 12, 13].includes(d.length)) return true;
  const body = d.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    // Weights alternate 3/1 counting from the rightmost body digit.
    const weight = (body.length - i) % 2 === 1 ? 3 : 1;
    sum += Number(body[i]) * weight;
  }
  return String((10 - (sum % 10)) % 10) === d[d.length - 1];
}
