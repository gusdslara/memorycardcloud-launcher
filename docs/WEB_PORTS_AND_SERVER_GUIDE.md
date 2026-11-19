# Guia Completo de Hospedagem, Compilação e Assets de Web Ports
## Plataforma MemoryCard.cloud (Host Próprio & Sincronização em Nuvem)

Este guia documenta como configurar seu servidor para hospedar ports web nativos em WebAssembly (Wasm) e WebGL, onde colocar as ISOs/ROMs, quais formatos e regiões utilizar, como configurar as chaves de criptografia do Nintendo Switch (`prod.keys` e `title.keys`), e como operar os controles de superadmin.

---

## 1. Estrutura de Diretórios no Seu Servidor

Recomenda-se criar a árvore de pastas padrão em `/var/www/memorycard-ports/` (ou no diretório de armazenamento configurado no `.env` do backend):

```text
/var/www/memorycard-ports/
├── nginx.conf / caddyfile          # Servidor web com cabeçalhos Cross-Origin (COOP/COEP)
├── bios/                           # BIOS de PlayStation 1, PlayStation 2 e Arcades
│   ├── scph1001.bin                # PS1 USA
│   ├── scph39001.bin               # PS2 USA
│   └── neogeo.zip                  # Arcade Neo-Geo
├── switch/                         # Chaves e Firmware do Nintendo Switch
│   ├── keys/
│   │   ├── prod.keys               # Chaves mestras de decriptação (permissão 600)
│   │   └── title.keys              # Chaves de títulos e tickets (permissão 600)
│   ├── firmware/                   # Firmware Oficial extraído (ex: 18.1.0 contendo ~220 .nca)
│   └── games/                      # Jogos em formato .nsp ou .xci
├── saves/                          # Sincronização em tempo real de cartões virtuais
│   └── users/{user_id}/            # Saves por usuário (ex: Mcd001.ps2, diablo_0.sv, etc.)
├── nfsu2/                          # Need for Speed: Underground 2
│   ├── assets/                     # SPEED2.EXE, GLOBAL/, CARS/, TRACKS/ ou ISO PS2
│   └── public/                     # OpenNFS.js, OpenNFS.wasm, index.html
├── nfsmw/                          # Need for Speed: Most Wanted
│   ├── assets/                     # speed.exe + dados Black Edition ou ISO PS2 SLUS-21351
│   └── public/                     # mw-runner.js, mw-runner.wasm
├── gtasa/                          # Grand Theft Auto: San Andreas
│   ├── assets/                     # gta_sa.exe, audio/, data/, models/, text/ (PC v1.0)
│   └── public/                     # reSA.js, reSA.wasm
├── gtavc/                          # Grand Theft Auto: Vice City
│   ├── assets/                     # gta-vc.exe, audio/, models/, anim/ (PC v1.0)
│   └── public/                     # reVC.js, reVC.wasm
├── gta3/                           # Grand Theft Auto III
│   ├── assets/                     # gta3.exe, audio/, models/, textures/ (PC v1.0)
│   └── public/                     # re3.js, re3.wasm
├── diablo1/                        # Diablo 1 & Hellfire (DevilutionX)
│   ├── assets/                     # DIABDAT.MPQ, hellfire.mpq
│   └── public/                     # devilutionx.js, devilutionx.wasm
├── sm64/                           # Super Mario 64
│   ├── assets/                     # baserom.us.z64 (MD5: 20b854b239203b142412d83e6393ad16)
│   └── public/                     # sm64.js, sm64.wasm
├── soh/                            # Zelda: Ocarina of Time (Ship of Harkinian)
│   ├── assets/                     # baserom_original.z64
│   └── public/                     # soh.js, soh.wasm
├── 2s2h/                           # Zelda: Majora's Mask (2Ship2Harkinian)
│   ├── assets/                     # baserom_mm.z64
│   └── public/                     # 2s2h.js, 2s2h.wasm
├── rtcw/                           # Call of Duty / Return to Castle Wolfenstein
│   ├── assets/main/                # pak0.pk3, sp_pak1.pk3, sp_pak2.pk3
│   └── public/                     # rtcw.js, rtcw.wasm
├── doom/                           # Doom I, II e Final Doom
│   ├── assets/                     # DOOM.WAD, DOOM2.WAD, PLUTONIA.WAD, TNT.WAD
│   └── public/                     # doom.js, doom.wasm
├── quake/                          # Quake 1, 2, 3 Arena
│   ├── assets/id1/                 # pak0.pak, pak1.pak
│   └── public/                     # quake.js, quake.wasm
└── openlara/                       # Tomb Raider 1 & 2
    ├── assets/                     # TITLE.PHD, GAME.G1 ou ISO PS1 SLUS-00152
    └── public/                     # openlara.js, openlara.wasm
```

---

## 2. Tabela de Ports Web: ISOs, Regiões, Extensões e Chaves

| Jogo | Plataforma | Extensão / Formato | Nome Exato do Arquivo | Região Homologada | Requer Chaves ou BIOS? | Detalhes de Chaves / BIOS |
| :--- | :--- | :--- | :--- | :--- | :---: | :--- |
| **Need for Speed: Underground 2** | PS2 / PC | `.iso`, `.bin/.cue`, pasta PC | `SPEED2.EXE` + pastas `GLOBAL/`, `CARS/` ou `SLUS-21065.iso` | USA (NTSC-U) v1.2 ou PAL | Sim (se PS2) | Se rodar core PS2: `scph39001.bin`. Se rodar recompilação PC: sem chaves. |
| **Need for Speed: Most Wanted** | PS2 / PC | `.iso`, `.bin/.cue`, pasta PC | `speed.exe` + dados Black Edition ou `SLUS-21351.iso` | USA (NTSC-U) v1.3 | Sim (se PS2) | BIOS PS2 `scph39001.bin` (se core PS2). |
| **GTA: San Andreas** | PC / PS2 | `.iso`, `.cue`, pasta PC v1.0 | `gta_sa.exe` + pastas `audio/`, `models/`, `data/` | USA v1.0 / Global | Não | Motor nativo recompilado (sem BIOS). |
| **GTA: Vice City** | PC | `.iso`, pasta PC v1.0 | `gta-vc.exe` + pastas `audio/`, `models/` | USA / Global | Não | Motor nativo recompilado (sem BIOS). |
| **GTA III** | PC | `.iso`, pasta PC v1.0 | `gta3.exe` + pastas `audio/`, `models/` | USA v1.0 / Global | Não | Motor nativo recompilado (sem BIOS). |
| **Diablo 1 & Hellfire** | PC | `.mpq` | `DIABDAT.MPQ` e `hellfire.mpq` | Global (Retail/GOG) | Não | Lê MPQ nativamente. |
| **Super Mario 64** | N64 | `.z64`, `.n64` | `baserom.us.z64` | USA (NTSC-U) | Não | Extrai texturas na compilação. |
| **Zelda: Ocarina of Time** | N64 | `.z64` | `baserom_original.z64` | USA (v1.0 ou v1.2) | Não | Ship of Harkinian Wasm. |
| **Zelda: Majora's Mask** | N64 | `.z64` | `baserom_mm.z64` | USA (v1.0) | Não | 2Ship2Harkinian Wasm. |
| **Call of Duty & RTCW** | PC | `.pk3` | `pak0.pk3`, `sp_pak1.pk3`, `sp_pak2.pk3` | USA / Global | Não | Engine idTech3 Wasm. |
| **Doom I & II** | PC | `.wad` | `DOOM.WAD`, `DOOM2.WAD`, `PLUTONIA.WAD` | Global | Não | IWAD original de PC. |
| **Quake I & III** | PC | `.pak`, `.pk3` | `pak0.pak`, `pak1.pak` (Q1) / `pak0.pk3` (Q3) | Global | Não | QuakeJS / WebQuake. |
| **Half-Life & CS 1.6** | PC | `.pak`, `.wad`, `.bsp` | Pasta `valve/` (`pak0.pak`, `halflife.wad`) | Global (Steam/CD) | Não | Xash3D-FWGS Emscripten. |
| **Fallout 1 & 2** | PC | `.dat` | `master.dat`, `critter.dat` | USA / Global v1.02+ | Não | Fallout-CE Wasm. |
| **RollerCoaster Tycoon 2** | PC | `.dat`, pasta PC | Pastas `Data/` e `ObjData/` | Global | Não | OpenRCT2 Emscripten. |
| **Tomb Raider 1 & 2** | PS1 / PC | `.phd`, `.iso`, `.bin/.cue` | `TITLE.PHD`, `GAME.G1` ou `SLUS-00152.bin` | USA / PAL | Não | OpenLara WebGL nativo. |
| **Nintendo Switch Cloud** | Switch | `.nsp`, `.xci`, `.keys` | Jogo `.nsp` ou `.xci` + `prod.keys` e `title.keys` | Region-Free | **SIM** | **OBRIGATÓRIO: `prod.keys` e `title.keys`** do console + Firmware 18.x/19.x. |

---

## 3. Guia de Chaves do Nintendo Switch (prod.keys & title.keys)

No ecossistema Nintendo Switch:
1. **`prod.keys` (Master Keys)**:
   - Contém os pares de chaves de criptografia do sistema (`master_key_XX`, `header_key`, `key_area_key_application_XX`, etc.).
   - São necessárias para descriptografar os cabeçalhos NCA e partições de sistema.
2. **`title.keys` (Title Rights)**:
   - Contém os ingressos e chaves de licença de títulos específicos (jogos e DLCs da eShop).
3. **Firmware Oficial do Switch**:
   - Pacote de arquivos de sistema (versão 18.x ou 19.x) contendo as bibliotecas de fontes, áudio e decodificadores de mídia.
   - Colocar descompactado em `/var/www/memorycard-ports/switch/firmware/`.

### No Aplicativo Desktop e no Scanner:
- O scanner do aplicativo reconhece automaticamente quando você aponta para a pasta contendo `prod.keys` e `title.keys`.
- Ambos os emuladores suportados (**Eden**, **Citron** e **Ryujinx**) têm suporte a cópia automática das chaves com 1 clique através do botão "Instalar no Eden/Citron/Ryujinx".

---

## 4. Compilação dos Binários WebAssembly (Emscripten SDK)

Para compilar os projetos em Wasm, certifique-se de ter o **emsdk** instalado e ativado:

```bash
# Instalação do Emscripten SDK
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
```

### Exemplos de Compilação:

#### DevilutionX (Diablo 1 & Hellfire):
```bash
git clone https://github.com/diasurgical/devilutionX.git
cd devilutionX
emcmake cmake -S . -B build -DNONET=OFF -DCMAKE_BUILD_TYPE=Release
cmake --build build --target devilutionx -j$(nproc)
cp build/devilutionx.js build/devilutionx.wasm /var/www/memorycard-ports/diablo1/public/
```

#### Super Mario 64:
```bash
git clone https://github.com/sm64-port/sm64-port.git
cd sm64-port
cp /path/to/baserom.us.z64 baserom.us.z64
make TARGET_WEB=1 -j$(nproc)
cp build/us_web/* /var/www/memorycard-ports/sm64/public/
```

#### re3 / reVC / reSA (GTA III / Vice City / San Andreas):
```bash
git clone --recursive https://github.com/re3-wasm/re3.git
cd re3
emcmake cmake -B build-web -DRE3_AUDIO=OAL -DWITH_AUDIO=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build-web --target reSA -j$(nproc)
cp build-web/bin/reSA.* /var/www/memorycard-ports/gtasa/public/
```

---

## 5. Operação do Superadmin na Landing Page

1. **Visibilidade do Host:**
   - Acesse `/ports` ou vá até o painel em `/admin` e clique em **"Gerenciar Web Ports & Scraper"**.
   - Alterne entre:
     - **Aberto ao Público**: Qualquer pessoa joga no seu servidor com Cloud Saves.
     - **Escondido / Restrito**: Somente o superadmin e e-mails autorizados na **Whitelist** acessam o host. Demais visitantes veem a vitrine com links para espelhos públicos externos homologados (NFSU2, NFSMW, etc.).
2. **Whitelist de Acesso:**
   - Adicione o e-mail de amigos ou beta testers para liberar o acesso ao host próprio mesmo em modo restrito.
3. **Scraper Automático:**
   - Cole a URL de um repositório GitHub de port Wasm ou pesquise o título de um jogo. O sistema detectará automaticamente a engine, extensões de arquivos, requisitos de ISO e se precisa de chaves/BIOS.
