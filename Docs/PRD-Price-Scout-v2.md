# Price Scout v2 — Product Requirements

**Version:** 1.0 · **Date:** 2026-08-27 · **Owner:** Ooa (Bewild)
**Status:** agreed scope, pre-build
**Supersedes:** the "lite pipeline" phase. Lite `index.html` / `viewer.html` are throwaway and will be deleted.
**Companion:** `HANDOVER-CLAUDE.md` (architecture, Sheet schema, gotchas, decisions log)

---

## 1. Why this exists

Bewild is a Thai OEM cosmetics brand. To price its own products correctly it needs to know what
competitors actually charge on Traditional Trade shelves and at border-export traders — data that
exists nowhere except on the shelf itself.

Price Scout is the instrument that captures it. It is an **internal tool for a handful of people**,
not a product. Every requirement below is judged on one question: *does it get a correct price row
into the Sheet faster?*

**v2 goal:** make in-store capture fast enough that a shop visit is limited by walking speed, not by
the app — and give the support team a desk tool to enter prices from shelf photos.

---

## 2. Workflows

Four, in priority order.

### R1 — Capture a known price *(mobile, in store, speed-critical)*
Scan barcode → product is recognised → type price → saved. This is the overwhelming majority of all
activity: the catalog holds 26,289 products and **most items on a TT shelf already exist in it**.
This loop is the product.

### R2 — Compare a price *(mobile, in store, relaxed)*
Scan a barcode and see what every other shop charges for the same product. Used when there is time,
and when standing in front of a competitor's shelf deciding whether a price is notable.

### R3 — Capture an unknown product *(mobile, in store, speed-critical)*
Barcode not recognised. The price still matters and there is **no time to type details**. Save the
price with, at most, one optional hint (a product name, or a photo). An admin completes it later.

### R4 — Desk entry from a shelf photo *(desktop, back at base, relaxed)*
On a trip Ooa photographs a whole shelf with a **normal phone camera, outside the app**. Later, a
support team member opens the photo alongside a desktop page and types the rows in: fuzzy-search the
product by name, enter price, next. Plus two admin surfaces: a queue of products missing details,
and store management.

**Explicitly not a workflow:** uploading shelf photos into the app. Decided and closed — photos stay
in the phone's camera roll and reach the team however they do today. The app never sees them.

---

## 3. Scope and sequence

Mobile ships first and completely, then the web app.

| Milestone | Delivers | Covers |
|---|---|---|
| **M1 — the fast loop** | Rewritten `index.html` + `core.js`; Apps Script **v6** (idempotent writes, batch POST, per-scan lookup) | R1, R3 |
| **M2 — compare** | Scan-to-compare view on the same screen | R2 |
| **M3 — the desk** | New `admin.html` + Apps Script v5 | R4 |

`viewer.html` is out of scope for v2 beyond keeping it working.

---

## 4. Architecture

Unchanged in shape, and deliberately so: **Google Sheet as database, Apps Script as API, static HTML
on GitHub Pages.** No build step, no framework, no app store, no server. A commit is a deploy.

```
index.html   (mobile capture)  ─┐
admin.html   (desk entry)      ─┼→ Apps Script Web App ──→ Google Sheet "TT Price War"
viewer.html  (analysis)        ─┘        (API only)     ↘ Drive "PriceScout Photos"
        ↑
   catalog.json  (static snapshot on GitHub Pages)
```

Each page is a single self-contained HTML file. Apps Script cannot host these pages — its sandbox
iframe blocks `getUserMedia` and kills the camera.

---

## 5. Product data: resolved per scan, not downloaded

**Decision (2026-08-27, Ooa): the capture page does not download the product master.**

The measured cost of the old approach against the live v4 API:

| | raw | over the wire | time |
|---|---|---|---|
| `?action=bootstrap` | 3.15 MB | 966 KB gzipped | **7.7 s** |

A static snapshot on GitHub Pages was built and measured at 446 KB gzipped, cached in IndexedDB
behind a service worker — fast after the first open, and fully offline. It was **rejected**: this app
exists to type a price, and shipping the entire 26,289-product master to do that is disproportionate.

**What ships instead:** `GET ?action=lookup&barcode=<code>` returns one product. The request is
fired the moment a barcode is decoded and resolves **while the price is being typed**, so its round
trip sits inside a gap the user was already filling rather than in front of them. Results are cached
for the session, so a rescan is instant.

**What this costs, stated plainly:**

- With no signal, a scan shows no product name. Prices are still captured correctly, but a mis-scan
  is not caught until someone reviews the data at a desk.
- The app can no longer tell a known barcode from a new one. It does not need to: every save carries
  an empty `new_product`, and the **backend** decides — an existing barcode gets an observation only,
  an unknown one also gets a `needs_info` Products row. Without this, an observation could point at a
  product that does not exist, and `viewdata` drops such rows silently.

`size` and `unit` come back with the lookup, so M2's comparison never presents ฿129/150 G and
฿129/50 G as the same price.

**Nothing may hang the UI.** Every network call carries a timeout and a failure path. The first
build of this shell had an unguarded `indexedDB.open` whose promise never settled, leaving the page
on a loading message with no error and no way forward — the exact failure that strands someone in a
shop. The app is interactive before any request completes.

## 6. M1 — Mobile capture, the fast loop

### 6.1 The core requirement
The camera **stays live between items**. Today `lookup()` calls `stopCam()` on every hit and rebuilds
a scanner instance on the next item, costing a cold start per product. In v2: point at a barcode, the
product and the price tag rise over the live viewfinder, type the price, save, and the camera is
already waiting for the next barcode. No mode switches, no reopening.

**Target loop for a known item:** aim (0 taps) → 3 digit taps → save (1 tap) = **4 taps, no camera restart.**

### 6.2 Scanning
- Continuous scanning, camera persists across saves
- Native `BarcodeDetector` where available, `html5-qrcode` as fallback
- Formats: EAN-13, EAN-8, UPC-A, UPC-E, Code 128
- Torch toggle where the browser exposes it — TT shelves are dim
- Manual typed entry always available, Enter submits
- **Duplicate guard:** the same barcode re-detected within a few seconds is ignored, so a code
  lingering in frame cannot create two rows
- Camera pauses on tab-hide and resumes on return, to protect battery

### 6.3 Price entry
- The orange price-tag keypad stays — it is the signature element and it works
- Flags ปกติ / โปรฯ / ใกล้หมดอายุ, defaulting to ปกติ
- Physical keyboard support on desktop (digits, Backspace, Enter to save)

### 6.4 Unknown product (R3)
One screen, everything optional, always saveable in a single tap:
- One free-text field for a product name hint
- One optional photo button
- Save writes the observation and creates the Products row with `needs_info = YES`

No brand field, no SKU field, no required input. Three text fields at a shelf is three too many.

### 6.5 Undo and session review
- A running list of what was captured this session: product, price, flag, time
- **Undo the last entry.** Implemented as a short send delay: a saved row is held locally for a few
  seconds before POSTing, and undo cancels it. This needs no backend change — the API is
  append-only and cannot delete. The buffer is persisted, so closing the app flushes rather than
  loses.
- Tapping a session row re-opens it for price correction while it is still in the buffer

### 6.6 Navigation

The phone does two jobs — capture a price and look one up — so the app carries a **two-tab bar**:
**เก็บราคา** and **ค้นหาราคา**. One tap between them, no menu. The store picker uses a real
filtered dropdown, not `<datalist>`, which renders inconsistently on mobile and cannot be styled.

### 6.7 Offline and install
- PWA: manifest, icon, `display: standalone`
- Service worker caches the app shell and `catalog.json` — the app **opens and scans with no signal**,
  which the current version cannot do
- Observations queue locally and flush on reconnect (already works; keep it, and surface a visible
  pending count so nothing looks lost)

### 6.8 Store selection
- Sticky, and **persisted across reloads** — currently a page refresh dumps you back to the picker
- Recent stores as tap chips; typing a new name creates the store

---

## 7. M2 — Compare (R2)

Same screen as capture, no separate mode. A scan shows, below the product:

- Latest price per store, newest first, each with its date, flag, and channel (TT / Border Export /
  Modern Trade)
- Size and unit alongside, so different pack sizes are visibly not comparable

Comparison data ships in the static snapshot as `prices.json` (latest price per product/store/flag),
so **compare works offline too**. Prices captured in the current session merge in locally.

**Known limitation, stated up front:** Stores currently contains exactly one row — EVEANDBOY, the
Modern Trade seed. Until several TT shops have been visited, this screen shows one benchmark and
nothing to compare it against. It becomes useful after the first few trips, not on day one.

ทุนส่ง never appears on mobile.

---

## 8. M3 — `admin.html` (R4)

Desktop-only, three tabs.

### 8.1 Entry from a shelf photo
The support team member has the photo open on a second screen or phone. The page is a typing loop:
1. Pick the store and date once; both stick for the whole batch
2. Fuzzy-search the product by name or brand (reuse the scorer already in `viewer.html`)
3. Enter price, pick flag, Enter saves and returns focus to the search box
4. A running list of the batch, with edit and remove

Optimised for keyboard, not mouse. Target: a row in a few seconds without touching the mouse.

### 8.2 Needs-details queue
Every product with `needs_info = YES` — the ones captured price-first in the field. Shows the field
photo where one exists, and lets an admin fill brand, item, sku, size, unit, categories, then clear
the flag.

### 8.3 Stores
List and edit stores: name, region, channel, notes. Today `region` and `channel` are filled by hand
in the Sheet and are frequently blank, which limits the viewer's filtering.

---

## 9. Backend changes

`code.gs` is committed to this repo as of v2. It previously existed only inside the Apps Script
editor — no history, no review, no backup.

### v5 — ships with M1

Review of the deployed v4 found three defects that matter in the field:

1. **Retries duplicate rows.** `doPost` appends unconditionally, so a POST that reaches the Sheet but
   whose response is lost — what a weak signal does — is retried and written twice. v5 recognises a
   repeated `obs_id` and reports `duplicate` instead of writing again. Without this, "zero duplicate
   rows" in the release gate cannot be claimed.
2. **An unknown `type` silently succeeds.** Neither `obs` nor `tunsong` means nothing is written and
   `{ok:true}` is still returned; the client then discards the row. Silent data loss. v5 returns
   `ok:false`.
3. **The new-product check misses zero-padded barcodes**, appending a duplicate Products row — and
   the same mismatch makes `viewdata` silently drop those observations from analysis. v5 normalises
   before comparing.

Plus three additions: `POST {type:"batch", items:[...]}` so a shop's worth of queued rows is one
round trip rather than one per row; `GET ?action=delta&after_seq=<mark>` (§5); and a **`seq` column**
on Products — column O, the only schema change in M1 — stamped at append time so nothing depends on
row order. A one-time `backfillSeq` stamps the existing 26,289 rows before v5 is deployed.

A **Price Scout menu inside the Sheet** ("เรียงลำดับสินค้ากลับเป็นเดิม") restores the product master
to its original order by sorting on `seq`. With `seq` in place this is a convenience rather than a
repair — sorting no longer breaks anything — but people do want the master back the way it was.

### v6 — ships with M3

The API is otherwise **append-only**, and the admin surfaces are fundamentally edits:

- `POST {type:"updateProduct", barcode, fields{...}}` — fills details, clears `needs_info`
- `POST {type:"updateStore", store_id, fields{...}}` — region, channel, notes

**Constraints that must be respected:**
- The Sheet is read **by column position**. New columns go on the far right only, and the `.gs` is
  updated in the same change.
- **Nothing depends on row order.** `delta` keys on `seq`; retry detection keys on a cache rather
  than on the last N rows. Sorting a tab must stay harmless — assuming people will not sort a
  spreadsheet is not a constraint anyone can honour.
- Deploy via **Manage deployments → edit → New version**. "New deployment" mints a new URL and
  breaks every page.
- POST stays `Content-Type: text/plain` — Apps Script cannot handle a CORS preflight.
- Barcodes are strings; the backend writes a leading `'`.

## 10. Non-goals

Not in v2, and not by accident:

- A native app, React Native, or anything with a build step
- User accounts, login, or roles. `entered_by` may become a one-time name saved on the device; a
  shared password in the Sheet is the ceiling if access control is ever wanted
- Uploading shelf photos into the app *(explicitly rejected)*
- OCR or any automatic reading of price tags from photos
- ทุนส่ง entry on mobile, or ทุนส่ง on any non-viewer surface
- Multi-language UI. Thai-first labels; English code and comments
- Changing `viewer.html` beyond keeping it working

---

## 11. Release gate

v2 mobile is done when, **on a real phone in a real TT shop**:

1. 20 consecutive known-item observations are captured with a **median under 6 seconds each**
2. The app opens and reaches a live camera in **under 2 seconds** on a repeat visit
3. It opens and scans **with mobile data switched off**, and every queued row arrives after reconnect
4. Zero rows lost, zero duplicate rows, and every row lands in the correct store
5. An unknown barcode is captured price-only in a single tap

A feature checklist does not close this milestone. The shop test does.

---

## 12. Resolved decisions

- **Who regenerates `catalog.json`?** Effectively nobody, routinely. New products reach the app
  through the `delta` call within seconds of being saved — the snapshot does not need to be current
  for the app to be correct. It is rebuilt and committed only after a bulk retailer import, when the
  delta has grown large enough to be slow on its own. Expected frequency: once or twice a year.
- **A distinct `source` value for desk-entered rows?** No. `source` stays `scan` / `manual` /
  `retailer_master`. Desk entries are `manual`.
- **A "this is ours" flag on Products?** No. Bewild's own products are not marked, and the compare
  view does not highlight them.
