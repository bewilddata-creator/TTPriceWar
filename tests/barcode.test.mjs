import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidBarcode, barcodeQuery } from "../core.js";

test("real EAN-13 codes from the product master validate", () => {
  assert.equal(isValidBarcode("8857128940075"), true);
  assert.equal(isValidBarcode("8859141308566"), true);
});

test("a real UPC-A from the master validates, padded or not", () => {
  assert.equal(isValidBarcode("773602335374"), true);
  assert.equal(isValidBarcode("0773602335374"), true);
});

test("a single mistyped digit is caught", () => {
  assert.equal(isValidBarcode("8857128940076"), false);
  assert.equal(isValidBarcode("8857128940175"), false);
});

test("a transposition is caught", () => {
  assert.equal(isValidBarcode("8857128944075"), false);
});

test("separators are ignored", () => {
  assert.equal(isValidBarcode("885-712 894 0075"), true);
});

test("lengths we cannot judge are not blocked", () => {
  assert.equal(isValidBarcode("64178"), true);        // 5-digit codes exist in the master
  assert.equal(isValidBarcode("18857125816387"), true);
});

test("barcodeQuery: digit strings are barcode searches, words are not", () => {
  assert.equal(barcodeQuery("8859065100970"), "8859065100970");
  assert.equal(barcodeQuery(" 885 906-5100970 "), "8859065100970");   // spaced/hyphenated as typed
  assert.equal(barcodeQuery("0885906"), "885906");                     // leading zeros stripped, as everywhere
  assert.equal(barcodeQuery("885906"), "885906");                      // 6 digits is the minimum
  assert.equal(barcodeQuery("88590"), "");                             // shorter is a size or shade, not a code
  assert.equal(barcodeQuery("mille lip"), "");
  assert.equal(barcodeQuery("no 29"), "");                             // digits mixed with words stay a name search
  assert.equal(barcodeQuery(""), "");
  assert.equal(barcodeQuery(null), "");
});
