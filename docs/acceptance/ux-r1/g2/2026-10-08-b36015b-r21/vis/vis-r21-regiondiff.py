#!/usr/bin/env python3
# vis-r21 区域逐像素 diff：同端连拍自差定噪声底，跨端差异对噪声底判定。
from PIL import Image
import sys

V = '/Users/chenpu/workspace/claude-code/TinySSH/docs/acceptance/ux-r1/g2/2026-10-08-b36015b-r21/vis/'
lines = []
def log(s=''):
    lines.append(s); print(s)

def diff(a_path, b_path, region=None, crop_b=None):
    a = Image.open(a_path).convert('RGB')
    b = Image.open(b_path).convert('RGB')
    if crop_b is not None:
        b = b.crop(crop_b)
    if region:
        a = a.crop(region); b = b.crop(region)
    if a.size != b.size:
        return {'size_mismatch': (a.size, b.size)}
    da, db = a.tobytes(), b.tobytes()
    n = len(da)
    diff_bytes = sum(1 for x, y in zip(da, db) if x != y)
    diff_px = 0
    w, h = a.size
    if diff_bytes:
        # 逐像素（RGB 3 字节）
        px = w * h
        step = 3
        diff_px = sum(1 for i in range(0, n, step) if da[i:i+3] != db[i:i+3])
    maxd = 0
    if diff_bytes:
        maxd = max(abs(x - y) for x, y in zip(da, db))
    return {'px_total': w * h, 'px_diff': diff_px, 'bytes_diff': diff_bytes, 'max_channel_delta': maxd}

HOSTBAR = (0, 0, 226, 800)
MAIN = (226, 0, 1280, 800)

log('vis-r21 region diff — 5183(new, R21 worktree) vs 5184(base, b36015b worktree)')
log('viewport 1280x800, real Chrome headless, demo backend, dark theme, fresh localStorage')
log('')

# ---- 噪声底：同端连拍 ----
log('== 噪声底（同端连拍自差，px_diff / px_total）==')
for end in ('new', 'base'):
    for shot in ('welcome', 'terminal'):
        r = diff(V + f'{end}-{shot}-1.png', V + f'{end}-{shot}-2.png')
        log(f'{end} {shot}: px_diff={r.get("px_diff")}/{r.get("px_total")} maxΔ={r.get("max_channel_delta")}')
    for shot in ('addhost', 'settings'):
        r = diff(V + f'{end}-{shot}-1.png', V + f'{end}-{shot}-2.png')
        log(f'{end} {shot}(element): px_diff={r.get("px_diff")}/{r.get("px_total")} maxΔ={r.get("max_channel_delta")}')
log('')

# ---- 跨端：设置弹窗（顶部 min(h) 区域 = 字号/主题区，必须逐位同）----
log('== 跨端 settings 弹窗 ==')
ni = Image.open(V + 'new-settings-1.png'); bi = Image.open(V + 'base-settings-1.png')
log(f'element size: new={ni.size} base={bi.size}（高差 {ni.size[1]-bi.size[1]}px = 新增凭据库空态区，宽同 {ni.size[0]==bi.size[0]}）')
top_h = min(ni.size[1], bi.size[1])
r = diff(V + 'new-settings-1.png', V + 'base-settings-1.png', region=(0, 0, ni.size[0], top_h))
log(f'TOP 区域(0,0,{ni.size[0]},{top_h}) 字号/主题区: px_diff={r.get("px_diff")}/{r.get("px_total")} maxΔ={r.get("max_channel_delta")}')
r2 = diff(V + 'new-settings-1.png', V + 'base-settings-1.png', region=(0, top_h, ni.size[0], ni.size[1]))
log(f'BOTTOM 区域(0,{top_h},{ni.size[0]},{ni.size[1]}) 新增凭据库空态: px_diff={r2.get("px_diff")}/{r2.get("px_total")}（预期非零=新面，不计回归）')
log('')

# ---- 跨端：添加主机表单（元素同尺寸，全量比）----
log('== 跨端 addhost 表单元素 ==')
r = diff(V + 'new-addhost-1.png', V + 'base-addhost-1.png')
log(f'px_diff={r.get("px_diff")}/{r.get("px_total")} maxΔ={r.get("max_channel_delta")} size={r.get("size_mismatch", "same")}')
log('')

# ---- 跨端：欢迎页（hostbar=已知差异面[新端多 otp-2 演示卡]；main 区必须 ≤ 噪声底）----
log('== 跨端 welcome ==')
r = diff(V + 'new-welcome-1.png', V + 'base-welcome-1.png', region=MAIN)
log(f'MAIN 区域 {MAIN}: px_diff={r.get("px_diff")}/{r.get("px_total")} maxΔ={r.get("max_channel_delta")}')
r = diff(V + 'new-welcome-1.png', V + 'base-welcome-1.png', region=HOSTBAR)
log(f'HOSTBAR 区域 {HOSTBAR}: px_diff={r.get("px_diff")}/{r.get("px_total")}（已知差异=R21 demo.ts 新增 otp-2 演示卡）')
# hostbar 差异定位：逐行扫差异的 y 范围
a = Image.open(V + 'new-welcome-1.png').convert('RGB').crop(HOSTBAR)
b = Image.open(V + 'base-welcome-1.png').convert('RGB').crop(HOSTBAR)
da, db = a.tobytes(), b.tobytes(); w, h = a.size; stride = w * 3
rows = [y for y in range(h) if da[y*stride:(y+1)*stride] != db[y*stride:(y+1)*stride]]
if rows:
    log(f'HOSTBAR 差异行范围: y∈[{rows[0]},{rows[-1]}] 共 {len(rows)} 行')
log('')

# ---- 跨端：终端态（main 区，光标闪烁入噪声底）----
log('== 跨端 terminal ==')
r = diff(V + 'new-terminal-1.png', V + 'base-terminal-1.png', region=MAIN)
log(f'MAIN 区域 {MAIN}: px_diff={r.get("px_diff")}/{r.get("px_total")} maxΔ={r.get("max_channel_delta")}')
log('')

open(V + 'region-diff.txt', 'w').write('\n'.join(lines) + '\n')
print('WROTE region-diff.txt')
