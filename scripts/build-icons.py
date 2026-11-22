#!/usr/bin/env python
"""从参考图生成「沮诵」品牌图标资产（方案 E：内裁 + 重新圆角 + padding）。

输入：scripts/app-icon-source.png（朱红圆角方块 + 纸白「沮」书页图形）
输出：
  scripts/app-icon.png            1024x1024 完整图标（透明留边，桌面/通用）
  scripts/app-icon-bg.png         1024x1024 Android 自适应图标背景（纯朱红）
  scripts/app-icon-fg.png         1024x1024 Android 自适应图标前景（纸白图形，透明底）
  scripts/app-icon.manifest.json  Tauri icon 清单（含 Android 自适应配置）
  public/brand/glyph-mask.png     1024x1024 可复用抽象图形 alpha 遮罩（全部米白像素：书页 + 沮形记号）

做法：
  1. 从参考图朱红区域向内裁 8%，四角全部落在朱红内部（彻底去掉参考图白边）；
  2. 用边长 20% 的圆角重新切边（切口在朱红内部，不会产生白边）；
  3. 缩放到 88% 后居中放到 1024 透明画布，四周留 6% padding。

用法：
  python scripts/build-icons.py            # 需要 Pillow + numpy
  pnpm tauri icon scripts/app-icon.manifest.json
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "app-icon-source.png"
ICON_SIZE = 1024
PADDING_RATIO = 0.06
INSET_RATIO = 0.08
CORNER_RATIO = 0.20
RED = (159, 41, 28)
PAPER = (249, 238, 227)


def load_source() -> Image.Image:
    image = Image.open(SOURCE).convert("RGB")
    if image.width != image.height:
        raise SystemExit(f"参考图必须是正方形，当前为 {image.size}")
    return image


def red_bounds(image: Image.Image) -> tuple[int, int, int, int]:
    array = np.asarray(image)
    mask = array.min(axis=2) < 120
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    return int(cols[0]), int(rows[0]), int(cols[-1]), int(rows[-1])


def rounded_mask(size: int, radius: int) -> Image.Image:
    scale = 4
    big = Image.new("L", (size * scale, size * scale), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size * scale - 1, size * scale - 1),
        radius=max(1, radius) * scale,
        fill=255,
    )
    return big.resize((size, size), Image.LANCZOS)


def extract_glyph(icon: Image.Image) -> Image.Image:
    """从完整图标中提取纸白图形（透明底），供 Android 自适应前景使用。"""
    array = np.asarray(icon).astype(np.float32)
    rgb = array[..., :3]
    alpha_full = array[..., 3] / 255.0
    low = rgb.min(axis=2)
    warmth = np.clip((rgb[..., 0] - rgb[..., 2] - 6) / 10.0, 0.0, 1.0)
    alpha = np.clip((low - 110) / 120.0, 0.0, 1.0) * warmth * alpha_full
    glyph = np.zeros((icon.height, icon.width, 4), dtype=np.uint8)
    glyph[..., 0] = PAPER[0]
    glyph[..., 1] = PAPER[1]
    glyph[..., 2] = PAPER[2]
    glyph[..., 3] = (np.clip(alpha, 0.0, 1.0) * 255).astype(np.uint8)
    return Image.fromarray(glyph, "RGBA")


def main() -> None:
    source = load_source()
    x0, y0, x1, y1 = red_bounds(source)
    side = min(x1 - x0 + 1, y1 - y0 + 1)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    inset = int(round(side * INSET_RATIO))
    inner = side - 2 * inset
    left, top = cx - inner // 2, cy - inner // 2
    crop = source.crop((left, top, left + inner, top + inner))
    print(f"source={source.size} red_bounds=({x0},{y0},{x1},{y1}) inner={inner}px")

    radius = int(round(inner * CORNER_RATIO))
    mask = rounded_mask(inner, radius)
    artwork = crop.convert("RGBA")
    artwork.putalpha(mask)

    target = int(round(ICON_SIZE * (1 - PADDING_RATIO * 2)))
    artwork = artwork.resize((target, target), Image.LANCZOS)
    offset = (ICON_SIZE - target) // 2
    icon = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), (0, 0, 0, 0))
    icon.alpha_composite(artwork, (offset, offset))
    icon.save(ROOT / "app-icon.png", optimize=True)

    # Android 自适应图标：纯朱红背景 + 纸白图形前景
    Image.new("RGBA", (ICON_SIZE, ICON_SIZE), (*RED, 255)).save(
        ROOT / "app-icon-bg.png", optimize=True
    )
    # Android 自适应图标前景：纸白图形透明底（包含书页轮廓与「沮」形记号的全部米白像素）
    glyph = extract_glyph(icon)
    glyph.save(ROOT / "app-icon-fg.png", optimize=True)

    # 可复用装饰素材：全部米白像素的 alpha mask（白色 + 透明），供 Hero 水印用 CSS mask 上色。
    glyph_array = np.asarray(glyph)
    alpha = glyph_array[..., 3]
    ys, xs = np.where(alpha > 8)
    if len(xs) == 0:
        raise SystemExit("前景提取失败：没有可见像素")
    pad = int(max(xs.max() - xs.min() + 1, ys.max() - ys.min() + 1) * 0.04)
    side = max(xs.max() - xs.min() + 1, ys.max() - ys.min() + 1) + pad * 2
    cx, cy = (int(xs.min()) + int(xs.max())) // 2, (int(ys.min()) + int(ys.max())) // 2
    left, top = cx - side // 2, cy - side // 2
    mask = np.zeros((side, side), dtype=np.uint8)
    src_left, src_top = max(0, left), max(0, top)
    src_right = min(glyph.width, left + side)
    src_bottom = min(glyph.height, top + side)
    mask[
        src_top - top : src_bottom - top,
        src_left - left : src_right - left,
    ] = alpha[src_top:src_bottom, src_left:src_right]
    mask_canvas = np.zeros((side, side, 4), dtype=np.uint8)
    mask_canvas[..., :3] = 255
    mask_canvas[..., 3] = mask
    public_brand = ROOT.parent / "public" / "brand"
    public_brand.mkdir(parents=True, exist_ok=True)
    Image.fromarray(mask_canvas, "RGBA").resize((1024, 1024), Image.LANCZOS).save(
        public_brand / "glyph-mask.png", optimize=True
    )

    manifest = {
        "default": "app-icon.png",
        "bg_color": "#9F291C",
        "android_bg": "app-icon-bg.png",
        "android_fg": "app-icon-fg.png",
        "android_fg_scale": 85,
    }
    (ROOT / "app-icon.manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("wrote app-icon.png / app-icon-bg.png / app-icon-fg.png / app-icon.manifest.json")


if __name__ == "__main__":
    main()
