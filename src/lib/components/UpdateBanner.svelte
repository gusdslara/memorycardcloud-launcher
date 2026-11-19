<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { getVersion } from "@tauri-apps/api/app";
  import { CircleArrowUp, X } from "lucide-svelte";
  import { API_BASE_URL } from "../config";
  import { InstallService } from "../services/installService";
  import { compareVersions } from "../services/installPlanner";
  import { Button, IconButton } from "./ui";

  let available: { version: string; notes?: string } | null = null;
  let state: "idle" | "downloading" | "installing" | "error" = "idle";
  let progress = 0;
  let error = "";
  let hidden = false;
  let platform = "";
  let desktopUpdate: { downloadAndInstall: (cb: (e: any) => void) => Promise<void> } | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const isTauri = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

  async function checkNow() {
    if (!isTauri() || state === "downloading" || state === "installing") return;
    try {
      platform ||= (await invoke<string>("get_system_platform_cmd")).toLowerCase();
      if (platform === "android") {
        const [current, res] = await Promise.all([getVersion(), fetch(`${API_BASE_URL}/app/releases`, { cache: "no-store" })]);
        if (!res.ok) return;
        const rel = (await res.json())?.android;
        if (rel?.version && compareVersions(rel.version, current) > 0) {
          available = { version: rel.version, notes: rel.notes };
          hidden = false;
        }
      } else if (platform !== "ios") {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (update) {
          desktopUpdate = update;
          available = { version: update.version, notes: update.body ?? undefined };
          hidden = false;
        }
      }
    } catch (e) {
      console.warn("[updater] check failed:", e);
    }
  }

  async function updateNow() {
    error = "";
    try {
      if (platform === "android") {
        await InstallService.openUrl(`${API_BASE_URL}/app/download/android`);
        return;
      }
      if (!desktopUpdate) return;
      state = "downloading";
      let total = 0;
      let got = 0;
      await desktopUpdate.downloadAndInstall((ev: any) => {
        if (ev.event === "Started") total = ev.data?.contentLength ?? 0;
        if (ev.event === "Progress") {
          got += ev.data?.chunkLength ?? 0;
          progress = total ? Math.round((got / total) * 100) : 0;
        }
        if (ev.event === "Finished") state = "installing";
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      state = "error";
      error = String((e as Error)?.message ?? e);
    }
  }

  onMount(() => {
    void checkNow();
    timer = setInterval(checkNow, 6 * 60 * 60 * 1000);
  });
  onDestroy(() => clearInterval(timer));
</script>

{#if available && !hidden}
  <div
    class="mb-4 rounded-md border border-action-border bg-action-bg px-4 py-3 flex flex-wrap items-center gap-3"
    role="status"
  >
    <CircleArrowUp size={20} strokeWidth={2} class="text-action shrink-0" aria-hidden="true" />
    <div class="flex-1 min-w-[200px]">
      <p class="text-sm font-display font-bold text-ink">
        Nova versão do MemoryCard disponível: {available.version}
      </p>
      {#if state === "downloading"}
        <p class="text-xs text-ink-2">Baixando… {progress}%</p>
      {:else if state === "installing"}
        <p class="text-xs text-ink-2">Instalando, o app vai reiniciar sozinho.</p>
      {:else if state === "error"}
        <p class="text-xs text-warn-ink">Não deu para atualizar: {error}</p>
      {:else}
        <p class="text-xs text-ink-2">
          {available.notes ? available.notes.split("\n")[0] : "Clique para atualizar agora. Seus jogos e saves continuam onde estão."}
        </p>
      {/if}
    </div>
    <Button
      variant="primary"
      size="sm"
      loading={state === "downloading" || state === "installing"}
      on:click={updateNow}
    >
      {state === "error" ? "Tentar de novo" : "Atualizar agora"}
    </Button>
    {#if state === "idle" || state === "error"}
      <IconButton
        label="Lembrar depois"
        variant="ghost"
        size="sm"
        icon={X}
        on:click={() => (hidden = true)}
      />
    {/if}
  </div>
{/if}
