import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = resolve(import.meta.dirname, "ide");

export default defineConfig({
  root,
  base: "/ide/",
  build: {
    outDir: resolve(import.meta.dirname, "dist/ide"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        redirect: resolve(root, "index.html"),
        level1: resolve(root, "1/index.html"),
      },
    },
  },
  worker: { format: "es" },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
