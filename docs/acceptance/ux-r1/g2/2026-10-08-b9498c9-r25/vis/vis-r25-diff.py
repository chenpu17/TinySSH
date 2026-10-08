import json
from PIL import Image, ImageChops

EV = "/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g2/2026-10-08-b9498c9-r25/vis"

def diff_img(ia, ib, crop=None):
    if crop:
        ia, ib = ia.crop(crop), ib.crop(crop)
    d = ImageChops.difference(ia.convert("RGB"), ib.convert("RGB"))
    bbox = d.getbbox()
    px = d.load() if bbox else None
    n = 0; detail = {}
    if bbox:
        for y in range(bbox[1], bbox[3]):
            for x in range(bbox[0], bbox[2]):
                p = px[x, y]
                if p != (0, 0, 0):
                    n += 1
                    m = max(p)
                    detail.setdefault(m, []).append((x, y))
    return n, bbox, detail

out = []
rep = json.load(open(f"{EV}/vis-r25-driverreport.json"))
lines = [r for r in rep["results"]]

# 噪声底：cur 同端连拍自差
for pair in [("cur/N1-noise-1.png","cur/N1-noise-2.png"), ("cur/N1-noise-2.png","cur/N1-noise-3.png"), ("cur/N1-noise-1.png","cur/N1-noise-3.png")]:
    n, bbox, detail = diff_img(Image.open(f"{EV}/{pair[0]}"), Image.open(f"{EV}/{pair[1]}"))
    out.append(f"[噪声底] {pair[0].split('/')[-1]}×{pair[1].split('/')[-1]} diff_px={n} bbox={bbox}")
    for m, pts in sorted(detail.items()):
        out.append(f"   max_delta={m} pts={len(pts)} 示例{pts[:6]}")

# 零回归面全图：A1/A2/A4/A5（A3 拆两部）
for face in ["A1-welcome", "A2-addform", "A4-search", "A5-deadbanner"]:
    n, bbox, detail = diff_img(Image.open(f"{EV}/base/{face}.png"), Image.open(f"{EV}/cur/{face}.png"))
    out.append(f"[跨树] {face} diff_px={n} bbox={bbox}")
    for m, pts in sorted(detail.items()):
        out.append(f"   max_delta={m} pts={len(pts)} 示例{pts[:8]}")

# A3 设置弹窗：上部（0..312=字号快捷键行 bottom 312.1 之上，两树锚点一致）应零 diff；
# 全图 diff 预期只在粘贴 section（y>=324）
for tag, crop in [("A3上部(0..313)", (0, 0, 1280, 313)), ("A3全图", None)]:
    n, bbox, detail = diff_img(Image.open(f"{EV}/base/A3-settings.png"), Image.open(f"{EV}/cur/A3-settings.png"), crop=crop)
    out.append(f"[跨树] {tag} diff_px={n} bbox={bbox}")
    for m, pts in sorted(detail.items()):
        out.append(f"   max_delta={m} pts={len(pts)} 示例{pts[:8]}")

print("\n".join(out))
open(f"{EV}/vis-r25-diff.txt", "w").write(
    "vis-r25 像素 diff（PIL ImageChops.difference，1280x800 viewport，dsf=1）\n"
    "方法：双树同操作（base=worktree b9498c9 vite:5184，cur=工作树 vite:5183），每态 localStorage.clear() 后 reload 同初态，rAFx2+300ms 稳定后截图\n"
    "A3 上部裁剪线=313px（字号快捷键提示行 bottom 312.1 之上，两树锚点 y 完全一致：字号144/主题202/快捷键295.1）\n"
    "A3 预期 delta=粘贴 section：基线凭据库 y=324.1 → 当前树凭据库 y=456.9（Δ132.8=弹窗高差 464.2-331.4）\n\n" + "\n".join(out) + "\n")
