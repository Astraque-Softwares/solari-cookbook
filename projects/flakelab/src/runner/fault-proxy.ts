import { createServer, request as httpRequest } from "node:http"
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import { randomUUID } from "node:crypto"
import { request as httpsRequest } from "node:https"
import { connect } from "node:net"
import type { Socket } from "node:net"
import { Transform } from "node:stream"
import type { TransformCallback } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"

import type { AuthCookieExpiryFault, Fault, LoadingResourceType } from "../domain/schema.js"
import { faultSetSchema } from "../domain/schema.js"
import { isBrowserContextFault } from "../faults/browser-context.js"
import { withoutNamedCookies } from "../faults/cookie-header.js"
import { compileUrlPattern } from "../faults/pattern.js"
import type { DocumentBootstrapFault } from "../faults/document-bootstrap.js"
import {
  documentBootstrapScript,
  injectDocumentBootstrap,
  isDocumentBootstrapFault,
} from "../faults/document-bootstrap.js"

export interface FaultProxy {
  close: () => Promise<void>
  unmatchedFaults: () => Fault[]
  url: string
}

interface CompiledFault {
  expression: RegExp
  fault: Fault
  index: number
  matches: number
}

type CompiledAuthFault = CompiledFault & { fault: AuthCookieExpiryFault }

interface BootstrapScript {
  faultIndexes: number[]
  source: string
}

class TruncateTailTransform extends Transform {
  private tail = Buffer.alloc(0)

  constructor(private readonly removeBytes: number) {
    super()
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const combined = Buffer.concat([this.tail, chunk])
    const emitBytes = Math.max(0, combined.length - this.removeBytes)
    if (emitBytes > 0) {
      this.push(combined.subarray(0, emitBytes))
    }
    this.tail = combined.subarray(emitBytes)
    callback()
  }

  override _flush(callback: TransformCallback): void {
    this.tail = Buffer.alloc(0)
    callback()
  }
}

class DuplicateTailTransform extends Transform {
  private tail = Buffer.alloc(0)

  constructor(private readonly duplicateBytes: number) {
    super()
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.push(chunk)
    const combined = Buffer.concat([this.tail, chunk])
    this.tail = combined.subarray(Math.max(0, combined.length - this.duplicateBytes))
    callback()
  }

  override _flush(callback: TransformCallback): void {
    this.push(this.tail)
    this.tail = Buffer.alloc(0)
    callback()
  }
}

type ResponseMutation =
  | { kind: "duplicate"; bytes: number }
  | { kind: "truncate"; bytes: number }

function mutateResponseBody(upstream: IncomingMessage, mutations: ResponseMutation[]): NodeJS.ReadableStream {
  return mutations.reduce<NodeJS.ReadableStream>((body, mutation) => {
    const transform = mutation.kind === "duplicate"
      ? new DuplicateTailTransform(mutation.bytes)
      : new TruncateTailTransform(mutation.bytes)
    return body.pipe(transform)
  }, upstream)
}

function requestTarget(request: IncomingMessage): URL {
  const rawUrl = request.url
  if (!rawUrl) {
    throw new Error("Proxy request did not include a URL")
  }
  if (/^https?:\/\//iu.test(rawUrl)) {
    return new URL(rawUrl)
  }
  const host = request.headers.host
  if (!host) {
    throw new Error("Proxy request did not include a host")
  }
  return new URL(rawUrl, `http://${host}`)
}

function requestResourceType(request: IncomingMessage): LoadingResourceType | undefined {
  const destination = request.headers["sec-fetch-dest"]
  if (destination === "style") {
    return "stylesheet"
  }
  if (destination === "iframe") {
    return "document"
  }
  if (destination === "document" || destination === "font"
    || destination === "image" || destination === "script") {
    return destination
  }
  return undefined
}

function matchesRequest(entry: CompiledFault, request: IncomingMessage, target: URL): boolean {
  if (!entry.expression.test(target.href)) {
    return false
  }
  if (entry.fault.kind === "resource-loading-delay") {
    return entry.fault.resourceType === requestResourceType(request)
  }
  if (isBrowserContextFault(entry.fault)) {
    return requestResourceType(request) === "document"
  }
  return !isDocumentBootstrapFault(entry.fault)
    || requestResourceType(request) === "document"
}

function failResponse(response: ServerResponse, error: Error): void {
  if (response.headersSent) {
    response.destroy(error)
    return
  }
  response.writeHead(502, { "content-type": "text/plain; charset=utf-8" })
  response.end("FlakeLab fault proxy could not forward the request")
}

async function forwardUpstream(
  upstream: IncomingMessage,
  response: ServerResponse,
  mutations: ResponseMutation[],
  responseDelayMs: number,
  bootstrapScriptPath: string | undefined,
  complete: () => void,
  reject: (error: Error) => void,
): Promise<void> {
  if (responseDelayMs > 0) {
    await delay(responseDelayMs)
  }
  const responseHeaders: IncomingHttpHeaders = { ...upstream.headers }
  if (mutations.length > 0 || bootstrapScriptPath) {
    delete responseHeaders["content-length"]
  }
  if (bootstrapScriptPath) {
    const body = await readInjectedBody(upstream, bootstrapScriptPath)
    const mutated = mutateBufferedBody(body, mutations)
    delete responseHeaders["content-encoding"]
    responseHeaders["content-length"] = String(mutated.length)
    response.writeHead(upstream.statusCode ?? 502, responseHeaders)
    response.once("finish", complete)
    response.end(mutated)
    return
  }
  response.writeHead(upstream.statusCode ?? 502, responseHeaders)
  const body = mutations.length > 0 ? mutateResponseBody(upstream, mutations) : upstream
  body.pipe(response)
  response.once("finish", complete)
  body.once("error", reject)
  upstream.once("error", reject)
}

function readBoundedBody(upstream: IncomingMessage): Promise<Buffer> {
  return new Promise((complete, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    upstream.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > 1_048_576) {
        upstream.destroy(new Error("Document bootstrap injection supports HTML up to 1048576 bytes"))
        return
      }
      chunks.push(chunk)
    })
    upstream.once("end", () => complete(Buffer.concat(chunks)))
    upstream.once("error", reject)
  })
}

async function readInjectedBody(upstream: IncomingMessage, scriptPath: string): Promise<Buffer> {
  const contentType = upstream.headers["content-type"]?.toLowerCase() ?? ""
  const contentEncoding = upstream.headers["content-encoding"]?.toLowerCase()
  if (!contentType.startsWith("text/html")) {
    throw new Error("Document bootstrap fault matched a response that is not HTML")
  }
  if (contentEncoding && contentEncoding !== "identity") {
    throw new Error("Document bootstrap injection requires an uncompressed HTML response")
  }
  return injectDocumentBootstrap(await readBoundedBody(upstream), scriptPath)
}

function mutateBufferedBody(body: Buffer, mutations: ResponseMutation[]): Buffer {
  return mutations.reduce((current, mutation) => {
    if (mutation.kind === "duplicate") {
      const duplicate = current.subarray(Math.max(0, current.length - mutation.bytes))
      return Buffer.concat([current, duplicate])
    }
    return current.subarray(0, Math.max(0, current.length - mutation.bytes))
  }, body)
}

function forwardRequest(
  incoming: IncomingMessage,
  response: ServerResponse,
  target: URL,
  mutations: ResponseMutation[] = [],
  responseDelayMs = 0,
  bootstrapScriptPath?: string,
  requestHeaders?: IncomingHttpHeaders,
): Promise<void> {
  return new Promise((complete, reject) => {
    const headers: IncomingHttpHeaders = { ...(requestHeaders ?? incoming.headers), host: target.host }
    delete headers["proxy-authorization"]
    delete headers["proxy-connection"]
    if (bootstrapScriptPath) {
      delete headers["accept-encoding"]
    }
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest
    const outgoing = transport(target, { headers, method: incoming.method }, (upstream) => {
      forwardUpstream(
        upstream,
        response,
        mutations,
        responseDelayMs,
        bootstrapScriptPath,
        complete,
        reject,
      )
        .catch((error: Error) => reject(error))
    })
    outgoing.once("error", reject)
    incoming.pipe(outgoing)
  })
}

function responseHoldMs(entries: CompiledFault[]): number {
  let total = 0
  for (const entry of entries) {
    if (entry.fault.kind !== "response-reordering") {
      continue
    }
    const shouldHold = entry.matches % 2 === 0
    entry.matches += 1
    if (shouldHold) {
      total += entry.fault.holdMs
    }
  }
  return total
}

async function applyRequestDelay(entries: CompiledFault[]): Promise<void> {
  const totalDelayMs = entries.reduce((total, entry) => {
    if (entry.fault.kind === "network-delay" || entry.fault.kind === "resource-loading-delay") {
      return total + entry.fault.delayMs
    }
    return total
  }, 0)
  if (totalDelayMs > 0) {
    await delay(totalDelayMs)
  }
}

function forwardedAuthHeaders(
  request: IncomingMessage,
  entries: CompiledFault[],
  recordMatch: (index: number) => void,
): IncomingHttpHeaders | undefined {
  const authEntries = entries.filter((entry): entry is CompiledAuthFault =>
    entry.fault.kind === "auth-cookie-expiry")
  const cookieResult = withoutNamedCookies(
    request.headers.cookie,
    authEntries.map((entry) => entry.fault.cookieName),
  )
  if (cookieResult.removedNames.length === 0) {
    return undefined
  }
  const headers = { ...request.headers }
  if (cookieResult.header === undefined) {
    delete headers.cookie
  } else {
    headers.cookie = cookieResult.header
  }
  for (const entry of authEntries) {
    if (cookieResult.removedNames.includes(entry.fault.cookieName)) {
      recordMatch(entry.index)
    }
  }
  return headers
}

function recordBrowserContextMatches(
  entries: CompiledFault[],
  recordMatch: (index: number) => void,
): void {
  for (const entry of entries) {
    if (isBrowserContextFault(entry.fault)) {
      recordMatch(entry.index)
    }
  }
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  faults: CompiledFault[],
  bootstrapScripts: Map<string, BootstrapScript>,
  registerBootstrapScript: (entries: CompiledFault[]) => string,
  recordMatch: (index: number) => void,
): Promise<void> {
  const target = requestTarget(request)
  const bootstrapScript = bootstrapScripts.get(target.pathname)
  if (bootstrapScript) {
    for (const index of bootstrapScript.faultIndexes) {
      recordMatch(index)
    }
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" })
    response.end(bootstrapScript.source)
    return
  }
  const matching = faults.filter((entry) => matchesRequest(entry, request, target))
  if (matching.length === 0) {
    await forwardRequest(request, response, target)
    return
  }

  const delays = matching.filter((entry) => entry.fault.kind === "network-delay")
  const resourceDelays = matching.filter((entry) => entry.fault.kind === "resource-loading-delay")
  for (const entry of [...delays, ...resourceDelays]) {
    recordMatch(entry.index)
  }
  await applyRequestDelay([...delays, ...resourceDelays])

  const failure = matching.find((entry) => entry.fault.kind === "request-failure")
  if (failure?.fault.kind === "request-failure") {
    recordMatch(failure.index)
    response.writeHead(failure.fault.statusCode, { "content-type": "application/json" })
    response.end('{"error":"flakelab-injected-failure"}')
    return
  }

  const requestHeaders = forwardedAuthHeaders(request, matching, recordMatch)

  recordBrowserContextMatches(matching, recordMatch)

  const responseMutations = matching.filter((entry) =>
    entry.fault.kind === "response-duplication" || entry.fault.kind === "response-truncation")
  for (const entry of responseMutations) {
    recordMatch(entry.index)
  }
  const mutations = responseMutations.map((entry): ResponseMutation => {
    if (entry.fault.kind === "response-duplication") {
      return { kind: "duplicate", bytes: entry.fault.duplicateBytes }
    }
    if (entry.fault.kind === "response-truncation") {
      return { kind: "truncate", bytes: entry.fault.removeBytes }
    }
    throw new Error("Unsupported response mutation")
  })
  const reordering = matching.filter((entry) => entry.fault.kind === "response-reordering")
  for (const entry of reordering) {
    recordMatch(entry.index)
  }
  const bootstrapEntries = matching.filter((entry) => isDocumentBootstrapFault(entry.fault))
  const bootstrapScriptPath = bootstrapEntries.length > 0
    ? registerBootstrapScript(bootstrapEntries)
    : undefined
  await forwardRequest(
    request,
    response,
    target,
    mutations,
    responseHoldMs(reordering),
    bootstrapScriptPath,
    requestHeaders,
  )
}

function tunnelConnect(
  request: IncomingMessage,
  client: Socket,
  head: Buffer,
): void {
  const destination = new URL(`http://${request.url ?? ""}`)
  const upstream = connect(Number(destination.port || "443"), destination.hostname)
  upstream.once("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
    if (head.length > 0) {
      upstream.write(head)
    }
    upstream.pipe(client)
    client.pipe(upstream)
  })
  upstream.once("error", () => client.destroy())
}

export async function startFaultProxy(input: readonly Fault[]): Promise<FaultProxy> {
  const validatedFaults = faultSetSchema.parse(input)
  const faults = validatedFaults.map((fault, index): CompiledFault => ({
    expression: compileUrlPattern(fault.pattern),
    fault,
    index,
    matches: 0,
  }))
  const sockets = new Set<Socket>()
  const matchedFaultIndexes = new Set(faults.flatMap((entry) =>
    isBrowserContextFault(entry.fault) ? [entry.index] : []))
  const bootstrapScripts = new Map<string, BootstrapScript>()
  const bootstrapScriptRoot = `/.well-known/flakelab/${randomUUID()}`
  let bootstrapScriptIndex = 0
  const registerBootstrapScript = (entries: CompiledFault[]): string => {
    const path = `${bootstrapScriptRoot}/${bootstrapScriptIndex}.js`
    bootstrapScriptIndex += 1
    const bootstrapFaults = entries.map((entry): DocumentBootstrapFault => {
      if (!isDocumentBootstrapFault(entry.fault)) {
        throw new Error("Document bootstrap received an incompatible fault")
      }
      return entry.fault
    })
    bootstrapScripts.set(path, {
      faultIndexes: entries.map((entry) => entry.index),
      source: documentBootstrapScript(bootstrapFaults),
    })
    return path
  }
  const server = createServer((request, response) => {
    handleRequest(request, response, faults, bootstrapScripts, registerBootstrapScript, (index) => {
      matchedFaultIndexes.add(index)
    }).catch((error: Error) => failResponse(response, error))
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  server.on("connect", tunnelConnect)
  await new Promise<void>((complete, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", complete)
  })
  const address = server.address()
  if (!address || typeof address === "string") {
    server.close()
    throw new Error("FlakeLab fault proxy did not bind to a TCP port")
  }
  return {
    close: async () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>((complete, reject) => {
        server.close((error) => error ? reject(error) : complete())
      })
    },
    unmatchedFaults: () => validatedFaults.filter((_fault, index) =>
      !matchedFaultIndexes.has(index)),
    url: `http://127.0.0.1:${address.port}`,
  }
}
