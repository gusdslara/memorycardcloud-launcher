#!/usr/bin/env bash
# Roda na VPS antes do `docker compose up` (vps-deploy.json → preflight).
#  1. confere o .env de produção
#  2. cria as pastas persistentes (MEMORYCARD_HOME) e a rede do Caddy
#  3. na 1ª subida desta stack, migra os dados de um backend MemoryCard antigo
#     (container memorycard-api de outro compose / imagem do ghcr) e o desliga sem apagar nada
set -Eeuo pipefail
cd "$(dirname "$0")/.."
PROJECT_DIR="$PWD"

envget() { { grep -E "^[[:space:]]*$1=" .env 2>/dev/null || true; } | tail -1 | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"'][[:space:]]*$//; s/[[:space:]]+$//"; }
say() { printf '  · %s\n' "$*"; }
fail() { printf '✖ %s\n' "$*" >&2; exit 1; }

SUDO=""
[[ "$(id -u)" != 0 ]] && SUDO="sudo -n"

# ------------------------------------------------------------------ 1. .env
[[ -f .env ]] || fail ".env não encontrado em $PROJECT_DIR (o deploy envia deploy/vps.env)"
missing=()
for v in JWT_SECRET ADMIN_EMAIL ADMIN_PASSWORD; do [[ -n "$(envget "$v")" ]] || missing+=("$v"); done
((${#missing[@]} == 0)) || fail "faltam no .env: ${missing[*]}"
case "$(envget JWT_SECRET)" in
  your_secret_key_here|dev_secret_key_change_me|troque*) fail "JWT_SECRET ainda é o valor de exemplo";;
esac
[[ -n "$(envget CATALOG_ADMIN_TOKEN)" ]] || say "aviso: CATALOG_ADMIN_TOKEN vazio (POST /api/catalog/refresh fica desativado)"

MC_HOME="$(envget MEMORYCARD_HOME)"; MC_HOME="${MC_HOME:-/opt/memorycard}"
DB_NAME="$(envget DB_NAME)"; DB_NAME="${DB_NAME:-memorycard.db}"
ROMS="$(envget ROMS_SSD_PATH)"; ROMS="${ROMS:-/opt/memorycard/roms-cache}"

# ------------------------------------------------------------------ 2. pastas e rede
$SUDO mkdir -p "$MC_HOME/data" "$MC_HOME/uploads" "$ROMS"
mkdir -p .deploy-cache .deploy-logs .deploy-secrets
chmod 700 .deploy-secrets
docker network inspect caddy-net >/dev/null 2>&1 || { docker network create caddy-net >/dev/null; say "rede caddy-net criada"; }
say "dados persistentes em $MC_HOME (banco: $MC_HOME/data/$DB_NAME)"

avail_gb="$(df -BG --output=avail "$MC_HOME" | tail -1 | tr -dc 0-9)"
((avail_gb >= 25)) || say "aviso: só ${avail_gb} GB livres em $MC_HOME (builds do app + mirror do catálogo ocupam bastante)"

# ------------------------------------------------------------------ 3. backend antigo
mount_of() { docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Source}}{{end}}{{end}}" "$1" 2>/dev/null; }
label_of() { docker inspect -f "{{ index .Config.Labels \"$2\" }}" "$1" 2>/dev/null; }
is_ours() {
  [[ "$(label_of "$1" com.docker.compose.project)" == "memorycard" && \
     "$(label_of "$1" com.docker.compose.project.working_dir)" == "$PROJECT_DIR" ]]
}

# Containers de API MemoryCard que não são desta stack (nome/imagem + pasta /data montada)
old=()
while read -r id name image; do
  [[ -z "$id" ]] && continue
  [[ "$name" =~ memorycard|go-backend || "$image" =~ memorycard|go-backend ]] || continue
  [[ "$name" =~ app-builder|filebrowser ]] && continue
  [[ -n "$(mount_of "$id" /data)" ]] || continue
  is_ours "$id" && continue
  old+=("$id")
done < <(docker ps -a --format '{{.ID}} {{.Names}} {{.Image}}')

if ((${#old[@]})); then
  say "backend MemoryCard antigo encontrado: $(for c in "${old[@]}"; do docker inspect -f '{{.Name}}' "$c"; done | tr -d / | xargs)"
  for c in "${old[@]}"; do docker stop "$c" >/dev/null 2>&1 || true; done

  if [[ ! -e "$MC_HOME/data/$DB_NAME" ]]; then
    # o mais recente que tenha banco de dados
    src="" ; best=0
    for c in "${old[@]}"; do
      d="$(mount_of "$c" /data)"
      for f in "$d/$DB_NAME" "$d/memorycard.db"; do
        if $SUDO test -f "$f"; then
          t="$($SUDO stat -c %Y "$f")"
          ((t > best)) && { best=$t; src=$c; }
        fi
      done
    done
    if [[ -n "$src" ]]; then
      d="$(mount_of "$src" /data)"; u="$(mount_of "$src" /app/uploads)"
      say "migrando dados de $(docker inspect -f '{{.Name}}' "$src" | tr -d /): $d → $MC_HOME/data"
      [[ "$d" != "$MC_HOME/data" ]] && $SUDO cp -a "$d/." "$MC_HOME/data/"
      if [[ -n "$u" && "$u" != "$MC_HOME/uploads" ]] && $SUDO test -d "$u"; then
        $SUDO cp -a "$u/." "$MC_HOME/uploads/"
      fi
      say "cópia concluída (os arquivos originais continuam onde estavam)"
    else
      say "nenhum banco encontrado nos containers antigos: começando com banco novo"
    fi
  fi

  ts="$(date +%Y%m%d%H%M%S)"
  for c in "${old[@]}"; do
    n="$(docker inspect -f '{{.Name}}' "$c" | tr -d /)"
    docker update --restart=no "$c" >/dev/null 2>&1 || true
    [[ "$n" == "memorycard-api" ]] && docker rename "$c" "memorycard-api-old-$ts" && n="memorycard-api-old-$ts"
    say "container antigo parado (não removido): $n — apague depois com: docker rm $n"
  done
elif docker inspect memorycard-api >/dev/null 2>&1 && ! is_ours memorycard-api; then
  # mesmo nome, mas sem /data (não é um backend com dados): só tira do caminho
  ts="$(date +%Y%m%d%H%M%S)"
  docker stop memorycard-api >/dev/null 2>&1 || true
  docker update --restart=no memorycard-api >/dev/null 2>&1 || true
  docker rename memorycard-api "memorycard-api-old-$ts"
  say "container memorycard-api de outra stack renomeado para memorycard-api-old-$ts"
fi

say "preflight ok"
