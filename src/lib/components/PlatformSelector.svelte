<script lang="ts">
  import { t } from "svelte-i18n";
  import { Layers, Monitor, Smartphone, Gamepad2 } from "lucide-svelte";
  import { Segmented, Chip } from "./ui";

  export let selectedPlatform = "All";

  $: platforms = [
    { id: "All", label: $t("platforms.all"), icon: Layers },
    { id: "PC", label: $t("platforms.pc"), icon: Monitor },
    { id: "Mobile", label: $t("platforms.mobile"), icon: Smartphone },
    { id: "Emulator", label: $t("platforms.emulators"), icon: Gamepad2 },
  ];
</script>

<Segmented ariaLabel="Filtrar por plataforma">
  {#each platforms as platform}
    <Chip
      active={selectedPlatform === platform.id}
      icon={platform.icon}
      on:click={() => (selectedPlatform = platform.id)}
    >
      {platform.label}
    </Chip>
  {/each}
</Segmented>
