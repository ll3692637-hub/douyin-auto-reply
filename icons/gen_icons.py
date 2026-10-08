#!/usr/bin/env python3
"""生成扩展所需的 PNG 图标 - 使用纯Python实现"""
import struct, zlib, os

def make_png(size):
    """生成一个 size x size 的图标：
    - 圆角红色背景 (#FE2C55)
    - 白色音符/播放标志
    """
    img = [[(254, 44, 85, 255)] * size for _ in range(size)]  # 红色背景

    # 画白色播放三角形
    cx, cy = size // 2, size // 2
    tri_size = int(size * 0.35)

    for y in range(size):
        for x in range(size):
            # 播放三角形
            px = x - (cx - tri_size // 3)
            py = y - cy
            if px >= 0 and abs(py) <= px * 0.7 and px <= tri_size:
                img[y][x] = (255, 255, 255, 255)

    # 编码
    raw = bytearray()
    for row in img:
        raw.append(0)
        for r, g, b, a in row:
            raw.extend([r, g, b, a])

    def chunk(tag, data):
        c = tag.encode() + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    idat = zlib.compress(bytes(raw))

    return b"\x89PNG\r\n\x1a\n" + chunk("IHDR", ihdr) + chunk("IDAT", idat) + chunk("IEND", b"")


out_dir = os.path.dirname(os.path.abspath(__file__))
for s in [16, 48, 128]:
    data = make_png(s)
    with open(os.path.join(out_dir, f"icon{s}.png"), "wb") as f:
        f.write(data)
    print(f"icon{s}.png OK ({s}x{s}, {len(data)}B)")
