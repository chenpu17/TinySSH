import sys, json
from PIL import Image, ImageChops

EV = "/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g2/2026-10-08-ad652a2-r23/vis"

def diff(a, b):
    ia, ib = Image.open(f"{EV}/{a}").convert("RGB"), Image.open(f"{EV}/{b}").convert("RGB")
    d = ImageChops.difference(ia, ib)
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
for pair in [("cur/N1-noise-1.png","cur/N1-noise-2.png"), ("cur/N1-noise-2.png","cur/N1-noise-3.png"), ("cur/N1-noise-1.png","cur/N1-noise-3.png")]:
    n, bbox, detail = diff(*pair)
    out.append(f"[噪声底] {pair[0].split('/')[-1]}×{pair[1].split('/')[-1]} diff_px={n} bbox={bbox}")
    for m, pts in sorted(detail.items()):
        out.append(f"   max_delta={m} pts={len(pts)} 示例{pts[:6]}")

for face in ["A1-welcome", "A2-addform", "A3-settings"]:
    n, bbox, detail = diff(f"base/{face}.png", f"cur/{face}.png")
    out.append(f"[跨树] {face} diff_px={n} bbox={bbox}")
    for m, pts in sorted(detail.items()):
        out.append(f"   max_delta={m} pts={len(pts)} 示例{pts[:10]}")

print("\n".join(out))
open(f"{EV}/vis-r23-diff.txt", "w").write("vis-r23 像素 diff（PIL ImageChops.difference，1280x800 viewport，dsf=1）\n方法：双树同操作（base=worktree ad652a2 vite:5184，cur=工作树 vite:5183），每态 localStorage.clear() 后 reload 同初态，rAFx2+300ms 稳定后截图\n\n" + "\n".join(out) + "\n")
