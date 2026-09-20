import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// TEMPORARY test harness config: the real chat components run unchanged; only the shared supabase module is
// swapped for an in-memory fake that counts every request / channel and can echo Realtime events.
const FAKE = path.resolve("src/chat-harness/fakeSupabase.js");
export default defineConfig({
  plugins: [
    react(),
    {
      name: "fake-supabase",
      enforce: "pre",
      async resolveId(source, importer, options) {
        if (!importer || !/supabase(\.js)?$/.test(source) || source.includes("@supabase")) return null;
        const r = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (r && r.id.replace(/\\/g, "/").endsWith("/src/lib/supabase.js")) return FAKE;
        return null;
      },
    },
  ],
  optimizeDeps: { entries: ["chat-harness.html"] },
  server: { port: 5210, strictPort: true },
});
