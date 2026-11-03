import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const apiPort = Number(process.env.PI_BOT_PORT ?? 4317);

// Capture source identity at build time, never from a later runtime checkout.
function buildRevision(): string {
  try {
    const cwd = resolve(root, "../..");
    const revision = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd,
      encoding: "utf8",
    }).trim();
    return `${revision}${dirty ? "-dirty" : ""}`;
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  define: { __BUILD_REVISION__: JSON.stringify(buildRevision()) },
  plugins: [react()],
  server: {
    fs: {
      allow: [root, resolve(root, "../../node_modules")],
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem,key}",
        "**/.git/**",
        "**/*.sqlite*",
        "**/*.db*",
        "**/config.toml",
      ],
    },
    port: 5173,
    host: "127.0.0.1",
    strictPort: true,
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${apiPort}`, ws: true, changeOrigin: false },
      "/health": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
