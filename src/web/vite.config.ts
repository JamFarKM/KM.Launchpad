import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During dev, the SPA runs on :5173 and proxies API calls to the ASP.NET backend on :5080.
// In production the backend serves the built bundle from wwwroot, so no proxy is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:5080",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
