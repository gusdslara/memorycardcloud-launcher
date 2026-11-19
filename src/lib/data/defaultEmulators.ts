import type { EmulatorItem } from "../types/emulators";
import { EXTRA_EMULATORS } from "./extraEmulators.ts";

/** No RetroArch / libretro frontends: MemoryCard is the frontend, each console gets its best standalone emulator. */
const CORE_EMULATORS: EmulatorItem[] = [
  // ==========================================
  // MULTI-SYSTEM
  // ==========================================

  // ==========================================
  // PLAYSTATION 1
  // ==========================================
  {
    id: "duckstation",
    wikiTitle: "DuckStation",
    name: "DuckStation",
    system: "PlayStation 1",
    description:
      "O emulador mais moderno e preciso de PlayStation 1, com resolução 4K, PGXP (correção de jitter de texturas 3D) e gerenciador de memory cards virtuais.",
    longDescription:
      "DuckStation foca em jogabilidade com fidelidade e velocidade. Suporta downsampling, PGXP geometry precision, aceleração de overclock de CPU simulada e leitura/gravação em cartões virtuais .mcd.",
    author: "Stenzek",
    websiteUrl: "https://www.duckstation.org",
    githubRepo: "stenzek/duckstation",
    supportedOs: ["windows", "linux", "macos", "android"],
    release: {
      provider: "github",
      repo: "stenzek/duckstation",
      assets: {
        windows: "duckstation-windows-x64-release\\.zip$",
        linux: "DuckStation-x64\\.AppImage$",
        macos: "duckstation-mac-release\\.zip$"
      },
      tag: "latest"
    },
    downloadUrls: {},
    stores: {
      android: {
        playStore: "https://play.google.com/store/apps/details?id=com.github.stenzek.duckstation"
      }
    },
    executableNames: {
      windows: "duckstation-qt-x64-ReleaseLTCG.exe",
      linux: "DuckStation-x64.AppImage",
      macos: "DuckStation.app"
    },
    saveSubpathDescription: "Pasta 'memcards' (arquivos .mcd de 15 blocos de PS1)",
    biosRequirements: [
      {
        name: "BIOS do PlayStation 1 (SCPH-5501 / SCPH-5502 / SCPH-5500)",
        system: "PlayStation 1",
        description:
          "DuckStation inclui uma BIOS simulada (HLE), porém a BIOS original Sony (SCPH-5501 NTSC-U ou SCPH-5502 PAL) é fortemente recomendada para 100% de compatibilidade e áudio autêntico.",
        filenames: ["scph5501.bin", "scph5502.bin", "scph5500.bin", "scph1001.bin", "scph7001.bin"],
        targetSubpath: "bios",
        isRequired: false,
        howToObtain:
          "Extraia a BIOS do seu console PlayStation 1 original ou copie de um backup legítimo para a pasta 'bios' do DuckStation.",
        typicalSize: "512 KB",
      },
    ],
    tags: ["Sony", "PlayStation", "PS1", "PGXP 3D", "4K", "Memory Cards MCD", "Vulkan"],
  },

  // ==========================================
  // PLAYSTATION 2
  // ==========================================
  {
    id: "pcsx2",
    wikiTitle: "PCSX2",
    name: "PCSX2",
    system: "PlayStation 2",
    description:
      "Emulador de PlayStation 2 consagrado com renderizador Vulkan/DirectX 12, resolução até 8K, patches widescreen e 60fps automáticos.",
    longDescription:
      "PCSX2 possui compatibilidade superior a 99% com toda a biblioteca de jogos do lendário PS2. O MemoryCard configura a pasta 'memcards' (.ps2) portátil automaticamente para sincronização imediata.",
    author: "PCSX2 Team",
    websiteUrl: "https://pcsx2.net",
    githubRepo: "PCSX2/pcsx2",
    supportedOs: ["windows", "linux", "macos"],
    release: {
      provider: "github",
      repo: "PCSX2/pcsx2",
      assets: {
        windows: "-windows-x64-Qt\\.7z$",
        linux: "-linux-appimage-x64-Qt\\.AppImage$",
        macos: "-macos-Qt\\.tar\\.xz$"
      }
    },
    downloadUrls: {},
    executableNames: {
      windows: "pcsx2-qt.exe",
      linux: "pcsx2-qt.AppImage",
      macos: "PCSX2.app"
    },
    saveSubpathDescription: "Pasta 'memcards' (arquivos .ps2 de 8MB a 64MB)",
    biosRequirements: [
      {
        name: "BIOS do PlayStation 2 (SCPH-39001 / SCPH-70004 / SCPH-90001)",
        system: "PlayStation 2",
        description:
          "Obrigatório! O PCSX2 não inicializa jogos comerciais sem uma imagem válida da BIOS do PlayStation 2.",
        filenames: ["scph39001.bin", "scph70004.bin", "SCPH-39001.bin", "SCPH-70004.bin", "ps2-*.bin", "SCPH*.bin"],
        targetSubpath: "bios",
        isRequired: true,
        howToObtain:
          "Faça o dump da BIOS do seu PlayStation 2 original com um pendrive USB e o utilitário uLaunchELF/biosdump, colocando os arquivos na pasta 'bios'.",
        typicalSize: "4 MB",
      },
    ],
    tags: ["Sony", "PlayStation", "PS2", "Vulkan", "Widescreen Patches", "60FPS Hacks", "Memory Card 8MB"],
  },

  // ==========================================
  // NINTENDO GAMECUBE & WII
  // ==========================================
  {
    id: "dolphin",
    wikiTitle: "Dolphin (emulator)",
    name: "Dolphin",
    system: "Nintendo GameCube & Wii",
    description:
      "O aclamado emulador de GameCube e Nintendo Wii com suporte a 4K+, controles originais via bluetooth e netplay integrado.",
    longDescription:
      "Dolphin oferece qualidade gráfica inigualável para os clássicos de GameCube e Wii. Configurado com 'portable.txt' para salvar todos os memory cards (.raw) e dados de Wii diretamente na pasta User.",
    author: "Dolphin Team",
    websiteUrl: "https://dolphin-emu.org",
    githubRepo: "dolphin-emu/dolphin",
    supportedOs: ["windows", "linux", "macos", "android"],
    release: {
      provider: "github",
      repo: "pkgforge-dev/Dolphin-emu-AppImage",
      assets: {
        linux: "anylinux-x86_64\\.AppImage$"
      }
    },
    downloadUrls: {
      windows: "https://dl.dolphin-emu.org/releases/2609a/dolphin-2609a-x64.7z",
      macos: "https://dl.dolphin-emu.org/releases/2609a/dolphin-2609a-universal.dmg",
      android: "https://dl.dolphin-emu.org/releases/2609a/dolphin-2609a.apk"
    },
    stores: {
      android: {
        playStore: "https://play.google.com/store/apps/details?id=org.dolphinemu.dolphinemu"
      }
    },
    downloadPage: "https://dolphin-emu.org/download/",
    executableNames: {
      windows: "Dolphin.exe",
      linux: "Dolphin_Emulator.AppImage",
      macos: "Dolphin.app"
    },
    saveSubpathDescription: "Pasta 'User/GC' (Memory Cards .raw) e 'User/Wii' (Title Saves)",
    biosRequirements: [
      {
        name: "BIOS GameCube IPL e Certificados Wii (Opcional)",
        system: "Nintendo GameCube & Wii",
        description:
          "Dolphin inclui emulação de alta fidelidade HLE e roda todos os jogos sem BIOS externa. A BIOS original IPL.bin é apenas para ver a clássica animação do cubo girando ao ligar.",
        filenames: ["IPL.bin", "ipl.bin"],
        targetSubpath: "User/GC/USA",
        isRequired: false,
        howToObtain: "Dump do GameCube via CleanRip em um console desbloqueado.",
        typicalSize: "2 MB",
      },
    ],
    tags: ["GameCube", "Wii", "4K", "Wiimote", "Memory Card Raw"],
  },

  // ==========================================
  // PLAYSTATION PORTABLE (PSP)
  // ==========================================
  {
    id: "ppsspp",
    wikiTitle: "PPSSPP",
    name: "PPSSPP",
    system: "PlayStation Portable (PSP)",
    description:
      "Emulador de PSP ultra-rápido com suporte a texturas HD personalizadas, filtros anisotrópicos, resoluções extremas e multiplayer local/online.",
    longDescription:
      "Criado por Henrik Rydgård (co-criador do Dolphin), o PPSSPP roda perfeitamente em qualquer dispositivo. Salva os dados no padrão autêntico do PSP: pasta 'PSP/SAVEDATA'.",
    author: "Henrik Rydgård",
    websiteUrl: "https://www.ppsspp.org",
    githubRepo: "hrydgard/ppsspp",
    supportedOs: ["windows", "linux", "macos", "android", "ios"],
    release: {
      provider: "github",
      repo: "hrydgard/ppsspp",
      assets: {
        windows: "-Windows-x64\\.zip$",
        linux: "-anylinux-x86_64\\.AppImage$",
        macos: "PPSSPPSDL-macOS-.*\\.zip$"
      }
    },
    downloadUrls: {},
    stores: {
      android: {
        playStore: "https://play.google.com/store/apps/details?id=org.ppsspp.ppsspp"
      },
      ios: {
        appStore: "https://apps.apple.com/app/ppsspp-psp-emulator/id6496972903"
      }
    },
    executableNames: {
      windows: "PPSSPPWindows64.exe",
      linux: "PPSSPP.AppImage",
      macos: "PPSSPPSDL.app"
    },
    saveSubpathDescription: "Pasta 'memstick/PSP/SAVEDATA' (formato nativo de save do PSP)",
    biosRequirements: [
      {
        name: "Fontes de Sistema do PSP (Opcional)",
        system: "PlayStation Portable (PSP)",
        description:
          "O PPSSPP possui firmware completo simulado HLE e roda todos os jogos comerciais sem arquivos externos. Fontes oficiais do flash0 são úteis para jogos com tipografia especial.",
        filenames: ["jpn0.pgf", "ltn0.pgf"],
        targetSubpath: "memstick/flash0/font",
        isRequired: false,
        howToObtain: "Dump da flash0 de um PSP original.",
        typicalSize: "15 MB",
      },
    ],
    tags: ["PSP", "HD Textures", "Multiplayer", "Fast", "Vulkan"],
  },

  // ==========================================
  // NINTENDO SWITCH
  // ==========================================
  {
    id: "ryujinx",
    wikiTitle: "Ryujinx",
    name: "Ryujinx (Ryubing)",
    system: "Nintendo Switch",
    description:
      "Emulador de Nintendo Switch em C# com foco em acurácia, estabilidade de áudio, multiplayer local/online e compatibilidade superior.",
    longDescription:
      "Ryubing é a continuação oficial da comunidade do Ryujinx. Oferece emulação precisa de hardware NVN e ARM64 do Switch com saves armazenados em modo portátil em 'portable/bis/user/save'.",
    author: "Ryubing Team",
    websiteUrl: "https://ryujinx.app",
    supportedOs: ["windows", "linux", "macos"],
    release: {
      provider: "gitea",
      host: "git.ryujinx.app",
      repo: "projects/Ryubing",
      assets: {
        windows: "-win_x64\\.zip$",
        linux: "-x64\\.AppImage$|-linux_x64\\.tar\\.gz$",
        macos: "-macos_universal\\.app\\.tar\\.gz$"
      }
    },
    downloadUrls: {
      windows: "https://git.ryujinx.app/projects/Ryubing/releases/download/1.3.3/ryujinx-1.3.3-win_x64.zip",
      linux: "https://git.ryujinx.app/projects/Ryubing/releases/download/1.3.3/ryujinx-1.3.3-x64.AppImage",
      macos: "https://git.ryujinx.app/projects/Ryubing/releases/download/1.3.3/ryujinx-1.3.3-macos_universal.app.tar.gz"
    },
    downloadPage: "https://ryujinx.app/download",
    executableNames: {
      windows: "Ryujinx.exe",
      linux: "Ryujinx.AppImage",
      macos: "Ryujinx.app"
    },
    saveSubpathDescription: "Pasta 'portable/bis/user/save' (slots de savegames do Switch)",
    biosRequirements: [
      {
        name: "Chaves de Criptografia do Switch (prod.keys & title.keys)",
        system: "Nintendo Switch",
        description:
          "Obrigatório! O Ryujinx necessita das chaves prod.keys para descriptografar os jogos, atualizações e DLCs.",
        filenames: ["prod.keys", "title.keys"],
        targetSubpath: "system",
        isRequired: true,
        howToObtain:
          "Extraia as chaves do seu Nintendo Switch desbloqueado utilizando o payload Lockpick_RCM e coloque-as na pasta 'system'.",
        typicalSize: "10 KB",
      },
      {
        name: "Firmware Oficial do Nintendo Switch",
        system: "Nintendo Switch",
        description:
          "Obrigatório para jogos que requerem fontes de sistema, Mii e serviços de rede locais. Instalado pelo menu Ferramentas > Instalar Firmware.",
        filenames: ["Firmware*.zip", "registered/*.nca"],
        targetSubpath: "system/firmware",
        isRequired: true,
        howToObtain:
          "Faça o dump do firmware do seu Switch com o homebrew TegraExplorer/Daybreak.",
        typicalSize: "300 MB a 400 MB",
      },
    ],
    tags: ["Switch", "60FPS", "LDN Multiplayer", "Vulkan", "Shader Cache"],
  },

  // ==========================================
  // NINTENDO WII U
  // ==========================================
  {
    id: "cemu",
    wikiTitle: "Cemu",
    name: "Cemu",
    system: "Nintendo Wii U",
    description:
      "Emulador completo de Nintendo Wii U com suporte a mods gráficos, resoluções ultrawide e patches de 60fps para Zelda: Breath of the Wild e Mario Kart 8.",
    longDescription:
      "Cemu alcançou maturidade total em código aberto com renderizador Vulkan de alto desempenho. Salva diretamente em mlc01/usr/save.",
    author: "Cemu Project",
    websiteUrl: "https://cemu.info",
    githubRepo: "cemu-project/Cemu",
    supportedOs: ["windows", "linux", "macos", "android"],
    release: {
      provider: "github",
      repo: "cemu-project/Cemu",
      platformRepos: {
        android: "SSimco/Cemu"
      },
      assets: {
        android: "Cemu-[\\d.]+\\.apk$",
        windows: "-windows-x64\\.zip$",
        linux: "-x86_64\\.AppImage$",
        macos: "-macos-12-x64\\.dmg$"
      }
    },
    downloadUrls: {},
    platformNotes: { android: "Port comunitário (SSimco/Cemu), ainda experimental: exige celular topo de linha." },
    executableNames: {
      windows: "Cemu.exe",
      linux: "Cemu.AppImage",
      macos: "Cemu.app"
    },
    saveSubpathDescription: "Pasta 'mlc01/usr/save' (dados de usuário e saves de Wii U)",
    biosRequirements: [
      {
        name: "Chaves de Jogo Wii U (keys.txt)",
        system: "Nintendo Wii U",
        description:
          "Necessário apenas para imagens .wud brutas não descriptografadas. Jogos no formato .wux, .rpx ou Loadiine funcionam sem nenhuma chave.",
        filenames: ["keys.txt"],
        targetSubpath: "keys.txt",
        isRequired: false,
        howToObtain: "Extraia a chave comum e de títulos do seu Wii U com dumper de Wii U.",
        typicalSize: "1 KB",
      },
    ],
    tags: ["Wii U", "Graphic Packs", "Zelda BOTW", "60FPS", "Ultrawide"],
  },

  // ==========================================
  // PLAYSTATION 3
  // ==========================================
  {
    id: "rpcs3",
    wikiTitle: "RPCS3",
    name: "RPCS3",
    system: "PlayStation 3",
    description:
      "O emulador definitivo de PlayStation 3 em C++ com suporte a renderização Vulkan, patches de 60FPS e resolução até 8K.",
    longDescription:
      "RPCS3 é um dos projetos de emulação mais avançados da história da computação. O MemoryCard isola os saves em 'dev_hdd0/home' para backups seguros.",
    author: "RPCS3 Team",
    websiteUrl: "https://rpcs3.net",
    githubRepo: "RPCS3/rpcs3",
    supportedOs: ["windows", "linux", "macos"],
    release: {
      provider: "github",
      repo: "RPCS3/rpcs3-binaries-win",
      assets: {
        windows: "_win64_msvc\\.7z$",
        linux: "_linux64\\.AppImage$",
        macos: "_macos\\.7z$"
      },
      platformRepos: {
        linux: "RPCS3/rpcs3-binaries-linux",
        macos: "RPCS3/rpcs3-binaries-mac"
      }
    },
    downloadUrls: {},
    executableNames: {
      windows: "rpcs3.exe",
      linux: "rpcs3.AppImage",
      macos: "RPCS3.app"
    },
    saveSubpathDescription: "Pasta 'dev_hdd0/home' (diretórios de savegame de PS3)",
    biosRequirements: [
      {
        name: "Firmware Oficial Sony PlayStation 3 (PS3UPDAT.PUP)",
        system: "PlayStation 3",
        description:
          "Obrigatório! O RPCS3 não inicia jogos sem que o Firmware Oficial da Sony seja instalado para compilar os módulos nativos do sistema Cell.",
        filenames: ["PS3UPDAT.PUP"],
        targetSubpath: "dev_flash",
        isRequired: true,
        howToObtain:
          "Baixe a atualização oficial de firmware do PS3 (PS3UPDAT.PUP) gratuitamente no site oficial de suporte da PlayStation Sony e instale via Arquivo > Instalar Firmware no RPCS3.",
        typicalSize: "200 MB",
      },
    ],
    tags: ["PS3", "Cell BE", "Vulkan 4K", "60FPS Patches", "Trophies"],
  },

  // ==========================================
  // NINTENDO 3DS
  // ==========================================
  {
    id: "lime3ds",
    wikiTitle: "Citra (emulator)",
    name: "Azahar (ex-Lime3DS/Citra)",
    system: "Nintendo 3DS",
    description:
      "Sucessor em código aberto do Citra para Nintendo 3DS com renderizador Vulkan otimizado, suporte a texturas HD e giroscópio.",
    longDescription:
      "Azahar / Lime3DS continua o legado do Citra com melhorias contínuas de compatibilidade e desempenho. Armazena os saves na pasta 'user/sdmc'.",
    author: "Azahar / Lime3DS Team",
    websiteUrl: "https://github.com/azahar-emu/azahar",
    githubRepo: "azahar-emu/azahar",
    supportedOs: ["windows", "linux", "macos", "android"],
    release: {
      provider: "github",
      repo: "azahar-emu/azahar",
      assets: {
        windows: "azahar-windows-msvc-[\\d.]+\\.zip$",
        linux: "^azahar\\.AppImage$",
        macos: "azahar-macos-universal-[\\d.]+\\.zip$",
        android: "azahar-android-vanilla-[\\d.]+\\.apk$"
      }
    },
    downloadUrls: {},
    executableNames: {
      windows: "azahar.exe",
      linux: "azahar.AppImage",
      macos: "Azahar.app"
    },
    saveSubpathDescription: "Pasta 'user/sdmc' (arquivos de save criptografados do 3DS)",
    biosRequirements: [
      {
        name: "Chaves AES do Nintendo 3DS (aes_keys.txt)",
        system: "Nintendo 3DS",
        description:
          "Necessário apenas se você for carregar arquivos .cia ou .3ds encriptados originais de eShop. Jogos descriptografados (.3ds/.cxi) rodam diretamente sem chaves.",
        filenames: ["aes_keys.txt"],
        targetSubpath: "user/sysdata",
        isRequired: false,
        howToObtain: "Dump das chaves do 3DS via GodMode9.",
        typicalSize: "2 KB",
      },
    ],
    tags: ["3DS", "Dual Screen", "Stereoscopic 3D", "HD Textures", "Vulkan"],
  },

  // ==========================================
  // NINTENDO DS
  // ==========================================
  {
    id: "melonds",
    wikiTitle: "MelonDS",
    name: "melonDS",
    system: "Nintendo DS",
    description:
      "Emulador de Nintendo DS e DSi de alta precisão com suporte a renderização 3D acelerada por OpenGL, Wi-Fi local e microfone.",
    longDescription:
      "melonDS foi construído do zero para oferecer fidelidade impecável aos ciclos originais do Nintendo DS. Salva os arquivos .sav automaticamente na pasta 'saves'.",
    author: "melonDS Team",
    websiteUrl: "https://melonds.kuribo64.net",
    githubRepo: "melonDS-emu/melonDS",
    supportedOs: ["windows", "linux", "macos", "android"],
    release: {
      provider: "github",
      repo: "melonDS-emu/melonDS",
      assets: {
        windows: "-windows-x86_64\\.zip$",
        linux: "-appimage-x86_64\\.zip$",
        macos: "-macOS-universal\\.zip$",
        android: "\\.apk$"
      },
      platformRepos: {
        android: "rafaelvcaetano/melonDS-android"
      }
    },
    downloadUrls: {},
    stores: {
      android: {
        playStore: "https://play.google.com/store/apps/details?id=me.magnum.melonds"
      }
    },
    executableNames: {
      windows: "melonDS.exe",
      linux: "melonDS-x86_64.AppImage",
      macos: "melonDS.app"
    },
    saveSubpathDescription: "Pasta 'saves' (.sav com 512KB a 8MB por cartucho)",
    biosRequirements: [
      {
        name: "BIOS ARM9 & ARM7 e Firmware do Nintendo DS",
        system: "Nintendo DS",
        description:
          "Recomendado para autenticidade máxima! O melonDS tem HLE embutido, mas para inicialização autêntica com tela e som de boot original, Wi-Fi e modo DSi, os arquivos bios9.bin, bios7.bin e firmware.bin são necessários.",
        filenames: ["bios9.bin", "bios7.bin", "firmware.bin"],
        targetSubpath: "bios",
        isRequired: false,
        howToObtain:
          "Faça o dump da BIOS e Firmware do seu Nintendo DS/DSi com o homebrew dsbf_dump.",
        typicalSize: "4 KB (bios9), 4 KB (bios7), 256/512 KB (firmware)",
      },
    ],
    tags: ["NDS", "DSi", "Touch Screen", "OpenGL", "Wi-Fi Emulation"],
  },

  // ==========================================
  // GAME BOY ADVANCE
  // ==========================================
  {
    id: "mgba",
    wikiTitle: "MGBA",
    name: "mGBA",
    system: "Game Boy Advance",
    description:
      "O emulador mais rápido e preciso para Game Boy Advance, com excelente suporte a cheats, sensores solares de Boktai e paletas personalizadas.",
    longDescription:
      "mGBA roda a toda velocidade mesmo em hardware modesto sem abrir mão da precisão cirúrgica de ciclos de clock do GBA. Salva arquivos .sav na pasta 'saves'.",
    author: "endrift",
    websiteUrl: "https://mgba.io",
    githubRepo: "mgba-emu/mgba",
    supportedOs: ["windows", "linux", "macos"],
    release: {
      provider: "github",
      repo: "mgba-emu/mgba",
      assets: {
        windows: "-win64\\.7z$",
        linux: "-appimage-x64\\.appimage$",
        macos: "-macos\\.dmg$"
      }
    },
    downloadUrls: {},
    executableNames: {
      windows: "mGBA.exe",
      linux: "mGBA.appimage",
      macos: "mGBA.app"
    },
    saveSubpathDescription: "Pasta 'saves' (arquivos .sav de cartucho GBA e GBC)",
    biosRequirements: [
      {
        name: "BIOS Oficial do Game Boy Advance (gba_bios.bin)",
        system: "Game Boy Advance",
        description:
          "mGBA vem com uma implementação livre de BIOS de alto desempenho. A BIOS oficial de 16KB é recomendada para exibir a animação clássica de boot da Nintendo e fidelidade de som 100%.",
        filenames: ["gba_bios.bin", "bios.bin", "gba.bin"],
        targetSubpath: "bios",
        isRequired: false,
        howToObtain:
          "Extraia a BIOS de um console GBA através do cabo link com GBA BIOS Dumper.",
        typicalSize: "16 KB",
      },
    ],
    tags: ["GBA", "GBC", "Solar Sensor", "Multiplayer Cable", "Fast"],
  },

  // ==========================================
  // SEGA DREAMCAST & ARCADE
  // ==========================================
  {
    id: "flycast",
    name: "Flycast",
    system: "Sega Dreamcast & Arcade",
    description:
      "Emulador multiplataforma de Sega Dreamcast, Naomi, Naomi 2 e Atomiswave com resolução 4K widescreen e suporte a cartões virtuais VMU.",
    longDescription:
      "Flycast é o sucessor definitivo do reicast com renderizador Vulkan de alto desempenho. Salva os cartões virtuais de memória VMU na pasta 'data'.",
    author: "flyinghead",
    websiteUrl: "https://github.com/flyinghead/flycast",
    githubRepo: "flyinghead/flycast",
    supportedOs: ["windows", "linux", "macos", "android"],
    release: {
      provider: "github",
      repo: "flyinghead/flycast",
      assets: {
        windows: "flycast-win64-[\\d.]+\\.zip$",
        linux: "flycast-x86_64-[\\d.]+\\.AppImage$",
        macos: "flycast-macOS-[\\d.]+\\.zip$",
        android: "flycast-[\\d.]+\\.apk$"
      }
    },
    downloadUrls: {},
    stores: {
      android: {
        playStore: "https://play.google.com/store/apps/details?id=com.flycast.emulator"
      }
    },
    executableNames: {
      windows: "flycast.exe",
      linux: "flycast.AppImage",
      macos: "Flycast.app"
    },
    saveSubpathDescription: "Pasta 'data' (Visual Memory Units - VMU .bin de 128KB)",
    biosRequirements: [
      {
        name: "BIOS do Sega Dreamcast (dc_boot.bin) e Flash NVRAM (dc_flash.bin)",
        system: "Sega Dreamcast & Arcade",
        description:
          "Obrigatório para quase toda a biblioteca comercial! O Flycast necessita dos arquivos dc_boot.bin e dc_flash.bin para rodar jogos de Dreamcast e carregar a memória do sistema.",
        filenames: ["dc_boot.bin", "dc_flash.bin", "dc_bios.bin"],
        targetSubpath: "data",
        isRequired: true,
        howToObtain:
          "Faça o dump da BIOS do seu Dreamcast usando um cabo serial coder's cable, SD adapter ou GD-ROM dumper e coloque os arquivos na pasta 'data'.",
        typicalSize: "2 MB (boot) + 128 KB (flash)",
      },
    ],
    tags: ["Dreamcast", "Naomi", "VMU", "Widescreen 4K", "Vulkan"],
  },

  // ==========================================
  // PLAYSTATION VITA
  // ==========================================
  {
    id: "vita3k",
    wikiTitle: "Vita3K",
    name: "Vita3K",
    system: "PlayStation Vita",
    description:
      "O primeiro emulador funcional de PlayStation Vita do mundo em código aberto, com renderizador Vulkan e suporte a troféus.",
    longDescription:
      "Vita3K permite jogar os títulos de PS Vita com suporte a resoluções superiores e renderização moderna. Armazena os dados de save em 'ux0/user/00/savedata'.",
    author: "Vita3K Team",
    websiteUrl: "https://vita3k.org",
    githubRepo: "Vita3K/Vita3K",
    supportedOs: ["windows", "linux", "macos", "android"],
    release: {
      provider: "github",
      repo: "Vita3K/Vita3K",
      assets: {
        windows: "^windows-latest\\.zip$",
        linux: "^Vita3K-x86_64\\.AppImage$",
        macos: "^macos-arm64-latest\\.dmg$",
        android: "^android-latest\\.apk$"
      },
      tag: "continuous"
    },
    downloadUrls: {},
    executableNames: {
      windows: "Vita3K.exe",
      linux: "Vita3K-x86_64.AppImage",
      macos: "Vita3K.app"
    },
    saveSubpathDescription: "Pasta 'ux0/user/00/savedata' (savegames e perfis de PS Vita)",
    biosRequirements: [
      {
        name: "Firmware Oficial PS Vita (PSP2UPDAT.PUP) e Pacote de Fontes",
        system: "PlayStation Vita",
        description:
          "Obrigatório! O Vita3K precisa do Firmware Oficial da Sony PSP2UPDAT.PUP e do pacote de fontes para carregar as bibliotecas de sistema e interface gráfica.",
        filenames: ["PSP2UPDAT.PUP"],
        targetSubpath: "data",
        isRequired: true,
        howToObtain:
          "Baixe a atualização oficial de PS Vita gratuitamente no site de suporte da Sony e selecione 'File > Install Firmware' no Vita3K.",
        typicalSize: "130 MB",
      },
    ],
    tags: ["PS Vita", "Vulkan", "Touchpad Traseiro", "Troféus", "60FPS"],
  },

  // ==========================================
  // PLAYSTATION 2 (ANDROID)
  // ==========================================
  {
    id: "nethersx2",
    name: "NetherSX2 / AetherSX2",
    system: "PlayStation 2",
    description:
      "Patch comunitário do AetherSX2 (congelado desde 2023). Ainda é o mais leve em celulares intermediários; para o mais atual use o ARMSX2.",
    longDescription:
      "O NetherSX2 é a versão aprimorada pela comunidade do clássico AetherSX2 para Android, corrigindo anúncios e adicionando melhorias de performance.",
    author: "Tahlreth / NetherSX2 Community",
    websiteUrl: "https://github.com/Trixarian/NetherSX2-patch",
    githubRepo: "Trixarian/NetherSX2-patch",
    supportedOs: ["android"],
    release: {
      provider: "github",
      repo: "Trixarian/NetherSX2-patch",
      assets: {
        android: "NetherSX2-.*\\.apk$"
      }
    },
    downloadUrls: {},
    executableNames: {},
    saveSubpathDescription: "Armazenamento Android: /Android/data/xyz.aethersx2.android/files",
    biosRequirements: [
      {
        name: "BIOS do PlayStation 2 (SCPH-39001 / SCPH-70004)",
        system: "PlayStation 2",
        description:
          "Obrigatório! NetherSX2 requer um arquivo de BIOS do PS2 para inicializar qualquer jogo no Android.",
        filenames: ["scph39001.bin", "scph70004.bin", "SCPH-39001.bin", "SCPH-70004.bin", "ps2-*.bin"],
        targetSubpath: "bios",
        isRequired: true,
        howToObtain:
          "Extraia a BIOS do seu console PS2 e selecione-a no aplicativo NetherSX2 no Android.",
        typicalSize: "4 MB",
      },
    ],
    tags: ["PS2 Mobile", "Android", "Full Speed", "Vulkan Mobile"],
  },

  // ==========================================
  // PLAYSTATION 4
  // ==========================================
  {
    id: "shadps4",
    name: "shadPS4",
    system: "PlayStation 4",
    description:
      "Emulador experimental de PlayStation 4 em Vulkan, capaz de rodar títulos como Bloodborne e P.T. com compatibilidade crescente.",
    author: "shadPS4 Team",
    websiteUrl: "https://shadps4.net",
    githubRepo: "shadps4-emu/shadPS4",
    supportedOs: ["windows", "linux", "macos"],
    release: {
      provider: "github",
      repo: "shadps4-emu/shadPS4",
      assets: {
        windows: "shadps4-win64-sdl.*\\.zip$",
        linux: "shadps4-linux-sdl.*\\.zip$",
        macos: "shadps4-macos-sdl.*\\.zip$",
      },
    },
    downloadUrls: {},
    executableNames: { windows: "shadPS4.exe", linux: "Shadps4-sdl.AppImage", macos: "shadps4.app" },
    compatibilityNote: "Builds atuais são SDL (sem interface gráfica): o MemoryCard inicia o jogo direto pelo eboot.bin.",
    saveSubpathDescription: "Pasta 'user/savedata' (saves por título CUSA)",
    tags: ["PS4", "Vulkan", "Experimental"],
  },

  // ==========================================
  // XBOX
  // ==========================================
  {
    id: "xemu",
    wikiTitle: "Xemu",
    name: "xemu",
    system: "Xbox",
    description:
      "Emulador do Xbox original com renderização em alta resolução, netplay via System Link e snapshots.",
    author: "xemu Project",
    websiteUrl: "https://xemu.app",
    githubRepo: "xemu-project/xemu",
    supportedOs: ["windows", "linux", "macos"],
    release: {
      provider: "github",
      repo: "xemu-project/xemu",
      assets: {
        windows: "xemu-[\\d.]+-windows-x86_64\\.zip$",
        linux: "xemu-[\\d.]+-x86_64\\.AppImage$",
        macos: "xemu-[\\d.]+-macos-universal\\.zip$",
      },
    },
    downloadUrls: {},
    executableNames: { windows: "xemu.exe", linux: "xemu.AppImage", macos: "xemu.app" },
    saveSubpathDescription: "Imagem do HD virtual 'xbox_hdd.qcow2' (contém os saves)",
    biosRequirements: [
      {
        name: "BIOS, MCPX Boot ROM e HD do Xbox",
        system: "Xbox",
        description: "Obrigatório: MCPX boot ROM (mcpx_1.0.bin), BIOS flash (Complex 4627) e uma imagem de HD.",
        filenames: ["mcpx_1.0.bin", "Complex_4627.bin", "xbox_hdd.qcow2"],
        targetSubpath: "bios",
        isRequired: true,
        howToObtain: "Faça o dump do seu Xbox original. A imagem de HD pode ser criada pelo próprio xemu.",
        typicalSize: "1 MB + HD",
      },
    ],
    tags: ["Xbox", "Halo", "SystemLink"],
  },

  // ==========================================
  // MOBILE
  // ==========================================
  {
    id: "delta",
    name: "Delta",
    system: "Multi-System",
    description:
      "O emulador mais popular do iPhone e iPad (NES, SNES, N64, GB/GBC/GBA, DS) disponível oficialmente na App Store.",
    author: "Riley Testut",
    websiteUrl: "https://faq.deltaemulator.com",
    githubRepo: "rileytestut/Delta",
    supportedOs: ["ios"],
    stores: {
      ios: { appStore: "https://apps.apple.com/app/delta-game-emulator/id1048524688" },
    },
    downloadUrls: {},
    executableNames: {},
    saveSubpathDescription: "Sincronização via iCloud/Google Drive/Dropbox do próprio Delta",
    tags: ["iOS", "App Store", "Nintendo"],
  },

  // ==========================================
  // NINTENDO SWITCH: forks ativos (out/2026)
  // ==========================================
  {
    id: "eden",
    name: "Eden",
    system: "Nintendo Switch",
    description:
      "O emulador de Switch mais ativo em 2026: builds otimizados (PGO) para PC, macOS e Android, com Vulkan, multiplayer local e mods.",
    longDescription:
      "Fork comunitário do yuzu mantido pela equipe Eden. Publica versões estáveis em git.eden-emu.dev; instalamos a build PGO (mais rápida) no PC.",
    author: "Eden Team",
    websiteUrl: "https://eden-emu.dev",
    supportedOs: ["windows", "linux", "macos", "android"],
    release: {
      provider: "gitea",
      host: "git.eden-emu.dev",
      repo: "eden-emu/eden",
      assets: {
        windows: "Eden-Windows-v[\\d.]+-amd64-clang-pgo\\.zip$",
        linux: "Eden-Linux-v[\\d.]+-amd64-clang-pgo\\.AppImage$",
        macos: "Eden-macOS-v[\\d.]+\\.dmg$",
        android: "Eden-Android-v[\\d.]+-standard\\.apk$",
      },
    },
    downloadUrls: {
      windows: "https://stable.eden-emu.dev/v0.2.1/Eden-Windows-v0.2.1-amd64-clang-pgo.zip",
      linux: "https://stable.eden-emu.dev/v0.2.1/Eden-Linux-v0.2.1-amd64-clang-pgo.AppImage",
      macos: "https://stable.eden-emu.dev/v0.2.1/Eden-macOS-v0.2.1.dmg",
      android: "https://stable.eden-emu.dev/v0.2.1/Eden-Android-v0.2.1-standard.apk",
    },
    downloadPage: "https://git.eden-emu.dev/eden-emu/eden/releases",
    executableNames: { windows: "eden.exe", linux: "Eden.AppImage", macos: "Eden.app" },
    saveSubpathDescription: "Pasta 'user/nand/user/save' (modo portátil)",
    biosRequirements: [
      {
        name: "Chaves (prod.keys) e firmware do Switch",
        system: "Nintendo Switch",
        description: "Obrigatório: prod.keys/title.keys e o firmware extraídos do seu console.",
        filenames: ["prod.keys", "title.keys"],
        targetSubpath: "user/keys",
        isRequired: true,
        howToObtain: "Extraia com Lockpick_RCM no seu Switch e instale o firmware pelo menu do Eden.",
        typicalSize: "10 KB + 300 MB",
      },
    ],
    tags: ["Switch", "PGO", "Vulkan", "Android"],
  },
  {
    id: "citron",
    name: "Citron Neo",
    system: "Nintendo Switch",
    description:
      "Fork do yuzu com builds noturnas para Windows, Linux, macOS e Android. Boa segunda opção quando um jogo falha no Eden.",
    author: "Citron Neo Team",
    websiteUrl: "https://www.citronneo.org",
    githubRepo: "citron-neo/emulator",
    supportedOs: ["windows", "linux", "macos", "android"],
    release: {
      provider: "github",
      repo: "citron-neo/emulator",
      assets: {
        windows: "Citron-windows-nightly-.*-x64-msvc\\.zip$",
        linux: "citron_nightly-.*-linux-x86_64\\.AppImage$",
        macos: "Citron-macOS-.*\\.dmg$",
        android: "app-mainline-release\\.apk$",
      },
    },
    downloadUrls: {},
    executableNames: { windows: "citron.exe", linux: "citron.AppImage", macos: "Citron.app" },
    compatibilityNote: "Builds noturnas: mais recentes, porém menos testadas que o Eden estável.",
    saveSubpathDescription: "Pasta 'user/nand/user/save' (modo portátil)",
    tags: ["Switch", "Nightly", "Android"],
  },

  // ==========================================
  // PS2 NO ANDROID
  // ==========================================
  {
    id: "armsx2",
    name: "ARMSX2",
    system: "PlayStation 2",
    description:
      "Port open source do PCSX2 2.8 para Android, atualizado junto com o PCSX2 de PC. A opção mais atual de PS2 no celular.",
    author: "ARMSX2 Team",
    githubRepo: "ARMSX2/ARMSX2",
    supportedOs: ["android"],
    release: {
      provider: "github",
      repo: "ARMSX2/ARMSX2",
      assets: { android: "ARMSX2-[\\d.]+-a11-armv8\\.2-sdk30\\.apk$" },
    },
    downloadUrls: {},
    executableNames: {},
    compatibilityNote: "Build para Android 11+ (ARMv8.2). Há builds específicas para Android 13/15 e uma 'legacy' na página da release.",
    saveSubpathDescription: "Pasta 'memcards' dentro do armazenamento do app",
    biosRequirements: [
      {
        name: "BIOS do PlayStation 2",
        system: "PlayStation 2",
        description: "Obrigatório para jogos comerciais.",
        filenames: ["scph39001.bin", "scph70004.bin", "SCPH*.bin"],
        targetSubpath: "bios",
        isRequired: true,
        howToObtain: "Faça o dump da BIOS do seu PS2 e selecione-a no primeiro uso do ARMSX2.",
        typicalSize: "4 MB",
      },
    ],
    tags: ["PS2", "Android", "PCSX2"],
  },
];

export const DEFAULT_EMULATORS: EmulatorItem[] = [...CORE_EMULATORS, ...EXTRA_EMULATORS];
