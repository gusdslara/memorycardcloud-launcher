/**
 * Verifies that every port/emulator in the catalog resolves to a real asset in
 * its latest release, per platform.
 *
 *   npm run verify:catalog            # all items
 *   npm run verify:catalog -- mm-2s2h # only some ids
 *
 * Uses the public GitHub HTML endpoints (no API token / rate limit) and the
 * Gitea/Forgejo API for self-hosted sources. Exit code 1 when something broke.
 */
import { DEFAULT_PORTS } from "../src/lib/data/defaultPorts.ts";
import { DEFAULT_EMULATORS } from "../src/lib/data/defaultEmulators.ts";
import { getInstallPlan, pickAsset } from "../src/lib/services/installPlanner.ts";
import type { ReleaseSource } from "../src/lib/types/install.ts";
import type { SupportedPlatform } from "../src/lib/types/ports.ts";

const PLATFORMS: SupportedPlatform[] = ["windows", "linux", "macos", "android", "ios"];
const filter = process.argv.slice(2);
const cache = new Map<string, Promise<{ tag: string; assets: { name: string }[] } | null>>();

async function githubAssets(repo: string, tag?: string) {
  const key = `${repo}@${tag ?? "latest"}`;
  if (!cache.has(key)) {
    cache.set(
      key,
      (async () => {
        let resolvedTag = tag;
        let realRepo = repo;
        if (!resolvedTag) {
          const res = await fetch(`https://github.com/${repo}/releases/latest`, { redirect: "follow" });
          const m = res.url.match(/github\.com\/([^/]+\/[^/]+)\/releases\/tag\/(.+)$/);
          if (!m) return null;
          realRepo = m[1];
          resolvedTag = decodeURIComponent(m[2]);
        }
        const html = await (
          await fetch(`https://github.com/${realRepo}/releases/expanded_assets/${encodeURIComponent(resolvedTag!)}`)
        ).text();
        const names = [...html.matchAll(/href="\/[^"]+\/releases\/download\/[^/"]+\/([^"]+)"/g)].map((m) => ({
          name: decodeURIComponent(m[1]),
        }));
        return { tag: resolvedTag!, assets: names };
      })().catch(() => null),
    );
  }
  return cache.get(key)!;
}

async function giteaAssets(src: ReleaseSource) {
  try {
    const res = await fetch(`https://${src.host}/api/v1/repos/${src.repo}/releases/latest`);
    if (!res.ok) return null;
    const json: any = await res.json();
    return { tag: json.tag_name as string, assets: (json.assets ?? []).map((a: any) => ({ name: a.name })) };
  } catch {
    return null;
  }
}

let failures = 0;
const items = [
  ...DEFAULT_PORTS.map((p) => ({ kind: "port", item: p })),
  ...DEFAULT_EMULATORS.map((e) => ({ kind: "emu", item: e })),
].filter(({ item }) => filter.length === 0 || filter.includes(item.id));

for (const { kind, item } of items) {
  const lines: string[] = [];
  for (const platform of PLATFORMS) {
    const plan = getInstallPlan(item, platform);
    if (plan.mode === "unavailable") continue;
    const src = item.release;
    const pattern = src?.assets[platform];
    if (!src || !pattern) {
      lines.push(`  ${platform.padEnd(8)} ${plan.mode.padEnd(10)} ${plan.openUrl ?? plan.fallbackUrl ?? ""}`);
      continue;
    }
    const repo = src.platformRepos?.[platform] ?? src.repo;
    const rel = src.provider === "gitea" ? await giteaAssets(src) : await githubAssets(repo, src.tag);
    if (!rel) {
      const ok = !!plan.fallbackUrl;
      if (!ok) failures++;
      lines.push(`  ${platform.padEnd(8)} ${ok ? "WARN" : "FAIL"} release inacessível (${repo})${ok ? " → fallback" : ""}`);
      continue;
    }
    const asset = pickAsset(rel.assets, pattern);
    if (!asset) failures++;
    lines.push(
      `  ${platform.padEnd(8)} ${asset ? "OK  " : "FAIL"} ${plan.mode.padEnd(10)} ${rel.tag} → ${asset?.name ?? `nenhum asset casa /${pattern}/`}`,
    );
  }
  console.log(`[${kind}] ${item.id}\n${lines.join("\n")}`);
}

console.log(failures ? `\n${failures} problema(s) encontrado(s).` : "\nCatálogo OK.");
process.exit(failures ? 1 : 0);
