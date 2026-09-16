import { once } from "node:events"
import { createServer as createHttpServer, request as httpRequest } from "node:http"
import { createServer, connect } from "node:net"
import type { AddressInfo, Server, Socket } from "node:net"

import { expect, test } from "@playwright/test"

import { startFaultProxy } from "../../src/runner/fault-proxy.js"

async function listen(server: Server): Promise<number> {
  await new Promise<void>((complete, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", complete)
  })
  return (server.address() as AddressInfo).port
}

test("CONNECT tunnel tolerates a client reset while upstream is writing", async () => {
  let acceptUpstream: ((socket: Socket) => void) | undefined
  const upstreamConnection = new Promise<Socket>((complete) => {
    acceptUpstream = complete
  })
  const upstream = createServer((socket) => {
    socket.on("error", () => undefined)
    acceptUpstream?.(socket)
  })
  const upstreamPort = await listen(upstream)
  const proxy = await startFaultProxy([{
    kind: "network-delay",
    pattern: "**/unused",
    delayMs: 1,
  }])
  const proxyPort = new URL(proxy.url).port
  const client = connect(Number(proxyPort), "127.0.0.1")
  client.on("error", () => undefined)

  try {
    await once(client, "connect")
    client.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1:${upstreamPort}\r\n\r\n`)
    await once(client, "data")
    const serverSocket = await upstreamConnection
    const closed = new Promise<void>((complete) => serverSocket.once("close", complete))
    const writes = setInterval(() => serverSocket.write(Buffer.alloc(64 * 1024)), 0)
    serverSocket.once("close", () => clearInterval(writes))

    client.resetAndDestroy()
    await closed

    expect(serverSocket.destroyed).toBe(true)
  } finally {
    client.destroy()
    await proxy.close()
    await new Promise<void>((complete, reject) => {
      upstream.close((error) => error ? reject(error) : complete())
    })
  }
})

test("proxy observation records bounded request metadata without query values", async () => {
  const upstream = createHttpServer((_request, response) => {
    response.end("ok")
  })
  const upstreamPort = await listen(upstream)
  const proxy = await startFaultProxy([])
  const proxyPort = Number(new URL(proxy.url).port)

  try {
    await new Promise<void>((complete, reject) => {
      const request = httpRequest({
        headers: { host: `127.0.0.1:${upstreamPort}` },
        host: "127.0.0.1",
        method: "POST",
        path: `http://127.0.0.1:${upstreamPort}/api/products?token=secret`,
        port: proxyPort,
      }, (response) => {
        response.resume()
        response.once("end", complete)
      })
      request.once("error", reject)
      request.end()
    })

    expect(proxy.observedRequests()).toEqual([{
      count: 1,
      method: "POST",
      resourceType: "other",
      url: `http://127.0.0.1:${upstreamPort}/api/products`,
    }])
  } finally {
    await proxy.close()
    await new Promise<void>((complete, reject) => {
      upstream.close((error) => error ? reject(error) : complete())
    })
  }
})
