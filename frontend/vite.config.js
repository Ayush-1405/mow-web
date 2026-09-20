import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const supabaseRemote =
    env.VITE_SUPABASE_URL || "https://bykmyttaesuyjwvtnxks.supabase.co";

  const supabaseProxy = {
    target: supabaseRemote,
    changeOrigin: true,
    secure: true,
  };

  return {
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        // Default "auto" injects a script whose autoUpdate behavior is a
        // silent window.location.reload() the instant a new SW activates --
        // no user-facing prompt, and the reload can land mid-form-entry.
        // Registered manually in main.jsx instead, with an onNeedReload
        // callback that shows an "Update App" banner (components/UpdateBanner.jsx)
        // so nothing reloads until the user chooses to.
        injectRegister: null,
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.js",
        injectManifest: {
          // The app bundle's own chunk is already precached via the JS
          // entry; this keeps the precache manifest to real static assets
          // instead of duplicating everything Rollup already content-hashes.
          globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}"],
        },
        includeAssets: ["icons/favicon-32.png", "icons/apple-touch-icon.png"],
        manifest: {
          name: "Mood of Wood — Staff Pilot",
          short_name: "Mood of Wood",
          description: "Mood of Wood staff task, department, and project management app.",
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "#f6efe6",
          theme_color: "#7a4a24",
          orientation: "portrait",
          icons: [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
            { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
      }),
    ],
    server: {
      proxy: {
        "/rest": supabaseProxy,
        "/auth": supabaseProxy,
        "/functions": supabaseProxy,
        "/storage": supabaseProxy,
        "/realtime": { ...supabaseProxy, ws: true },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: false,
      rollupOptions: {
        output: {
          // Framework and Supabase client in their own long-lived chunks:
          // the app entry shrinks (faster first paint) and these files stay
          // cached across deploys because app-code changes no longer
          // invalidate them. xlsx/jszip are already lazy-loaded elsewhere and
          // are deliberately NOT listed here.
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined;
            if (/[\/]node_modules[\/](react|react-dom|react-router|react-router-dom|scheduler)[\/]/.test(id)) return "vendor-react";
            if (id.includes("@supabase")) return "vendor-supabase";
            return undefined;
          },
        },
      },
    },
  };
});
