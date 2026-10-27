import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // Relative base so the build works from any sub-path (GitHub Pages, a USB stick, ...)
  base: "./",
  define: {
    // Excalidraw reads this at runtime; keep it out of dev-only checks
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Tablo",
        short_name: "Tablo",
        description: "Local-first whiteboards with peer-to-peer sharing",
        theme_color: "#1f2937",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "./",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // The Excalidraw bundle is large; allow it in the offline cache
        maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
        globPatterns: ["**/*.{js,css,html,svg,png,ico}", "pdf-fonts/*.{ttf,json}", "fonts/{Excalifont,Virgil,Nunito,Cascadia,Liberation,Assistant}/*.woff2"],
        runtimeCaching: [
          {
            // Other fonts (e.g. CJK) are cached the first time they are used
            urlPattern: ({ url }) => url.pathname.includes("/fonts/"),
            handler: "CacheFirst",
            options: { cacheName: "tablo-fonts", expiration: { maxEntries: 400 } },
          },
        ],
      },
    }),
  ],
  build: { chunkSizeWarningLimit: 6000 },
});
