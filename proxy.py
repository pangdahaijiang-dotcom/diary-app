#!/usr/bin/env python3
# proxy.py —— 本地代理（CORS 兜底用）
# 当浏览器直连 DeepSeek 被跨域(CORS)拦截时，用本代理转发请求。
# 用法：
#   1) 终端运行：python proxy.py
#   2) 把 config.js 里的 apiBase 改成 "http://localhost:8080"
#   3) 像平常一样起本地服务器打开页面即可
import http.server
import socketserver
import urllib.request

UPSTREAM = "https://api.deepseek.com"


class Handler(http.server.BaseHTTPRequestHandler):
    def _proxy(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length) if length else None
        url = UPSTREAM + self.path
        req = urllib.request.Request(
            url,
            data=body,
            method=self.command,
            headers={
                "Content-Type": self.headers.get("Content-Type", "application/json"),
                "Authorization": self.headers.get("Authorization", ""),
            },
        )
        try:
            # 先把上游响应完整读完，再开始给浏览器回包。
            # 避免「响应头已经发出去、读取却失败」时又发一次 502，
            # 把已经开始的响应体污染成半截，前端就会报 JSON 解析失败。
            resp = urllib.request.urlopen(req, timeout=120)
            status = resp.status
            data = resp.read()
        except Exception as e:
            msg = ("代理转发失败：" + str(e)).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(msg)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(msg)
            return

        # 关键：明确给出 Content-Length。
        # 不发长度时，客户端只能靠「连接关闭」判断响应结束，
        # 在某些链路下会被当成流式响应而读到半截 —— 这正是
        # 前端报 "Unterminated string in JSON" 的典型成因。
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self._proxy()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        super().end_headers()

    def log_message(self, *args):
        pass  # 静默日志


if __name__ == "__main__":
    # Windows 上 TIME_WAIT 状态的端口仍会拒绝 bind，开启地址复用避开。
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("127.0.0.1", 8080), Handler) as httpd:
            print("本地代理已启动：http://localhost:8080 -> DeepSeek", flush=True)
            print("按 Ctrl+C 停止服务", flush=True)
            httpd.serve_forever()
    except OSError as e:
        # 最常见：8080 端口被别的程序占着
        print(f"[启动失败] 端口 8080 无法绑定：{e}", flush=True)
        print("排查：1) 别的程序占着 8080 → 关掉它  2) 改成本项目用别的端口（同步改 config.js）", flush=True)
        input("按回车键退出...")  # 防止窗口一闪而过看不到错误
    except KeyboardInterrupt:
        print("\n已停止", flush=True)
