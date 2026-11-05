# -*- coding: utf-8 -*-
"""生成 zcode-pilot 的品牌图形（assets/icon.png / assets/banner.png）。

设计语言
--------
* **循点（Orbit Dot）**：一个只开一道缝的圆环，环心压着一颗实心原点。
  环＝循环、缝＝断点、原点＝正在跑的这一轮 —— 「把中断的一轮接回轨道」。
* **极简**：没有箭头、没有渐变、没有高光，只有「环 + 点」两个几何体。
  装饰全部去掉后，小尺寸下轮廓仍只由两条信息构成，不会糊成一团。
* **单色可反白**：图形本身只有一种颜色。深底白标（icon）与浅底墨标（banner）
  是同一份图形的正反两用，不做渐变，也不靠半透明叠色制造层次。

几何比例（相对标志盒 S）
-----------------------
  环中线半径 r = 0.255·S      线宽 w = 0.072·S
  缺口 52°，平分线指向右上 45°（PIL 角 315°）
  点半径 1.35·w，落在环心 —— 「循环里正在跑的那一轮」

实现要点（都是踩过的坑）
-----------------------
1. PIL 的 arc 线宽**向内**生长，所以 bbox 半径要取 r + w/2，描边才以 r 居中；
2. icon 用 4 倍超采样后 LANCZOS 降采样，圆环边缘才不会出现阶梯锯齿；
3. 标志先画在透明层上、按 alpha 包围盒裁切再缩放，避免手算 bbox 产生偏差；
4. 文本用系统字体，取不到就退回默认字体（生成器是开发工具，不能因字体缺失而崩）；
   中文必须单独找 CJK 字体，否则会渲染成一排「豆腐块」。

用法：
    python tools/make_logo.py            # 重新生成两个资源
"""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
SS = 4  # 超采样倍数（只用于 icon 的几何描边）

# 单色系：只有墨与纸两个值，正反两用
INK = (16, 19, 25)        # #101319
PAPER = (245, 245, 243)   # #F5F5F3
MUTED = (98, 104, 112)    # #626870

# 标志几何（相对标志盒 S）
R_RATIO = 0.255
W_RATIO = 0.072
GAP_DEG = 52.0            # 缺口只开一道缝：再大就退化成「C 加一个点」
GAP_MID = 315.0           # 缺口平分线：右上 45°
DOT_RATIO = 1.35          # 点半径 = 1.35 × 线宽（太大就读成「©」）
SQUIRCLE_RATIO = 0.225


# ---------------------------------------------------------------- 标志本体

def _draw_mark(layer: Image.Image, cx: float, cy: float, s: float, fill) -> None:
    """在 layer 上以 (cx, cy) 为环心画「循点」标志，s 为标志盒边长。"""
    r = R_RATIO * s
    w = W_RATIO * s
    d = ImageDraw.Draw(layer)

    half = GAP_DEG / 2.0
    start = (GAP_MID + half) % 360.0
    end = start + (360.0 - GAP_DEG)
    # bbox 半径 = r + w/2：arc 的描边从 bbox 向内生长，线宽才以 r 居中。
    br = r + w / 2.0
    d.arc((cx - br, cy - br, cx + br, cy + br), start=start, end=end,
          fill=fill, width=max(1, round(w)))

    # 原点落在正中心：与环同权重的实体，视线有落点，也不会读成「C 加一点」。
    dr = DOT_RATIO * w
    d.ellipse((cx - dr, cy - dr, cx + dr, cy + dr), fill=fill)


@lru_cache(maxsize=1)
def _mark_master() -> Image.Image:
    """高分辨率母版（白色 + 透明底），按 alpha 包围盒裁掉留白。"""
    box = 3072
    pad = 0.08
    canvas = round(box * (1 + 2 * pad))
    layer = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    _draw_mark(layer, canvas / 2.0, canvas / 2.0, box, (255, 255, 255, 255))
    return layer.crop(layer.getchannel("A").getbbox())


def render_mark(ink_px: int) -> Image.Image:
    """宽度缩放到 ink_px 的标志（白色、透明底）。"""
    master = _mark_master()
    h = max(1, round(ink_px * master.height / master.width))
    return master.resize((ink_px, h), Image.LANCZOS)


def _tint(img: Image.Image, color) -> Image.Image:
    """把白色标志换成任意颜色：整体只有一个色调，只改 RGB、保留 alpha。"""
    out = Image.new("RGBA", img.size, tuple(color) + (0,))
    out.putalpha(img.getchannel("A"))
    return out


def _squircle(size: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size - 1, size - 1),
                                        radius=int(size * SQUIRCLE_RATIO), fill=255)
    return m


# ---------------------------------------------------------------- 资源

def build_icon(size: int = 512) -> Image.Image:
    """深底 + 浅标志：icon 自身带底色，浅色桌面上边界清楚。"""
    s = size * SS
    bg = Image.new("RGBA", (s, s), INK + (255,))
    bg.putalpha(_squircle(s))

    ink_px = round(s * 0.60)
    mark = _tint(render_mark(ink_px), PAPER)
    # 缺口在右上，分量偏左下；整体往右上挪一点点，视觉中心才落回几何中心。
    ox = (s - mark.width) // 2 + round(s * 0.003)
    oy = (s - mark.height) // 2 - round(s * 0.005)
    bg.alpha_composite(mark, (ox, oy))

    # 极淡内描边：深色桌面上圆角仍有边界，浅色桌面上不抢眼。
    edge = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(edge).rounded_rectangle(
        (0, 0, s - 1, s - 1), radius=int(s * SQUIRCLE_RATIO),
        outline=(255, 255, 255, 18), width=max(1, round(s * 0.006)))
    bg.alpha_composite(edge)

    return bg.resize((size, size), Image.LANCZOS)


_LATIN_FONTS = ("segoeuib.ttf", "segoeui.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf")
# 中文必须单独找字体：Segoe UI 之类没有 CJK 字形，会渲染成一排「豆腐块」方框。
_CJK_FONTS = ("msyhbd.ttc", "msyh.ttc", "simhei.ttf", "NotoSansCJK-Bold.ttc",
              "SourceHanSansSC-Bold.otf", "PingFang.ttc", "wqy-zenhei.ttc")
_FONT_DIRS = (Path("C:/Windows/Fonts"), Path("/System/Library/Fonts"),
              Path("/usr/share/fonts/truetype/dejavu"),
              Path("/usr/share/fonts/opentype/noto"))


def _load_font(size: int, *, cjk: bool = False):
    """系统字体优先，取不到就退回 PIL 默认字体（不因环境差异而崩）。"""
    for name in (_CJK_FONTS if cjk else _LATIN_FONTS):
        for base in _FONT_DIRS:
            p = base / name
            if p.is_file():
                try:
                    return ImageFont.truetype(str(p), size)
                except Exception:
                    pass
    return None if cjk else ImageFont.load_default()


def _text_tracked(draw: ImageDraw.ImageDraw, xy, text: str, font,
                  fill, tracking: float = 0.0) -> None:
    """逐字绘制以加字距 —— PIL 原生没有 letter-spacing。"""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking


def build_banner(w: int = 1280, h: int = 420) -> Image.Image:
    """纸底 + 墨标：与 icon 正好反白，两件资源摆在一起能看出是同一套图形。"""
    base = Image.new("RGBA", (w, h), PAPER + (255,))

    # 右侧水印：同一标志压到极低不透明度，大半出画，只留一点纵深。
    wm_px = round(h * 0.78)
    wm = _tint(render_mark(wm_px), INK)
    wm.putalpha(wm.getchannel("A").point(lambda v: round(v * 0.05)))
    base.alpha_composite(wm, (w - round(wm_px * 0.48), (h - wm.height) // 2 + 14))

    # 前景标志
    ink_px = round(h * 0.40)
    mark = _tint(render_mark(ink_px), INK)
    mx = 96
    my = (h - mark.height) // 2 + round(ink_px * 0.006)
    base.alpha_composite(mark, (mx, my))

    # 字样：字距略放开，极简版面靠留白与间距立住，不靠装饰
    d = ImageDraw.Draw(base)
    tx = mx + mark.width + 58
    title_px = round(h * 0.176)
    sub_px = round(h * 0.057)
    title, f_title = "ZCode Pilot", _load_font(title_px)

    f_sub = _load_font(sub_px, cjk=True)
    subtitle = "自动继续 · 循环守卫 · 实时遥测"
    if f_sub is None:                      # 没有中文字体就退回英文，绝不画豆腐块
        f_sub, subtitle = _load_font(round(h * 0.055)), \
            "Auto-Continue · Loop Guard · Live Telemetry"

    # 按实测包围盒排版：PIL 的 text y 是 em 框顶部，按字号硬推会撞行。
    tb = d.textbbox((0, 0), title, font=f_title)
    sb = d.textbbox((0, 0), subtitle, font=f_sub)
    th, sh = tb[3] - tb[1], sb[3] - sb[1]
    gap = round(h * 0.048)
    top = round((h - (th + gap + sh)) / 2)

    _text_tracked(d, (tx, top - tb[1]), title, f_title, INK + (255,),
                  tracking=title_px * 0.014)
    _text_tracked(d, (tx + 2, top + th + gap - sb[1]), subtitle, f_sub,
                  MUTED + (255,), tracking=sub_px * 0.09)

    return base.convert("RGB")


if __name__ == "__main__":
    ASSETS.mkdir(parents=True, exist_ok=True)
    build_icon(512).save(ASSETS / "icon.png")
    build_banner().save(ASSETS / "banner.png")
    print("wrote", ASSETS / "icon.png", ASSETS / "banner.png")
