#!/usr/bin/env bash
# Compila o app MemoryCard para as plataformas de APP_PLATFORMS e publica no servidor.
# Roda dentro do container app-builder (docker-compose.vps.yml), disparado a cada deploy.
#
#   APP_PLATFORMS      linux,windows,android (padrão)  — macos/ios só num Mac
#   FORCE_APP_BUILD=1  recompila mesmo sem mudanças no código do app
#   APP_RELEASE_NOTES  novidades mostradas no app e em /baixar
set -Eeuo pipefail
cd /workspace

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }

PLATFORMS="${APP_PLATFORMS:-linux,windows,android}"
mkdir -p /cache/cargo /cache/gradle /cache/xwin /cache/xdg /cache/npm

# ------------------------------------------------------------------ dependências JS
lock_hash="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [[ ! -f node_modules/.memorycard-lock ]] || [[ "$(cat node_modules/.memorycard-lock)" != "$lock_hash" ]]; then
  log "npm ci"
  npm ci --no-audit --no-fund
  echo "$lock_hash" > node_modules/.memorycard-lock
fi

# ------------------------------------------------------------------ Android: projeto + assinatura
if [[ ",$PLATFORMS," == *",android,"* ]]; then
  if [[ ! -f src-tauri/gen/android/app/build.gradle.kts ]]; then
    log "Gerando o projeto Android (tauri android init)"
    npx tauri android init --ci
  fi
  chmod +x src-tauri/gen/android/gradlew
  node deploy/android-signing.mjs patch

  # Keystore de release: usa a enviada pelo deploy; na 1ª vez cria uma e guarda em .deploy-secrets/android.
  dir="${ANDROID_SECRETS_DIR:-/workspace/.deploy-secrets/android}"
  if [[ ! -f "$dir/keystore.properties" ]]; then
    log "Criando a keystore de release do Android em $dir (faça backup dela!)"
    mkdir -p "$dir"
    pass="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
    keytool -genkeypair -v -keystore "$dir/memorycard-release.jks" -alias memorycard \
      -keyalg RSA -keysize 4096 -validity 36500 -storepass "$pass" -keypass "$pass" \
      -dname "CN=MemoryCard.cloud, O=Unrender, C=BR" >/dev/null
    # storeFile relativo: a pasta inteira pode ser copiada para src-tauri/.android/ no PC
    printf 'storeFile=memorycard-release.jks\npassword=%s\nkeyAlias=memorycard\nkeyPassword=%s\n' \
      "$pass" "$pass" > "$dir/keystore.properties"
    chmod 600 "$dir"/*
    warn "Nova keystore Android criada. Copie a pasta .deploy-secrets/android da VPS para um lugar seguro:"
    warn "sem ela, as próximas versões do APK não instalam por cima das antigas."
  fi
  # lido por src-tauri/gen/android/app/build.gradle.kts (storeFile relativo a esta pasta)
  export ANDROID_KEYSTORE_PROPERTIES="$dir/keystore.properties"
fi

# ------------------------------------------------------------------ build + publicação
args=(--platforms "$PLATFORMS" --continue-on-error)
[[ -z "${FORCE_APP_BUILD:-}" ]] && args+=(--if-changed)
[[ -n "${APP_RELEASE_NOTES:-}" ]] && args+=(--notes "$APP_RELEASE_NOTES")
[[ -n "${ANDROID_TARGETS:-}" ]] && args+=(--android-targets "$ANDROID_TARGETS")
if [[ -n "${MEMORYCARD_ADMIN_EMAIL:-}" && -n "${MEMORYCARD_ADMIN_PASSWORD:-}" ]]; then
  args+=(--publish)
else
  warn "ADMIN_EMAIL/ADMIN_PASSWORD ausentes no .env: compila mas não publica."
fi

log "release-app ${args[*]}"
# prioridade baixa: a API continua respondendo rápido enquanto compila
exec nice -n 10 node scripts/release-app.mjs "${args[@]}"
