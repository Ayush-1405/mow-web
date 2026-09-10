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
        workbox: {
          // Supabase calls always go to the network (this is a live ERP —
          // stale task/project data must never be served from cache);
          // only the built app shell (JS/CSS/HTML/icons) is precached, so
          // the app still opens offline even though data won't load.
          navigateFallback: "/index.html",
          runtimeCaching: [
            {
              urlPattern: ({ url }) => url.pathname.startsWith("/rest") || url.pathname.startsWith("/auth") || url.pathname.startsWith("/storage") || url.pathname.startsWith("/functions"),
              handler: "NetworkOnly",
            },
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
    },
  };
});
