"""Render assets/skylog.png (256x256) with pure Python — no image libraries."""
import math
import random
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets" / "skylog.png"
N, SS = 256, 3  # size, supersampling


def star_shape(x, y, cx, cy, R, r):
    """Inside a 4-pointed star (concave diamond)."""
    dx, dy = abs(x - cx), abs(y - cy)
    # boundary: (dx/R)^p + (dy/R)^p <= 1 with p<1 gives concave spikes
    p = 0.55
    return (dx / R) ** p + (dy / R) ** p <= 1 or math.hypot(dx, dy) < r


def main():
    random.seed(7)
    bg_stars = [(random.uniform(40, 216), random.uniform(40, 216), random.uniform(0.6, 1.6))
                for _ in range(26)]
    rows = []
    c = N / 2
    for py in range(N):
        row = bytearray([0])
        for px in range(N):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    x, y = px + (sx + .5) / SS, py + (sy + .5) / SS
                    d = math.hypot(x - c, y - c)
                    if d > 120:
                        continue
                    t = d / 120
                    col = [38 + (11 - 38) * t, 48 + (16 - 48) * t, 107 + (38 - 107) * t]
                    # light-pollution glow at the rim
                    if t > .8:
                        k = (t - .8) / .2 * .35
                        col = [col[0] + (120 - col[0]) * k, col[1] + (80 - col[1]) * k, col[2] + (60 - col[2]) * k]
                    for bx, by, br in bg_stars:
                        if math.hypot(x - bx, y - by) < br and abs(x - c) + abs(y - c) > 60:
                            col = [235, 238, 255]
                    # glow around the main star
                    g = max(0, 1 - d / 70) ** 2 * .55
                    col = [col[0] + (245 - col[0]) * g, col[1] + (200 - col[1]) * g, col[2] + (106 - col[2]) * g]
                    if star_shape(x, y, c, c, 80, 6):
                        col = [245, 200, 106] if d > 10 else [255, 240, 200]
                    if d > 117:  # ring
                        col = [col[0] * .6 + 245 * .4, col[1] * .6 + 200 * .4, col[2] * .6 + 106 * .4]
                    acc[0] += col[0]; acc[1] += col[1]; acc[2] += col[2]; acc[3] += 255
            n = SS * SS
            row += bytes([min(255, int(acc[0] / n)), min(255, int(acc[1] / n)),
                          min(255, int(acc[2] / n)), int(acc[3] / n)])
        rows.append(bytes(row))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", N, N, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_bytes(png)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
