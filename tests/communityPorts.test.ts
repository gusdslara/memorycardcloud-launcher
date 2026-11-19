import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  COMMUNITY_CACHE_KEY,
  loadCommunityPorts,
  mergeCatalog,
  resetCommunityMemory,
  sanitizeCommunityList,
  sanitizeCommunityPort,
} from "../src/lib/services/communityPorts.ts";
import { CONSOLE_CATEGORIES } from "../src/lib/types/ports.ts";
import type { PortItem } from "../src/lib/types/ports.ts";

const port = (id: string, extra: Partial<PortItem> = {}): PortItem => ({
  id,
  name: id.toUpperCase(),
  projectName: "Jogo",
  console: "Nintendo 64",
  portType: "recomp",
  description: "",
  author: "x",
  supportedOs: ["windows"],
  downloadUrls: {},
  executableNames: { windows: "a.exe" },
  romRequirements: { fileType: "file", extensions: [".z64"], fileDescription: "ROM", instructions: "..." },
  ...extra,
});

function memStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

function jsonResponse(body: unknown, init: { status?: number; etag?: string } = {}) {
  return new Response(init.status === 304 ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: init.etag ? { ETag: init.etag } : {},
  });
}

describe("Ports da comunidade", () => {
  beforeEach(() => resetCommunityMemory());

  test("lista de consoles cobre todas as categorias reais, sem 'All'", () => {
    assert.ok(!CONSOLE_CATEGORIES.includes("All" as never));
    for (const c of ["Xbox 360", "PlayStation 5", "Dreamcast / Saturn", "Arcade", "Outros"]) {
      assert.ok(CONSOLE_CATEGORIES.includes(c as never), c);
    }
    assert.equal(new Set(CONSOLE_CATEGORIES).size, CONSOLE_CATEGORIES.length);
  });

  test("sanitiza: descarta itens inválidos e marca como comunidade", () => {
    assert.equal(sanitizeCommunityPort({ id: "Bad Id", name: "x", supportedOs: ["windows"] }), undefined);
    assert.equal(sanitizeCommunityPort({ id: "ok-id", name: "x", supportedOs: ["dos"] }), undefined);
    const p = sanitizeCommunityPort({
      id: "ok-id",
      name: "Ok",
      console: "Atari",
      portType: "weird",
      supportedOs: ["windows", "dos"],
      downloadUrls: { windows: "https://x/y.zip", dos: "z" },
      isCustom: true,
    });
    assert.ok(p);
    assert.equal(p.console, "Outros");
    assert.equal(p.portType, "source_port");
    assert.deepEqual(p.supportedOs, ["windows"]);
    assert.deepEqual(p.downloadUrls, { windows: "https://x/y.zip" });
    assert.equal(p.community, true);
    assert.equal(p.isCustom, false);
    assert.equal(sanitizeCommunityList([p, p, null, "x"]).length, 1);
    assert.deepEqual(sanitizeCommunityList({ not: "array" }), []);
  });

  test("merge: curado e aliases nunca são sobrescritos; custom do aparelho ganha de todos", () => {
    const merged = mergeCatalog(
      [port("soh")],
      [port("soh", { name: "fake" }), port("old-alias"), port("new-one")],
      [port("mine")],
      ["soh", "old-alias"],
    );
    const byId = new Map(merged.map((p) => [p.id, p]));
    assert.equal(byId.get("soh")?.name, "SOH");
    assert.equal(byId.get("soh")?.community, undefined);
    assert.ok(!byId.has("old-alias"));
    assert.equal(byId.get("new-one")?.community, true);
    assert.equal(byId.get("mine")?.isCustom, true);

    const own = mergeCatalog([], [port("new-one")], [port("new-one", { name: "local" })]);
    assert.equal(own.length, 1);
    assert.equal(own[0].name, "local");
    assert.equal(own[0].isCustom, true);
  });

  test("carrega, guarda em cache e revalida com ETag", async () => {
    const storage = memStorage();
    let t = 1_000_000;
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      if ((init.headers as Record<string, string>)?.["If-None-Match"] === 'W/"1"') return jsonResponse(null, { status: 304 });
      return jsonResponse([port("new-one")], { etag: 'W/"1"' });
    }) as unknown as typeof fetch;

    const first = await loadCommunityPorts("https://api", { fetchImpl, storage, now: () => t });
    assert.deepEqual(first.map((p) => p.id), ["new-one"]);
    assert.ok(storage.data.get(COMMUNITY_CACHE_KEY));

    // fresco: não vai à rede
    await loadCommunityPorts("https://api", { fetchImpl, storage, now: () => t + 1000 });
    assert.equal(calls.length, 1);

    // velho: revalida (304) e mantém a lista
    t += 11 * 60 * 1000;
    const again = await loadCommunityPorts("https://api", { fetchImpl, storage, now: () => t });
    assert.equal(calls.length, 2);
    assert.deepEqual(again.map((p) => p.id), ["new-one"]);
  });

  test("offline: usa o cache; sem cache, lista vazia (nunca lança)", async () => {
    const failing = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    const empty = await loadCommunityPorts("https://api", { fetchImpl: failing, storage: memStorage() });
    assert.deepEqual(empty, []);

    resetCommunityMemory();
    const cached = memStorage({
      [COMMUNITY_CACHE_KEY]: JSON.stringify({ savedAt: 0, ports: [port("cached-one"), { broken: true }] }),
    });
    const fromCache = await loadCommunityPorts("https://api", { fetchImpl: failing, storage: cached });
    assert.deepEqual(fromCache.map((p) => p.id), ["cached-one"]);

    resetCommunityMemory();
    const http500 = (async () => jsonResponse({ message: "x" }, { status: 500 })) as unknown as typeof fetch;
    assert.deepEqual(await loadCommunityPorts("https://api", { fetchImpl: http500, storage: memStorage() }), []);
  });
});
