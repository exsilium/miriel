import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev (and `vite preview`) the API runs on 8080; proxying /api keeps the
// browser on one origin, so no CORS is needed. VITE_API_TARGET overrides.
const proxy = {
  "/api": {
    target: process.env["VITE_API_TARGET"] ?? "http://localhost:8080",
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
