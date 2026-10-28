import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const apiPort = Number(process.env.PI_BOT_PORT ?? 4317);

export default defineConfig({
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
