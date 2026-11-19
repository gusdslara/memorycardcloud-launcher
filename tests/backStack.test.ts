import { describe, test as it } from "node:test";
import assert from "node:assert/strict";
import { createBackStack, type BackHistory } from "../src/lib/backStack.ts";

/** Histórico falso: conta entradas e deixa o teste simular o "voltar" do sistema. */
function fakeHistory() {
  let depth = 0;
  let pop: () => void = () => {};
  const pending: (() => void)[] = [];
  const h: BackHistory = {
    push: () => void depth++,
    back: () => {
      depth--;
      pop();
    },
    onPop: (cb) => {
      pop = cb;
      return () => {};
    },
  };
  return {
    h,
    get depth() {
      return depth;
    },
    /** o usuário aperta voltar */
    systemBack() {
      if (depth === 0) return "exit";
      depth--;
      pop();
      return "handled";
    },
    defer: (fn: () => void) => void pending.push(fn),
    flush() {
      while (pending.length) pending.shift()!();
    },
  };
}

describe("backStack", () => {
  it("voltar fecha a camada do topo e só sai do app quando não sobra nenhuma", () => {
    const f = fakeHistory();
    const s = createBackStack(f.h, f.defer);
    const closed: string[] = [];
    s.push(() => closed.push("aba"));
    s.push(() => closed.push("modal"));
    s.push(() => closed.push("player"));
    assert.equal(f.depth, 1); // uma guarda só

    assert.equal(f.systemBack(), "handled");
    assert.deepEqual(closed, ["player"]);
    assert.equal(f.depth, 1); // guarda recolocada
    f.systemBack();
    f.systemBack();
    assert.deepEqual(closed, ["player", "modal", "aba"]);
    assert.equal(f.depth, 0);
    assert.equal(f.systemBack(), "exit");
  });

  it("fechar pelo app remove a guarda quando não sobra camada", () => {
    const f = fakeHistory();
    const s = createBackStack(f.h, f.defer);
    let closed = false;
    const release = s.push(() => (closed = true));
    release();
    f.flush();
    assert.equal(f.depth, 0);
    assert.equal(closed, false); // o pop do nosso history.back() não fecha nada
    assert.equal(f.systemBack(), "exit");
  });

  it("fechar o detalhe e abrir o player no mesmo tick reaproveita a guarda", () => {
    const f = fakeHistory();
    const s = createBackStack(f.h, f.defer);
    const closed: string[] = [];
    const releaseDetail = s.push(() => closed.push("detalhe"));
    releaseDetail();
    s.push(() => closed.push("player"));
    f.flush();
    assert.equal(f.depth, 1);
    f.systemBack();
    assert.deepEqual(closed, ["player"]);
    assert.equal(f.systemBack(), "exit");
  });

  it("liberar uma camada do meio mantém as outras e liberar duas vezes não faz nada", () => {
    const f = fakeHistory();
    const s = createBackStack(f.h, f.defer);
    const closed: string[] = [];
    s.push(() => closed.push("aba"));
    const release = s.push(() => closed.push("modal"));
    s.push(() => closed.push("player"));
    release();
    release();
    f.flush();
    assert.equal(s.depth, 2);
    f.systemBack();
    f.systemBack();
    assert.deepEqual(closed, ["player", "aba"]);
  });
});
