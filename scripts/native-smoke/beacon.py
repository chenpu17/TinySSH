from http.server import BaseHTTPRequestHandler, HTTPServer
import os, sys, time, urllib.parse

# 日志路径：`beacon.py <tag> <path>`（冒烟驱动用法，如 `beacon.py x /tmp/smoke-r32/beacon-r32.txt`）；
# 无第二参数时回落 T40 默认路径（/tmp/t40_smoke/beacon.log）。
# 历史教训（R35 补档实测）：旧版把路径写死默认值、忽略 argv——而 R31/R32/R33/R34 驱动都传了
# 自己的 $LOG，于是标记全落默认文件、驱动的 wait_mark 恒超时；又因驱动从 /tmp/smoke-r32/
# 拷「打了补丁的副本」（该临时目录已消失）才侥幸可用，repo 里的这份一直是失效的。
# 现显式接收路径参数，驱动直接拷 repo 版本即可自足。
LOG_PATH = sys.argv[2] if len(sys.argv) > 2 else '/tmp/t40_smoke/beacon.log'
_d = os.path.dirname(LOG_PATH)
if _d:
    os.makedirs(_d, exist_ok=True)

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        # /q/<s>：只读查询——进度日志中已出现过含 <s> 的行则 200，否则 404。
        # 查询本身不落日志（否则查询会自匹配）。T44 冒烟双角色同步用：
        # 注入脚本（人工角色）据此感知 shell 侧（Agent 角色）是否完成。
        if self.path.startswith('/q/'):
            s = urllib.parse.unquote(self.path[3:])
            hit = False
            try:
                with open(LOG_PATH) as f:
                    hit = any(s in urllib.parse.unquote(line) for line in f)
            except FileNotFoundError:
                pass
            self.send_response(200 if hit else 404)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(b'yes' if hit else b'no')
            return
        if self.path.startswith('/w/'):
            try:
                ms = min(int(self.path[3:]), 15000)
            except ValueError:
                ms = 100
            time.sleep(ms / 1000.0)
        with open(LOG_PATH, 'a') as f:
            f.write(self.path + '\n')
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(b'ok')
    def log_message(self, *a):
        pass
HTTPServer(('127.0.0.1', 15199), H).serve_forever()
