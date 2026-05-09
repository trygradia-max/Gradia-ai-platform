import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hosts allowed to load /_next dev resources during `next dev`. Ngrok and
  // similar tunnels are the common case for mobile/HTTPS testing.
  allowedDevOrigins: ["*.ngrok-free.dev", "*.ngrok-free.app"],
};

export default nextConfig;
