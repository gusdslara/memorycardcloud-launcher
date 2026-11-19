#!/usr/bin/env node
/**
 * Deixa o APK de release assinado: injeta a configuração de assinatura em
 * src-tauri/gen/android/app/build.gradle.kts (idempotente; refaz se o Tauri regenerar o projeto).
 *
 *   node deploy/android-signing.mjs patch
 *
 * A keystore vem de um keystore.properties (formato da documentação do Tauri):
 *   storeFile=memorycard-release.jks   (absoluto ou relativo à pasta do .properties)
 *   password=...
 *   keyAlias=memorycard
 *   keyPassword=...                    (opcional; padrão = password)
 * Procurado em $ANDROID_KEYSTORE_PROPERTIES ou em src-tauri/.android/keystore.properties.
 * Sem keystore, o Gradle gera o APK sem assinatura (e o release-app.mjs avisa).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gradle = path.join(root, "src-tauri", "gen", "android", "app", "build.gradle.kts");
const MARK = "MEMORYCARD_SIGNING";

const props = `// ${MARK} (deploy/android-signing.mjs): assina o release com a keystore de
// $ANDROID_KEYSTORE_PROPERTIES ou src-tauri/.android/keystore.properties. Sem keystore, sai sem assinatura.
val releaseKeystore = Properties().apply {
    val f = file(System.getenv("ANDROID_KEYSTORE_PROPERTIES") ?: rootProject.file("../../.android/keystore.properties").path)
    if (f.exists()) {
        f.inputStream().use { load(it) }
        setProperty("_dir", f.parentFile.absolutePath)
    }
}

`;

const signingConfigs = `    signingConfigs {
        create("release") {
            releaseKeystore.getProperty("storeFile")?.let { store ->
                val f = File(store)
                storeFile = if (f.isAbsolute) f else File(releaseKeystore.getProperty("_dir"), store)
                storePassword = releaseKeystore.getProperty("password")
                keyAlias = releaseKeystore.getProperty("keyAlias")
                keyPassword = releaseKeystore.getProperty("keyPassword") ?: releaseKeystore.getProperty("password")
            }
        }
    }
`;

const useSigning = `            if (releaseKeystore.getProperty("storeFile") != null) {
                signingConfig = signingConfigs.getByName("release")
            }
`;

function patch() {
  if (!existsSync(gradle)) {
    console.error(`✖ ${path.relative(root, gradle)} não existe (rode: npx tauri android init)`);
    process.exit(1);
  }
  let s = readFileSync(gradle, "utf8");
  if (s.includes(MARK)) {
    console.log("✔ assinatura Android já configurada");
    return;
  }
  const nl = s.includes("\r\n") ? "\r\n" : "\n";
  s = s.replace(/\r\n/g, "\n");

  const steps = [
    [/^android \{\n/m, (m) => props + m],
    [/^(    buildTypes \{\n)/m, (m) => signingConfigs + m],
    [/^(        getByName\("release"\) \{\n)/m, (m) => m + useSigning],
  ];
  for (const [re, fn] of steps) {
    if (!re.test(s)) {
      console.error(`✖ formato inesperado em build.gradle.kts (não achei ${re}); configure a assinatura à mão`);
      process.exit(1);
    }
    s = s.replace(re, fn);
  }
  writeFileSync(gradle, s.replace(/\n/g, nl));
  console.log("✔ assinatura Android configurada em build.gradle.kts");
}

if (process.argv[2] === "patch") patch();
else console.log("uso: node deploy/android-signing.mjs patch");
