import type { ConsoleCategory, PortType } from "../types/ports";
import { GENERATED_WEB_PORTS } from "./webPorts.generated.ts";

export interface WebPortItem {
  id: string;
  /** Nome do projeto / engine do port web */
  name: string;
  /** Nome do jogo (usado para resolver a capa em coverArt / COVER_SOURCES) */
  projectName: string;
  /** Caso o nome em COVER_SOURCES seja diferente de projectName */
  artProjectName?: string;
  console: ConsoleCategory;
  portType: PortType;
  author: string;
  description: string;
  /** Link oficial para jogar ou abrir o projeto do port online no navegador */
  webUrl: string;
  /** URL hospedada no próprio MemoryCard.cloud (preferencial para assinantes) */
  hostedUrl?: string;
  /** Se o port está hospedado nos nossos servidores (MemoryCard.cloud) */
  isHostedOnMCD?: boolean;
  /**
   * Precisa de cross-origin isolation (WASM com threads / SharedArrayBuffer). Um iframe só consegue isso se o app
   * inteiro for isolado, então no app esses abrem numa janela própria do MemoryCard (não no navegador).
   */
  crossOriginIsolated?: boolean;
  /** Repositório GitHub do projeto (owner/repo) */
  githubRepo?: string;
  /** ID correspondente no catálogo de ports instaláveis (/ports/<portId>/) */
  portId?: string;
  /** Diferencial real do port nativo em relação à versão web (mods, multiplayer online, áudio, etc.) */
  nativeDifferential?: string;
  /** URL de capa extra (fallback caso não esteja no pacote local ou live scraper) */
  coverUrl?: string;
  /** Se o port já abre jogável na hora (shareware/demo/assets inclusos) ou pede arquivo do usuário */
  readyToPlay?: boolean;
  /** O que o usuário precisa fornecer no navegador (se aplicável) */
  requiredFilesNote?: string;
  extensions?: string[];
  tags?: string[];
}

/** Escolhidos à mão (descrição, capa e diferencial conferidos). Têm prioridade sobre os gerados. */
export const CURATED_WEB_PORTS: WebPortItem[] = [
  {
    id: "gow-coo-web",
    name: "God of War: Chains of Olympus (Web Recomp)",
    projectName: "God of War: Chains of Olympus",
    console: "PlayStation Portable",
    portType: "recomp",
    author: "snuri00 / PSPRecomp",
    description:
      "Recompilação estática nativa de PSP compilada para WebAssembly e WebGL2 multithread com 60 FPS, SharedArrayBuffer e streaming HTTP Range do disco original decriptado via pspdecrypt.",
    webUrl: "https://github.com/snuri00/psp-web-recomp",
    hostedUrl: "/play/gow-coo/",
    isHostedOnMCD: true,
    crossOriginIsolated: true,
    githubRepo: "snuri00/psp-web-recomp",
    nativeDifferential:
      "Execução recompilada de 25.391 funções PSP compiladas diretamente para C++, renderização WebGL2 em alta definição e saves locais no navegador.",
    coverUrl: "https://raw.githubusercontent.com/libretro-thumbnails/Sony_-_PlayStation_Portable/master/Named_Boxarts/God%20of%20War%20-%20Chains%20of%20Olympus%20(USA).png",
    readyToPlay: true,
    requiredFilesNote: "Hospedado no MemoryCard.cloud (WASM + disco de dados pronto)",
    tags: ["Recompilação Estática", "PSP", "WASM 82MB", "60 FPS", "Hospedado no MemoryCard.cloud"],
  },
  {
    id: "sm64-web-native",
    name: "Super Mario 64 (Web Decomp)",
    projectName: "Super Mario 64",
    console: "Nintendo 64",
    portType: "decomp",
    author: "sm64-port / Emscripten",
    description:
      "Porte C nativo da decompilação oficial de Super Mario 64 compilado via Emscripten para WebAssembly e WebGL. Áudio, texturas e 60 FPS nativos no browser sem emulador.",
    webUrl: "http://localhost:8080",
    hostedUrl: "/play/sm64/",
    isHostedOnMCD: true,
    portId: "sm64-classic",
    githubRepo: "sm64-port/sm64-port",
    nativeDifferential:
      "Decompilação C pura de N64 rodando direto em WebAssembly com suporte a controles, widescreen e física idêntica ao original.",
    coverUrl: "https://raw.githubusercontent.com/libretro-thumbnails/Nintendo_-_Nintendo_64/master/Named_Boxarts/Super%20Mario%2064%20(USA).png",
    readyToPlay: true,
    requiredFilesNote: "Hospedado no MemoryCard.cloud (pronto para jogar na hora)",
    tags: ["Decompilação C", "N64", "WASM 13MB", "Hospedado no MemoryCard.cloud"],
  },
  {
    id: "wipeout-web",
    name: "WipEout Rewrite (Web)",
    projectName: "WipEout (1995)",
    artProjectName: "Wipeout",
    console: "PlayStation 1",
    portType: "source_port",
    author: "Dominic Szablewski (PhobosLab)",
    description:
      "Reimplementação completa em C e WebGL do clássico WipEout de 1995 com física original, 60+ FPS, widescreen e trilha sonora direto no navegador.",
    webUrl: "https://phoboslab.org/wipeout/",
    githubRepo: "phoboslab/wipeout-rewrite",
    portId: "wipeout-phantom-edition",
    nativeDifferential:
      "Renderização nativa de alta resolução sem cortes de memória do navegador, 120+ FPS, física precisa e trilha sonora original do CD sem compressão.",
    coverUrl: "https://raw.githubusercontent.com/libretro-thumbnails/Sony_-_PlayStation/master/Named_Boxarts/Wipeout%20(USA).png",
    readyToPlay: true,
    requiredFilesNote: "Pronto para jogar no navegador",
    tags: ["60FPS", "WebGL", "Corrida Futurista"],
  },
  {
    id: "devilutionx-web",
    name: "DevilutionX Web",
    projectName: "Diablo + Hellfire",
    console: "PC / Retro",
    portType: "decomp",
    author: "Diasurgical Team",
    description:
      "Port oficial em WebAssembly do DevilutionX. Jogue a versão shareware imediatamente no navegador ou arraste seu DIABDAT.MPQ para a campanha completa.",
    webUrl: "https://d07riv.github.io/diabloweb/",
    githubRepo: "diasurgical/devilutionX",
    portId: "diablo1-devilutionx",
    nativeDifferential:
      "Multiplayer online via TCP/IP e ZeroTier, suporte nativo a controle e tela touch, resoluções modernas sem distorção, tradução PT-BR e expansão Hellfire completa.",
    readyToPlay: true,
    requiredFilesNote: "Shareware incluso (ou envie DIABDAT.MPQ)",
    extensions: [".mpq"],
    tags: ["WASM", "ARPG", "Touch & Gamepad"],
  },
  {
    id: "openlara-web",
    name: "OpenLara Web",
    projectName: "Tomb Raider (1996)",
    console: "PlayStation 1",
    portType: "source_port",
    author: "XProger",
    description:
      "Engine clássica de Tomb Raider reescrita em WebGL com iluminação dinâmica, sombras suaves, água reflexiva, 60 FPS e suporte a controle.",
    webUrl: "https://xproger.info/projects/OpenLara/",
    githubRepo: "XProger/OpenLara",
    portId: "openlara-tr1",
    nativeDifferential:
      "Iluminação dinâmica acelerada por GPU, sombras suaves em tempo real, modos de câmera em 1ª e 3ª pessoa e sem engasgos de Garbage Collection do WebGL.",
    readyToPlay: true,
    requiredFilesNote: "Demo inclusa (aceita arquivos .PHD/.PSX próprios)",
    extensions: [".phd", ".psx", ".iso"],
    tags: ["WebGL", "60FPS", " Primeira/Terceira Pessoa"],
  },
  {
    id: "classicube-web",
    name: "ClassiCube Web Client",
    projectName: "Minecraft Classic",
    console: "PC / Retro",
    portType: "source_port",
    author: "ClassiCube Team",
    description:
      "Reimplementação leve em C compilada para WebGL de Minecraft Classic (0.30) com servidores multiplayer, texturas customizadas e alta taxa de quadros.",
    webUrl: "https://www.classicube.net/server/play/",
    githubRepo: "ClassiCube/ClassiCube",
    portId: "classicube",
    nativeDifferential:
      "Acesso a toda a lista de servidores multiplayer clássicos sem restrições de WebSocket, suporte a texture packs HD locais e menor consumo de CPU/RAM.",
    readyToPlay: true,
    requiredFilesNote: "Pronto para jogar no navegador",
    tags: ["Multiplayer", "Sandbox", "Ultra-Leve"],
  },
  {
    id: "sm64-web",
    name: "sm64-port Web (WebGL)",
    projectName: "Super Mario 64",
    console: "Nintendo 64",
    portType: "decomp",
    author: "sm64-port & Harbour Masters",
    description:
      "Decompilação nativa de Super Mario 64 compilada para WebAssembly e WebGL com widescreen nativo, câmera analógica e suporte a gamepad.",
    webUrl: "https://sm64-web.pages.dev",
    githubRepo: "sm64-port/sm64-port",
    portId: "sm64-coopdx",
    nativeDifferential:
      "Multiplayer online cooperativo para até 16 jogadores simultâneos, suporte total a mods em Lua e DynOS (modelos 3D HD), 60+ FPS cravados sem input lag e controles com vibração.",
    readyToPlay: false,
    requiredFilesNote: "Pede sua ROM USA (.z64) no navegador",
    extensions: [".z64"],
    tags: ["Decomp", "Widescreen", "60FPS"],
  },
  {
    id: "oot-soh-web",
    name: "Ship of Harkinian",
    projectName: "The Legend of Zelda: Ocarina of Time",
    console: "Nintendo 64",
    portType: "decomp",
    author: "Harbour Masters",
    description:
      "Port nativo de Ocarina of Time com 60+ FPS, widescreen, randomizer integrado, câmera livre e melhorias de qualidade de vida.",
    webUrl: "https://www.shipofharkinian.com/",
    githubRepo: "HarbourMasters/Shipwright",
    portId: "oot-soh",
    nativeDifferential:
      "60+ FPS fluido, widescreen e ultrawide reais sem cortes, Randomizer embutido, câmera livre no analógico direito, giroscópio e pacotes de texturas em alta definição.",
    readyToPlay: false,
    requiredFilesNote: "Requer ROM de Ocarina of Time (.z64)",
    extensions: [".z64", ".n64"],
    tags: ["Zelda", "Randomizer", "60FPS"],
  },
  {
    id: "mm-2s2h-web",
    name: "2 Ship 2 Harkinian",
    projectName: "The Legend of Zelda: Majora's Mask",
    console: "Nintendo 64",
    portType: "decomp",
    author: "Harbour Masters",
    description:
      "Port nativo de Majora's Mask sobre a decompilação oficial com 60+ FPS, widescreen, giroscópio, texturas HD e mods.",
    webUrl: "https://www.shipofharkinian.com/",
    githubRepo: "HarbourMasters/2ship2harkinian",
    portId: "mm-recomp",
    nativeDifferential:
      "Taxa de quadros de 60+ FPS sem quebrar a física do relógio de 3 dias, controles modernos com mira livre no analógico, texturas HD, save states e correções QoL integradas.",
    readyToPlay: false,
    requiredFilesNote: "Requer ROM de Majora's Mask (.z64)",
    extensions: [".z64"],
    tags: ["Zelda", "Decomp", "Widescreen"],
  },
  {
    id: "sonic3air-web",
    name: "Sonic 3 A.I.R. Web",
    projectName: "Sonic the Hedgehog 3 & Knuckles",
    console: "Sega Genesis / CD",
    portType: "decomp",
    author: "Eukaryot",
    description:
      "Versão web oficial em WebAssembly de Sonic 3 Angel Island Revisited: widescreen 16:9, 60 FPS cravados, Time Attack e suporte a mods.",
    webUrl: "https://projects.sappharad.com/s3air_ios/",
    githubRepo: "Eukaryot/sonic3air",
    portId: "sonic-air",
    nativeDifferential:
      "Mod Manager completo nativo com suporte a trilhas sonoras orquestradas em alta fidelidade, personagens customizados e áudio bit-perfect com latência zero.",
    readyToPlay: false,
    requiredFilesNote: "Pede sua ROM Sonic_Knuckles_wSonic3.bin no navegador",
    extensions: [".bin", ".md", ".gen"],
    tags: ["Widescreen", "60FPS", "Sega Genesis"],
  },
  {
    id: "julius-web",
    name: "Julius Web",
    projectName: "Caesar III",
    console: "PC / Retro",
    portType: "source_port",
    author: "bvschaik",
    description:
      "Reimplementação open-source de Caesar III rodando no navegador via Emscripten, com suporte a resoluções HD e salvamento local.",
    webUrl: "https://bvschaik.github.io/julius/",
    githubRepo: "bvschaik/julius",
    portId: "julius",
    nativeDifferential:
      "Suporte nativo a telas ultrawide e altas resoluções, salvamentos permanentes no disco (sem risco de limpeza acidental pelo navegador) e suporte a mods do Augustus.",
    readyToPlay: false,
    requiredFilesNote: "Selecione a pasta/arquivos do Caesar III no navegador",
    tags: ["Estratégia", "City Builder", "WASM"],
  },
  {
    id: "doom-wasm",
    name: "DOOM-WASM / PrBoom+ Web",
    projectName: "Doom / Doom II / Heretic / Hexen",
    console: "PC / Retro",
    portType: "source_port",
    author: "Cloudflare / Doom-Wasm",
    description:
      "Motor clássico de DOOM compilado para WebAssembly com suporte a teclado, mouse lock, gamepad e carregamento de arquivos WAD.",
    webUrl: "https://silviolardau.github.io/doom-wasm/",
    githubRepo: "cloudflare/doom-wasm",
    portId: "uzdoom",
    nativeDifferential:
      "Suporte a mods avançados de gameplay (.pk3 e .wad como Brutal Doom), iluminação dinâmica 3D, som posicional binaural, renderizadores Vulkan/OpenGL e suporte a gamepads.",
    readyToPlay: true,
    requiredFilesNote: "Shareware DOOM1.WAD incluso",
    extensions: [".wad"],
    tags: ["FPS", "WASM", "Clássico"],
  },
  {
    id: "quakejs-web",
    name: "QuakeJS (ioquake3 Web)",
    projectName: "Quake",
    console: "PC / Retro",
    portType: "source_port",
    author: "inolen (ioquake3)",
    description:
      "Port de ioquake3 compilado com Emscripten e WebGL com partidas multiplayer online direto na aba do navegador.",
    webUrl: "http://www.quakejs.com/",
    githubRepo: "inolen/quakejs",
    portId: "vkquake",
    nativeDifferential:
      "Renderizador Vulkan com iluminação moderna de alta performance, taxas de quadros ilimitadas, mapas gigantes da comunidade e áudio surround sem compressão.",
    readyToPlay: true,
    requiredFilesNote: "Pronto para jogar no navegador",
    tags: ["Arena FPS", "Multiplayer", "WebGL"],
  },
  {
    id: "xash3d-web",
    name: "Xash3D FWGS Web",
    projectName: "Half-Life & Counter-Strike 1.6",
    artProjectName: "Half Life",
    console: "PC / Retro",
    portType: "source_port",
    author: "FWGS Team",
    description:
      "Motor GoldSrc reimplementado (Xash3D FWGS) compilado para WebAssembly para jogar Half-Life e Counter-Strike 1.6 no navegador.",
    webUrl: "https://play-cs.com",
    githubRepo: "FWGS/xash3d-fwgs",
    portId: "xash3d-fwgs",
    nativeDifferential:
      "Multiplayer via rede local (LAN) e servidores dedicados, suporte a mods clássicos do Half-Life (Counter-Strike 1.6, Team Fortress Classic) e zero engasgos de memória.",
    coverUrl: "https://cdn.cloudflare.steamstatic.com/steam/apps/70/library_600x900.jpg",
    readyToPlay: true,
    requiredFilesNote: "Servidores públicos ou envie sua pasta valve/",
    extensions: [".pak", ".wad"],
    tags: ["GoldSrc", "Multiplayer", "FPS"],
  },
  {
    id: "iortcw-web",
    name: "iortcw Web",
    projectName: "Return to Castle Wolfenstein",
    console: "PC / Retro",
    portType: "source_port",
    author: "iortcw Team",
    description:
      "Source port moderno de Return to Castle Wolfenstein em WebAssembly e WebGL2 com widescreen e controles de mouse precisos.",
    webUrl: "https://rtcw.pages.dev",
    githubRepo: "iortcw/iortcw",
    coverUrl: "https://cdn.cloudflare.steamstatic.com/steam/apps/9010/library_600x900.jpg",
    readyToPlay: false,
    requiredFilesNote: "Pede os arquivos .pk3 da pasta Main/",
    extensions: [".pk3"],
    tags: ["id Tech 3", "FPS", "Widescreen"],
  },
  {
    id: "fallout-ce-web",
    name: "Fallout Community Edition Web",
    projectName: "Fallout",
    console: "PC / Retro",
    portType: "decomp",
    author: "alexbatalov",
    description:
      "Reimplementação moderna de Fallout 1 rodando em WebAssembly no navegador a partir dos arquivos originais master.dat e critter.dat.",
    webUrl: "https://fallout-ce.pages.dev",
    githubRepo: "alexbatalov/fallout1-ce",
    portId: "fallout1-ce",
    nativeDifferential:
      "Saves locais permanentes sem risco de perda pelo navegador, interface em alta resolução sem distorção e estabilidade total sem limites de sandbox.",
    readyToPlay: false,
    requiredFilesNote: "Envie master.dat e critter.dat no navegador",
    extensions: [".dat"],
    tags: ["CRPG", "Isométrico", "WASM"],
  },
  {
    id: "openrct2-web",
    name: "OpenRCT2",
    projectName: "RollerCoaster Tycoon 2",
    console: "PC / Retro",
    portType: "decomp",
    author: "OpenRCT2 Team",
    description:
      "Reimplementação open-source de RollerCoaster Tycoon 2 com multiplayer cooperativo, fast-forward, alta resolução e suporte a parques clássicos.",
    webUrl: "https://openrct2.io/",
    githubRepo: "OpenRCT2/OpenRCT2",
    portId: "openrct2",
    nativeDifferential:
      "Multiplayer cooperativo online para gerenciar parques em equipe, aceleração de tempo (fast-forward) e suporte a parques colossais sem engasgos de memória.",
    readyToPlay: false,
    requiredFilesNote: "Requer arquivos do RCT2 original (g1.dat / pasta Data)",
    extensions: [".dat", ".sv6"],
    tags: ["Simulação", "Tycoon", "Multiplayer"],
  },
  {
    id: "fheroes2-web",
    name: "fheroes2",
    projectName: "Heroes of Might and Magic II",
    console: "PC / Retro",
    portType: "source_port",
    author: "ihhub / fheroes2 Team",
    description:
      "Recriação completa do motor de Heroes of Might and Magic II com IA aprimorada, modo hot-seat, widescreen e suporte a todas as plataformas.",
    webUrl: "https://ihhub.github.io/fheroes2/",
    githubRepo: "ihhub/fheroes2",
    portId: "fheroes2",
    nativeDifferential:
      "Inteligência Artificial reescrita muito mais desafiadora, modo multiplayer hot-seat completo, resoluções widescreen modernas e interface aprimorada.",
    readyToPlay: false,
    requiredFilesNote: "Compatível com a versão Demo gratuita ou completa (DATA/ e MAPS/)",
    extensions: [".agg", ".mp2"],
    tags: ["Estratégia", "Turnos", "HD"],
  },
  {
    id: "spacecadet-web",
    name: "3D Pinball: Space Cadet (WASM)",
    projectName: "3D Pinball for Windows: Space Cadet",
    console: "PC / Retro",
    portType: "decomp",
    author: "k4zmu2a / alula",
    description:
      "Decompilação do clássico Full Tilt! Pinball / 3D Pinball do Windows XP compilada para Emscripten e WebGL com som e física idênticos ao original.",
    webUrl: "https://alula.github.io/SpaceCadetPinball/",
    githubRepo: "k4zmu2a/SpaceCadetPinball",
    portId: "spacecadetpinball",
    nativeDifferential:
      "Física de pinball suave com taxa de atualização de 144Hz+, áudio MIDI de altíssima fidelidade e resposta instantânea dos flippers sem latência de teclado.",
    coverUrl: "https://raw.githubusercontent.com/k4zmu2a/SpaceCadetPinball/master/Icon_128x128.png",
    readyToPlay: true,
    requiredFilesNote: "Pronto para jogar no navegador",
    tags: ["Arcade", "Pinball", "Windows XP"],
  },
  {
    id: "princejs-web",
    name: "SDLPoP / PrinceJS",
    projectName: "Prince of Persia (1989)",
    console: "PC / Retro",
    portType: "source_port",
    author: "NagyD / ultrabolido",
    description:
      "Port fiel para navegador do clássico Prince of Persia de Jordan Mechner, baseado na disassembly original com controles de teclado e touch.",
    webUrl: "https://princejs.com/",
    githubRepo: "ultrabolido/PrinceJS",
    coverUrl: "https://raw.githubusercontent.com/libretro-thumbnails/DOS/master/Named_Boxarts/Prince%20of%20Persia.png",
    readyToPlay: true,
    requiredFilesNote: "Pronto para jogar no navegador",
    tags: ["Plataforma", "DOS", "Clássico"],
  },
  {
    id: "cnc-openra-web",
    name: "CNC3D / OpenRA Web",
    projectName: "Command & Conquer: Red Alert / Tiberian Dawn",
    artProjectName: "Command & Conquer: Red Alert / Tiberian Dawn / Dune 2000",
    console: "PC / Retro",
    portType: "source_port",
    author: "OpenRA & CNC3D Team",
    description:
      "Recriação moderna da franquia clássica de RTS Command & Conquer com suporte a navegador, câmera fluida e campanhas clássicas.",
    webUrl: "https://cnc3dgame.com/#live",
    githubRepo: "OpenRA/OpenRA",
    portId: "openra",
    nativeDifferential:
      "Multiplayer competitivo moderno com servidores dedicados e matchmaking, replays, névoa de guerra moderna e suporte completo a Red Alert, Tiberian Dawn e Dune 2000.",
    coverUrl: "https://raw.githubusercontent.com/libretro-thumbnails/DOS/master/Named_Boxarts/Command%20_%20Conquer.png",
    readyToPlay: true,
    requiredFilesNote: "Pronto para jogar no navegador",
    tags: ["RTS", "Estratégia", "WebGL"],
  },
  {
    id: "revc-web",
    name: "reVC Web (Vice City)",
    projectName: "Grand Theft Auto: Vice City",
    console: "PlayStation 2",
    portType: "decomp",
    author: "reVC Web Contributors",
    description:
      "Engine reimplementada de GTA: Vice City compilada para WebAssembly e WebGL2 com widescreen, 60 FPS e carregamento dos seus próprios arquivos do jogo.",
    webUrl: "https://revc-web.pages.dev",
    coverUrl: "https://raw.githubusercontent.com/libretro-thumbnails/Sony_-_PlayStation_2/master/Named_Boxarts/Grand%20Theft%20Auto%20-%20Vice%20City%20(USA).png",
    readyToPlay: false,
    requiredFilesNote: "Permite testar demo ou carregar pasta do GTA: Vice City",
    extensions: [".img", ".dir"],
    tags: ["Mundo Aberto", "WebGL2", "60FPS"],
  },
  {
    id: "re3-web",
    name: "re3 Web (GTA III)",
    projectName: "Grand Theft Auto III",
    console: "PlayStation 2",
    portType: "decomp",
    author: "re3 Web Contributors",
    description:
      "Engenharia reversa do motor RenderWare de Grand Theft Auto III rodando nativamente em WebAssembly no navegador com suporte a controle.",
    webUrl: "https://re3-web.pages.dev",
    coverUrl: "https://raw.githubusercontent.com/libretro-thumbnails/Sony_-_PlayStation_2/master/Named_Boxarts/Grand%20Theft%20Auto%20III%20(USA).png",
    readyToPlay: false,
    requiredFilesNote: "Permite testar demo ou carregar pasta do GTA III",
    extensions: [".img", ".dir"],
    tags: ["Mundo Aberto", "RenderWare", "WASM"],
  },
  {
    id: "opennfs-nfsu2-web",
    name: "OpenNFS / Web-Speed (NFSU2)",
    projectName: "Need for Speed: Underground 2",
    console: "PlayStation 2",
    portType: "source_port",
    author: "OpenNFS Contributors",
    description:
      "Port experimental para navegador e engine open-source de Need for Speed: Underground 2 com exploração de Bayview e física customizada.",
    webUrl: "https://web-speed.pages.dev/nfsu2",
    githubRepo: "OpenNFS/OpenNFS",
    coverUrl: "https://raw.githubusercontent.com/libretro-thumbnails/Sony_-_PlayStation_2/master/Named_Boxarts/Need%20for%20Speed%20-%20Underground%202%20(USA).png",
    readyToPlay: false,
    requiredFilesNote: "Aceita arquivos da instalação do NFS Underground 2",
    extensions: [".bin", ".bun"],
    tags: ["Corrida", "Tuning", "WebGL"],
  },
  {
    id: "opennfs-nfsmw-web",
    name: "Web-Speed (Most Wanted)",
    projectName: "Need for Speed: Most Wanted (2005)",
    console: "PlayStation 2",
    portType: "source_port",
    author: "OpenNFS Contributors",
    description:
      "Port web experimental de Need for Speed: Most Wanted (2005) rodando em WebAssembly a partir dos arquivos originais do jogo.",
    webUrl: "https://web-speed.pages.dev/nfsmw",
    githubRepo: "OpenNFS/OpenNFS",
    coverUrl: "https://raw.githubusercontent.com/libretro-thumbnails/Sony_-_PlayStation_2/master/Named_Boxarts/Need%20for%20Speed%20-%20Most%20Wanted%20(USA).png",
    readyToPlay: false,
    requiredFilesNote: "Aceita arquivos da instalação do NFS Most Wanted",
    extensions: [".bin", ".bun"],
    tags: ["Corrida", "Rockport", "WebGL"],
  },
  {
    id: "psxrecomp-hub",
    name: "PSXRecomp Ports Hub",
    projectName: "PlayStation 1 Recompilations",
    console: "PlayStation 1",
    portType: "recomp",
    author: "alexbeav / PSXRecomp",
    description:
      "Portal oficial dos projetos de recompilação estática de PlayStation 1 (Driver, Spyro, Crash 3, Metal Gear Solid, Final Fantasy VIII/IX e mais).",
    webUrl: "https://alexbeav.github.io/psxrecomp-ports/",
    githubRepo: "alexbeav/psxrecomp-ports",
    portId: "mgs1-recomp",
    nativeDifferential:
      "Execução em código nativo C++ direto no hardware da máquina (sem emulação ou sandbox do navegador), 60 FPS cravados e suporte a widescreen em clássicos do PS1.",
    coverUrl: "https://raw.githubusercontent.com/libretro-thumbnails/Sony_-_PlayStation/master/Named_Boxarts/Metal%20Gear%20Solid%20(USA)%20(Disc%201).png",
    readyToPlay: true,
    requiredFilesNote: "Catálogo interativo oficial do projeto PSXRecomp",
    extensions: [".bin", ".cue", ".chd"],
    tags: ["Recompilação Estática", "PS1", "C++"],
  },
];

/**
 * Todos os ports de navegador: os escolhidos à mão primeiro, depois os achados por
 * scripts/catalog/build-web-ports.mjs (link conferido; sem repetir site nem projeto).
 */
export const WEB_PORTS: WebPortItem[] = (() => {
  const norm = (u?: string) =>
    (u ?? "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/+$/, "");
  const urls = new Set(CURATED_WEB_PORTS.map((w) => norm(w.webUrl)));
  const ids = new Set(CURATED_WEB_PORTS.map((w) => w.id));
  return [...CURATED_WEB_PORTS, ...GENERATED_WEB_PORTS.filter((w) => !urls.has(norm(w.webUrl)) && !ids.has(w.id))];
})();

/**
 * Retorna o diferencial real e pesquisado do port nativo em relação à versão web,
 * destacando mods, multiplayer, taxa de quadros, áudio e recursos que não existem no browser.
 */
export function getNativeDifferential(w: WebPortItem, desktopPort?: { name?: string; description?: string }): string {
  if (w.nativeDifferential) return w.nativeDifferential;
  if (desktopPort?.description) {
    return `${desktopPort.name ?? "Versão nativa"}: ${desktopPort.description}. Executa direto no processador com menor latência, suporte a controle com vibração e sem limites de memória do navegador.`;
  }
  return "Execução nativa direta no sistema operacional: suporte completo a controles com vibração, áudio de baixa latência, taxa de quadros desbloqueada e saves permanentes no disco.";
}
