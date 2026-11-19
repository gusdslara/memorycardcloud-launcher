# API pública: ports e avaliações (dados abertos)

Base: `https://memorycard.cloud/api`. Página para pessoas: <https://memorycard.cloud/dados/>.
Código: `go-backend/handlers/public_api.go`, `reviews.go` e `cors.go`.

Leitura livre, sem chave e sem login, de qualquer site (CORS `Access-Control-Allow-Origin: *` só para leitura).
Cache de 5 minutos (`Cache-Control`; `ETag` em `/api/catalog`). Escrita só por `POST /api/reviews`, com login.

## Licença e crédito

- Avaliações do MemoryCard (`source: "memorycard"`): CC BY 4.0. Cite "MemoryCard.cloud".
- Itens importados mantêm o crédito e os termos da fonte (`source`, `sourceName`, `sourceUrl` em cada item;
  lista em `GET /api/public/sources`):
  - `recomplauncher`: relatos públicos e anônimos do RecompLauncher (API `pc.php?a=counts` / `a=feedback`).
  - `awesome-decomp-games`: notas de curadoria (jogabilidade e completude, 1 a 5) em `stats.externalRatings`.
  - `ports-launcher`: selo `quality` em `stats.externalRatings`.

## Endpoints

| Método | Caminho | Resposta |
|---|---|---|
| GET | `/public` | Índice: versão, licença, fontes, endpoints |
| GET | `/public/sources` | Fontes de avaliações/notas com link e termos |
| GET | `/public/ports?primary=1&console=&q=&limit=100&offset=0` | `{ total, offset, limit, items: PublicPort[] }`; total também em `X-Total-Count` |
| GET | `/public/ports/{id}` | `{ port, options, gameReviews }`: o port, as versões do mesmo jogo e a soma das avaliações delas |
| GET | `/public/reviews?port=&source=&since=AAAA-MM-DD&after=&limit=1000&format=json\|ndjson` | `{ license, count, next, items: PublicReview[] }` (JSON) ou uma avaliação por linha (NDJSON). Máximo 5.000 por página; siga `next` (ou o cabeçalho `Link`) até `null` |
| GET | `/reviews/summary[?source=memorycard\|recomplauncher]` | `{ ports: { [id]: ReviewSummary } }` de todos os ports com avaliação |
| GET | `/reviews?port={id}&limit=50&offset=0` | `{ port, summary, items }` (o que o app e o site usam na página do port) |
| GET | `/catalog` | Catálogo completo do app (versões, espelhos, artes) |
| POST | `/reviews` | Cria ou substitui a avaliação da conta para aquele port e plataforma (login) |
| DELETE | `/reviews/{id}` | Remove a própria avaliação (ou admin). Importadas são ocultadas, não apagadas |

### PublicPort

```json
{
  "id": "dkb-pc-recomp", "name": "Donkey Kong Bananza PC Recomp", "game": "Donkey Kong Bananza",
  "console": "Nintendo Switch", "portType": "recomp", "author": "Lucas-blip-png",
  "repo": "Lucas-blip-png/dkb-pc-recomp", "websiteUrl": "https://github.com/…", "supportedOs": ["windows"],
  "alternativeOf": "",                       // id do principal quando é uma versão alternativa do jogo
  "stats": { "score": 926.3, "stars": 1159, "reports": { "runs": 125, "issues": 19, "broken": 9 },
             "externalRatings": [{ "source": "awesome-decomp-games", "playability": 5, "completeness": 4, "max": 5 }],
             "sources": ["awesome-switch-recomp", "recomplauncher"] },
  "externalIds": { "recomplauncher": "…" },
  "reviews": { /* ReviewSummary ou null */ },
  "links": { "page": "https://memorycard.cloud/ports/dkb-pc-recomp", "reviews": "/api/public/reviews?port=dkb-pc-recomp" }
}
```

### ReviewSummary

`total`, `runs`, `issues`, `broken`, `avgRating` (1–5 ou null), `ratingCount`, `avgFps`, `stutterYes`, `stutterNo`,
`sources` (`{ memorycard, recomplauncher }`), `platforms` (`{ windows, linux, macos, android, ios }`),
`devices` (aparelhos diferentes, pelo texto do hardware).

### PublicReview

`id`, `port`, `game`, `source`, `sourceName`, `sourceUrl`, `author` (primeiro nome + inicial; nunca e-mail),
`hardware`, `platform`, `version`, `rating` (1–5, só MemoryCard), `verdict` (`runs` | `issues` | `broken`),
`fps`, `stutter`, `note`, `createdAt`.

## Escrita e proteção contra abuso

`POST /api/reviews` com `Authorization: Bearer <token>` e corpo
`{ port, platform, hardware, rating (1–5), version?, fps?, stutter?, note? }`.

- Uma avaliação por conta, port e plataforma: enviar de novo substitui a anterior.
- Limites: 20 por hora por conta e 40 por hora por IP (HTTP 429 com `Retry-After`).
- Port precisa existir no catálogo; textos com tamanho máximo (hardware 300, nota 500, versão 64).
- Conta suspensa não avalia.

## Exemplos

```bash
curl -s "https://memorycard.cloud/api/public/ports/dkb-pc-recomp" | jq '.gameReviews'
curl -s "https://memorycard.cloud/api/public/reviews?format=ndjson&limit=5000" > reviews.ndjson
```

```js
let url = "https://memorycard.cloud/api/public/reviews?limit=5000";
const all = [];
while (url) {
  const page = await (await fetch(url)).json();
  all.push(...page.items);
  url = page.next && new URL(page.next, "https://memorycard.cloud").href;
}
```

## CORS

- `GET`/`HEAD` de `/api/public/*`, `/api/catalog*`, `/api/reviews`, `/api/reviews/summary` e `/api/ports/community`:
  qualquer origem, sem credenciais.
- O resto da API: só as origens conhecidas (site, servidores de dev e o webview do app: `tauri://localhost`,
  `http://tauri.localhost`, `https://tauri.localhost`), com credenciais. `CORS_ORIGINS` ACRESCENTA origens a essa
  lista (antes substituía, e o valor de produção deixava o app de fora: as avaliações não carregavam no app).
