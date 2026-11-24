# TinySSH 应用图标生成源 · 视觉升级 v2。
# 设计延续「人写提示符，机器回块」：白色「>」= 人类提示符，
# 紫罗兰块状光标 = 命令块。v2 升级点：
#   1) 圆角矩形 → 真 squircle（n=4 超椭圆，连续曲率）；
#   2) 提示符加粗 76→84，光标块放大 210×160→228×176，小尺寸更可辨；
#   3) 光标块加磷光外晕，成为 dock / 任务栏里的识别点；
#   4) 背景加深并偏冷，顶部受光、底部压暗，紫色光晕收敛到光标附近。
# 4× 超采样抗锯齿；产物 src-tauri/icons/app-icon.png（1024，透明角），
# 再经 `cargo tauri icon src-tauri/icons/app-icon.png` 派生桌面全套 icns/ico/png。
# Android 各密度 launcher / round / foreground 由本脚本直接生成。
from PIL import Image, ImageDraw, ImageFilter, ImageChops
import glob
import math
import os

S = 4                     # 超采样倍率
W = 1024 * S              # 工作画布
OUT = 1024                # 输出尺寸
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANDROID_RES = os.path.join(ROOT, "src-tauri/gen/android/app/src/main/res")

# ---- 色板 ----
BG_TOP = (26, 34, 62)     # 顶部海军蓝紫
BG_BOT = (9, 12, 22)      # 底部近黑
GLOW = (124, 92, 255)     # 紫色光晕
FG = (240, 243, 250)      # 提示符白
BAR_TOP = (167, 139, 255) # 光标块渐变顶
BAR_BOT = (109, 76, 255)  # 光标块渐变底

# ---- 几何：squircle 与字形（1024 坐标系）----
MARGIN = 96               # 图标内边距（透明角）
CHEV = [(255, 318), (467, 512), (255, 706)]
CHEV_W = 84
BAR = (584, 532, 812, 708)  # x0, y0, x1, y1
BAR_R = 52


def squircle_points(size, margin, n=4.0, samples=720):
    """n 阶超椭圆采样点：连续曲率的 squircle 轮廓。"""
    a = (size - 2 * margin) / 2
    c = size / 2
    pts = []
    for i in range(samples):
        t = 2 * math.pi * i / samples
        ct, st = math.cos(t), math.sin(t)
        x = a * math.copysign(abs(ct) ** (2 / n), ct)
        y = a * math.copysign(abs(st) ** (2 / n), st)
        pts.append((c + x, c + y))
    return pts


def squircle_mask(size, margin, n=4.0):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).polygon(squircle_points(size, margin, n), fill=255)
    return m


def background(size):
    """垂直渐变底 + 收敛的紫色光晕，按 squircle 裁形。"""
    g = Image.new("RGBA", (size, size))
    gd = ImageDraw.Draw(g)
    for y in range(size):
        t = y / (size - 1)
        c = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOT))
        gd.line([(0, y), (size, y)], fill=c + (255,))
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gl = ImageDraw.Draw(glow)
    cx, cy, r = int(size * 0.40), int(size * 0.34), int(size * 0.58)
    gl.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GLOW + (100,))
    glow = glow.filter(ImageFilter.GaussianBlur(size // 8))
    g.alpha_composite(glow)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    m = round(MARGIN * size / 1024)
    out.paste(g, (0, 0), squircle_mask(size, m))
    # 内缘高光：细一圈白，模拟切面受光
    rim = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rim)
    pts = squircle_points(size, m + max(1, round(2 * size / 1024)))
    rd.line(pts + [pts[0]], fill=(255, 255, 255, 24),
            width=max(1, round(3 * size / 1024)), joint="curve")
    out.alpha_composite(rim)
    return out


def glyphs(size, with_glow=True):
    """提示符 + 块状光标（透明底）。with_glow=False 用于单色/自适应前景。"""
    k = size / 1024
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bx0, by0, bx1, by1 = [round(v * k) for v in BAR]
    # 光标磷光外晕：先画一层模糊紫色，再压实体块
    if with_glow:
        halo = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        hd = ImageDraw.Draw(halo)
        pad = round(30 * k)
        hd.rounded_rectangle([bx0 - pad, by0 - pad, bx1 + pad, by1 + pad],
                             radius=round((BAR_R + 30) * k), fill=GLOW + (110,))
        halo = halo.filter(ImageFilter.GaussianBlur(round(26 * k)))
        layer.alpha_composite(halo)
    # 提示符「>」：圆头圆接折线
    mk = ImageDraw.Draw(layer)
    chev = [(round(x * k), round(y * k)) for x, y in CHEV]
    mk.line(chev, fill=FG + (255,), width=round(CHEV_W * k), joint="curve")
    cap_r = CHEV_W * k / 2
    for px, py in (chev[0], chev[2]):
        mk.ellipse([px - cap_r, py - cap_r, px + cap_r, py + cap_r], fill=FG + (255,))
    # 块状光标：紫渐变 + 顶部玻璃受光
    bw, bh = bx1 - bx0, by1 - by0
    bgrad = Image.new("RGBA", (bw, 1))
    for x in range(bw):
        t = x / (bw - 1)
        c = tuple(round(a + (b - a) * t) for a, b in zip(BAR_TOP, BAR_BOT))
        bgrad.putpixel((x, 0), c + (255,))
    bgrad = bgrad.resize((bw, bh))
    bmask = Image.new("L", (bw, bh), 0)
    ImageDraw.Draw(bmask).rounded_rectangle([0, 0, bw - 1, bh - 1],
                                            radius=round(BAR_R * k), fill=255)
    layer.paste(bgrad, (bx0, by0), bmask)
    sheen = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    shd = ImageDraw.Draw(sheen)
    for y in range(bh * 45 // 100):
        a = round(34 * (1 - y / (bh * 45 / 100)))
        shd.line([(0, y), (bw, y)], fill=(255, 255, 255, a))
    sheen.putalpha(ImageChops.multiply(sheen.getchannel("A"), bmask))
    layer.alpha_composite(sheen, (bx0, by0))
    return layer


def compose(size, circle=False):
    if circle:
        base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        bg = background(size)
        cmask = Image.new("L", (size, size), 0)
        m = round(MARGIN * size / 1024)
        ImageDraw.Draw(cmask).ellipse([m, m, size - m, size - m], fill=255)
        base.paste(bg, (0, 0), cmask)
    else:
        base = background(size)
    base.alpha_composite(glyphs(size))
    return base


# ---- 1) 桌面母版：1024 全尺寸，透明 squircle 角 ----
icon = compose(W).resize((OUT, OUT), Image.LANCZOS)
icon.save(os.path.join(ROOT, "src-tauri/icons/app-icon.png"))

# ---- 2) 预览板：深 / 浅底各一排，16–512px ----
SIZES = [512, 256, 128, 64, 32, 16]
PAD, COL_W = 40, 560
sheet = Image.new("RGBA", (PAD * 2 + COL_W * 2, 660), (0, 0, 0, 0))
for col, bgc in enumerate([(12, 16, 23, 255), (238, 240, 244, 255)]):
    panel = Image.new("RGBA", (COL_W, 660), bgc)
    x = 24
    for sz in SIZES:
        y = 620 - sz
        panel.alpha_composite(icon.resize((sz, sz), Image.LANCZOS), (x, y))
        x += sz + 24
    sheet.alpha_composite(panel, (col * COL_W + PAD, 20))
sheet.save(os.path.join(ROOT, "src-tauri/icons/icon-preview.png"))

# ---- 3) Android：沿用各密度既有文件尺寸，逐个重渲染 ----
for path in sorted(glob.glob(os.path.join(ANDROID_RES, "mipmap-*/*.png"))):
    name = os.path.basename(path)
    target = Image.open(path).size[0]
    size = target * S
    if name == "ic_launcher.png":
        im = compose(size).resize((target, target), Image.LANCZOS)
    elif name == "ic_launcher_round.png":
        im = compose(size, circle=True).resize((target, target), Image.LANCZOS)
    elif name == "ic_launcher_foreground.png":
        # 自适应前景：透明底纯字形，字形占宽 58% < 安全区 66/108，缩放裁剪安全
        im = glyphs(size).resize((target, target), Image.LANCZOS)
    else:
        continue
    im.save(path)

# Android 自适应图标的单色背景也必须走品牌色：cargo tauri icon 默认生成 #fff，
# 若不在生成源里收回，下次重建会悄悄退回白底。
ANDROID_BG = "#151D35"
with open(os.path.join(ANDROID_RES, "values", "ic_launcher_background.xml"),
          "w", encoding="utf-8", newline="\n") as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n'
            '<resources>\n'
            f'  <color name="ic_launcher_background">{ANDROID_BG}</color>\n'
            '</resources>\n')
adaptive_dir = os.path.join(ANDROID_RES, "mipmap-anydpi-v26")
os.makedirs(adaptive_dir, exist_ok=True)
with open(os.path.join(adaptive_dir, "ic_launcher.xml"),
          "w", encoding="utf-8", newline="\n") as f:
    f.write('<?xml version="1.0" encoding="utf-8"?>\n'
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
            '  <background android:drawable="@color/ic_launcher_background"/>\n'
            '</adaptive-icon>\n')

print("ok: app-icon.png + icon-preview.png + Android mipmap / adaptive 全套")
