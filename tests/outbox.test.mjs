import { test } from "node:test";
import assert from "node:assert/strict";
import { buildObs, outboxAdd, outboxUndo, outboxDue, outboxMark,
         outboxRemove, outboxPending, UNDO_MS } from "../core.js";

const base = {
  obsId: "O-8FN3TR", ts: "2026-08-27T10:14:00.000Z", storeId: "S-7KM2QW",
  barcode: "8859141308566", price: 129, flag: "normal", by: "Ooa"
};

test("buildObs produces exactly the record the backend expects", () => {
  assert.deepEqual(buildObs(base), {
    type: "obs", obs_id: "O-8FN3TR", ts: "2026-08-27T10:14:00.000Z",
    store_id: "S-7KM2QW", barcode: "8859141308566", price: 129,
    flag: "normal", source: "scan", by: "Ooa"
  });
});

test("buildObs keeps the barcode a string", () => {
  assert.equal(typeof buildObs({ ...base, barcode: "0012345678905" }).barcode, "string");
});

test("buildObs attaches a new store and a new product only when given", () => {
  const plain = buildObs(base);
  assert.equal("new_store" in plain, false);
  assert.equal("new_product" in plain, false);
  const rich = buildObs({ ...base,
    newStore: { store_id: "S-AAA111", store: "ร้านเจ๊หงษ์" },
    newProduct: { brand: "", item: "ครีมใหม่", sku: "", photo: null } });
  assert.equal(rich.new_store.store, "ร้านเจ๊หงษ์");
  assert.equal(rich.new_product.item, "ครีมใหม่");
});

test("a new entry is held, not sent", () => {
  const ob = outboxAdd([], buildObs(base), 1000);
  assert.equal(ob.length, 1);
  assert.equal(ob[0].state, "held");
  assert.equal(outboxPending(ob), 1);
});

test("undo drops a held entry", () => {
  const ob = outboxAdd([], buildObs(base), 1000);
  assert.equal(outboxUndo(ob, "O-8FN3TR").length, 0);
});

test("undo cannot drop an entry that is already sending", () => {
  let ob = outboxAdd([], buildObs(base), 1000);
  ob = outboxMark(ob, "O-8FN3TR", "sending");
  assert.equal(outboxUndo(ob, "O-8FN3TR").length, 1);
});

test("an entry becomes due only after the undo window", () => {
  const ob = outboxAdd([], buildObs(base), 1000);
  assert.equal(outboxDue(ob, 1000 + UNDO_MS - 1).length, 0);
  assert.equal(outboxDue(ob, 1000 + UNDO_MS).length, 1);
});

test("a queued entry is not re-collected by outboxDue", () => {
  let ob = outboxAdd([], buildObs(base), 1000);
  ob = outboxMark(ob, "O-8FN3TR", "queued");
  assert.equal(outboxDue(ob, 999999).length, 0);
});

test("a sent entry is removed and stops counting as pending", () => {
  const ob = outboxRemove(outboxAdd([], buildObs(base), 1000), "O-8FN3TR");
  assert.equal(ob.length, 0);
  assert.equal(outboxPending(ob), 0);
});

test("the outbox survives a JSON round trip", () => {
  const ob = outboxAdd([], buildObs(base), 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(ob)), ob);
});
