#!/usr/bin/env python3
"""T44 真机冒烟 Agent 侧：持真实 token 经内嵌 MCP 端点驱动转发审批链。

与 src-tauri 注入脚本（人工角色，TINYSSH_SMOKE harness）经 beacon.log 协作：
  等 beacon 三信号（mcp| 端点、agent-token|、session-id|）→ MCP initialize
  握手（真实 Bearer）→ forward_start(-L 127.0.0.1:15432→容器 127.0.0.1:22，
  阻塞等人工批准）→ forwards_list 等 Listening → 本地直连读 SSH banner →
  forward_stop（等人工批准）→ 等 forwards 清空 → forward_start(-L :15433→
  容器 127.0.0.1:9) → 直连触发 refused → 等 Degraded → AGENT-DONE。
末尾对 beacon.log 做全链存在性核账（人工侧的卡/批/状态行一并检查；不校验
行序——时序由各步自身超时异常路径把守）。退出码 0 = Agent 数据面 + beacon
核账全过；UI 事件驱动刷新的实证以真机前后对照截图为准（docs/acceptance/
screenshots/），不在本退出码判定内。

用法：python3 scripts/native-smoke/t44_agent.py（beacon 与 app 已在跑）
"""
import json
import re
import socket
import sys
import time
import urllib.parse
import urllib.request

LOG = "/tmp/t40_smoke/beacon.log"
BEACON = "http://127.0.0.1:15199"
GOOD_PORT = 15432   # -L → 容器 sshd（banner 可读）
BAD_PORT = 15433    # -L → 容器 127.0.0.1:9（refused → Degraded）


def t(step):
    urllib.request.urlopen(f"{BEACON}/t/{urllib.parse.quote(step)}", timeout=10).read()


def log_lines():
    try:
        with open(LOG) as f:
            return [urllib.parse.unquote(l.strip()) for l in f]
    except FileNotFoundError:
        return []


def wait_signal(prefix, timeout=180):
    """等 beacon.log 出现以 /t/<prefix>| 开头的行，返回 | 后的值。"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        for l in log_lines():
            if l.startswith(f"/t/{prefix}|"):
                return l[len(f"/t/{prefix}|"):]
        time.sleep(0.4)
    raise SystemExit(f"beacon-wait-timeout: {prefix}")


def strip_sse(body):
    """SSE 流式响应剥成 JSON 文本（非 SSE 原样返回）。"""
    if "data:" in body:
        return "\n".join(l[len("data:"):].strip() for l in body.splitlines() if l.startswith("data:"))
    return body


class Mcp:
    def __init__(self, ep, tok):
        self.ep, self.tok, self.sid, self.i = ep, tok, None, 0

    def post(self, body, timeout=120):
        req = urllib.request.Request(
            self.ep, data=json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.tok}",
                     "Content-Type": "application/json",
                     "Accept": "application/json, text/event-stream"})
        if self.sid:
            req.add_header("mcp-session-id", self.sid)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.headers, r.read().decode()

    def notify(self):
        self.post({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})

    def call(self, name, args, timeout=120):
        self.i += 1
        _, b = self.post({"jsonrpc": "2.0", "id": self.i, "method": "tools/call",
                          "params": {"name": name, "arguments": args}}, timeout)
        r = json.loads(strip_sse(b))["result"]
        if r.get("isError"):
            raise SystemExit(f"tool-error {name}: {r['content'][0]['text'][:200]}")
        txt = r["content"][0]["text"]
        return json.loads(txt) if txt.strip().startswith("{") else txt


def read_banner(port, timeout=5):
    s = socket.create_connection(("127.0.0.1", port), timeout)
    s.settimeout(timeout)
    try:
        return s.recv(64).decode(errors="replace").strip()
    finally:
        s.close()


def poke(port):
    """连一下即关——驱动 direct_tcpip 通道建立（坏目标由此翻 Degraded）。"""
    try:
        s = socket.create_connection(("127.0.0.1", port), timeout=5)
        s.settimeout(2)
        try:
            s.recv(64)
        except OSError:
            pass
        s.close()
    except OSError:
        pass


def main():
    ep = wait_signal("mcp")
    tok = wait_signal("agent-token")
    sid = wait_signal("session-id")
    print(f"[agent] endpoint={ep} session={sid} token={tok[:12]}...")

    m = Mcp(ep, tok)
    h, b = m.post({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                   "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                              "clientInfo": {"name": "t44-smoke-agent", "version": "0.0.1"}}})
    m.sid = h.get("mcp-session-id")
    server = json.loads(strip_sse(b))["result"]["serverInfo"]
    m.notify()
    t(f"AGENT-init|{server.get('name', '?')}")
    print(f"[agent] MCP initialized: {server}")

    local = {"Local": {"listen_addr": "127.0.0.1", "listen_port": GOOD_PORT,
                       "target_host": "127.0.0.1", "target_port": 22}}
    t("AGENT-fwd-start-issued")
    r = m.call("forward_start", {"session_id": sid, "spec": local})
    fid = r["forward_id"]
    t(f"AGENT-fwd-up|fid={fid[:8]}")
    print(f"[agent] forward up: {fid}")

    deadline = time.time() + 30
    state = None
    while time.time() < deadline:
        fl = m.call("forwards_list", {"session_id": sid})["forwards"]
        state = fl[0]["state"] if fl else None
        if state == "Listening":
            break
        time.sleep(0.4)
    assert state == "Listening", f"forward not Listening: {state}"
    t("AGENT-listening")

    banner = read_banner(GOOD_PORT)
    assert banner.startswith("SSH-"), f"no ssh banner: {banner!r}"
    t(f"AGENT-banner-ok|{banner[:16]}")
    print(f"[agent] banner through tunnel: {banner}")

    t("AGENT-fwd-stop-issued")
    r = m.call("forward_stop", {"session_id": sid, "forward_id": fid})
    assert r["stopped"] is True, r
    deadline = time.time() + 15
    n = -1
    while time.time() < deadline:
        fl = m.call("forwards_list", {"session_id": sid})["forwards"]
        n = len(fl)
        if n == 0:
            break
        time.sleep(0.4)
    assert n == 0, f"forwards not cleared: {n}"
    t("AGENT-fwd-stopped")
    print("[agent] forward stopped, list cleared")

    bad = {"Local": {"listen_addr": "127.0.0.1", "listen_port": BAD_PORT,
                     "target_host": "127.0.0.1", "target_port": 9}}
    t("AGENT-fwd-bad-issued")
    r = m.call("forward_start", {"session_id": sid, "spec": bad})
    fid2 = r["forward_id"]
    poke(BAD_PORT)  # 触发 direct_tcpip → 容器 refused → Degraded
    deadline = time.time() + 30
    err = ""
    while time.time() < deadline:
        fl = m.call("forwards_list", {"session_id": sid})["forwards"]
        f0 = fl[0] if fl else None
        if f0 and f0["state"] == "Degraded":
            err = (f0.get("error") or "")[:48]
            break
        time.sleep(0.4)
    else:
        raise SystemExit("forward never Degraded")
    t(f"AGENT-degraded-ok|err={err}")
    print(f"[agent] degraded as expected: {err}")
    t("AGENT-DONE")

    # ---- 全链核账：人工侧行序列 + 状态行 ----
    time.sleep(1.5)
    lines = log_lines()
    seq = [l[3:] for l in lines if l.startswith("/t/")]
    def need(pat, what):
        assert any(re.search(pat, l) for l in seq), f"missing beacon step: {what} ({pat})\nseq={seq}"
    need(r"^fwd-card\|端口转发 -L 127\.0\.0\.1:15432.*\|editable=false", "建卡-不可编辑")
    need(r"^fwd-approved\|", "人工批准")
    need(r"^fwd-state\|[^|]*:Listening", "监听中")
    need(r"^fwd-card\|停止 端口转发 -L 127\.0\.0\.1:15432", "停卡")
    need(r"^fwd-state\|$", "清空")
    need(r"^fwd-state\|[^|]*:Degraded", "降级")
    need(r"^DONE$", "注入脚本收尾")
    # Degraded 错误文案行（fwd-state 带 err= 的那条）
    de = [l for l in seq if l.startswith("fwd-state|") and ":Degraded" in l and "err=" in l]
    assert de and ("目标" in de[0] or "不可达" in de[0] or "拒绝" in de[0]), f"degraded err text: {de}"
    print("[agent] full chain verified:")
    for l in seq:
        if l.startswith(("fwd-", "AGENT-", "DONE", "sftp", "mcp", "session-id")) or "banner" in l:
            print("   ", l)


if __name__ == "__main__":
    main()
