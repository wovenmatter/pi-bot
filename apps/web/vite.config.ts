import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const apiPort = Number(process.env.PI_BOT_PORT ?? 4317);

// The runtime checkout retains its counter across commits and deployments.
const counterPath = resolve(root, "../../.preview-build-number");
function previousBuild(): number {
  try {
    const value = Number(readFileSync(counterPath, "utf8").trim());
    if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Invalid preview build counter");
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export default defineConfig(({ command }) => {
  const buildNumber = command === "build" ? previousBuild() + 1 : 0;
  return {
    define: { __BUILD_NUMBER__: JSON.stringify(buildNumber) },
    plugins: [
      react(),
      {
        name: "preview-build-number",
        apply: "build",
        writeBundle() {
          writeFileSync(counterPath, `${buildNumber}\n`);
        },
      },
    ],
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
  };
});
