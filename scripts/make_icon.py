# TinySSH 应用图标生成源（十轮品牌重设计）。
# 设计语言：深海军紫 squircle + 辐射光晕；白色「>」= 人类提示符，
# 紫渐变块状光标 = Agent/命令块（应用签名概念）——「人写提示符，机器回块」。
# 4× 超采样抗锯齿；产物 icons/app-icon.png（1024，透明角），
# 再经 `cargo tauri icon icons/app-icon.png` 派生全套 icns/ico/png。
from PIL import Image, ImageDraw, ImageFilter

S = 4                     # 超采样倍率
W = 1024 * S              # 工作画布
OUT = 1024                # 输出尺寸

# ---- 色板（取自 UI：背景 #0c1017，accent 紫罗兰）----
BG_TOP = (23, 32, 58)     # 顶部海军紫
BG_BOT = (11, 15, 27)     # 底部深黑蓝
GLOW = (124, 92, 255)     # 辐射光晕
FG = (240, 243, 250)      # 提示符白
BAR_TOP = (161, 141, 255) # 光标块渐变顶
BAR_BOT = (108, 74, 255)  # 光标块渐变底

canvas = Image.new("RGBA", (W, W), (0, 0, 0, 0))

# ---- 1) 背景：垂直渐变 ----
grad = Image.new("RGBA", (W, W))
gd = ImageDraw.Draw(grad)
for y in range(W):
    t = y / (W - 1)
    c = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOT))
    gd.line([(0, y), (W, y)], fill=c + (255,))
canvas.paste(grad, (0, 0))

# ---- 2) 辐射光晕（左上偏置，柔边）----
glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
gl = ImageDraw.Draw(glow)
cx, cy, r = int(W * 0.42), int(W * 0.38), int(W * 0.55)
gl.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GLOW + (95,))
glow = glow.filter(ImageFilter.GaussianBlur(W // 9))
canvas.alpha_composite(glow)

# ---- 3) squircle 裁形（22% 圆角）+ 内缘高光 ----
margin = 100 * S
radius = 224 * S
mask = Image.new("L", (W, W), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([margin, margin, W - margin, W - margin], radius=radius, fill=255)
bg_squircle = Image.new("RGBA", (W, W), (0, 0, 0, 0))
bg_squircle.paste(canvas, (0, 0), mask)
canvas = bg_squircle
stroke = Image.new("RGBA", (W, W), (0, 0, 0, 0))
sd = ImageDraw.Draw(stroke)
sd.rounded_rectangle(
    [margin + 2 * S, margin + 2 * S, W - margin - 2 * S, W - margin - 2 * S],
    radius=radius - 2 * S, outline=(255, 255, 255, 26), width=3 * S,
)
canvas.alpha_composite(stroke)

# ---- 4) 提示符「>」：白色圆头折线（人）----
mark = Image.new("RGBA", (W, W), (0, 0, 0, 0))
mk = ImageDraw.Draw(mark)
chev = [(261 * S, 324 * S), (461 * S, 512 * S), (261 * S, 700 * S)]
mk.line(chev, fill=FG + (255,), width=76 * S, joint="curve")
cap_r = 38 * S  # 圆头端帽（线宽/2）
for px, py in (chev[0], chev[2]):
    mk.ellipse([px - cap_r, py - cap_r, px + cap_r, py + cap_r], fill=FG + (255,))
canvas.alpha_composite(mark)

# ---- 5) 块状光标：紫渐变圆角块（机器/命令块）----
bar = Image.new("RGBA", (W, W), (0, 0, 0, 0))
bx0, by0, bx1, by1 = 591 * S, 540 * S, 801 * S, 700 * S
bgrad = Image.new("RGBA", (by1 - by0, 1))
for x in range(by1 - by0):
    t = x / (by1 - by0 - 1)
    c = tuple(round(a + (b - a) * t) for a, b in zip(BAR_TOP, BAR_BOT))
    bgrad.putpixel((x, 0), c + (255,))
bgrad = bgrad.resize((bx1 - bx0, by1 - by0))
bmask = Image.new("L", (bx1 - bx0, by1 - by0), 0)
ImageDraw.Draw(bmask).rounded_rectangle(
    [0, 0, bx1 - bx0 - 1, by1 - by0 - 1], radius=44 * S, fill=255
)
bar.paste(bgrad, (bx0, by0), bmask)
# 块面光泽：上半部一层极淡的白色渐隐（玻璃受光），按圆角裁剪后叠加
sheen = Image.new("RGBA", (bx1 - bx0, by1 - by0), (0, 0, 0, 0))
shd = ImageDraw.Draw(sheen)
for y in range((by1 - by0) * 45 // 100):
    a = round(36 * (1 - y / ((by1 - by0) * 45 / 100)))
    shd.line([(0, y), (bx1 - bx0, y)], fill=(255, 255, 255, a))
from PIL import ImageChops
sheen.putalpha(ImageChops.multiply(sheen.getchannel("A"), bmask))
bar.alpha_composite(sheen, (bx0, by0))
canvas.alpha_composite(bar)

# ---- 6) 缩采样输出 + 预览板 ----
icon = canvas.resize((OUT, OUT), Image.LANCZOS)
icon.save("src-tauri/icons/app-icon.png")

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
sheet.save("src-tauri/icons/icon-preview.png")
print("ok: app-icon.png + icon-preview.png")
