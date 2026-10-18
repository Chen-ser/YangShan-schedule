# -*- coding: utf-8 -*-
"""从 shell/branding/app-icon.jpg 生成 Windows 的 app.ico 与安卓的各级图标。

这不是构建步骤的一部分（构建只读生成好的文件），只在**换品牌图时**手工跑一次：

    pip install pillow
    python tools/make-icons.py

输出：
    shells/windows/app.ico                              10 种尺寸，16 → 256
    shells/android/app/src/main/res/mipmap-{mdpi..xxxhdpi}/ic_launcher.png          传统方形
    shells/android/app/src/main/res/mipmap-{mdpi..xxxhdpi}/ic_launcher_round.png    传统圆形
    shells/android/app/src/main/res/mipmap-{mdpi..xxxhdpi}/ic_launcher_foreground.png  自适应前景

设计约束（改之前先读）：
  1. 自适应图标的前景必须画在 108dp 画布的**正中 72dp 安全区**里 —— 启动器的蒙版
     （圆形/圆角方形/水滴）只保证这 72dp 可见，画满 108dp 会被切掉四边。
     源图自带约 4% 白边，缩到 72dp 后徽章外圈约 66dp，正好落在安全区内。
  2. ICO 必须多带几种尺寸。只放一张 256 的话，任务栏和托盘会把 256 硬缩到 16，
     边缘糊成一团；Pillow 会为每个尺寸单独重采样。
  3. 生成的是位图，所以仓库里第一次出现二进制资源。之前用矢量 drawable 是为了
     避开二进制，但品牌图本身就是位图，矢量重绘的保真度不如直接用图。
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "shells" / "branding" / "app-icon.jpg"
RES = ROOT / "shells" / "android" / "app" / "src" / "main" / "res"
WIN = ROOT / "shells" / "windows"

BASE = 1024  # 母版边长：缩到 256 时仍有余量


def round_mask(im: Image.Image) -> Image.Image:
    """裁成圆，4 倍超采样后缩回来做抗锯齿。"""
    ss = 4
    big = Image.new("L", (im.width * ss, im.height * ss), 0)
    ImageDraw.Draw(big).ellipse((0, 0, big.width - 1, big.height - 1), fill=255)
    out = im.copy()
    out.putalpha(big.resize(im.size, Image.LANCZOS))
    return out


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"缺少品牌图：{SRC}")

    src = Image.open(SRC).convert("RGBA")
    if src.width != src.height:
        side = min(src.width, src.height)
        left, top = (src.width - side) // 2, (src.height - side) // 2
        src = src.crop((left, top, left + side, top + side))
    master = src.resize((BASE, BASE), Image.LANCZOS)

    ico_sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    WIN.mkdir(parents=True, exist_ok=True)
    master.save(WIN / "app.ico", format="ICO", sizes=[(s, s) for s in ico_sizes])
    print(f"app.ico  {len(ico_sizes)} 种尺寸  {(WIN / 'app.ico').stat().st_size} B")

    for name, size in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
        out = RES / f"mipmap-{name}"
        out.mkdir(parents=True, exist_ok=True)
        square = master.resize((size, size), Image.LANCZOS)
        square.save(out / "ic_launcher.png")
        round_mask(square).save(out / "ic_launcher_round.png")

    for name, mult in {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}.items():
        canvas_px = int(round(108 * mult))
        art_px = int(round(72 * mult))
        canvas = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
        off = (canvas_px - art_px) // 2
        canvas.alpha_composite(master.resize((art_px, art_px), Image.LANCZOS), (off, off))
        canvas.save(RES / f"mipmap-{name}" / "ic_launcher_foreground.png")

    print("安卓 mipmap 已更新：", ", ".join(sorted(p.name for p in RES.glob("mipmap-*"))))


if __name__ == "__main__":
    main()
