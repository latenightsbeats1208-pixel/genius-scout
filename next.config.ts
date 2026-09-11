import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  // Next.js blocks dev resources (fonts, HMR chunks, RSC payloads) from
  // cross-origin hosts by default. The phone reaches the server on the PC's LAN
  // IP, which counts as cross-origin, so those hosts must be allowlisted.
  //
  // Wildcards on the private ranges instead of one hard-coded IP: DHCP renumbers
  // the PC (it moved .43 → .42 between sessions) and a stale literal silently
  // broke the phone.
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "192.168.*.*",
    "10.*.*.*",
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.2*.*.*",
    "172.30.*.*",
    "172.31.*.*",
  ],
};

export default nextConfig;
