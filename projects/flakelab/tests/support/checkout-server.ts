import { createServer  } from "node:http"
import type {Server} from "node:http";

const checkoutPage = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>FlakeLab checkout fixture</title></head>
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
        }, 75)
        await fetch('/api/checkout', { method: 'POST' })
        clearTimeout(deadline)
        if (!expired) status.textContent = 'Checkout complete'
      })
    </script>
  </body>
</html>`

export interface CheckoutServer {
  url: string
  close: () => Promise<void>
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

export async function startCheckoutServer(): Promise<CheckoutServer> {
  const server = createServer((request, response) => {
    if (request.url === "/api/checkout") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end('{"ok":true}')
      return
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    response.end(checkoutPage)
  })
  await listen(server)
  const address = server.address()
  if (!address || typeof address === "string") {
    await close(server)
    throw new Error("Checkout fixture did not bind to a TCP port")
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => close(server),
  }
}
