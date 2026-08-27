# tools/make-icons.py — generate the PWA icons with no third-party libraries.
# The app's scan glyph (▣) in the tag orange: a white square outline with a solid
# white core, on orange. Run once: python3 tools/make-icons.py
import zlib, struct, os

TAG   = (0xFF, 0x7A, 0x1A, 255)   # --tag orange
WHITE = (0xFF, 0xFF, 0xFF, 255)

def make(path, size, pad_ratio=0.22):
    px = [[TAG] * size for _ in range(size)]
    pad = int(size * pad_ratio)
    outer_a, outer_b = pad, size - pad
    stroke = max(2, int(size * 0.075))
    inner_pad = stroke * 2
    inner_a, inner_b = outer_a + inner_pad, outer_b - inner_pad

    for y in range(outer_a, outer_b):
        for x in range(outer_a, outer_b):
            on_edge = (x < outer_a + stroke or x >= outer_b - stroke or
                       y < outer_a + stroke or y >= outer_b - stroke)
            in_core = inner_a <= x < inner_b and inner_a <= y < inner_b
            if on_edge or in_core:
                px[y][x] = WHITE

    raw = b"".join(b"\x00" + bytes(v for p in row for v in p) for row in px)
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    blob = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))
    os.makedirs("icons", exist_ok=True)
    with open(path, "wb") as f:
        f.write(blob)
    print("wrote", path, f"{size}x{size}")

# maskable icons get cropped on Android, so the glyph sits well inside the safe zone
make("icons/icon-192.png", 192)
make("icons/icon-512.png", 512)
make("icons/apple-touch-icon.png", 180)
