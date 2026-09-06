import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SUPABASE_REMOTE = "https://bykmyttaesuyjwvtnxks.supabase.co";

const supabaseProxy = {
  target: SUPABASE_REMOTE,
  changeOrigin: true,
  secure: true,
};

export default defineConfig({
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
});
