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
