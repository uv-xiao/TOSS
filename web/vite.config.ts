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
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  }
});
