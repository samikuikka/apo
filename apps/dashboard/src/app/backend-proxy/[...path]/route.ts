import { auth } from "@/auth";
import { getServerBackendBaseUrl } from "@/lib/config.server";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  // The Next.js server applies response compression (gzip/brotli) when the
  // upstream is allowed to negotiate it. Compressing a text/event-stream
  // buffers it until enough data accumulates, so the browser's EventSource
  // connects but never receives events — which silently breaks every live
  // feed (run events, trace spans). Stripping accept-encoding forces the
  // upstream to return raw bytes that flush through incrementally.
  "accept-encoding",
]);

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxyToBackend(request, context);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxyToBackend(request, context);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxyToBackend(request, context);
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxyToBackend(request, context);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxyToBackend(request, context);
}

export async function OPTIONS(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxyToBackend(request, context);
}

async function proxyToBackend(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const pathname = path.join("/");
  const backendUrl = new URL(`${getServerBackendBaseUrl()}/${pathname}`);
  backendUrl.search = new URL(request.url).search;

  const headers = buildProxyHeaders(request.headers);
  // Instance-maintenance endpoints (/v1/admin/*) authenticate with the
  // operator's ADMIN_API_KEY via the x-admin-key header. The key must never
  // reach the browser, and it must only be attached for a caller the
  // dashboard has authenticated as an installation admin — without the
  // session check the proxy would be an unauthenticated admin surface
  // (reset-db / nuke-db / invitation management) on whatever origin can
  // reach it.
  const adminApiKey = process.env.ADMIN_API_KEY;
  if (adminApiKey && pathname.startsWith("v1/admin/")) {
    const session = await auth();
    if (session?.user?.is_admin !== true) {
      return Response.json({ detail: "Admin access required" }, { status: 403 });
    }
    headers.set("x-admin-key", adminApiKey);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) {
    init.body = await request.arrayBuffer();
    // Required by fetch when forwarding a request body from a route handler.
    // @ts-expect-error duplex is supported at runtime in Node fetch.
    init.duplex = "half";
  }

  // A proxy must never serve a cached upstream response: every request goes
  // straight to the backend. Kept inline at the call site so the no-cache
  // intent is visible where the fetch happens.
  const upstream = await fetch(backendUrl, {
    ...init,
    cache: "no-store",
    next: { revalidate: 0 },
  });
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("content-length");

  // Server-Sent Events must stream chunk-by-chunk. Two things conspire to
  // buffer them otherwise: (1) response compression (gzip/brotli) applied by
  // the Next.js server accumulates data before flushing, so the browser's
  // EventSource connects but never receives events — silently breaking every
  // live feed (run events, trace spans); (2) passing upstream.body straight
  // into `new Response(...)` is buffered by the route handler runtime.
  //
  // For event-stream responses we mark the encoding as `identity` so the
  // compression layer skips it, and pump the body through an explicit
  // ReadableStream so each chunk flushes as soon as the upstream emits it.
  const isEventStream = upstream.headers
    .get("content-type")
    ?.includes("text/event-stream");

  if (isEventStream && upstream.body) {
    responseHeaders.set("content-encoding", "identity");
    responseHeaders.set("cache-control", "no-cache, no-transform");
    responseHeaders.set("x-accel-buffering", "no");

    const stream = new ReadableStream({
      async start(controller) {
        const reader = upstream.body!.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch {
          // upstream closed / client disconnected
        } finally {
          controller.close();
          reader.releaseLock();
        }
      },
    });

    return new Response(stream, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

function buildProxyHeaders(source: Headers) {
  const headers = new Headers();

  for (const [key, value] of source.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    headers.set(key, value);
  }

  return headers;
}
