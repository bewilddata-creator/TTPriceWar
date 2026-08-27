import { test } from "node:test";
import assert from "node:assert/strict";
import { normBarcode, shouldAcceptScan } from "../core.js";

// The catalog is no longer downloaded — the backend resolves one barcode per scan. Both
// sides must normalise identically, or a UPC-A scanned as a zero-padded EAN-13 is reported
// "not found" and a duplicate product is created.
test("normBarcode keeps digits and drops leading zeros", () => {
  assert.equal(normBarcode("0773602335374"), "773602335374");
  assert.equal(normBarcode("773602335374"), "773602335374");
  assert.equal(normBarcode(773602335374), "773602335374");
  assert.equal(normBarcode("885-914 1308566"), "8859141308566");
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
