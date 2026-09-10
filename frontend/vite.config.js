import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

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
    plugins: [react()],
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
