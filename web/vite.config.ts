import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  worker: {
    format: "es"
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/react") || id.includes("/node_modules/scheduler")) {
            return "vendor-react";
          }
          if (id.includes("/node_modules/react-router")) {
            return "vendor-router";
          }
          if (
            id.includes("/node_modules/@codemirror/") ||
            id.includes("/node_modules/codemirror") ||
            id.includes("/node_modules/@lezer/")
          ) {
            return "vendor-editor";
          }
          if (
            id.includes("/node_modules/yjs") ||
            id.includes("/node_modules/@myriaddreamin/")
          ) {
            return "vendor-collab-typst";
          }
          return undefined;
        }
      }
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  }
});
