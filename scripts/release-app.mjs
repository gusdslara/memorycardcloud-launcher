#!/usr/bin/env node
/**
 * Gera as builds do app com os arquivos de atualização assinados e (opcional) publica no servidor.
 *
 *   node scripts/release-app.mjs --bump patch --publish --notes "Novidades…"
 *   node scripts/release-app.mjs --platforms linux,windows,android --publish      (o que a VPS roda a cada deploy)
 *
 *   --platforms a,b,c          windows | linux | android | macos | ios (padrão: o sistema desta máquina)
 *                              Linux compila windows (cargo-xwin + NSIS), linux e android.
 *                              Windows compila windows e android. Mac compila macos, ios e android.
 *   --bump patch|minor|major   sobe a versão em tauri.conf.json, Cargo.toml e package.json
 *                              (o atualizador só oferece versões MAIORES que a instalada)
 *   --publish                  envia instalador + .sig para /admin (usa scripts/publish-app-release.mjs)
 *   --notes "…"                novidades mostradas no app e na página /baixar
 *   --skip-build               só publica o que já está compilado
 *   --if-changed               pula a plataforma se o código do app não mudou desde a última build
 *                              publicada dela (e o servidor ainda tem essa versão)
 *   --android-targets "…"      ABIs do APK (padrão: aarch64 armv7 x86_64)
 *   --continue-on-error        uma plataforma que falha não impede as outras (sai com erro no fim)
 *
 * Chave do atualizador: $TAURI_SIGNING_PRIVATE_KEY (conteúdo ou caminho) ou o arquivo
 * src-tauri/.updater/memorycard-updater.key. Guarde uma cópia dessa chave fora do PC:
 * sem ela não dá para assinar atualizações para quem já instalou o app.
 * A chave pública correspondente está em src-tauri/tauri.conf.json (plugins.updater.pubkey).
 */
import { createHash } from "node:crypto";
import { copyFileSync as copyFile, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const die = (m) => {
  console.error("✖ " + m);
  process.exit(1);
};
const host = process.platform; // win32 | linux | darwin
const hostPlatform = host === "win32" ? "windows" : host === "darwin" ? "macos" : "linux";

// ---- plataformas
const ALL = ["windows", "linux", "android", "macos", "ios"];
const CAN_BUILD = {
  windows: ["win32", "linux"],
  linux: ["linux"],
  android: ["win32", "linux", "darwin"],
  macos: ["darwin"],
  ios: ["darwin"],
};
const platforms = (opt("platforms") || hostPlatform)
  .split(/[,\s]+/)
  .map((p) => p.trim().toLowerCase())
  .filter(Boolean);
for (const p of platforms) {
  if (!ALL.includes(p)) die(`plataforma desconhecida: ${p} (use ${ALL.join(", ")})`);
}

// ---- version bump
const confPath = path.join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
let version = conf.version;
const bump = opt("bump");
if (bump) {
  const [ma, mi, pa] = version.split(".").map(Number);
  version = bump === "major" ? `${ma + 1}.0.0` : bump === "minor" ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
  conf.version = version;
  writeFileSync(confPath, JSON.stringify(conf, null, 4) + "\n");
  const cargo = path.join(root, "src-tauri", "Cargo.toml");
  writeFileSync(cargo, readFileSync(cargo, "utf8").replace(/^version = "[^"]+"/m, `version = "${version}"`));
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`→ versão ${version}`);
}

// ---- signing key (desktop updater)
let key = process.env.TAURI_SIGNING_PRIVATE_KEY || "";
const keyFile = path.join(root, "src-tauri", ".updater", "memorycard-updater.key");
if (!key && existsSync(keyFile)) key = readFileSync(keyFile, "utf8").trim();
if (key && existsSync(key)) key = readFileSync(key, "utf8").trim();
const needsKey = platforms.some((p) => ["windows", "linux", "macos"].includes(p));
if (!key && needsKey && !flag("skip-build")) die(`chave do atualizador não encontrada (defina TAURI_SIGNING_PRIVATE_KEY ou crie ${keyFile})`);
const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" };

// ---- helpers
const npx = host === "win32" ? "npx.cmd" : "npx";

// A chave abre? (testa em 1 s, antes de gastar minutos compilando). Se não abrir, as builds de
// desktop saem sem os arquivos do atualizador: instalam normalmente pelo /baixar, mas não se
// atualizam sozinhas até a chave/senha ser corrigida.
let noUpdaterConfig = null;
if (needsKey && !flag("skip-build")) {
  const probe = path.join(os.tmpdir(), `memorycard-sign-${process.pid}.txt`);
  writeFileSync(probe, "ok");
  const r = spawnSync(npx, ["tauri", "signer", "sign", probe], { cwd: root, env, stdio: "pipe", encoding: "utf8", shell: host === "win32" });
  for (const f of [probe, probe + ".sig"]) if (existsSync(f)) rmSync(f);
  if (r.status !== 0) {
    const why = `${r.stderr || r.stdout || ""}`.trim().split("\n").pop();
    console.warn(
      `! A chave do atualizador não abriu (${why}).\n` +
        "  Se ela tem senha, defina TAURI_SIGNING_PRIVATE_KEY_PASSWORD. Se não lembra a senha, gere outra:\n" +
        "  npx tauri signer generate -w src-tauri/.updater/memorycard-updater.key  (e troque plugins.updater.pubkey).\n" +
        "  Seguindo SEM atualização automática nas builds de desktop desta vez.",
    );
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    noUpdaterConfig = path.join(os.tmpdir(), `memorycard-no-updater-${process.pid}.json`);
    writeFileSync(noUpdaterConfig, JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
  }
}
const withUpdaterFallback = (args) => (noUpdaterConfig ? [...args, "--config", noUpdaterConfig] : args);

function tauri(args) {
  console.log(`\n$ tauri ${args.join(" ")}`);
  const r = spawnSync(npx, ["tauri", ...args], { cwd: root, stdio: "inherit", env, shell: host === "win32" });
  if (r.status !== 0) throw new Error(`tauri ${args[0]} falhou (código ${r.status})`);
}
function listFiles(dir) {
  const out = [];
  (function walk(d) {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (!n.endsWith(".app")) walk(p);
      } else out.push(p);
    }
  })(dir);
  return out;
}
const newest = (files) => files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const pickIn = (dir, re, withVersion = true) =>
  newest(listFiles(dir).filter((f) => re.test(path.basename(f)) && (!withVersion || path.basename(f).includes(version))));
const target = (...p) => path.join(root, "src-tauri", "target", ...p);

/** Copia um artefato para um nome legível (o nome vira o arquivo que o usuário baixa). */
function stage(file, name) {
  const dir = target("release-artifacts", version);
  mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, name);
  copyFile(file, dst);
  if (existsSync(file + ".sig")) copyFile(file + ".sig", dst + ".sig");
  return dst;
}

// ---- receitas por plataforma: build() compila, artifacts() devolve [{file, role}]
const androidTargets = (opt("android-targets") || process.env.ANDROID_TARGETS || "aarch64 armv7 x86_64").split(/[,\s]+/).filter(Boolean);
const RECIPES = {
  windows: {
    build() {
      if (host === "win32") tauri(withUpdaterFallback(["build", "--bundles", "nsis,msi"]));
      else tauri(withUpdaterFallback(["build", "--runner", "cargo-xwin", "--target", "x86_64-pc-windows-msvc", "--bundles", "nsis"]));
    },
    artifacts() {
      const dir = host === "win32" ? target("release", "bundle") : target("x86_64-pc-windows-msvc", "release", "bundle");
      return [{ file: pickIn(dir, /-setup\.exe$/i), role: "both" }];
    },
  },
  linux: {
    build() {
      tauri(withUpdaterFallback(["build", "--bundles", "appimage,deb"]));
    },
    artifacts() {
      return [{ file: pickIn(target("release", "bundle"), /\.AppImage$/i), role: "both" }];
    },
  },
  macos: {
    // Universal (Apple Silicon + Intel): o servidor guarda uma build por plataforma.
    // Requer: rustup target add aarch64-apple-darwin x86_64-apple-darwin
    build() {
      tauri(withUpdaterFallback(["build", "--target", "universal-apple-darwin", "--bundles", "app,dmg"]));
    },
    artifacts() {
      const dir = target("universal-apple-darwin", "release", "bundle");
      return [
        { file: pickIn(dir, /\.dmg$/i), role: "installer" },
        ...(noUpdaterConfig ? [] : [{ file: pickIn(dir, /\.app\.tar\.gz$/i, false), role: "updater" }]),
      ];
    },
  },
  android: {
    build() {
      const gradle = path.join(root, "src-tauri", "gen", "android", "app", "build.gradle.kts");
      if (!existsSync(gradle)) tauri(["android", "init", "--ci"]);
      spawnSync(process.execPath, [path.join(root, "deploy", "android-signing.mjs"), "patch"], { cwd: root, stdio: "inherit" });
      tauri(["android", "build", "--apk", "--target", ...androidTargets]);
    },
    artifacts() {
      const dir = path.join(root, "src-tauri", "gen", "android", "app", "build", "outputs", "apk");
      const apk = pickIn(dir, /release.*\.apk$/i, false);
      if (apk && /unsigned/i.test(path.basename(apk))) {
        throw new Error(
          "o APK saiu sem assinatura: crie src-tauri/.android/keystore.properties (ou defina ANDROID_KEYSTORE_PROPERTIES). " +
            "Na VPS isso é automático (deploy/build-apps.sh).",
        );
      }
      return [{ file: apk && stage(apk, `MemoryCard.cloud_${version}_android.apk`), role: "both" }];
    },
  },
  ios: {
    // Em breve: exige Xcode, conta Apple Developer e `npx tauri ios init` uma vez.
    build() {
      if (!existsSync(path.join(root, "src-tauri", "gen", "apple"))) tauri(["ios", "init", "--ci"]);
      tauri(["ios", "build", "--export-method", process.env.IOS_EXPORT_METHOD || "app-store-connect"]);
    },
    artifacts() {
      const ipa = pickIn(path.join(root, "src-tauri", "gen", "apple", "build"), /\.ipa$/i, false);
      return [{ file: ipa && stage(ipa, `MemoryCard.cloud_${version}_ios.ipa`), role: "installer" }];
    },
  },
};

// ---- "mudou desde a última build?" (impressão digital do código do app)
const FINGERPRINT_INPUTS = [
  "src",
  "static",
  "src-tauri/src",
  "src-tauri/capabilities",
  "src-tauri/icons",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
  "src-tauri/build.rs",
  "src-tauri/gen/android/app/src/main/AndroidManifest.xml",
  "src-tauri/gen/android/app/src/main/java",
  "src-tauri/gen/android/app/src/main/res",
  "src-tauri/gen/android/app/build.gradle.kts",
  "package.json",
  "package-lock.json",
  "svelte.config.js",
  "vite.config.js",
  "tailwind.config.js",
  "postcss.config.js",
];
function fingerprint(platform) {
  const h = createHash("sha256");
  h.update(`${platform}\n${version}\n`);
  for (const rel of FINGERPRINT_INPUTS) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    const files = statSync(abs).isDirectory() ? listFiles(abs) : [abs];
    for (const f of files.sort()) {
      h.update(path.relative(root, f).split(path.sep).join("/") + "\n");
      h.update(readFileSync(f));
    }
  }
  return h.digest("hex");
}
const stateFile = target("release-state.json");
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const saveState = () => {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
};

async function publishedOnServer() {
  const api = (process.env.MEMORYCARD_API || "https://memorycard.cloud/api").replace(/\/$/, "");
  try {
    const r = await fetch(`${api}/app/releases`, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// ---- execução
const server = flag("if-changed") ? await publishedOnServer() : null;
const results = [];
for (const platform of platforms) {
  const recipe = RECIPES[platform];
  console.log(`\n━━━━━━━━ ${platform} ━━━━━━━━`);
  try {
    if (!CAN_BUILD[platform].includes(host)) {
      const where = { macos: "num Mac", ios: "num Mac com Xcode", linux: "em Linux", windows: "em Windows ou Linux", android: "em qualquer sistema" }[platform];
      throw new Error(`${platform} só compila ${where}`);
    }
    const fp = fingerprint(platform);
    if (flag("if-changed") && state[platform]?.fingerprint === fp && server?.[platform]?.version === version) {
      console.log(`= sem mudanças desde a build ${server[platform].build} (v${version}); pulando`);
      results.push({ platform, status: "sem mudanças" });
      continue;
    }

    if (!flag("skip-build")) recipe.build();
    const plan = recipe.artifacts();
    for (const p of plan) {
      if (!p.file) throw new Error(`artefato de ${platform} não encontrado (versão ${version})`);
      // .sig de uma build anterior com o mesmo nome não vale para este arquivo
      if (noUpdaterConfig && existsSync(p.file + ".sig")) rmSync(p.file + ".sig");
      console.log(`✔ ${path.relative(root, p.file)}${existsSync(p.file + ".sig") ? " (+ .sig)" : ""}`);
    }

    if (flag("publish")) {
      for (const p of plan) {
        const args = [path.join(root, "scripts", "publish-app-release.mjs"), "--platform", platform, "--file", p.file, "--version", version, "--role", p.role];
        if (opt("notes")) args.push("--notes", opt("notes"));
        const r = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env });
        if (r.status !== 0) throw new Error("publicação falhou");
      }
      state[platform] = { fingerprint: fp, version, date: new Date().toISOString() };
      saveState();
      results.push({ platform, status: "publicado" });
    } else {
      results.push({ platform, status: "compilado" });
    }
  } catch (e) {
    console.error(`✖ ${platform}: ${e.message}`);
    results.push({ platform, status: "falhou", error: e.message });
    if (!flag("continue-on-error")) break;
  }
}

console.log(`\nResumo (v${version}):`);
for (const r of results) console.log(`  ${r.status === "falhou" ? "✖" : "✔"} ${r.platform}: ${r.status}${r.error ? ` (${r.error})` : ""}`);
if (!flag("publish") && results.some((r) => r.status === "compilado")) {
  console.log("\nPara publicar: node scripts/release-app.mjs --skip-build --publish" + (opt("platforms") ? ` --platforms ${opt("platforms")}` : ""));
}
if (results.some((r) => r.status === "falhou") || results.length < platforms.length) process.exit(1);
