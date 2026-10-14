import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        toolbar: resolve(__dirname, "toolbar.html"),
        "region-select": resolve(__dirname, "region-select.html"),
      },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/antd") || id.includes("node_modules/@ant-design")) {
            return "antd";
          }
          if (id.includes("node_modules/react-dom") || id.includes("node_modules/react/")) {
            return "react";
          }
          if (id.includes("/src/pages/EditorPage") || id.includes("/src/components/editor/")) {
            return "editor";
          }
          if (id.includes("/src/lib/editor/") || id.includes("/src/lib/export/")) {
            return "editor-lib";
          }
        },
      },
    },
  },
});
