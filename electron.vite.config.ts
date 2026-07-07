import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/electron/main",
      rollupOptions: {
        external: ["electron"]
      },
      lib: {
        entry: resolve(__dirname, "gui/electron/main/index.ts")
      }
    }
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "dist/electron/preload",
      rollupOptions: {
        external: ["electron"],
        output: {
          format: "cjs"
        }
      },
      lib: {
        entry: resolve(__dirname, "gui/electron/preload/index.ts")
      }
    }
  },

  renderer: {
    root: resolve(__dirname, "gui/renderer"),

    plugins: [react()],

    build: {
      rollupOptions: {
        input: resolve(__dirname, "gui/renderer/index.html")
      }
    },

    server: {
      port: 5173
    }
  }
});