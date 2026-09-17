import { test } from "node:test";
import assert from "node:assert/strict";
import { backupImageUrl, IMG_BACKUP_BASE } from "../core.js";

test("a zero-padded EAN-13 and its UPC-A map to the same backup file", () => {
  assert.equal(backupImageUrl("0773602335374"), backupImageUrl("773602335374"));
  assert.equal(backupImageUrl("773602335374"), IMG_BACKUP_BASE + "773602335374.jpg");
});

test("leading zeros are stripped, same as normBarcode", () => {
  assert.equal(backupImageUrl("00012345"), IMG_BACKUP_BASE + "12345.jpg");
});

test("non-digit separators are stripped", () => {
  assert.equal(backupImageUrl("885-712 894 0075"), IMG_BACKUP_BASE + "8857128940075.jpg");
});

test("empty, blank or all-zero input has no backup — normBarcode would give \"0\"", () => {
  assert.equal(backupImageUrl(""), "");
  assert.equal(backupImageUrl("   "), "");
  assert.equal(backupImageUrl("0"), "");
  assert.equal(backupImageUrl("000"), "");
});

test("plain numeric input works", () => {
  assert.equal(backupImageUrl(8857128940075), IMG_BACKUP_BASE + "8857128940075.jpg");
});
