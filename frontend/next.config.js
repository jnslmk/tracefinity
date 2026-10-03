/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '8000',
      },
      {
        protocol: 'http',
        hostname: 'localhost',
        port: '3000',
      },
    ],
  },
  devIndicators: false,
  experimental: {
    // Layout budgets reach 60s; leave room for bounded worker cleanup.
    proxyTimeout: 65_000,
  },
  async rewrites() {
    // proxy api and storage requests to backend (for single-container docker)
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:8000'
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
      {
        source: '/storage/:path*',
        destination: `${backendUrl}/storage/:path*`,
      },
    ]
  },
}

module.exports = nextConfig

