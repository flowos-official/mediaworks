import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { withWorkflow } from 'workflow/next';

const withNextIntl = createNextIntlPlugin('./i18n.ts');
const projectRoot = process.cwd();

const securityHeaders = [
  { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive, nosnippet, noimageindex, noai, noimageai' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
];

const aiCrawlerPattern = '.*(GPTBot|ChatGPT-User|OAI-SearchBot|ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai|Google-Extended|PerplexityBot|Perplexity-User|CCBot|Bytespider|Applebot-Extended|Meta-ExternalAgent|Amazonbot).*';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  outputFileTracingRoot: projectRoot,
  turbopack: {
    root: projectRoot,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb'
    },
    useCache: true,
    // Keep dynamic RSC payloads in the browser router cache so returning to a
    // page restores it instantly instead of re-running the full server tree.
    staleTimes: {
      dynamic: 5 * 60,
      static: 30 * 60,
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.s3.*.amazonaws.com'
      },
      {
        protocol: 'https',
        hostname: '*.s3.amazonaws.com'
      },
      {
        protocol: 'https',
        hostname: '*.cloudfront.net'
      }
    ]
  },
  // `@ffmpeg-installer/ffmpeg` does dynamic `require()` for the platform-specific
  // binary (linux-x64/darwin-x64/win32-x64). Next.js Webpack can't statically
  // resolve those — bundling fails with "Module not found". Mark it external
  // so the serverless function loads it from node_modules at runtime instead.
  serverExternalPackages: ['@ffmpeg-installer/ffmpeg'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  async redirects() {
    return [{
      source: '/:path((?!robots\\.txt).*)',
      has: [{ type: 'header', key: 'user-agent', value: aiCrawlerPattern }],
      destination: '/robots.txt',
      permanent: false,
    }];
  }
};

export default withWorkflow(withNextIntl(nextConfig));
