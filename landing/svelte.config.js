import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    // Fully prerendered: every port/emulator gets its own indexable page.
    adapter: adapter({ pages: "build", assets: "build", fallback: "404.html", strict: true }),
    alias: {
      // The SAME catalog the desktop/mobile app uses (single source of truth).
      $shared: "../src/lib",
    },
    prerender: {
      // A broken link is a warning; a page that crashes while rendering fails the build.
      handleHttpError: ({ status, path, message }) => {
        if (status >= 500) throw new Error(`${path}: ${message}`);
        console.warn(message);
      },
    },
  },
};
