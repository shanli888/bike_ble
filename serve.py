"""本地静态服务器：禁用缓存，便于手机端实时看到改动。"""
import http.server
import socketserver
import os

PORT = 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 强制不缓存，手机每次刷新都能拿到最新文件
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


class ReuseServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


if __name__ == '__main__':
    with ReuseServer(('0.0.0.0', PORT), NoCacheHandler) as httpd:
        print(f'Serving on http://0.0.0.0:{PORT} (no-cache)', flush=True)
        httpd.serve_forever()