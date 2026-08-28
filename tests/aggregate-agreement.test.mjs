import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The viewer recomputes ref/lo/hi/ns/pd client-side whenever a store filter is active, while
 * the unfiltered view uses values precomputed by buildAnalysis() in code.gs. Two
 * implementations of the same definition WILL drift — they already did: the backend rounded
 * the median to 2dp and the client did not, so selecting every store showed ฿533.305 where the
 * default view showed ฿533.30.
 *
 * These are ports of both implementations. If either side's definition changes without the
 * other, this fails. Keep them in step with code.gs `buildAnalysis` and viewer.html
 * `computeFiltered`.
 */
const median = s => { const n = s.length, m = Math.floor(n / 2); return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round2 = x => Math.round(x * 100) / 100;

/** Port of code.gs buildAnalysis()'s per-product aggregation. */
function backendAggregate(rows) {
  const normal = {}, promo = {};
  rows.forEach(r => { (r.flag === 0 ? normal : promo)[r.store] = r.price; });
  const latest = Object.values(normal);
  let ref = 0, lo = 0, hi = 0, ns = 0, pd = 0;
  if (latest.length) {
    const s = latest.slice().sort((a, b) => a - b);
    lo = s[0]; hi = s[s.length - 1]; ref = round2(median(s)); ns = latest.length;
  }
  const promos = Object.values(promo);
  if (promos.length && ref) pd = Math.round((1 - Math.min(...promos) / ref) * 1000) / 1000;
  return { ref, lo, hi, ns, pd };
}

/** Port of viewer.html computeFiltered(). */
const med = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function clientFiltered(rows, sel) {
  let normals = [], minPromo = null;
  for (const o of rows) {
    if (!sel.has(o.store)) continue;
    if (o.flag === 0) normals.push(o.price);
    else if (o.flag === 1 && (minPromo === null || o.price < minPromo)) minPromo = o.price;
  }
  if (!normals.length) return null;
  const ref = Math.round(med(normals) * 100) / 100;
  const pd = (minPromo !== null && ref) ? Math.round((1 - minPromo / ref) * 1000) / 1000 : 0;
  return { ref, lo: Math.min(...normals), hi: Math.max(...normals), ns: normals.length, pd };
}

test("selecting every store reproduces the precomputed aggregates exactly", () => {
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let t = 0; t < 3000; t++) {
    const rows = [];
    for (let s = 0; s < 1 + (t % 6); s++) {
      rows.push({ store: s, price: Math.round((5 + rand() * 900) * 100) / 100, flag: 0 });
      if (rand() < 0.5) rows.push({ store: s, price: Math.round((5 + rand() * 400) * 100) / 100, flag: 1 });
    }
    const all = new Set(rows.map(r => r.store));
    assert.deepEqual(clientFiltered(rows, all), backendAggregate(rows),
      `disagreement on iteration ${t}: ${JSON.stringify(rows)}`);
  }
});

test("an even number of stores rounds the median the same way on both sides", () => {
  const rows = [{ store: 0, price: 199.31, flag: 0 }, { store: 1, price: 867.30, flag: 0 }];
  assert.equal(backendAggregate(rows).ref, 533.3);
  assert.equal(clientFiltered(rows, new Set([0, 1])).ref, 533.3);
});

test("a product with no price under the filter is excluded, not reported as zero", () => {
  const rows = [{ store: 0, price: 99, flag: 0 }];
  assert.equal(clientFiltered(rows, new Set([1])), null);
});

test("only the selected stores count toward the store count", () => {
  const rows = [{ store: 0, price: 100, flag: 0 }, { store: 1, price: 200, flag: 0 },
                { store: 2, price: 300, flag: 0 }];
  assert.equal(clientFiltered(rows, new Set([0, 2])).ns, 2);
  assert.equal(clientFiltered(rows, new Set([0, 2])).ref, 200);
});
