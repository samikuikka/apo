/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.NEXT_STANDALONE_OUTPUT ? 'standalone' : undefined,
  // Next.js applies gzip/brotli compression to route-handler responses by
  // default. That buffers Server-Sent Events (the /backend-proxy/* streams for
  // run events and trace spans): the browser's EventSource connects but never
  // receives events until disconnect, so every live feed silently breaks.
  // Production deployments typically run behind a reverse proxy (nginx/Caddy)
  // that handles compression, and localhost traffic doesn't need it.
  compress: false,
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
      {
        source: '/api/:path((?!auth(?:/|$)).*)',
        destination: `${backendUrl}/:path*`,
      },
      {
        source: '/backend-proxy/:path*',
        destination: `${backendUrl}/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
