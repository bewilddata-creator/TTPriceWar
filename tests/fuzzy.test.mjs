import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyScore, rankStores } from "../core.js";

const STORES = [
  { id:"S-1", name:"EVEANDBOY" },
  { id:"S-2", name:"ร้านเจ๊หงษ์" },
  { id:"S-3", name:"Big C สระแก้ว" },
  { id:"S-4", name:"ร้านป้าแดง" }
];

test("exact beats prefix beats substring beats subsequence", () => {
  assert.equal(fuzzyScore("EVEANDBOY", "eveandboy"), 3);
  assert.equal(fuzzyScore("EVEANDBOY", "eve"), 2.2);
  assert.equal(fuzzyScore("EVEANDBOY", "andboy"), 1.6);
  assert.equal(fuzzyScore("EVEANDBOY", "evb"), 1.2);
  assert.equal(fuzzyScore("EVEANDBOY", "zzz"), 0);
});

test("matching ignores case and surrounding space", () => {
  assert.equal(fuzzyScore("  EveAndBoy  ", "EVEANDBOY"), 3);
});

test("an empty query keeps every store, so focusing shows the whole list", () => {
  assert.equal(rankStores(STORES, "").length, 4);
});

test("Thai store names match on a partial", () => {
  const hits = rankStores(STORES, "เจ๊");
  assert.equal(hits[0].name, "ร้านเจ๊หงษ์");
});

test("a typo-ish partial still finds the store", () => {
  assert.equal(rankStores(STORES, "evb")[0].name, "EVEANDBOY");
  assert.equal(rankStores(STORES, "bigc")[0].name, "Big C สระแก้ว");
});

test("best match ranks first", () => {
  const hits = rankStores([{ id:"a", name:"Lotus" }, { id:"b", name:"Lotus Express" }], "lotus");
  assert.equal(hits[0].name, "Lotus");
});

test("non-matches are excluded, and the limit is honoured", () => {
  assert.equal(rankStores(STORES, "zzzz").length, 0);
  assert.equal(rankStores(STORES, "", 2).length, 2);
});
