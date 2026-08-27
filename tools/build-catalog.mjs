// tools/build-catalog.mjs — regenerate the static catalog from the live API.
// Run by hand: node tools/build-catalog.mjs
// Not deployed. Not part of any build step.
import { writeFileSync, mkdirSync } from "node:fs";

const API_URL = "https://script.google.com/macros/s/AKfycbz0PQVtM46QOMu7aWOKV56Q-A3R6Fp45V42sBslG1AhZfQ_S3RyQGOg1Zp5toMgQtyaGg/exec";

const stamp = new Date().toISOString().slice(0, 10);

console.log("fetching bootstrap (this takes ~8s)...");
const res = await fetch(API_URL + "?action=bootstrap");
if (!res.ok) throw new Error("bootstrap failed: " + res.status);
const d = await res.json();
if (!d.ok || !Array.isArray(d.p)) throw new Error("unexpected payload");
if (!d.seq) throw new Error(
  "bootstrap returned no seq — deploy backend v5 and run backfillSeq() first");

// `seq` is delta's starting point. Order-independent, so sorting the Sheet cannot invalidate it.
const catalog = { v: stamp, n: d.p.length, seq: d.seq,
                  p: d.p.map(r => [r[0], r[1], r[2], r[3]]) };
const images = { v: stamp, cdn: d.cdn || "", img: d.p.map(r => r[4] || "") };

mkdirSync("data", { recursive: true });
writeFileSync("data/catalog.json", JSON.stringify(catalog));
writeFileSync("data/images.json", JSON.stringify(images));

console.log(`wrote ${catalog.n} products, seq ${catalog.seq}, stamp ${stamp}`);
