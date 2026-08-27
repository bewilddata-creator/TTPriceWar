# Price Scout — Project Handover
> Save this file as `CLAUDE.md` in the repo root — Claude Code reads it automatically at the start of every session. Last updated: 2026-08-27, end of the "lite pipeline" phase.

## 1. What this project is

**Price Scout** is a competitor price-intelligence system for Bewild (Thai OEM cosmetics manufacturer). Ooa and colleagues visit Traditional Trade stores and border-export traders, see competitor products and prices, and sometimes learn the ทุนส่ง (wholesale/delivered price) other brands offer. This system captures those prices in seconds in-store and analyzes them to reverse-engineer Bewild's own pricing.

Working name of the dataset/Sheet: **TT Price War**. App name: **Price Scout**.

**Current status:** lite pipeline COMPLETE and verified end-to-end — capture works on phone (camera scan, typing, product photo) and laptop; viewer works with live data; ~45k seeded price observations. **Next phase: polish, starting with the mobile capture app** — priority "fast and easy."

## 2. Where everything lives

| Thing | Location |
|---|---|
| Repo (GitHub Pages host) | `github.com/bewilddata-creator/TTPriceWar` (public) |
| Capture page (mobile input) | repo `index.html` → live at `https://bewilddata-creator.github.io/TTPriceWar/` |
| Viewer page (analysis) | repo `viewer.html` → live at `https://bewilddata-creator.github.io/TTPriceWar/viewer.html` |
| Database | Google Sheet **"TT Price War"** — `docs.google.com/spreadsheets/d/1aY7eZ4v_K_feLAar0t3T_bmMQ2gqoqGyf8poNrhcIw0` (private, Ooa's personal Google account) |
| Backend API | Apps Script bound to that Sheet (Extensions → Apps Script), deployed as Web App — currently **v4** of the code |
| API URL | The `/exec` URL is pasted as `API_URL` const at the top of BOTH html files (same URL for both) |
| Field photos | Drive folder **"PriceScout Photos"** (auto-created by backend), files link-shared |
| Product images (seeded) | Eveandboy CDN `https://prodenbcdn.azureedge.net/products/...` (external, not ours) |
| PRD | `price-scout-PRD.md` (v3) — from the Claude chat; add to repo if not already |

GitHub Pages config: deploy from branch `main`, root. Any committed file deploys in ~1 min. Repo is public → never commit data, ทุนส่ง, or anything beyond the app files (the API URL in the HTML is accepted as team-internal).

## 3. Architecture

```
index.html (capture, phone) ─┐
viewer.html (analysis)      ─┤→ Apps Script Web App (API only) → Google Sheet "TT Price War"
                             │                                  ↘ Drive "PriceScout Photos"
```

- Apps Script is API-only. It CANNOT host the pages: its sandbox iframe blocks `getUserMedia`, killing the barcode camera. Pages must be hosted on normal HTTPS (GitHub Pages).
- Sheet is the single source of truth and the de-facto desktop editor. Power BI was dropped (work Microsoft account not connected to Google); the custom viewer replaced it. Looker Studio noted as a free fallback if ad-hoc BI is ever wanted.
- Everything client-side: both pages load full datasets into memory. 26k products ≈ trivial for a browser; render ≤60 cards at a time, never the full list.

## 4. Database schema (Google Sheet tabs)

Normalized; joins happen client-side (in-memory maps). IDs generated client-side: `S-XXXXXX`, `O-XXXXXX`, `T-XXXXXX` (charset excludes I/L/O/0/1).

**Products** — key `barcode` (string! columns formatted as text; backend writes `"'"+barcode` to stop Sheets eating leading zeros / sci-notation)
`barcode · brand · item · sku · size · unit · category_1 · category_2 · category_3 · image_url · source · needs_info · first_seen · notes`
- `item` = product line (analysis level — shades don't matter for pricing); `sku` = shade/variant remainder, blank for standalone products
- `image_url` must be a DIRECT image link: Eveandboy CDN URLs as-is; field photos get `https://drive.google.com/thumbnail?id=...&sz=w400`
- `source`: `eveandboy_master` | `field_scan`; `needs_info`: `"YES"` or blank

**Stores** — key `store_id` · `store · region · channel · notes` (channels: TT / Border Export / Modern Trade)

**Observations** — key `obs_id` · `timestamp · store_id · barcode · price · flag · source · entered_by`
- `flag`: `normal` | `promo` | `short_shelf_life` · `source`: `scan` | `manual` | `retailer_master`
- Seed batch: 45,165 rows `EB-000001…` (26,289 normal + 18,876 promo), store EVEANDBOY, dated 2026-08-27

**Tunsong** — key `ts_id` · `date · store_id · barcode · tunsong_price · info_source · confidence · notes`
- SENSITIVE. Entered manually (Sheet). Shown only in the viewer (internal). Never on any public surface.

## 5. API contract (Apps Script v4)

All responses `{ok:true,...}` JSON. POST uses `Content-Type: text/plain` **on purpose** — avoids CORS preflight, which Apps Script doesn't handle.

**GET `?action=bootstrap`** (capture page) → `{ok, cdn, p, s}`
- `p`: array of `[barcode, brand, item, sku, imgCompact]` — img has CDN prefix replaced by `"~"`
- `s`: array of `[store_id, store_name]`

**GET `?action=viewdata`** (viewer) → `{ok, cdn, brands, c1, c2, c3, p, s, o, t, generated}`
- Dictionary-compressed: `brands/c1/c2/c3` are string arrays; rows hold indexes
- `p`: `[barcode, brandIdx, item, sku, c1Idx, c2Idx, c3Idx, imgCompact, needsInfo01]`
- `s`: `[name, region, channel]` (order = sIdx)
- `o`: `[pIdx, sIdx, price, flagIdx, "yyyy-mm-dd"]` (flagIdx into `["normal","promo","short_shelf_life"]`)
- `t`: `[pIdx, sIdx, price, info_source, confidence, date]`

**POST** body (JSON string):
- Observation: `{type:"obs", obs_id, ts(ISO), store_id, barcode, price, flag, source, by, new_store?:{store_id,store}, new_product?:{brand,item,sku,photo(base64 dataURL)}}`
- Tunsong: `{type:"tunsong", ts_id, ts, store_id, barcode, price, info_source, confidence, notes}`
- Backend side-effects: unknown barcode → appended to Products (needs_info YES if no names; photo saved to Drive, thumbnail URL written); unknown store name → appended to Stores.

**⚠️ Deployment rule:** to update backend code WITHOUT changing the URL: Deploy → **Manage deployments → ✏️ edit → Version: New version → Deploy**. "New deployment" mints a NEW url and breaks both pages. Web app settings: Execute as Me, access Anyone (URL-is-the-secret model, accepted risk, Sheet stays private).

## 6. Client behaviors already built

**Capture (`index.html`):** store picked once → sticks (chip in header); recent stores as tap chips; barcode via html5-qrcode (cdnjs 2.3.8) or typed + Enter; hit card shows brand/item/sku + product image; miss card = 3 optional fields (brand w/ datalist autocomplete, item, sku) + optional photo + skip-all→needs_info; price via custom keypad; flags ปกติ/ใกล้หมดอายุ/โปรฯ (default ปกติ); save → toast → auto-reset → refocus barcode. Offline queue in localStorage, flushes on `online` event. Bootstrap cached in localStorage (try/catch guarded). Photos client-shrunk to 800px JPEG 0.72 before upload.

**Viewer (`viewer.html`):** 3 tabs. ค้นหา = fuzzy search (custom scorer: exact=3 / prefix=2.2 / substring=1.6 / edit-distance-1 for tokens ≥4 chars=1.2; all query tokens must match; 120ms debounce; render top 60). หมวดหมู่ = 3-level chips (c1→c2→c3+ทั้งหมด), stats, 24-bin price-ladder histogram capped at p95, brand table w/ min-median-max + avg promo depth. เทียบแบรนด์ = category filter + 2 brand cards. Detail sheet = image, latest price per (store,flag) w/ dates, purple ทุนส่ง table when present. Per-product derived: `ref` = median of latest normal prices across stores; card shows min–max + store count. viewdata cached in IndexedDB (`pricescout` db, `kv` store, key `viewdata`); footer shows data date + รีเฟรชข้อมูล.

## 7. Data provenance & cleaning rules (Eveandboy seed)

Source: `Eveandboy_barcode_master.xlsx`, 26,294 rows → 26,289 after dedupe (5 dup barcodes, kept first). The source's sku_name/variant were inconsistent; cleaning rules (reuse for FUTURE retailer masters):
1. Trust `sku_name` as base (source `product_name` is sometimes a stale/wrong group label)
2. `variant` merged only when informative: text not already contained → append; numeric == size → drop (size dup); numeric ≠ size → shade number, append as `No.X`; `0`/blank → drop
3. item/sku split: group siblings by (brand, product_name), longest common prefix trimmed to word boundary = `item` (min 8 chars else no split); remainder = `sku`. Result: 14,661 items, 3,440 multi-SKU. Known cosmetic flaw: families with a "plain" member can push a shared word into sku (e.g. item "Natural Brow Waterproof Eyebrow", sku "Mascara 01 Deep Brown") — harmless, hand-fix on sight.

New retailer master pipeline: clean per rules → append ONLY new barcodes to Products (existing rows win) → optionally bulk-load its prices as observations with a new store row.

## 8. Design system (keep consistent across all pages)

- Palette: paper `#FAF9F6`, card `#FFF`, ink `#17191C`, muted `#6E6A61`, line `#E6E2D9`, **tag orange `#FF7A1A`** (deep `#E05E00`, ink-on-tag `#3A1A00`), ok `#0E8A5F`, warn `#C7462B`, amber `#B07100`, tunsong purple `#4A3AA8`
- Type: **Noto Sans Thai** (UI, must support Thai) + **IBM Plex Mono** (prices, barcodes, IDs)
- Signature element: the price-tag (orange rounded tag with punch-hole dot) on the capture keypad; the price ladder in the viewer
- UI language: Thai-first labels, short; radius 14px cards, 99px pills; shadow `0 1px 2px rgba(23,25,28,.06), 0 6px 18px rgba(23,25,28,.07)`
- Mobile: 480px max-width single column; viewer 1080px

## 9. Hard-won gotchas (do not rediscover these)

1. **Global name collisions in classic scripts:** `const top` at top level throws instantly ("already declared") and kills the whole script. Avoid `top, name, status, parent, self, length, history, open, close, origin, event` as top-level identifiers. This already bit us once.
2. Apps Script HtmlService **cannot** serve the camera pages (sandbox blocks getUserMedia) — API only.
3. POST as `text/plain` — do not "fix" it to application/json (CORS preflight will break it).
4. Barcodes are strings everywhere; backend prefixes `'` on write; Sheets columns formatted `@`.
5. Apps Script `viewdata` takes ~10–20 s (serializing 45k+ rows) — by design, viewer caches in IndexedDB. If it ever gets painful: nightly-generated static JSON on Pages is the planned escape hatch.
6. `localStorage` for the capture bootstrap is near the 5 MB quota — guarded with try/catch; viewer uses IndexedDB instead.
7. Update deployments via **New version on the existing deployment**, never New deployment (URL changes).
8. cdnjs is the script CDN in use (html5-qrcode); fonts from Google Fonts.
9. html5-qrcode: `qrbox {width:250,height:120}` wide box works better for EAN-13 than square.
10. Eveandboy CDN images: hotlinked, could break someday — acceptable; re-photograph/re-seed if so.

## 10. Decisions log (with reasons, so we don't relitigate)

- Custom web pages over Airtable/AppSheet — exact flow fidelity, ฿0, Ooa ships web tools
- Google Sheet as DB — free, human-editable, swappable later behind same API
- Normalized IDs + client-side joins over denormalized names — correctness on edits; join cost ~0
- item + sku two-level naming — price analysis at item level (shades don't matter), barcodes stay SKU-level
- Shelf-photo batch workflow CUT — old-school notes + manual entry instead
- Power BI CUT (account mismatch) → custom viewer; images no longer need to be public for BI
- One image per product, on Products row; first field photo wins; replace via Sheet
- Eveandboy prices loaded as seed observations (Modern Trade benchmark incl. promo depth)
- Prices recorded as printed; flag carries context; never "corrected"

## 11. Roadmap — the polish phase (current)

**NOW → Mobile capture app v2 — "fast and easy":**
- Re-examine the capture loop for taps-per-observation; keep store-sticky + auto-reset rhythm
- Physical keyboard support (desktop) + possible native `BarcodeDetector` API with html5-qrcode fallback
- Edit/undo last entry; session review list
- Known-item assist: new barcode of an existing item → suggest attaching (inherit brand/item, type sku only)
- PWA manifest + service worker (proper icon, offline shell, real installed-app feel)
- Faster bootstrap (static products.json on Pages, refreshed on demand?)

**Later:** viewer polish (price history timeline per store, multi-brand compare, ตัวกรอง by region/channel), ทุนส่ง entry form (desktop), needs_info cleanup screen, next retailer master import.

## 12. Working agreements

- Ooa's style: direct, action-oriented, concrete recommendations with honest tradeoffs, fast iteration over polish — but flag real risks plainly
- Discuss-before-build when scope is new ("let's talk about it first" is the pattern); demo early
- Thai UI copy; English code/comments
- Test checklist style (see SETUP-lite-test.md) worked well for verification — reuse it for releases
