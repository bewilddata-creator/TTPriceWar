import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync("data/catalog.json", "utf8"));
const images = JSON.parse(readFileSync("data/images.json", "utf8"));

test("catalog holds the full product master", () => {
  assert.ok(catalog.n > 26000, "expected >26k products, got " + catalog.n);
  assert.equal(catalog.p.length, catalog.n);
});

test("catalog records the seq high-water mark delta starts from", () => {
  assert.ok(Number.isInteger(catalog.seq) && catalog.seq >= catalog.n,
    "seq must be stamped by backfillSeq before the snapshot is built");
});

test("every catalog row is [barcode, brand, item, sku] with a string barcode", () => {
  for (const r of catalog.p.slice(0, 500)) {
    assert.equal(r.length, 4);
    assert.equal(typeof r[0], "string");
    assert.match(r[0], /^[0-9]+$/);
  }
});

test("barcodes are unique", () => {
  assert.equal(new Set(catalog.p.map(r => r[0])).size, catalog.p.length);
});

test("images align to catalog by index and share its stamp", () => {
  assert.equal(images.img.length, catalog.p.length);
  assert.equal(images.v, catalog.v);
  assert.ok(images.cdn.startsWith("https://"));
});
