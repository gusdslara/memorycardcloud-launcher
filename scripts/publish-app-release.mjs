#!/usr/bin/env node
/**
 * Publica uma build do app MemoryCard no servidor (página /baixar + atualizador automático).
 *
 *   node scripts/publish-app-release.mjs --platform windows --file "src-tauri/target/release/bundle/nsis/MemoryCard.cloud_0.2.0_x64-setup.exe"
 *
 * Opções:
 *   --platform  windows | macos | linux | android | ios    (obrigatório)
 *   --file      instalador / pacote                          (obrigatório)
 *   --sig       arquivo .sig do atualizador (padrão: <file>.sig, se existir)
 *   --version   padrão: "version" do src-tauri/tauri.conf.json
 *   --build     número da build (padrão: o próximo do servidor)
 *   --role      both | installer | updater (padrão: both; .dmg = installer; .app.tar.gz = updater)
 *   --notes     novidades da versão
 *   --api       padrão: $MEMORYCARD_API ou https://memorycard.cloud/api
 *
 * Login: $MEMORYCARD_ADMIN_EMAIL e $MEMORYCARD_ADMIN_PASSWORD (conta superadmin), ou $MEMORYCARD_TOKEN.
 * Sem dependências: só Node 18+.
 */
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? "true" : all[i + 1]]] : acc), []),
);
const die = (m) => {
  console.error("✖ " + m);
  process.exit(1);
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const api = (args.api || process.env.MEMORYCARD_API || "https://memorycard.cloud/api").replace(/\/$/, "");
const platform = args.platform;
const file = args.file;
if (!["windows", "macos", "linux", "android", "ios"].includes(platform)) die("--platform windows|macos|linux|android|ios");
if (!file || !existsSync(file)) die(`arquivo não encontrado: ${file}`);

const version = args.version || JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const lower = file.toLowerCase();
const role = args.role || (lower.endsWith(".dmg") ? "installer" : lower.endsWith(".app.tar.gz") ? "updater" : "both");
const sigPath = args.sig || (existsSync(file + ".sig") ? file + ".sig" : "");
const signature = sigPath ? readFileSync(sigPath, "utf8").trim() : "";
if (!["android", "ios"].includes(platform) && role !== "installer" && !signature) {
  console.warn("! Sem .sig: o atualizador automático vai ignorar esta build (rode o build com TAURI_SIGNING_PRIVATE_KEY).");
}

async function call(p, init = {}) {
  const r = await fetch(api + p, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!r.ok) throw new Error(`${r.status} ${body?.message ?? text}`);
  return body;
}

let token = process.env.MEMORYCARD_TOKEN;
if (!token) {
  const email = process.env.MEMORYCARD_ADMIN_EMAIL;
  const password = process.env.MEMORYCARD_ADMIN_PASSWORD;
  if (!email || !password) die("defina MEMORYCARD_ADMIN_EMAIL e MEMORYCARD_ADMIN_PASSWORD (ou MEMORYCARD_TOKEN)");
  const r = await fetch(api + "/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!r.ok) die(`login falhou (${r.status})`);
  token = (await r.json()).token;
}

const size = statSync(file).size;
const name = path.basename(file);
console.log(`→ ${name} (${(size / 1048576).toFixed(1)} MB) para ${api}`);
const up = await call("/admin/uploads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_name: name, size }) });

const CHUNK = 16 * 1024 * 1024;
const fd = openSync(file, "r");
let offset = 0;
let tries = 0;
while (offset < size) {
  const len = Math.min(CHUNK, size - offset);
  const buf = Buffer.alloc(len);
  readSync(fd, buf, 0, len, offset);
  try {
    const r = await call(`/admin/uploads/${up.id}`, { method: "PUT", headers: { "Upload-Offset": String(offset), "Content-Type": "application/octet-stream" }, body: buf });
    offset = r.received;
    tries = 0;
    process.stdout.write(`\r  ${Math.round((offset / size) * 100)}%`);
  } catch (e) {
    if (++tries > 5) die(e.message);
    const st = await call(`/admin/uploads/${up.id}`).catch(() => null);
    if (st) offset = st.received;
    await new Promise((r) => setTimeout(r, 1000 * tries));
  }
}
closeSync(fd);
process.stdout.write("\n");

const rel = await call("/admin/app-releases", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ platform, version, build: args.build ? Number(args.build) : 0, role, notes: args.notes || "", signature, upload_id: up.id }),
});
console.log(`✔ Publicado: ${platform} ${rel.version} build ${rel.build} (${rel.role}${rel.has_signature ? ", assinada" : ""})`);
