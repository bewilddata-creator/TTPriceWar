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
