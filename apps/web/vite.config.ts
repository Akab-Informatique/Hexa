import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

const api = process.env.API_URL ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      "@nexo/shared/permissions": path.resolve(__dirname, "../../packages/shared/src/permissions.ts"),
    },
  },
  server: { port: 5173, proxy: { "/api": { target: api } } },
  build: { outDir: "dist", sourcemap: false },
});
