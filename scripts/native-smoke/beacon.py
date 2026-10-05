from http.server import BaseHTTPRequestHandler, HTTPServer
import time, urllib.parse
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        # /q/<s>：只读查询——进度日志中已出现过含 <s> 的行则 200，否则 404。
        # 查询本身不落日志（否则查询会自匹配）。T44 冒烟双角色同步用：
        # 注入脚本（人工角色）据此感知 shell 侧（Agent 角色）是否完成。
        if self.path.startswith('/q/'):
            s = urllib.parse.unquote(self.path[3:])
            hit = False
            try:
                with open('/tmp/t40_smoke/beacon.log') as f:
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
        with open('/tmp/t40_smoke/beacon.log', 'a') as f:
            f.write(self.path + '\n')
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(b'ok')
    def log_message(self, *a):
        pass
HTTPServer(('127.0.0.1', 15199), H).serve_forever()
