const agentosApiUrl =
  process.env.AGENTOS_API_URL ??
  (process.env.NODE_ENV === 'production' ? 'http://agentos-d:7710' : 'http://127.0.0.1:7710');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // All pages in (shell) make live API calls to agentos-d.
  // Disable static generation globally — everything is SSR or dynamic.
  staticPageGenerationTimeout: 0,
  // Disable the pages directory entirely to prevent conflicts.
  // We use App Router only.
  async rewrites() {
    return {
      fallback: [
        {
          source: '/api/:path*',
          destination: `${agentosApiUrl}/api/:path*`,
        },
      ],
    };
  },
};

module.exports = nextConfig;
