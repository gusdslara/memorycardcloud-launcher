import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { WEB_PORTS } from "../src/lib/data/webPorts.ts";
import { isPlayerMessage, resolveAgainst, sameOrigin, webPortTarget } from "../src/lib/webPortPlay.ts";

describe("Web ports: onde cada um abre", () => {
  test("hospedado por nós abre no app, com URL relativa resolvida contra o site", () => {
    const t = webPortTarget({ webUrl: "https://example.org", hostedUrl: "/play/sm64/", isHostedOnMCD: true }, "https://memorycard.cloud");
    assert.deepEqual(t, { url: "https://memorycard.cloud/play/sm64/", inApp: true, ownWindow: false });
    const dev = webPortTarget({ webUrl: "x", hostedUrl: "/play/gow-coo/", isHostedOnMCD: true }, "http://localhost:5174/");
    assert.equal(dev.url, "http://localhost:5174/play/gow-coo/");
  });

  test("URL hospedada absoluta é mantida", () => {
    assert.equal(resolveAgainst("https://cdn.example.com/play/x/", "https://memorycard.cloud"), "https://cdn.example.com/play/x/");
  });

  test("os demais abrem o site do projeto fora do app", () => {
    const t = webPortTarget({ webUrl: "https://armor-alley.net", isHostedOnMCD: false }, "https://memorycard.cloud");
    assert.deepEqual(t, { url: "https://armor-alley.net", inApp: false, ownWindow: false });
    // marcado como hospedado mas sem URL: não dá para abrir no app
    assert.equal(webPortTarget({ webUrl: "https://a.b", isHostedOnMCD: true }, "https://memorycard.cloud").inApp, false);
  });

  test("todo port hospedado tem hostedUrl sob /play/", () => {
    for (const w of WEB_PORTS.filter((w) => w.isHostedOnMCD)) {
      assert.ok(w.hostedUrl, `${w.id} está marcado como hospedado mas não tem hostedUrl`);
      assert.match(webPortTarget(w, "https://memorycard.cloud").url, /^https:\/\/memorycard\.cloud\/play\//);
    }
  });

  test("port que precisa de cross-origin isolation abre em janela própria do app, não no iframe", () => {
    const gow = WEB_PORTS.find((w) => w.id === "gow-coo-web");
    assert.ok(gow?.crossOriginIsolated, "God of War precisa de COOP/COEP (WASM com threads)");
    const t = webPortTarget(gow!, "https://memorycard.cloud");
    assert.equal(t.inApp, true);
    assert.equal(t.ownWindow, true);
    // isolado sem estar hospedado por nós não vira janela do app
    assert.equal(webPortTarget({ webUrl: "https://a.b", crossOriginIsolated: true }, "https://memorycard.cloud").ownWindow, false);
  });

  test("mensagens do player e checagem de origem", () => {
    assert.ok(isPlayerMessage({ type: "mcd-player:close" }));
    assert.ok(!isPlayerMessage({ type: "other" }));
    assert.ok(!isPlayerMessage(null));
    assert.ok(sameOrigin("https://memorycard.cloud/play/sm64/", "https://memorycard.cloud"));
    assert.ok(!sameOrigin("https://evil.example/play/", "https://memorycard.cloud/play/sm64/"));
    assert.ok(!sameOrigin("null", "https://memorycard.cloud"));
  });
});
