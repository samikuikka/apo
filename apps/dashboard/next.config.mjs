/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.NEXT_STANDALONE_OUTPUT ? 'standalone' : undefined,
  // The dev server binds all interfaces and both loopback names must work:
  // without 127.0.0.1 here, Next blocks its own dev resources (HMR — and with
  // them hydration) for browsers that address the server as 127.0.0.1.
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  // Next.js applies gzip/brotli compression to route-handler responses by
  // default. That buffers Server-Sent Events (the /backend-proxy/* streams for
  // run events and trace spans): the browser's EventSource connects but never
  // receives events until disconnect, so every live feed silently breaks.
  // Production deployments typically run behind a reverse proxy (nginx/Caddy)
  // that handles compression, and localhost traffic doesn't need it.
  compress: false,
  // Issue #174: the rewrite proxy defaults to a 30 s response timeout and a
  // 10 MB request-body clone limit, which kill multi-MB CLI result
  // submissions (`/backend-proxy/…/result`) with a bodyless 500 or a
  // silently truncated body while the backend is still finalizing.
  // Server-profile deployments now route API traffic straight to the backend
  // in Caddy, but this hop remains for direct-frontend access (local
  // profile, custom ingresses) — give those the same headroom the backend
  // path has.
  experimental: {
    proxyTimeout: 300_000,
    proxyClientMaxBodySize: "64mb",
  },
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'pub-21fa567153294f0ca87dc79e6f19866a.r2.dev',
        pathname: '/attractions/**',
      },
    ],
  },
  async redirects() {
    return [
      {
        source: '/project/:projectId/agent-tasks/:path*',
        destination: '/project/:projectId/tasks/:path*',
        permanent: false,
      },
      {
        source: '/project/:projectId/agent-tasks',
        destination: '/project/:projectId/tasks',
        permanent: false,
      },
      {
        source: '/project/:projectId/agent-task-schedules/:path*',
        destination: '/project/:projectId/schedules/:path*',
        permanent: false,
      },
      {
        source: '/project/:projectId/agent-task-schedules',
        destination: '/project/:projectId/schedules',
        permanent: false,
      },
    ];
  },
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:8000';
    return [
      // Preserve the canonical OTLP path when traces enter through the public
      // frontend origin. The generic /api rewrite below intentionally strips
      // /api for dashboard routes, so telemetry needs this specific rule first.
      {
        source: '/api/public/otel/:path*',
        destination: `${backendUrl}/api/public/otel/:path*`,
      },
      {
        source: '/api/:path((?!auth(?:/|$)).*)',
        destination: `${backendUrl}/:path*`,
      },
      {
        source: '/backend-proxy/:path*',
        destination: `${backendUrl}/:path*`,
      },
      // The public origin is also the CLI's backend. ``apo login
      // --backend <public-origin>`` calls /v1/* and /auth/* directly, so those
      // backend-owned paths must resolve on the same origin as the dashboard —
      // the frontend itself serves neither. NextAuth's own /api/auth/* surface
      // is untouched (the /api rewrite above already excludes it).
      {
        source: '/v1/:path*',
        destination: `${backendUrl}/v1/:path*`,
      },
      {
        source: '/auth/:path*',
        destination: `${backendUrl}/auth/:path*`,
      },
    ];
  },
  async headers() {
    // Next.js's bootstrap scripts and Tailwind-class styling rely on inline
    // script/style elements, so those two directives must stay 'unsafe-inline'
    // (a nonce-based policy would require a middleware that rewrites every
    // response). Everything else is locked to 'self': no third-party script,
    // object, or frame sources exist. Dev adds eval (React refresh) and the
    // HMR websocket origin.
    const isDev = process.env.NODE_ENV === 'development';
    const csp = [
      "default-src 'self'",
      isDev
        ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
        : "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      isDev ? "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*" : "connect-src 'self'",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
