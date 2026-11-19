import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstallLink } from "../src/lib/stores/deepLink.ts";

test("site 'Instalar pelo app' links open the right installer", () => {
  assert.deepEqual(parseInstallLink("memorycard://install/port/mm-recomp"), { kind: "port", id: "mm-recomp" });
  assert.deepEqual(parseInstallLink("memorycard://install/emulator/pcsx2"), { kind: "emulator", id: "pcsx2" });
  assert.deepEqual(parseInstallLink("memorycard://install/native/grand-theft-auto-vice-city"), { kind: "native", id: "grand-theft-auto-vice-city" });
  assert.equal(parseInstallLink("memorycard://install/native/../../etc"), null);
  assert.equal(parseInstallLink("https://evil.com/install/port/x"), null);
});
