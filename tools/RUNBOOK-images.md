# Runbook: backing up product images

Instructions for Claude (or anyone) when Ooa says **"back up the new product images"**.
Follow the steps in order. Nothing here touches the Google Sheet.

## What this is

- Product images live at third-party URLs (the `image_url` column in Products). Stores can block
  them (Tops and BigC already do) or take them down.
- `tools/backup-images.mjs` copies every image to the **TTPriceWar-images** repo as
  `img/<key>.jpg`, max 300px, white background. `<key>` = `normBarcode(barcode)` from `core.js`:
  digits only, leading zeros stripped.
- Served at `https://bewilddata-creator.github.io/TTPriceWar-images/img/<key>.jpg`.
- All three pages show the original URL first and switch to the backup if it fails to load
  (`backupImageUrl()` in `core.js`). **The Sheet keeps the original URLs. Never overwrite them.**
- Local clone: `../TTPriceWar-images`, next to this repo. If it's missing:
  `gh repo clone bewilddata-creator/TTPriceWar-images` from the parent folder.

## Steps

1. **Rebuild the analysis first.** The script reads the prebuilt payload, so new products are
   invisible to it until a rebuild. Ask Ooa to press **อัปเดตข้อมูลวิเคราะห์** in the viewer, or
   run it from the Sheet menu (TT Price Wars → อัปเดตข้อมูลวิเคราะห์). Wait until it says it's done.
2. **First time on this Mac only:** `cd tools && npm install`
3. **Preview:** `node tools/backup-images.mjs --dry-run`. It shows how many images are new or
   changed, grouped by site. If it says "nothing to do", stop here and tell Ooa.
4. **Tell Ooa before running** if the preview lists any "(Chrome window)" sites. A Chrome window
   will open, and they must leave it alone until the run ends.
5. **Run:** `node tools/backup-images.mjs`. Run it in the background for large batches.
   Rough speed: ~20 images/s for normal sites, ~1.5 images/s through the Chrome window.
   It commits every 1,000 images and pushes at most every 10 minutes, plus once at the end.
6. **Report to Ooa:** how many were saved and failed, the main failure reasons (printed at the end),
   and the backup size vs the 1 GB limit.

The run is safe to stop with Ctrl+C: finished images are committed, and the next run continues
where it left off.

## Reading the result

- **Failures** are listed per product in `../TTPriceWar-images/failures.tsv`
  (key, URL hash, tries, reason, URL). Common reasons:
  - `HTTP 404` / `HTTP 410`: the image is gone from the store's site. Nothing to back up. The
    product needs a new `image_url` in the Sheet (admin → เติมข้อมูลสินค้า).
  - `browser: HTTP 403`: the site blocked even the Chrome window. Wait a few hours and rerun
    with `--host <site>`. Lower the request rate (`BROWSER_DELAY_MS`) if it keeps happening.
  - `too small (…)`: the URL returns a tracking pixel or placeholder, not a product photo.
  - `decode failed`: the file isn't a real image.
- After 3 failures on the **same URL**, later runs skip that product. Changing the URL in the Sheet
  (then rebuilding) makes it eligible again. `--retry-failed` forces a retry of everything.
- A product whose `image_url` changed is downloaded again and its backup overwritten.

## Options

| Option | Use |
|---|---|
| `--dry-run` | Count only; downloads nothing |
| `--host tops` | Only URLs whose host contains the text (e.g. to retry one store) |
| `--limit 20` | Stop after 20 attempts (testing) |
| `--no-push` | Commit locally but don't push |
| `--retry-failed` | Also retry products that failed 3 times |

## Troubleshooting

- **"summary and images disagree"**: a rebuild finished between the two downloads, or is still
  running. Wait a minute and rerun.
- **"action=summary failed"**: Apps Script or Drive hiccup. Rerun. If it persists, open the API URL
  with `?action=summary` in a browser to see the error.
- **Push rejected**: someone pushed to the images repo elsewhere. `git -C ../TTPriceWar-images pull --rebase`,
  then `git -C ../TTPriceWar-images push`.
- **Chrome window closed by accident**: the remaining browser downloads fail with a browser error.
  Rerun; only the failed ones are retried.
- **Backups don't show on the site right after a run**: GitHub Pages takes a few minutes to publish
  after a push. It also soft-limits builds to 10 an hour, which is why the script batches its pushes.

## Running out of space

GitHub Pages publishes at most **1 GB** per site. The script prints the size after each run and warns
past 80%. At ~14 KB per image that's roughly 70,000 products. Options when it gets close, in order
of preference:

1. Remove backups for products deleted from the Sheet (write a cleanup mode: files in `img/`
   whose key isn't in the current payload).
2. Lower `MAX_PX` to 240 or `JPEG_QUALITY` to 0.6 and rerun with a fresh repo. The viewer shows
   images at 130px at most.
3. Split into a second images repo (e.g. by the key's last digit) and teach `backupImageUrl()` the
   split.

Git history also grows each time an image is replaced. If the repo itself gets too large, replace it
with a fresh one containing only the current files; nothing depends on its history.
