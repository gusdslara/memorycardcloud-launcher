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
 *
 * É também onde ficam TODAS as personalizações do projeto Android gerado (src-tauri/gen não vai para o git e
 * é refeito pelo `tauri android init`): MainActivity com as áreas seguras (deploy/android/MainActivity.kt),
 * suporte a Android TV no manifesto e os ícones de src-tauri/icons/android.
 *
 * Também define o placeholder "admobAppId" que o manifesto do tauri-plugin-admob exige (sem ele o Gradle
 * falha no merge do manifesto). ID real via env ADMOB_APP_ID ou -PADMOB_APP_ID; sem isso usa o App ID de
 * TESTE oficial do Google (só anúncios de teste, nunca receita).
 */
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gradle = path.join(root, "src-tauri", "gen", "android", "app", "build.gradle.kts");
const MARK = "MEMORYCARD_SIGNING";
const ADMOB_MARK = "MEMORYCARD_ADMOB";

const admob = `// ${ADMOB_MARK} (deploy/android-signing.mjs): App ID do AdMob para o placeholder do tauri-plugin-admob.
val admobTestAppId = "ca-app-pub-3940256099942544~3347511713"
val admobAppId: String = (System.getenv("ADMOB_APP_ID") ?: (project.findProperty("ADMOB_APP_ID") as String?))
    ?.trim()?.takeIf { it.isNotEmpty() } ?: admobTestAppId
if (admobAppId == admobTestAppId) {
    logger.lifecycle("AdMob: usando o App ID de TESTE do Google (defina ADMOB_APP_ID para o real)")
}

`;

const admobPlaceholder = `        manifestPlaceholders["admobAppId"] = admobAppId
`;

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

const androidDir = path.join(root, "src-tauri", "gen", "android");
const mainDir = path.join(androidDir, "app", "src", "main");

/** Arquivos com este nome em `dir` (recursivo), fora de pastas "generated"/"build". */
function findFiles(dir, name, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "generated" && e.name !== "build") findFiles(p, name, out);
    } else if (e.name === name) out.push(p);
  }
  return out;
}

/**
 * MainActivity com as áreas seguras (barra de status, recorte da câmera, barra de gestos, teclado): sem ela o
 * topo do app fica por baixo da barra de status e o banner do AdMob por cima da barra de gestos.
 * Modelo em deploy/android/MainActivity.kt; o pacote vem do arquivo gerado pelo Tauri.
 */
function patchMainActivity() {
  const [file] = findFiles(path.join(mainDir, "java"), "MainActivity.kt");
  if (!file) {
    console.error("✖ MainActivity.kt não encontrado no projeto Android gerado");
    process.exit(1);
  }
  const pkg = /^package\s+([\w.]+)/m.exec(readFileSync(file, "utf8"))?.[1];
  if (!pkg) {
    console.error(`✖ sem "package" em ${path.relative(root, file)}`);
    process.exit(1);
  }
  const tpl = readFileSync(path.join(root, "deploy", "android", "MainActivity.kt"), "utf8").replace("__PACKAGE__", pkg);
  if (readFileSync(file, "utf8") !== tpl) {
    writeFileSync(file, tpl);
    console.log("✔ MainActivity: áreas seguras do Android aplicadas");
  } else console.log("✔ MainActivity já com as áreas seguras");
}

/** Android TV / Fire TV: aparece no launcher da TV (leanback) sem exigir tela de toque. */
function patchManifest() {
  const file = path.join(mainDir, "AndroidManifest.xml");
  let s = readFileSync(file, "utf8");
  const before = s;
  if (!s.includes("android.software.leanback"))
    s = s.replace(
      /(\n\s*)<application/,
      `$1<!-- MemoryCard: Android TV / Fire TV -->$1<uses-feature android:name="android.software.leanback" android:required="false" />$1<uses-feature android:name="android.hardware.touchscreen" android:required="false" />$1<application`,
    );
  if (!s.includes("LEANBACK_LAUNCHER"))
    s = s.replace(
      /(<category android:name="android\.intent\.category\.LAUNCHER"\s*\/>)/,
      `$1\n                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />`,
    );
  if (s !== before) {
    writeFileSync(file, s);
    console.log("✔ manifesto: suporte a Android TV");
  } else console.log("✔ manifesto já com suporte a Android TV");
}

/** Ícones do app (src-tauri/icons/android, gerados por `tauri icon`) no lugar dos padrão do Tauri. */
function copyIcons() {
  const src = path.join(root, "src-tauri", "icons", "android");
  if (!existsSync(src)) {
    console.warn("! src-tauri/icons/android não existe: ficam os ícones padrão (rode npx tauri icon)");
    return;
  }
  cpSync(src, path.join(mainDir, "res"), { recursive: true });
  console.log("✔ ícones do MemoryCard copiados");
}

function patch() {
  if (!existsSync(gradle)) {
    console.error(`✖ ${path.relative(root, gradle)} não existe (rode: npx tauri android init)`);
    process.exit(1);
  }
  patchMainActivity();
  patchManifest();
  copyIcons();
  let s = readFileSync(gradle, "utf8");
  if (s.includes(MARK) && s.includes(ADMOB_MARK)) {
    console.log("✔ assinatura e AdMob do Android já configurados");
    return;
  }
  const nl = s.includes("\r\n") ? "\r\n" : "\n";
  s = s.replace(/\r\n/g, "\n");

  const steps = [];
  if (!s.includes(MARK))
    steps.push(
      [/^android \{\n/m, (m) => props + m],
      [/^(    buildTypes \{\n)/m, (m) => signingConfigs + m],
      [/^(        getByName\("release"\) \{\n)/m, (m) => m + useSigning],
    );
  if (!s.includes(ADMOB_MARK))
    steps.push(
      [/^android \{\n/m, (m) => admob + m],
      [/^(    defaultConfig \{\n)/m, (m) => m + admobPlaceholder],
    );
  for (const [re, fn] of steps) {
    if (!re.test(s)) {
      console.error(`✖ formato inesperado em build.gradle.kts (não achei ${re}); configure a assinatura à mão`);
      process.exit(1);
    }
    s = s.replace(re, fn);
  }
  writeFileSync(gradle, s.replace(/\n/g, nl));
  console.log("✔ assinatura e AdMob do Android configurados em build.gradle.kts");
}

if (process.argv[2] === "patch") patch();
else console.log("uso: node deploy/android-signing.mjs patch");
