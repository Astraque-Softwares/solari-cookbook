import { createServer } from "node:http"
import type { IncomingMessage, Server } from "node:http"
import { connect as connectNet } from "node:net"
import type { Duplex } from "node:stream"
import { connect as connectTls } from "node:tls"
import type { TLSSocket } from "node:tls"

const CONNECT_TIMEOUT_MS = 10_000

function openTlsSocket(url: URL): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const port = Number(url.port || "443")
    const tcpSocket = connectNet({ host: url.hostname, port, family: 4 })
    const timeout = setTimeout(() => {
      tcpSocket.destroy()
      reject(new Error("Solari WebSocket TLS connection timed out"))
    }, CONNECT_TIMEOUT_MS)
    tcpSocket.once("error", (error) => {
      clearTimeout(timeout)
      reject(error instanceof Error ? error : new Error("Solari TCP connection failed"))
    })
    tcpSocket.once("connect", () => {
      const socket = connectTls({
        socket: tcpSocket,
        servername: url.hostname,
        maxVersion: "TLSv1.2",
        ALPNProtocols: ["http/1.1"],
      })
      socket.once("secureConnect", () => {
        clearTimeout(timeout)
        resolve(socket)
      })
      socket.once("error", (error) => {
        clearTimeout(timeout)
        reject(error instanceof Error ? error : new Error("Solari TLS connection failed"))
      })
    })
  })
}

function upstreamRequest(request: IncomingMessage, url: URL): string {
  const port = url.port || "443"
  const lines = [`GET ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.hostname}:${port}`]
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.toLowerCase() === "host" || value === undefined) {
      continue
    }
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      lines.push(`${name}: ${item}`)
    }
  }
  return `${lines.join("\r\n")}\r\n\r\n`
}

export class SecureWebSocketProxy {
  readonly #sockets = new Set<Duplex>()
  readonly #upstream: URL
  #server: Server | undefined

  private constructor(upstream: URL) {
    this.#upstream = upstream
  }

  static async create(upstreamEndpoint: string): Promise<SecureWebSocketProxy> {
    const upstream = new URL(upstreamEndpoint)
    if (upstream.protocol !== "wss:") {
      throw new Error("Solari browser endpoint must use secure WebSockets")
    }
    const proxy = new SecureWebSocketProxy(upstream)
    await proxy.#listen()
    return proxy
  }

  endpoint(): string {
    const address = this.#server?.address()
    if (!address || typeof address === "string") {
      throw new Error("Solari WebSocket proxy is not listening")
    }
    return `ws://127.0.0.1:${address.port}/session`
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) {
      socket.destroy()
    }
    this.#sockets.clear()
    const server = this.#server
    this.#server = undefined
    if (!server) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  async #listen(): Promise<void> {
    const server = createServer()
    server.on("upgrade", (request, client, head) => {
      void this.#connect(request, client, head).catch(() => {
        client.destroy()
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    this.#server = server
  }

  async #connect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (request.url !== "/session") {
      client.destroy()
      return
    }
    const upstream = await openTlsSocket(this.#upstream)
    this.#sockets.add(client)
    this.#sockets.add(upstream)
    const cleanup = (): void => {
      this.#sockets.delete(client)
      this.#sockets.delete(upstream)
      client.destroy()
      upstream.destroy()
    }
    client.once("error", cleanup)
    client.once("close", cleanup)
    upstream.once("error", cleanup)
    upstream.once("close", cleanup)
    upstream.write(upstreamRequest(request, this.#upstream))
    if (head.length > 0) {
      upstream.write(head)
    }
    upstream.pipe(client)
    client.pipe(upstream)
  }
}
