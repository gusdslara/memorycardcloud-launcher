# Backups dos usuários no Google Drive do dono

Relatório de 17/11/2026. Cobre o que existia, o que foi implementado, a política de capacidade para os 5 TB e os riscos (termos do Google e LGPD).

## 1. O que existia antes

| Parte | Situação |
|---|---|
| Google Drive (commit `fc9a482`) | Só para a **biblioteca de ROMs/ISOs**. O OAuth do superadmin pedia `drive.readonly`, então o servidor **não conseguia gravar** no Drive. |
| Backups (`/api/upload/backup` do app, `/api/saves` do site) | Gravados no **disco da VPS** (`DATA_DIR/users/<id>/...`), nunca no Drive. |
| Cota | Checada só no upload do app, e depois de receber o arquivo inteiro. O upload do site **não checava cota**. Nada era checado durante o upload. |
| Arquivos grandes | Multipart em um único request (até 500 MB, tudo em memória). O app lia o arquivo inteiro com `fs::read` e baixava com `resp.bytes()`. |
| Mudança/cancelamento de plano | O webhook do Asaas já ajusta `storage_limit`, mas nada liberava espaço: quem cancelava continuava ocupando tudo. |
| Versões antigas, dedup e limite de 750 GB/dia | Inexistentes. |
| Segurança | `getUserID` imprimia o header `Authorization` (o JWT) no log. Corrigido. |

## 2. O que foi implementado

### Backend Go (`go-backend/`)

- **`internal/gdrive/backup.go`**: lado de escrita do Drive.
  - Upload **resumível** em pedaços de 32 MiB, retomado do offset que o Drive confirma. A URI da sessão fica salva no banco, então um restart do servidor continua o envio.
  - **Retry com backoff exponencial e jitter** (até 64 s) para 429, 5xx e 403 de rate limit.
  - Em 401, o token é **descartado e renovado** com o refresh token guardado no servidor.
  - **Limitador de requisições** (8 req/s, compartilhado).
  - Os erros são classificados: sem permissão de gravação, limite diário de 750 GB e Drive cheio.
  - Também faz download com `Range`, delete permanente (a lixeira conta na cota) e move de pasta.
- **`internal/gdrive/oauth.go`**: o login do superadmin passa a pedir também `drive.file`. Esse escopo só enxerga o que o próprio servidor criou e não exige verificação do Google.
- **`internal/backupstore/`**: o serviço de backups.
  - **Pasta por usuário** no Drive do dono: `MemoryCard Backups/users/u<ID>/`. Os arquivos idênticos de 2 ou mais usuários vão para `MemoryCard Backups/shared/`. O nome da pasta não contém e-mail.
  - **Cota por plano**: `storage_limit` do usuário enquanto o plano está ativo; sem plano, vale o limite gratuito (100 MB).
    - **Antes** do upload, o tamanho é reservado (uso + reservas + tamanho ≤ limite) e o que não cabe é recusado com HTTP 507 antes do primeiro byte.
    - **Durante** o upload, o plano é rechecado a cada pedaço e nada passa do tamanho reservado (413).
    - **No fim**, a cota é rechecada com o tamanho real.
  - **Dedup** por SHA-256 calculado **no servidor**. O mesmo ISO enviado por vários usuários fica guardado uma vez, mas cada um paga o tamanho cheio na própria cota. Como os bytes sempre sobem, o cliente não consegue descobrir se outro usuário tem o arquivo.
  - **Fila de envio ao Drive** com orçamento móvel de 700 GB em 24 h, abaixo do limite de 750 GB do Google. O que passa espera a janela. Enquanto o arquivo está na fila, o download sai da cópia em staging.
  - **Versões**: mantém as N mais recentes de cada jogo (Silver 5, Gold 10, Diamond 20, Exclusive 50; `BACKUP_MAX_VERSIONS` sobrepõe). As mais antigas são apagadas.
  - **Downgrade ou cancelamento**: a conta fica "acima da cota", os envios são bloqueados e começa uma carência de 30 dias (`BACKUP_GRACE_DAYS`). Depois dela, o janitor apaga primeiro as versões antigas e depois as mais velhas, até caber no plano.
  - **Conta apagada (LGPD)**: os backups, os arquivos no Drive e a pasta do usuário são removidos.
  - **Capacidade física**: recusa novos envios quando o Drive (ou o disco) passaria de 90% (`BACKUP_RESERVE_RATIO`) e quando a VPS ficaria com menos de 10 GiB livres para staging.
  - **Sem Drive conectado** (`BACKUP_STORAGE=auto`): guarda no disco da VPS, como hoje. Quando o dono conecta o Drive, o janitor **migra sozinho** os blobs locais e os backups antigos (`DATA_DIR/users/...`) para o Drive e libera o disco.
- **`handlers/backups.go`**: as rotas novas.
  - `GET /api/backups/usage`
  - `POST/GET/PUT/DELETE /api/backups/uploads[/:id]` e `POST .../complete`
  - `GET /api/backups/:id/link`: link assinado de 10 minutos para o navegador baixar arquivos grandes sem carregar tudo na memória.
  - `GET /api/admin/backups/stats`: capacidade, vendido, uso lógico e físico, dedup, overcommit, fila, envio nas últimas 24 h e alertas.
  - `POST /api/admin/backups/janitor`
- As rotas antigas (`/api/upload/backup`, `/api/saves`, download e delete) continuam com o mesmo contrato, agora em cima do mesmo armazenamento. Versões antigas do app seguem funcionando.

### App Tauri (`src-tauri/`)

- **`src/cloud_upload.rs`**: upload resumível lendo o arquivo do disco pedaço por pedaço (um jogo de 30 GB não fica em memória), com retomada e backoff. Download em streaming para um arquivo `.part`, renomeado no fim.
- `backup_manager.rs`: `upload_to_cloud` usa o protocolo novo e volta para o multipart se o servidor for antigo. `download_from_cloud` usa o streaming. As assinaturas não mudaram, então os comandos Tauri e o `SaveHistoryModal` funcionam sem alteração.

### Landing (`landing/`)

- "Minha conta" ganhou **Enviar backup**:
  - arrastar ou escolher arquivos; o nome do jogo e o tipo (save ou jogo) são inferidos e editáveis;
  - plataforma, progresso por arquivo e cancelamento;
  - aviso quando a soma não cabe no plano.
- A lista de backups mostra "jogo" e "processando" (na fila do Drive) e permite apagar qualquer versão. O download usa o link assinado.
- Aparece um aviso de **acima da cota**, com a data-limite da carência.

### Testes

- `go test`:
  - `internal/gdrive`: upload resumível com chunk cortado ao meio, 429 na abertura da sessão, token expirado (401 → refresh), retomada de sessão salva após "queda" do processo, Range, move e delete.
  - `handlers`: 4 cenários de ponta a ponta contra um **Google Drive falso** (`internal/gdrive/gdrivetest`):
    - layout de pastas, cota antes e durante o upload, reserva e cancelamento;
    - dedup entre usuários com move para `shared/`, delete com contagem de referências e remoção da pasta vazia;
    - link assinado, retenção de versões e rotas multipart;
    - downgrade com carência e expurgo na ordem certa, conta apagada;
    - orçamento de 24 h, fallback local e promoção para o Drive.
- `npm test`: 2646 ok, incluindo `tests/backupNames.test.ts`.
- `svelte-check`: 0 erros e 0 avisos no app e na landing.
- `cargo check`: ok.
- Navegador: API local (`BACKUP_STORAGE=local`) + landing em dev. Envio de 3 MB, bloqueio de arquivo que não cabe, link assinado com Range (206), aviso de cota estourada e layout em 375 px sem rolagem horizontal.

**Não testado contra a conta real**: o token guardado hoje só tem `drive.readonly`, e gravar exige reconectar com `drive.file` (ver seção 5). O teste foi feito contra o Drive falso, que segue o protocolo da API v3.

## 3. Política para os 5 TB (quantos usuários cabem)

Base: a conta de 5 TB com 10% de reserva dá **≈ 4,6 TB úteis**. Esse espaço é dividido com a biblioteca de ROMs, se ela ficar na mesma conta. O cálculo de capacidade usa o `about` do Drive, então já desconta tudo o que a conta guarda.

Uso médio estimado (a medir em produção com `/api/admin/backups/stats`):

- Silver (5 GB): só saves, cerca de 1 GB por usuário (20% do plano).
- Gold (30 GB): cerca de 7,5 GB (25%).
- Diamond (100 GB): cerca de 35 GB, com ISOs. Com dedup de jogos populares, 20% a menos: **≈ 28 GB físicos**.

| Plano | Sem overcommit (cada um enche o plano) | Com o uso médio acima | Overcommit implícito |
|---|---|---|---|
| Silver 5 GB | 920 usuários | ~4.600 | 5x |
| Gold 30 GB | 153 | ~610 | 4x |
| Diamond 100 GB | 46 | ~165 | 3,6x |
| Mix 70% Silver / 25% Gold / 5% Diamond | ~290 | **~1.150** (≈ 4 GB físicos/usuário) | 4x |

Política recomendada:

1. **Overcommit máximo de 3x** (vendido ÷ capacidade) até haver 2 a 3 meses de dados reais. No mix acima, isso dá **~860 assinantes** (≈ 13,8 TB vendidos sobre 4,6 TB).
2. **Trava física já implementada**: a 90% de uso o servidor recusa novos envios (HTTP 507 `SERVER_FULL`). O alerta no admin começa em 85% de uso ou 4x de overcommit.
3. Parar de vender **Diamond** quando o uso físico passar de 70%. É o plano que mais consome por real cobrado (R$ 0,50/GB contra R$ 3/GB no Silver).
4. **Dedup** já ativo, mas só ajuda de verdade em jogos (ISOs iguais). Os saves do app são `.zip` com data dentro e raramente se repetem.
5. **Compressão**: os saves já chegam em zip (deflate), e recomprimir não ganha nada. Para jogos, o ganho grande vem do **formato**: CHD (PS1/PS2/DC/Saturn) e RVZ (GameCube/Wii) reduzem de 30% a 60% e continuam jogáveis. Recomendo converter no app antes do envio (follow-up). Zstd no servidor ganharia de 10% a 30% em ISO cru, mas quebra o download com Range e custa CPU na VPS. Não foi implementado.
6. **Versões**: os limites por plano já valem. Dá para baixar para 3, 5 e 10 se o uso médio passar do estimado.
7. **Carência de 30 dias** após downgrade ou cancelamento, depois expurgo automático. É o que devolve espaço de quem sai.

Fluxo diário: 700 GB por dia de envio ao Drive. Com ~1.000 usuários, só a primeira carga de jogos dos Diamond (165 × 28 GB ≈ 4,6 TB) levaria **~7 dias** na fila. O staging precisa de disco na VPS durante esse tempo, e o servidor recusa envios se sobrarem menos de 10 GiB livres.

## 4. Riscos

### Termos do Google

- Os termos do Google One **não proíbem de forma explícita** revender armazenamento (verificado em one.google.com/terms-of-service). Mesmo assim, é uma **conta pessoal** servindo de backend de um serviço pago. Os Termos de Serviço do Google e as políticas do Drive permitem suspender a conta por violação, e as políticas do programa Drive **proíbem conteúdo que infrinja direitos autorais**.
- Usuários enviando ISOs de jogos que não possuem **é o maior risco**. Uma denúncia ou detecção pode suspender a conta inteira, levando junto **os backups de todos os usuários e a biblioteca de ROMs**: é um ponto único de falha.
- Mitigação:
  - termos de uso exigindo cópia própria e processo de remoção (takedown);
  - **separar a biblioteca de ROMs dos backups em contas diferentes**;
  - médio prazo: migrar para armazenamento de objetos com contrato (Backblaze B2, Cloudflare R2, Wasabi, na faixa de US$ 6 por TB/mês) ou para o Google Workspace, que tem contrato de processamento de dados.
  - O `backupstore` já separa o backend (`drive`/`local`). Um backend S3 seria um terceiro tipo.
- Limites da API (developers.google.com/workspace/drive/api/guides/limits):
  - 750 GB por dia de upload: bloqueia por 24 h se passar. Tratado com o orçamento de 700 GB.
  - Cota por minuto: tratada com o limitador e o backoff.
  - A mesma página cita **1 TB por dia de egress por projeto** antes de cobrança. Os downloads passam por `alt=media`, então vale acompanhar.
- **OAuth**: o app OAuth precisa estar **"Em produção"** na tela de consentimento. Em modo "Teste", o Google expira o refresh token em 7 dias e os backups param.

### LGPD

- O MemoryCard é o **controlador**. O Google é operador, mas em conta pessoal **não existe contrato de processamento de dados** (o Workspace tem o Cloud Data Processing Addendum), e há transferência internacional (art. 33).
- **Precisa atualizar** `/privacidade` e `/termos` para dizer:
  - onde ficam os backups (Google Drive) e por quanto tempo (versões por plano);
  - a carência de 30 dias e o expurgo após downgrade ou cancelamento;
  - que a conta apagada leva os backups junto.
- Já implementado: pasta `u<ID>` sem e-mail, exclusão completa na conta apagada, link de download assinado de curta duração e caminhos do servidor fora das respostas da API.
- Recomendado (não implementado): **criptografar os saves** (podem ter nome e dados pessoais) com AES-GCM no servidor, com a chave fora do Drive. Os jogos podem ficar sem criptografia para manter o dedup. Isso também reduz o dano de um vazamento da conta.

### Operação

- Todo byte passa pela VPS duas vezes (entrada e saída para o Drive). É preciso acompanhar a banda e o disco de staging.
- Os locks de cota são por processo. Com mais de uma réplica da API, a cota precisaria de lock no banco.
- **Apagar uma pasta no Drive apaga o conteúdo dela.** O janitor só apaga a pasta de um usuário quando nenhum arquivo está nela.
- O upload multipart antigo (app antigo, até 500 MB) ainda carrega o corpo inteiro em memória antes de checar a cota. O app novo usa o protocolo resumível.

## 5. Para colocar em produção (pede o OK do dono)

1. Deploy da API e da landing (`deployer.py deploy compose ... --skip apps`, depois copiar a landing para `/var/www/memorycard.cloud`).
2. Na tela de consentimento OAuth do Google Cloud: publicação "Em produção" e adicionar o escopo `.../auth/drive.file`.
3. No painel admin, o superadmin **desconecta e conecta o Google Drive de novo** (para conceder `drive.file`). Até lá, o modo `auto` continua gravando na VPS, e a migração para o Drive é automática depois.
4. Opcional no `deploy/vps.env`:
   - `BACKUP_STORAGE` (`auto` | `drive` | `local`)
   - `BACKUP_DRIVE_DAILY_BYTES` (padrão 700 GB)
   - `BACKUP_RESERVE_RATIO` (0.10)
   - `BACKUP_GRACE_DAYS` (30)
   - `BACKUP_MAX_VERSIONS`
   - `BACKUP_STAGING_MIN_FREE` (10 GiB)
   - `BACKUP_WORKERS` (2)
   - `BACKUP_DRIVE_ROOT`
5. Gerar um build novo do app para os envios grandes usarem o protocolo resumível. Os apps antigos continuam funcionando.
6. Acompanhar `GET /api/admin/backups/stats` na primeira semana.
