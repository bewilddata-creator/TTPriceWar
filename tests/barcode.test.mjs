import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidBarcode } from "../core.js";

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
