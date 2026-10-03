from http.server import BaseHTTPRequestHandler, HTTPServer
import time, urllib.parse
class H(BaseHTTPRequestHandler):
    def do_GET(self):
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
