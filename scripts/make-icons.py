#!/usr/bin/env python3
"""生成扩展图标：深蓝圆角底 + 白色清单 + 绿色状态点。"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SIZES = [16, 32, 48, 128]
BG_TOP = (37, 99, 235)
BG_BOTTOM = (29, 78, 216)
ACCENT = (16, 185, 129)


def rounded_mask(size, radius, scale=4):
    m = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [0, 0, size * scale - 1, size * scale - 1], radius=radius * scale, fill=255
    )
    return m.resize((size, size), Image.LANCZOS)


def gradient(size):
    g = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        g.putpixel((0, y), tuple(round(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3)))
    return g.resize((size, size))


def draw_icon(size):
    s = size * 4  # 超采样，缩小后边缘更干净
    img = gradient(s).convert("RGBA")

    d = ImageDraw.Draw(img)
    # 白色纸张
    pad = round(s * 0.235)
    paper = [pad, round(s * 0.185), s - pad, round(s * 0.815)]
    d.rounded_rectangle(paper, radius=round(s * 0.075), fill=(255, 255, 255, 255))

    # 纸上的三行清单
    x0 = paper[0] + round(s * 0.10)
    x1 = paper[2] - round(s * 0.10)
    bar_h = max(2, round(s * 0.052))
    ys = [round(s * 0.34), round(s * 0.47), round(s * 0.60)]
    for i, y in enumerate(ys):
        end = x1 if i != 1 else x1 - round(s * 0.13)
        d.rounded_rectangle([x0, y, end, y + bar_h], radius=bar_h // 2, fill=(203, 213, 225) if i else (148, 163, 184))

    # 右下角绿色状态点（表示"已投递/进度"）
    r = round(s * 0.145)
    cx, cy = s - round(s * 0.215), s - round(s * 0.205)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 255, 255, 255))
    rr = round(r * 0.74)
    d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=ACCENT + (255,))

    img = img.resize((size, size), Image.LANCZOS)
    mask = rounded_mask(size, round(size * 0.22))
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    for s in SIZES:
        p = os.path.join(OUT, f"icon{s}.png")
        draw_icon(s).save(p, "PNG", optimize=True)
        print("wrote", p)


if __name__ == "__main__":
    main()
