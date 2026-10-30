import type { NextConfig } from 'next';

const api = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4100';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  // Geliştirmede ve tek-upstream dağıtımda /api ve /webhooks istekleri API'ye aktarılır.
  // Üretimde Caddy bu yolları doğrudan API'ye yönlendirir (deploy/Caddyfile.snippet).
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${api}/api/:path*` },
      { source: '/webhooks/:path*', destination: `${api}/webhooks/:path*` }
    ];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" }
        ]
      },
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache' }, { key: 'Service-Worker-Allowed', value: '/' }] }
    ];
  }
};

export default nextConfig;
