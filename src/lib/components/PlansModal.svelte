<script lang="ts">
    import { createEventDispatcher, onMount } from "svelte";
    import type { ComponentType } from "svelte";
    import { t } from "svelte-i18n";
    import { fly, fade } from "svelte/transition";
    import { openUrl } from "@tauri-apps/plugin-opener";
    import {
        X,
        Box,
        Coins,
        Gem,
        HelpCircle,
        Loader2,
        AlertTriangle,
        Check,
        Gift,
        Sparkles,
        AlertCircle,
        ArrowRight,
        Infinity as InfinityIcon,
        ExternalLink,
    } from "lucide-svelte";
    import { auth, isAdFree } from "$lib/stores/auth";
    import { API_BASE_URL } from "$lib/config";
    import { customFetch } from "$lib/services/api";
    import { Button, IconButton, Badge, Chip, Segmented } from "./ui";

    export let isOpen = false;

    const dispatch = createEventDispatcher();

    // UI State
    export let billingCycle = "monthly"; // 'monthly' | 'yearly'
    export let selectedTier = "silver"; // Default selection; "adfree" = "Sem anúncios para sempre"
    let isLoading = false;
    let errorMessage = "";
    let isFetchingPlans = true;

    // Data State
    interface Plan {
        tier: string;
        monthly_price: number;
        yearly_price: number;
        monthly_discount?: number;
        yearly_discount?: number;
        discount: number;
        is_promo_active: boolean;
        promo_ends_at: string | null;
        // UI enrichments
        name?: string;
        features?: string[];
        iconComponent?: ComponentType;
        badgeBg?: string;
        popular?: boolean;
        storage?: string;
        storage_display?: string;
    }

    let plans: Plan[] = [];
    let apiPlans: any[] = []; // Store raw API responses here

    // Reactive definitions for UI text
    $: PLAN_UI = {
        silver: {
            name: $t("plans.silver"),
            iconComponent: Box,
            storage: "5 GB",
            features: [$t("plans.features.cloudBackup"), $t("plans.features.versionHistory")],
            badgeBg: "bg-panel-3 text-ink-2 border-rule-strong",
        },
        gold: {
            name: $t("plans.gold"),
            iconComponent: Coins,
            storage: "30 GB",
            features: [$t("plans.features.everythingSilver"), $t("plans.features.prioritySupport")],
            badgeBg: "bg-warn-bg text-warn border-warn/40",
            popular: true,
        },
        diamond: {
            name: $t("plans.diamond"),
            iconComponent: Gem,
            storage: "100 GB",
            features: [$t("plans.features.everythingGold"), $t("plans.features.prioritySupport")],
            badgeBg: "bg-action-bg text-action border-action-border",
        },
    };

    /** "5.00 GB" (API) → "5 GB". */
    const cleanStorage = (v?: string) => (v ?? "").replace(/\.00(?=\s)/, "").trim();
    function planPrice(plan: Plan, cycle: string): number {
        const base = cycle === "monthly" ? plan.monthly_price : plan.yearly_price;
        return base * (1 - getDiscount(plan, cycle) / 100);
    }

    // Reactive Block to build 'plans' whenever apiPlans or PLAN_UI changes
    $: {
        if (apiPlans.length > 0 && PLAN_UI) {
            const tiers = ["silver", "gold", "diamond"];
            const currentPlanIndex = $auth.user?.subscription_plan
                ? tiers.indexOf($auth.user.subscription_plan)
                : -1;

            const relevantPlans = apiPlans.filter((p) => {
                const planIndex = tiers.indexOf(p.tier);
                return planIndex > currentPlanIndex;
            });

            plans = relevantPlans.map((p) => {
                const ui = PLAN_UI[p.tier as keyof typeof PLAN_UI] || {
                    name: p.tier.toUpperCase(),
                    iconComponent: HelpCircle,
                    storage: "",
                    features: [],
                    badgeBg: "bg-panel-3 text-ink-2 border-rule",
                };
                return { ...p, ...ui, storage: cleanStorage(p.storage_display) || ui.storage };
            });

            if (
                plans.length > 0 &&
                selectedTier !== "adfree" &&
                !plans.find((p) => p.tier === selectedTier)
            ) {
                selectedTier = plans[0].tier;
            }
        }
    }

    onMount(async () => {
        if (isOpen) {
            await fetchPlans();
        }
    });

    $: if (isOpen) {
        fetchPlans();
    }

    async function fetchPlans() {
        isFetchingPlans = true;
        errorMessage = "";
        void fetchAdFreeOffer();
        try {
            const response = await fetch(`${API_BASE_URL}/plans`, { method: "GET", mode: "cors" });

            if (!response.ok) {
                console.error(
                    "Failed to fetch plans:",
                    response.status,
                    response.statusText,
                );
                throw new Error("Failed to fetch plans");
            }

            apiPlans = await response.json();
        } catch (e) {
            console.error("Failed to fetch plans", e);
            errorMessage = $t("app.errors.plansLoad");
        } finally {
            isFetchingPlans = false;
        }
    }

    function close() {
        dispatch("close");
        isOpen = false;
        errorMessage = "";
        adFreeError = "";
        adFreeOpened = false;
    }

    // ---- "Sem anúncios para sempre" (one-time, R$ 10) ----
    let adFreePrice = 10;
    let adFreeLoading = false;
    let adFreeError = "";
    let adFreeOpened = false;
    let needCpf = false;
    let cpf = "";
    let adFreeCard: HTMLElement | null = null;

    $: ownsAdFree = $auth.user?.ad_free_lifetime === true;
    $: cpfDigits = cpf.replace(/\D/g, "");
    $: cpfValid = cpfDigits.length === 11 || cpfDigits.length === 14;

    async function fetchAdFreeOffer() {
        try {
            const r = await fetch(`${API_BASE_URL}/purchases/ad-free`);
            if (r.ok) {
                const offer = await r.json();
                if (typeof offer?.price === "number" && offer.price > 0) adFreePrice = offer.price;
            }
        } catch {
            /* keep the default price */
        }
    }

    // Opened from the Header "Sem anúncios" button: bring the option into view.
    $: if (isOpen && selectedTier === "adfree" && adFreeCard) {
        const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
        adFreeCard.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    }

    async function handleBuyAdFree() {
        adFreeError = "";
        adFreeOpened = false;
        if (!$auth.token) {
            adFreeError = $t("plans.adFree.loginRequired");
            return;
        }
        if (needCpf && !cpfValid) {
            adFreeError = $t("plans.adFree.cpfHint");
            return;
        }
        adFreeLoading = true;
        try {
            const body: Record<string, string> = {};
            if (cpfDigits) body.cpfCnpj = cpfDigits;
            if ($auth.user?.name) body.name = $auth.user.name;
            const res = await customFetch(`${API_BASE_URL}/purchases/ad-free`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (res.status === 422 && data?.code === "cpf_required") {
                needCpf = true;
                adFreeError = data.message || $t("plans.adFree.cpfHint");
                return;
            }
            if (res.status === 409) {
                await auth.checkSubscription().catch(() => {});
                return;
            }
            if (!res.ok) throw new Error(data?.message || res.statusText);
            if (data.invoice_url) {
                await openUrl(data.invoice_url);
                adFreeOpened = true;
            }
            if (data.ad_free) await auth.checkSubscription().catch(() => {});
        } catch (e: any) {
            console.error("Ad-free purchase failed", e);
            adFreeError = e?.message || $t("app.errors.general");
        } finally {
            adFreeLoading = false;
        }
    }

    function isPromoActive(plan: Plan): boolean {
        if (plan.tier !== "silver" || !plan.is_promo_active) return false;
        if (!plan.promo_ends_at) return true;
        return new Date() <= new Date(plan.promo_ends_at);
    }

    function getDiscount(plan: Plan, cycle: string): number {
        if (isPromoActive(plan)) return 0;
        return cycle === "monthly"
            ? plan.monthly_discount || 0
            : plan.yearly_discount || 0;
    }

    function formatPrice(value: number): string {
        return value.toLocaleString("pt-BR", {
            style: "currency",
            currency: "BRL",
        });
    }

    async function handleSubscribe() {
        if (!$auth.token) return;

        isLoading = true;
        errorMessage = "";

        try {
            const url = `https://memorycard.cloud?plan=${selectedTier}&period=${billingCycle}`;
            console.log("Opening subscription URL:", url);
            await openUrl(url);
            close();
        } catch (e: any) {
            console.error("Failed to open URL", e);
            errorMessage = $t("app.errors.general");
        } finally {
            isLoading = false;
        }
    }

    $: selectedPlanData = plans.find((p) => p.tier === selectedTier);

    function onKey(e: KeyboardEvent) {
        if (isOpen && e.key === "Escape") {
            e.preventDefault();
            close();
        }
    }
</script>

<svelte:window on:keydown={onKey} />

{#if isOpen}
    <div
        class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-night/85 backdrop-blur-md p-0 sm:p-4"
        transition:fade={{ duration: 200 }}
        on:click|self={close}
        on:keydown={(e) => {
            if (e.key === "Escape") close();
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plans-modal-title"
        tabindex="-1"
    >
        <div
            class="bg-panel border-t sm:border border-rule-strong rounded-t-lg sm:rounded-lg shadow-2xl w-full sm:max-w-5xl relative flex flex-col max-h-[92dvh] sm:max-h-[88dvh] overflow-hidden"
            style="padding-bottom: env(safe-area-inset-bottom, 0px);"
            transition:fly={{ y: 20, duration: 250 }}
        >
            <!-- Mobile drag handle -->
            <div class="sm:hidden flex justify-center pt-2.5 pb-1 bg-panel shrink-0">
                <div class="w-10 h-1 rounded-pill bg-rule-strong"></div>
            </div>

            <!-- Close Button -->
            <div class="absolute top-3.5 right-3.5 z-20">
                <IconButton label="Fechar" variant="ghost" size="sm" icon={X} on:click={close} />
            </div>

            {#if isFetchingPlans}
                <div class="flex items-center justify-center w-full h-96 text-ink gap-3">
                    <Loader2 class="w-6 h-6 animate-spin text-action" />
                    <span class="text-base font-medium">{$t("app.loading")}</span>
                </div>
            {:else if plans.length === 0 && ownsAdFree}
                <div class="flex flex-col items-center justify-center w-full h-96 text-ink gap-4 p-8 text-center">
                    {#if $auth.user?.subscription_plan === "diamond"}
                        <div class="w-16 h-16 rounded-lg bg-action-bg border border-action-border flex items-center justify-center text-action">
                            <Gem class="w-8 h-8" />
                        </div>
                        <h3 class="text-2xl font-display font-bold text-ink">
                            {$t("plans.diamondMember")}
                        </h3>
                        <p class="text-muted max-w-md text-sm">
                            {$t("plans.diamondMessage")}
                        </p>
                    {:else if errorMessage}
                        <div class="w-14 h-14 rounded-lg bg-warn-bg flex items-center justify-center text-warn">
                            <AlertTriangle class="w-7 h-7" />
                        </div>
                        <h3 class="text-xl font-display font-bold text-ink">
                            {$t("app.errors.plansLoad")}
                        </h3>
                        <p class="text-muted text-sm">{errorMessage}</p>
                        <Button variant="primary" size="md" on:click={fetchPlans}>
                            {$t("app.errors.tryAgain")}
                        </Button>
                    {:else}
                        <p class="text-muted text-sm">
                            {$t("app.errors.noPlans")}
                        </p>
                    {/if}
                </div>
            {:else}
                <div class="flex-1 flex flex-col md:flex-row overflow-y-auto md:overflow-hidden">
                    <!-- LEFT COLUMN: Controls -->
                    <div
                        class="w-full md:w-2/5 bg-night/60 p-5 md:p-7 flex flex-col border-b md:border-b-0 md:border-r border-rule md:overflow-y-auto gap-5"
                    >
                        <h2 id="plans-modal-title" class="text-2xl font-display font-bold text-ink pr-8">
                            {$t("plans.title")}
                        </h2>

                        <!-- "Sem anúncios para sempre": one-time support, sold apart from the cloud plans -->
                        {#if !ownsAdFree}
                            <button
                                type="button"
                                bind:this={adFreeCard}
                                class="relative w-full text-left p-3.5 rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action/50 {selectedTier ===
                                'adfree'
                                    ? 'bg-action-bg border-action shadow-md'
                                    : 'bg-action-bg/60 border-action-border hover:border-action'}"
                                aria-pressed={selectedTier === "adfree"}
                                on:click={() => (selectedTier = "adfree")}
                            >
                                <div class="flex items-center gap-3">
                                    <div
                                        class="w-10 h-10 rounded-md bg-action text-white flex items-center justify-center shrink-0"
                                    >
                                        <InfinityIcon class="w-5 h-5" strokeWidth={2.25} />
                                    </div>
                                    <div class="min-w-0 flex-1">
                                        <p class="text-[11px] font-bold uppercase tracking-wider text-action">
                                            {$t("plans.adFree.short")}
                                        </p>
                                        <p class="flex items-baseline gap-1.5 flex-wrap">
                                            <span class="text-2xl font-display font-bold text-ink leading-none">{formatPrice(adFreePrice)}</span>
                                            <span class="text-xs text-muted">· {$t("plans.adFree.once")}</span>
                                        </p>
                                    </div>
                                    {#if selectedTier === "adfree"}
                                        <div class="w-6 h-6 rounded-pill bg-action flex items-center justify-center shrink-0">
                                            <Check class="text-white w-3.5 h-3.5" strokeWidth={2.5} />
                                        </div>
                                    {:else}
                                        <div class="w-6 h-6 rounded-pill border border-rule-strong shrink-0"></div>
                                    {/if}
                                </div>
                            </button>
                        {:else}
                            <div class="notice notice-success w-full text-sm" role="status">
                                <InfinityIcon class="w-4 h-4 shrink-0 mt-0.5" />
                                <span>{$t("plans.adFree.owned")}</span>
                            </div>
                        {/if}

                        <div class="border-t border-rule pt-4 -mb-1">
                            <h3 class="text-sm font-display font-bold text-ink">{$t("plans.adFree.cloudTitle")}</h3>
                            <p class="text-xs text-muted">{$t("plans.adFree.cloudSubtitle")}</p>
                        </div>

                        {#if plans.length === 0}
                            <p class="text-xs text-muted">
                                {errorMessage || $t("app.errors.noPlans")}
                            </p>
                        {:else}
                        <!-- Period Toggle -->
                        <Segmented ariaLabel="Ciclo de cobrança" class="w-full">
                            <Chip
                                active={billingCycle === "monthly"}
                                class="flex-1 justify-center"
                                on:click={() => (billingCycle = "monthly")}
                            >
                                {$t("plans.monthly")}
                            </Chip>
                            <Chip
                                active={billingCycle === "yearly"}
                                class="flex-1 justify-center"
                                on:click={() => (billingCycle = "yearly")}
                            >
                                {$t("plans.yearly")}
                            </Chip>
                        </Segmented>

                        <!-- Plan Buttons List -->
                        <div class="flex flex-col gap-2">
                            {#each plans as plan}
                                <button
                                    type="button"
                                    class="relative w-full text-left p-3.5 rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action/50 {selectedTier ===
                                    plan.tier
                                        ? 'bg-panel-2 border-action shadow-md'
                                        : 'bg-panel border-rule hover:border-rule-strong hover:bg-panel-2'}"
                                    aria-pressed={selectedTier === plan.tier}
                                    on:click={() => (selectedTier = plan.tier)}
                                >
                                    <div class="flex items-center justify-between gap-2">
                                        <div class="flex items-center gap-2 min-w-0">
                                            <span class="w-7 h-7 rounded-sm border {plan.badgeBg} flex items-center justify-center shrink-0">
                                                {#if plan.iconComponent}
                                                    <svelte:component this={plan.iconComponent} class="w-4 h-4" />
                                                {/if}
                                            </span>
                                            <h3 class="text-ink font-display font-bold leading-tight truncate">{plan.name}</h3>
                                            {#if isPromoActive(plan)}
                                                <Badge variant="success" icon={Sparkles}>{$t("plans.monthFree")}</Badge>
                                            {:else if getDiscount(plan, billingCycle) > 0}
                                                <Badge variant="danger">-{getDiscount(plan, billingCycle)}%</Badge>
                                            {/if}
                                        </div>
                                        {#if selectedTier === plan.tier}
                                            <div class="w-6 h-6 rounded-pill bg-action flex items-center justify-center shrink-0">
                                                <Check class="text-white w-3.5 h-3.5" strokeWidth={2.5} />
                                            </div>
                                        {:else}
                                            <div class="w-6 h-6 rounded-pill border border-rule-strong shrink-0"></div>
                                        {/if}
                                    </div>
                                    <div class="mt-2 flex items-end justify-between gap-3">
                                        <span class="text-2xl font-display font-bold text-ink leading-none">{plan.storage}</span>
                                        <span class="text-right leading-none">
                                            <span class="text-2xl font-display font-bold text-ink">{formatPrice(planPrice(plan, billingCycle))}</span>
                                            <span class="text-xs text-muted">{billingCycle === "monthly" ? $t("plans.perMonth") : $t("plans.perYear")}</span>
                                        </span>
                                    </div>
                                    <p class="mt-2 inline-flex items-center gap-1.5 rounded-pill bg-action-bg border border-action-border px-2 py-0.5 text-[11px] font-semibold text-action">
                                        <InfinityIcon class="w-3.5 h-3.5" strokeWidth={2.25} />
                                        {$t("plans.adFree.includedLifetime")}
                                    </p>
                                </button>
                            {/each}
                        </div>
                        {/if}
                    </div>

                    <!-- RIGHT COLUMN: Details -->
                    <div
                        class="w-full md:w-3/5 p-5 md:p-8 flex flex-col bg-panel md:overflow-y-auto"
                    >
                        {#if selectedTier === "adfree" && !ownsAdFree}
                            <div class="flex-1 flex flex-col justify-center items-start gap-4 md:gap-5">
                                <div class="hidden md:block">
                                    <Badge variant="action" icon={InfinityIcon}>
                                        {$t("plans.adFree.badge")}
                                    </Badge>
                                </div>

                                <div class="hidden md:block space-y-2">
                                    <h2 class="text-3xl md:text-4xl font-display font-bold text-ink tracking-tight">
                                        {$t("plans.adFree.title")}
                                    </h2>
                                    <p class="text-ink-2 text-sm max-w-md">{$t("plans.adFree.tagline")}</p>
                                </div>

                                <div class="hidden md:flex items-baseline gap-2">
                                    <span class="text-4xl font-display font-bold text-ink tracking-tight">
                                        {formatPrice(adFreePrice)}
                                    </span>
                                    <span class="text-sm text-muted font-medium">{$t("plans.adFree.once")}</span>
                                </div>

                                <div class="hidden md:block w-full card bg-panel-2 space-y-3">
                                    <h4 class="text-xs uppercase tracking-wider text-muted font-bold">
                                        {$t("plans.includedFeatures")}
                                    </h4>
                                    <ul class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                        {#each [$t("plans.adFree.features.noAds"), $t("plans.adFree.features.oneTime"), $t("plans.adFree.features.support"), $t("plans.adFree.features.combine")] as feature}
                                            <li class="flex items-center gap-2.5 text-ink-2">
                                                <div class="w-5 h-5 rounded-pill bg-success-bg flex items-center justify-center shrink-0">
                                                    <Check class="text-success w-3 h-3" strokeWidth={2.5} />
                                                </div>
                                                <span class="text-xs font-medium">{feature}</span>
                                            </li>
                                        {/each}
                                    </ul>
                                </div>

                                {#if $isAdFree}
                                    <p class="text-xs text-muted max-w-md">{$t("plans.adFree.planCovers")}</p>
                                {/if}

                                {#if needCpf}
                                    <label class="w-full max-w-xs space-y-1.5" for="adfree-cpf">
                                        <span class="block text-xs font-semibold text-ink-2">{$t("plans.adFree.cpfLabel")}</span>
                                        <input
                                            id="adfree-cpf"
                                            class="bg-night text-ink placeholder-muted text-sm rounded-md block w-full h-11 px-3 border border-rule focus:outline-none focus:border-action focus-visible:ring-2 focus-visible:ring-action/40"
                                            inputmode="numeric"
                                            autocomplete="off"
                                            placeholder="000.000.000-00"
                                            bind:value={cpf}
                                            aria-describedby="adfree-cpf-hint"
                                        />
                                        <span id="adfree-cpf-hint" class="block text-xs text-muted">{$t("plans.adFree.cpfHint")}</span>
                                    </label>
                                {/if}

                                {#if adFreeError}
                                    <div class="notice notice-danger w-full" role="alert">
                                        <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
                                        <span>{adFreeError}</span>
                                    </div>
                                {/if}
                                {#if adFreeOpened}
                                    <div class="notice notice-success w-full" role="status">
                                        <ExternalLink class="w-4 h-4 shrink-0 mt-0.5" />
                                        <span>{$t("plans.adFree.opened")}</span>
                                    </div>
                                {/if}

                                <div class="w-full space-y-2 pt-1">
                                    <Button
                                        variant="primary"
                                        size="lg"
                                        block
                                        icon={InfinityIcon}
                                        loading={adFreeLoading}
                                        disabled={adFreeLoading || (needCpf && !cpfValid)}
                                        on:click={handleBuyAdFree}
                                    >
                                        {adFreeLoading ? $t("plans.processing") : $t("plans.adFree.cta")}
                                    </Button>
                                    <p class="text-xs text-muted text-center w-full">
                                        {$auth.token ? $t("plans.securePayment") : $t("plans.adFree.loginRequired")}
                                    </p>
                                </div>
                            </div>
                        {:else if selectedPlanData}
                            <div class="flex-1 flex flex-col justify-center items-start gap-4 md:gap-5">
                                <div class="hidden md:flex flex-col items-start gap-5">
                                    <Badge variant="action" icon={selectedPlanData.iconComponent}>
                                        {$t("plans.storage", {
                                            values: {
                                                amount: selectedPlanData.storage || "",
                                            },
                                        })}
                                    </Badge>

                                    <h2 class="text-3xl md:text-4xl font-display font-bold text-ink tracking-tight">
                                        {selectedPlanData.name}
                                    </h2>
                                </div>

                                <div>
                                    {#if isPromoActive(selectedPlanData)}
                                        {#if billingCycle === "monthly"}
                                            <div class="flex flex-col items-start gap-1">
                                                <div class="flex items-baseline gap-2 flex-wrap">
                                                    <span class="text-base text-muted line-through">
                                                        {formatPrice(selectedPlanData.monthly_price)}
                                                    </span>
                                                    <span class="text-4xl font-display font-bold text-ink tracking-tight">
                                                        R$ 0,00
                                                    </span>
                                                    <span class="text-sm text-muted font-medium">
                                                        {$t("plans.firstMonth")}
                                                    </span>
                                                </div>
                                                <span class="text-action text-xs font-semibold flex items-center gap-1.5 mt-1">
                                                    <Gift class="w-4 h-4" />
                                                    {$t("app.promo.noCreditCard")}
                                                </span>
                                            </div>
                                        {:else}
                                            <!-- Yearly Promo -->
                                            <div class="flex flex-col items-start gap-1">
                                                <div class="flex items-baseline gap-2">
                                                    <span class="text-4xl font-display font-bold text-ink tracking-tight">
                                                        {formatPrice(selectedPlanData.yearly_price)}
                                                    </span>
                                                    <span class="text-sm text-muted font-medium">
                                                        {$t("plans.perYear")}
                                                    </span>
                                                </div>
                                                <span class="text-success-ink text-xs font-bold flex items-center gap-1.5 mt-1">
                                                    <Sparkles class="w-4 h-4 text-success" />
                                                    {$t("plans.bonusMonths")}
                                                </span>
                                            </div>
                                        {/if}
                                    {:else}
                                        <!-- Standard Pricing with Discounts -->
                                        {@const basePrice =
                                            billingCycle === "monthly"
                                                ? selectedPlanData.monthly_price
                                                : selectedPlanData.yearly_price}
                                        {@const discount = getDiscount(
                                            selectedPlanData,
                                            billingCycle,
                                        )}

                                        <div class="flex flex-col items-start gap-1">
                                            {#if discount > 0}
                                                <div class="flex items-center gap-2">
                                                    <Badge variant="danger">
                                                        -{discount}%
                                                    </Badge>
                                                    <span class="text-sm text-muted line-through">
                                                        {formatPrice(basePrice)}
                                                    </span>
                                                </div>
                                            {/if}

                                            <div class="flex items-baseline gap-2">
                                                <span class="text-4xl font-display font-bold text-ink tracking-tight">
                                                    {formatPrice(basePrice * (1 - discount / 100))}
                                                </span>
                                                <span class="text-sm text-muted font-medium">
                                                    / {billingCycle === "monthly"
                                                        ? $t("plans.perMonth")
                                                        : $t("plans.perYear")}
                                                </span>
                                            </div>
                                        </div>
                                    {/if}
                                </div>

                                <div class="hidden md:block w-full card bg-panel-2 space-y-3">
                                    <h4 class="text-xs uppercase tracking-wider text-muted font-bold">
                                        {$t("plans.includedFeatures")}
                                    </h4>
                                    <ul class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                        <li class="flex items-center gap-2.5 text-action sm:col-span-2">
                                            <div class="w-5 h-5 rounded-pill bg-action-bg border border-action-border flex items-center justify-center shrink-0">
                                                <InfinityIcon class="w-3 h-3" strokeWidth={2.5} />
                                            </div>
                                            <span class="text-xs font-semibold">{$t("plans.adFree.includedLifetime")}</span>
                                        </li>
                                        {#each selectedPlanData.features || [] as feature}
                                            <li class="flex items-center gap-2.5 text-ink-2">
                                                <div class="w-5 h-5 rounded-pill bg-success-bg flex items-center justify-center shrink-0">
                                                    <Check class="text-success w-3 h-3" strokeWidth={2.5} />
                                                </div>
                                                <span class="text-xs font-medium">{feature}</span>
                                            </li>
                                        {/each}
                                    </ul>
                                </div>

                                {#if errorMessage}
                                    <div class="notice notice-danger w-full" role="alert">
                                        <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
                                        <span>{errorMessage}</span>
                                    </div>
                                {/if}

                                <div class="w-full space-y-2 pt-1">
                                    <Button
                                        variant="primary"
                                        size="lg"
                                        block
                                        loading={isLoading}
                                        disabled={isLoading}
                                        iconRight={ArrowRight}
                                        on:click={handleSubscribe}
                                    >
                                        {isLoading
                                            ? $t("plans.processing")
                                            : $t("plans.subscribe", {
                                                  values: {
                                                      planName: selectedPlanData.name || "",
                                                  },
                                              })}
                                    </Button>
                                    <p class="text-xs text-muted text-center w-full">
                                        {isPromoActive(selectedPlanData) &&
                                        billingCycle === "monthly"
                                            ? $t("plans.cancelAnytime")
                                            : $t("plans.securePayment")}
                                    </p>
                                </div>
                            </div>
                        {/if}
                    </div>
                </div>
            {/if}
        </div>
    </div>
{/if}
