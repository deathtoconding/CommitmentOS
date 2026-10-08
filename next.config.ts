import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const privateNoStoreHeaders = [
  { key: 'Cache-Control', value: 'private, no-store, max-age=0, must-revalidate' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
];

if (process.env.NODE_ENV === 'production') {
  securityHeaders.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000' });
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ['*.e2b.app'],
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/api/auth/:path*', headers: privateNoStoreHeaders },
      { source: '/reset-password', headers: privateNoStoreHeaders },
      { source: '/forgot-password', headers: privateNoStoreHeaders },
      {
        source: '/app/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'private, no-store, max-age=0, must-revalidate',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
