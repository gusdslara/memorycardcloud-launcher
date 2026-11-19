<script lang="ts">
  /** Small platform glyph used on badges (site and app). Paths are simple, single-color shapes. */
  import type { SupportedPlatform } from "../types/ports";

  export let platform: SupportedPlatform;
  export let size = 14;
  export let title: string | undefined = undefined;

  const NAME: Record<SupportedPlatform, string> = {
    windows: "Windows",
    linux: "Linux",
    macos: "macOS",
    android: "Android",
    ios: "iOS",
  };
</script>

<svg
  class="pi"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="currentColor"
  role={title ? "img" : undefined}
  aria-hidden={title ? undefined : "true"}
  aria-label={title ?? undefined}
>
  {#if title}<title>{title || NAME[platform]}</title>{/if}
  {#if platform === "windows"}
    <path d="M3 5.1 10.2 4v7.3H3V5.1Zm8.2-1.2L21 2.5v8.8h-9.8V3.9ZM3 12.7h7.2V20L3 18.9v-6.2Zm8.2 0H21v8.8l-9.8-1.4v-7.4Z" />
  {:else if platform === "android"}
    <path d="M7.3 4.2a.6.6 0 0 1 .8.2l1.2 2A7.6 7.6 0 0 1 12 6c1 0 1.9.2 2.7.5l1.2-2a.6.6 0 1 1 1 .6l-1.1 1.9A6.9 6.9 0 0 1 19.5 12h-15a6.9 6.9 0 0 1 3.7-5.1L7.1 5a.6.6 0 0 1 .2-.8ZM9 9.3a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Zm6 0a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8ZM4.5 13.2h15V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19v-5.8Z" />
  {:else if platform === "macos"}
    <path d="M16.4 12.6c0-2.3 1.9-3.4 2-3.5a4.3 4.3 0 0 0-3.4-1.8c-1.4-.2-2.8.8-3.5.8-.7 0-1.8-.8-3-.8a4.5 4.5 0 0 0-3.8 2.3c-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.4 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7c1.3 0 2.1-1.1 2.8-2.3a10 10 0 0 0 1.3-2.6 4 4 0 0 1-2.5-3.7ZM14.2 5.8A4 4 0 0 0 15.2 3a4.2 4.2 0 0 0-2.7 1.4 3.9 3.9 0 0 0-1 2.8 3.5 3.5 0 0 0 2.7-1.4Z" />
  {:else if platform === "linux"}
    <path d="M12 2.5c-2.2 0-3.6 1.8-3.6 4.4 0 1.3.3 2.2-.4 3.6-.8 1.5-2.6 3.6-2.6 6.2 0 .8.2 1.5.5 2-1 .4-1.6 1-1.4 1.6.3.9 2.2.7 3.4 1 1 .3 1.8.7 2.5.2.5-.4.8-.6 1.6-.6s1.1.2 1.6.6c.7.5 1.5.1 2.5-.2 1.2-.3 3.1-.1 3.4-1 .2-.6-.4-1.2-1.4-1.6.3-.5.5-1.2.5-2 0-2.6-1.8-4.7-2.6-6.2-.7-1.4-.4-2.3-.4-3.6 0-2.6-1.4-4.4-3.6-4.4Zm-1.5 3.6c.5 0 .8.5.8 1.1 0 .3-.1.5-.2.7l-.7-.2c.1-.1.1-.3.1-.5 0-.3-.1-.5-.2-.5s-.3.2-.3.5v.2l-.6-.2v-.1c0-.6.5-1 1.1-1Zm3 0c.6 0 1.1.4 1.1 1v.3l-.6.1v-.4c0-.3-.2-.5-.4-.5s-.3.2-.3.5c0 .2 0 .3.1.4l-.7.2a1.6 1.6 0 0 1-.1-.6c0-.6.4-1 .9-1Zm-1.5 2c.7 0 1.6.5 1.6.8 0 .4-.9 1-1.6 1s-1.6-.6-1.6-1c0-.3.9-.8 1.6-.8Zm-2.6 3.5c.4.6 1.4 1 2.6 1s2.2-.4 2.6-1c.9 1.4 2 3 2 5 0 2.1-2 3-4.6 3s-4.6-.9-4.6-3c0-2 1.1-3.6 2-5Z" />
  {:else}
    <path d="M8 2h8a2.5 2.5 0 0 1 2.5 2.5v15A2.5 2.5 0 0 1 16 22H8a2.5 2.5 0 0 1-2.5-2.5v-15A2.5 2.5 0 0 1 8 2Zm0 2a.5.5 0 0 0-.5.5v15c0 .3.2.5.5.5h8c.3 0 .5-.2.5-.5v-15A.5.5 0 0 0 16 4h-1.3a1 1 0 0 1-1 .8h-3.4a1 1 0 0 1-1-.8H8Zm2.5 13.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z" />
  {/if}
</svg>

<style>
  .pi {
    flex-shrink: 0;
    display: inline-block;
    vertical-align: -0.15em;
  }
</style>
