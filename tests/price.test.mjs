import { test } from "node:test";
import assert from "node:assert/strict";
import { makeId, priceKey, priceValue, ID_CHARS } from "../core.js";

test("makeId uses the unambiguous charset and the given prefix", () => {
  const id = makeId("O", () => 0.5);
  assert.match(id, /^O-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  assert.ok(!/[ILO01]/.test(ID_CHARS));
});

test("digits append", () => {
  assert.equal(priceKey("", "1"), "1");
  assert.equal(priceKey("12", "9"), "129");
});

test("a leading zero is replaced, not accumulated", () => {
  assert.equal(priceKey("0", "5"), "5");
  assert.equal(priceKey("", "0"), "0");
});

test("backspace removes one character", () => {
  assert.equal(priceKey("129", "back"), "12");
  assert.equal(priceKey("", "back"), "");
});

test("only one decimal point, and it can open a value", () => {
  assert.equal(priceKey("12", "."), "12.");
  assert.equal(priceKey("12.", "."), "12.");
  assert.equal(priceKey("", "."), "0.");
});

test("at most two decimal places", () => {
  assert.equal(priceKey("12.5", "0"), "12.50");
  assert.equal(priceKey("12.50", "9"), "12.50");
});

test("at most six digits", () => {
  assert.equal(priceKey("123456", "7"), "123456");
});

test("priceValue returns a positive number or null", () => {
  assert.equal(priceValue("129"), 129);
  assert.equal(priceValue("12.50"), 12.5);
  assert.equal(priceValue(""), null);
  assert.equal(priceValue("0"), null);
  assert.equal(priceValue("12."), 12);
});
