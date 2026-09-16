import type { IncomingMessage } from "node:http"

export type ObservedResourceType =
  | "document"
  | "font"
  | "iframe"
  | "image"
  | "other"
  | "script"
  | "stylesheet"

export interface ObservedRequest {
  count: number
  method: string
  resourceType: ObservedResourceType
  url: string
}

function observedUrl(request: IncomingMessage): URL | undefined {
  const rawUrl = request.url
  if (!rawUrl) return undefined
  try {
    if (/^https?:\/\//iu.test(rawUrl)) return new URL(rawUrl)
    const host = request.headers.host
    return host ? new URL(rawUrl, `http://${host}`) : undefined
  } catch {
    return undefined
  }
}

function observedResourceType(request: IncomingMessage): ObservedResourceType {
  const destination = request.headers["sec-fetch-dest"]
  if (destination === "document" || destination === "font" || destination === "iframe"
    || destination === "image" || destination === "script" || destination === "style") {
    return destination === "style" ? "stylesheet" : destination
  }
  return "other"
}

export function observeProxyRequest(request: IncomingMessage): ObservedRequest | undefined {
  const target = observedUrl(request)
  if (!target) return undefined
  return {
    count: 1,
    method: request.method?.toUpperCase() ?? "GET",
    resourceType: observedResourceType(request),
    url: `${target.origin}${target.pathname}`,
  }
}
