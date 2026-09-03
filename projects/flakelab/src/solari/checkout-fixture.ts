export const CHECKOUT_PORT = 4173
export const CHECKOUT_APP_DIRECTORY = "/opt/flakelab-checkout"

export const checkoutServerSource = `
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAGE = b'''<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>FlakeLab checkout</title></head>
  <body>
    <main>
      <h1>Checkout</h1>
      <button type="button">Place order</button>
      <p role="status">Ready</p>
    </main>
    <script>
      document.querySelector('button').addEventListener('click', async () => {
        const status = document.querySelector('[role=status]')
        status.textContent = 'Processing'
        let expired = false
        const deadline = setTimeout(() => {
          expired = true
          status.textContent = 'Checkout timed out'
        }, 100)
        await fetch('/api/checkout', { method: 'POST' })
        clearTimeout(deadline)
        if (!expired) status.textContent = 'Checkout complete'
      })
    </script>
  </body>
</html>'''

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.dumps({'ok': True}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, format, *args):
        return

ThreadingHTTPServer(('0.0.0.0', ${CHECKOUT_PORT}), Handler).serve_forever()
`
