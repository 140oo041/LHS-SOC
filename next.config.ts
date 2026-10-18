import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  output: "standalone",
  poweredByHeader: false,
  // `npm run typecheck` is the release gate. Next 16.4.2 currently fails to
  // parse TypeScript 5.9's valid `--showConfig` output before route generation.
  typescript: { ignoreBuildErrors: true },
  outputFileTracingIncludes: {
    "/api/admin/ingestion": ["./docs/**/*", "./architecture/**/*", "./*.pdf"],
    "/api/chat": ["./docs/**/*", "./architecture/**/*", "./README.md"],
    "/api/chat/image": ["./docs/**/*", "./architecture/**/*", "./README.md"],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
