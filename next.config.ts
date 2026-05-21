import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { withWorkflow } from 'workflow/next';

const withNextIntl = createNextIntlPlugin('./i18n.ts');

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb'
    }
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
  serverExternalPackages: ['@ffmpeg-installer/ffmpeg']
};

export default withWorkflow(withNextIntl(nextConfig));
