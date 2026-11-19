/* ==========================================================================
   MemoryCard.cloud — Web Player Shell (SM64 & GoW CoO)
   Zero-dependency controller, HUD, settings sheet, touch input & diagnostics.
   ========================================================================== */

(function () {
  "use strict";

  var STORAGE_KEY = "mcd-player";

  var ICONS = {
    arrowLeft:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>',
    volume2:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
    volumeX:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/></svg>',
    gamepad2:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/></svg>',
    activity:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>',
    maximize:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>',
    minimize:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>',
    settings:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
    close:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
  };

  /* Default N64 key map matching SM64 PC Port SDL2 scancodes */
  var N64_KEYMAP = {
    up: { code: "KeyW", key: "w", keyCode: 87, location: 0 },
    down: { code: "KeyS", key: "s", keyCode: 83, location: 0 },
    left: { code: "KeyA", key: "a", keyCode: 65, location: 0 },
    right: { code: "KeyD", key: "d", keyCode: 68, location: 0 },
    a: { code: "KeyL", key: "l", keyCode: 76, location: 0 },
    b: { code: "Comma", key: ",", keyCode: 188, location: 0 },
    z: { code: "KeyK", key: "k", keyCode: 75, location: 0 },
    start: { code: "Space", key: " ", keyCode: 32, location: 0 },
    r: { code: "ShiftRight", key: "Shift", keyCode: 16, location: 2, shiftKey: true },
    l: { code: "ShiftLeft", key: "Shift", keyCode: 16, location: 1, shiftKey: true },
    cup: { code: "ArrowUp", key: "ArrowUp", keyCode: 38, location: 0 },
    cdown: { code: "ArrowDown", key: "ArrowDown", keyCode: 40, location: 0 },
    cleft: { code: "ArrowLeft", key: "ArrowLeft", keyCode: 37, location: 0 },
    cright: { code: "ArrowRight", key: "ArrowRight", keyCode: 39, location: 0 }
  };

  function isTouchEnvironment() {
    return (
      (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
      /[?&]touch\b/.test(location.search)
    );
  }

  function isPortraitMobile() {
    var portrait = window.matchMedia && window.matchMedia("(orientation: portrait)").matches;
    return portrait && (isTouchEnvironment() || window.innerWidth < 768);
  }

  function detectWebGLRenderer() {
    try {
      var c = document.createElement("canvas");
      var gl = c.getContext("webgl2") || c.getContext("webgl");
      if (!gl) return "WebGL indisponível";
      var dbg = gl.getExtension("WEBGL_debug_renderer_info");
      return dbg
        ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
    } catch (e) {
      return "Desconhecido";
    }
  }

  function circleOf(el) {
    var r = el.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      r: Math.max(1, r.width / 2)
    };
  }

  function dispatchSyntheticKey(type, def, canvas) {
    if (!def) return;
    try {
      var ev = new KeyboardEvent(type, {
        key: def.key,
        code: def.code,
        location: def.location || 0,
        keyCode: def.keyCode,
        which: def.keyCode,
        charCode: 0,
        shiftKey: !!def.shiftKey,
        bubbles: true,
        cancelable: true
      });
      if (ev.keyCode !== def.keyCode) {
        Object.defineProperty(ev, "keyCode", { get: function () { return def.keyCode; } });
      }
      if (ev.which !== def.keyCode) {
        Object.defineProperty(ev, "which", { get: function () { return def.keyCode; } });
      }
      ev._mcdSynthetic = true;
      var target = canvas && document.body.contains(canvas) ? canvas : window;
      target.dispatchEvent(ev);
    } catch (e) {}
  }

  function buildControlsHTML(layout) {
    if (layout === "n64") {
      return (
        '<div class="mcd-cluster-left">' +
          '<div class="mcd-shoulders">' +
            '<div class="ctl ctl-shoulder" data-key="l">L</div>' +
            '<div class="ctl ctl-shoulder ctl-z" data-key="z">Z</div>' +
          "</div>" +
          '<div class="mcd-dpad mcd-dpad-compact" data-dpad>' +
            '<span class="up" data-dir="up">▲</span>' +
            '<span class="left" data-dir="left">◀</span>' +
            '<span class="hub"></span>' +
            '<span class="right" data-dir="right">▶</span>' +
            '<span class="down" data-dir="down">▼</span>' +
          "</div>" +
          '<div class="mcd-stick" data-stick><div class="mcd-stick-knob" id="mcd-knob"></div></div>' +
        "</div>" +
        '<div class="mcd-cluster-mid">' +
          '<div class="ctl ctl-pill ctl-start-n64" data-key="start">Start</div>' +
        "</div>" +
        '<div class="mcd-cluster-right">' +
          '<div class="mcd-shoulders">' +
            '<div class="ctl ctl-shoulder" data-key="r">R</div>' +
          "</div>" +
          '<div class="mcd-cpad">' +
            '<div class="ctl cup" data-key="cup">C▲</div>' +
            '<div class="ctl cleft" data-key="cleft">C◀</div>' +
            '<div class="ctl cright" data-key="cright">C▶</div>' +
            '<div class="ctl cdown" data-key="cdown">C▼</div>' +
          "</div>" +
          '<div class="mcd-ab-n64">' +
            '<div class="ctl ctl-b" data-key="b">B</div>' +
            '<div class="ctl ctl-a" data-key="a">A</div>' +
          "</div>" +
        "</div>"
      );
    }

    /* Default: PSP layout */
    return (
      '<div class="mcd-cluster-left">' +
        '<div class="mcd-shoulders">' +
          '<div class="ctl ctl-shoulder" data-btn="256">L</div>' +
        "</div>" +
        '<div class="mcd-dpad" data-dpad>' +
          '<span class="up" data-dir="16">▲</span>' +
          '<span class="left" data-dir="128">◀</span>' +
          '<span class="hub"></span>' +
          '<span class="right" data-dir="32">▶</span>' +
          '<span class="down" data-dir="64">▼</span>' +
        "</div>" +
        '<div class="mcd-stick" data-stick><div class="mcd-stick-knob" id="mcd-knob"></div></div>' +
      "</div>" +
      '<div class="mcd-cluster-mid">' +
        '<div class="ctl ctl-pill" data-btn="1">Select</div>' +
        '<div class="ctl ctl-pill" data-btn="8">Start</div>' +
      "</div>" +
      '<div class="mcd-cluster-right">' +
        '<div class="mcd-shoulders">' +
          '<div class="ctl ctl-shoulder" data-btn="512">R</div>' +
        "</div>" +
        '<div class="mcd-face-psp">' +
          '<div class="ctl tri" data-btn="4096">△</div>' +
          '<div class="ctl sq" data-btn="32768">□</div>' +
          '<div class="ctl ci" data-btn="8192">○</div>' +
          '<div class="ctl cr" data-btn="16384">✕</div>' +
        "</div>" +
      "</div>"
    );
  }

  function buildKeyboardHelpHTML(layout) {
    if (layout === "n64") {
      return (
        '<div class="mcd-key-row"><span>Analógico (Mover)</span><kbd>W A S D</kbd></div>' +
        '<div class="mcd-key-row"><span>Câmera (C-Buttons)</span><kbd>Setas ↑ ↓ ← →</kbd></div>' +
        '<div class="mcd-key-row"><span>Pular (Botão A)</span><kbd>L / X</kbd></div>' +
        '<div class="mcd-key-row"><span>Ataque / Mergulho (B)</span><kbd>, / C / J</kbd></div>' +
        '<div class="mcd-key-row"><span>Agachar (Gatilho Z)</span><kbd>K / Z</kbd></div>' +
        '<div class="mcd-key-row"><span>Gatilho R</span><kbd>Shift</kbd></div>' +
        '<div class="mcd-key-row"><span>Start / Pausa</span><kbd>Espaço / Enter</kbd></div>' +
        '<div class="mcd-key-row"><span>Tela cheia / Controles / FPS</span><kbd>F / H / O</kbd></div>'
      );
    }
    return (
      '<div class="mcd-key-row"><span>D-Pad</span><kbd>Setas ↑ ↓ ← →</kbd></div>' +
      '<div class="mcd-key-row"><span>Analógico</span><kbd>I J K L</kbd></div>' +
      '<div class="mcd-key-row"><span>Botões ✕ / ○ / □ / △</span><kbd>Z / X / A / S</kbd></div>' +
      '<div class="mcd-key-row"><span>Gatilhos L / R</span><kbd>Q / W</kbd></div>' +
      '<div class="mcd-key-row"><span>Start / Select</span><kbd>Enter / Shift</kbd></div>' +
      '<div class="mcd-key-row"><span>Tela cheia / Controles / FPS</span><kbd>F / H / O</kbd></div>'
    );
  }

  function init(config) {
    config = config || {};
    var layout = config.layout || "psp";
    var aspect = config.aspect || (layout === "n64" ? 4 / 3 : 480 / 272);
    var root = document.documentElement;
    root.style.setProperty("--game-aspect", String(aspect));

    /* Load saved preferences */
    var prefs = {};
    try {
      prefs = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
    } catch (e) {
      prefs = {};
    }

    if (typeof prefs.controls !== "string") prefs.controls = "auto";
    if (typeof prefs.opacity !== "number") prefs.opacity = 75;
    if (typeof prefs.ctlSize !== "string") prefs.ctlSize = "md";
    if (typeof prefs.haptics !== "boolean") prefs.haptics = true;
    if (typeof prefs.showPerf !== "boolean") prefs.showPerf = false;
    if (typeof prefs.muted !== "boolean") prefs.muted = false;
    if (typeof prefs.scale !== "number") {
      prefs.scale = isTouchEnvironment() ? 1 : 2;
    }

    function savePrefs() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      } catch (e) {}
    }

    function resolveMode() {
      if (
        prefs.mode === "gameboy" ||
        prefs.mode === "fullscreen" ||
        prefs.mode === "clean"
      ) {
        return prefs.mode;
      }
      return isPortraitMobile() ? "gameboy" : "fullscreen";
    }

    function resolveControls() {
      if (prefs.controls === "on") return "on";
      if (prefs.controls === "off") return "off";
      return isTouchEnvironment() || resolveMode() === "gameboy" ? "on" : "off";
    }

    /* Ensure .mcd-shell and .mcd-stage exist around #canvas */
    var canvas = config.canvas || document.getElementById("canvas");
    var shell = document.querySelector(".mcd-shell");
    var stage = document.querySelector(".mcd-stage");

    if (!shell) {
      shell = document.createElement("div");
      shell.className = "mcd-shell";
      if (!stage) {
        stage = document.createElement("div");
        stage.className = "mcd-stage";
      }
      if (canvas && canvas.parentNode) {
        canvas.parentNode.insertBefore(shell, canvas);
        stage.appendChild(canvas);
        shell.appendChild(stage);
      } else {
        document.body.appendChild(shell);
      }
    }

    /* Build Topbar */
    var topbar = document.createElement("header");
    topbar.className = "mcd-topbar";
    topbar.id = "mcd-topbar";
    topbar.innerHTML =
      '<div class="mcd-topbar-left">' +
        '<a class="mcd-icon-btn" href="/web-ports/" title="Voltar ao catálogo" aria-label="Voltar ao catálogo">' +
          ICONS.arrowLeft +
        "</a>" +
        '<div class="mcd-brand">' +
          '<img class="mcd-brand-logo" src="/logo.png" onerror="this.onerror=null;this.src=\'../../logo.png\'" alt="">' +
          '<span class="mcd-game-title">' + (config.title || "Jogo") + "</span>" +
          '<span class="mcd-console-badge">' + (config.consoleName || "Console") + "</span>" +
        "</div>" +
      "</div>" +
      '<div class="mcd-topbar-actions">' +
        '<button type="button" class="mcd-icon-btn" id="mcd-btn-sound" title="Alternar som" aria-label="Alternar som">' +
          ICONS.volume2 +
        "</button>" +
        '<button type="button" class="mcd-icon-btn" id="mcd-btn-controls" title="Mostrar ou ocultar controles na tela (H)" aria-label="Controles na tela">' +
          ICONS.gamepad2 +
        "</button>" +
        '<button type="button" class="mcd-icon-btn" id="mcd-btn-perf" title="Mostrar ou ocultar desempenho (O)" aria-label="Desempenho">' +
          ICONS.activity +
        "</button>" +
        '<button type="button" class="mcd-icon-btn" id="mcd-btn-fullscreen" title="Alternar tela cheia (F)" aria-label="Tela cheia">' +
          ICONS.maximize +
        "</button>" +
        '<button type="button" class="mcd-icon-btn" id="mcd-btn-menu" title="Abrir menu de configurações (Esc)" aria-label="Menu de configurações" aria-expanded="false">' +
          ICONS.settings +
        "</button>" +
      "</div>";
    shell.insertBefore(topbar, shell.firstChild);

    /* Floating button for Clean mode */
    var cleanFab = document.createElement("button");
    cleanFab.type = "button";
    cleanFab.className = "mcd-clean-fab";
    cleanFab.id = "mcd-clean-fab";
    cleanFab.title = "Abrir menu (Esc)";
    cleanFab.setAttribute("aria-label", "Abrir menu de configurações");
    cleanFab.innerHTML = ICONS.settings;
    shell.appendChild(cleanFab);

    /* Performance Chip */
    var perfEl = document.createElement("div");
    perfEl.className = "mcd-perf";
    perfEl.id = "mcd-perf";
    perfEl.textContent = "FPS --";
    shell.appendChild(perfEl);

    /* Toast Notification */
    var toastEl = document.createElement("div");
    toastEl.className = "mcd-toast";
    toastEl.id = "mcd-toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    shell.appendChild(toastEl);

    /* Loading Overlay */
    var loadingEl = document.createElement("div");
    loadingEl.className = "mcd-loading";
    loadingEl.id = "mcd-loading";
    loadingEl.innerHTML =
      '<div class="mcd-loading-card">' +
        '<img class="mcd-loading-logo" src="/logo.png" onerror="this.onerror=null;this.src=\'../../logo.png\'" alt="MemoryCard.cloud">' +
        '<span class="mcd-console-badge">' + (config.consoleName || "Console") + "</span>" +
        '<h1 class="mcd-loading-title">' + (config.title || "Carregando") + "</h1>" +
        '<div class="mcd-loading-status" id="mcd-loading-status">Carregando…</div>' +
        '<div class="mcd-loading-bar indeterminate" id="mcd-loading-bar">' +
          '<div class="mcd-loading-fill" id="mcd-loading-fill"></div>' +
        "</div>" +
        '<div id="mcd-loading-error" hidden></div>' +
      "</div>";
    shell.appendChild(loadingEl);

    /* On-screen Touch Controls */
    var controlsEl = document.createElement("div");
    controlsEl.className = "mcd-controls";
    controlsEl.id = "mcd-controls";
    controlsEl.setAttribute("aria-label", "Controles virtuais");
    controlsEl.innerHTML = buildControlsHTML(layout);
    shell.appendChild(controlsEl);

    /* Settings Menu Backdrop & Sheet */
    var backdropEl = document.createElement("div");
    backdropEl.className = "mcd-backdrop";
    backdropEl.id = "mcd-backdrop";
    shell.appendChild(backdropEl);

    var hasResolution = !!config.hasResolution;
    var hasSaves = !!config.hasSaves;

    var menuEl = document.createElement("aside");
    menuEl.className = "mcd-menu";
    menuEl.id = "mcd-menu";
    menuEl.setAttribute("role", "dialog");
    menuEl.setAttribute("aria-modal", "true");
    menuEl.setAttribute("aria-labelledby", "mcd-menu-title");
    menuEl.innerHTML =
      '<div class="mcd-menu-head">' +
        '<h2 class="mcd-menu-title" id="mcd-menu-title">Configurações do Player</h2>' +
        '<button type="button" class="mcd-icon-btn" id="mcd-menu-close" title="Fechar menu (Esc)" aria-label="Fechar menu">' +
          ICONS.close +
        "</button>" +
      "</div>" +
      '<div class="mcd-menu-body">' +
        /* 1. Modo de exibição */
        '<div class="mcd-field">' +
          '<span class="mcd-label">Modo de exibição</span>' +
          '<div class="mcd-segmented" role="group" aria-label="Modo de exibição">' +
            '<button type="button" class="mcd-seg-btn" data-mode-opt="gameboy">Gameboy</button>' +
            '<button type="button" class="mcd-seg-btn" data-mode-opt="fullscreen">Tela cheia</button>' +
            '<button type="button" class="mcd-seg-btn" data-mode-opt="clean">Tela limpa</button>' +
          "</div>" +
        "</div>" +
        /* 2. Controles na tela */
        '<div class="mcd-field-row">' +
          '<div><div class="mcd-label">Controles na tela</div><div class="mcd-sublabel">Atalho: tecla H</div></div>' +
          '<button type="button" class="mcd-toggle-btn" id="mcd-menu-controls">Visível</button>' +
        "</div>" +
        /* 3. Opacidade dos controles */
        '<div class="mcd-field">' +
          '<div class="mcd-field-row">' +
            '<label class="mcd-label" for="mcd-menu-opacity">Opacidade dos controles</label>' +
            '<span class="mcd-sublabel" id="mcd-opacity-val">75%</span>' +
          "</div>" +
          '<input type="range" class="mcd-range" id="mcd-menu-opacity" min="20" max="100" step="5" value="75">' +
        "</div>" +
        /* 4. Tamanho dos controles */
        '<div class="mcd-field">' +
          '<span class="mcd-label">Tamanho dos controles</span>' +
          '<div class="mcd-segmented" role="group" aria-label="Tamanho dos controles">' +
            '<button type="button" class="mcd-seg-btn" data-size-opt="sm">P</button>' +
            '<button type="button" class="mcd-seg-btn" data-size-opt="md">M</button>' +
            '<button type="button" class="mcd-seg-btn" data-size-opt="lg">G</button>' +
          "</div>" +
        "</div>" +
        /* 5. Vibração (Haptics) */
        '<div class="mcd-field-row">' +
          '<div><div class="mcd-label">Vibração (Haptics)</div><div class="mcd-sublabel">Resposta tátil ao tocar botões</div></div>' +
          '<button type="button" class="mcd-toggle-btn" id="mcd-menu-haptics">Ligado</button>' +
        "</div>" +
        /* 6. Mostrar desempenho (FPS) */
        '<div class="mcd-field-row">' +
          '<div><div class="mcd-label">Mostrar desempenho (FPS)</div><div class="mcd-sublabel">Atalho: tecla O</div></div>' +
          '<button type="button" class="mcd-toggle-btn" id="mcd-menu-perf">Oculto</button>' +
        "</div>" +
        /* 7. Som */
        '<div class="mcd-field-row">' +
          '<div><div class="mcd-label">Som</div><div class="mcd-sublabel">Áudio do jogo</div></div>' +
          '<button type="button" class="mcd-toggle-btn" id="mcd-menu-sound">Ligado</button>' +
        "</div>" +
        /* 8. Resolução interna (GoW) */
        (hasResolution
          ? '<div class="mcd-field" id="mcd-field-scale">' +
              '<span class="mcd-label">Resolução interna</span>' +
              '<div class="mcd-segmented" role="group" aria-label="Resolução interna">' +
                '<button type="button" class="mcd-seg-btn" data-scale-opt="1" title="480×272">1x (480×272)</button>' +
                '<button type="button" class="mcd-seg-btn" data-scale-opt="2" title="960×544">2x (960×544)</button>' +
                '<button type="button" class="mcd-seg-btn" data-scale-opt="3" title="1440×816">3x (1440×816)</button>' +
                '<button type="button" class="mcd-seg-btn" data-scale-opt="4" title="1920×1088">4x (1920×1088)</button>' +
              "</div>" +
            "</div>"
          : "") +
        /* 9. Saves (Memória PSP) */
        (hasSaves
          ? '<div class="mcd-field" id="mcd-field-saves">' +
              '<span class="mcd-label">Saves (Memória PSP)</span>' +
              '<div class="mcd-btn-grid">' +
                '<button type="button" class="btn btn-quiet" id="mcd-btn-export-saves">Exportar Saves (.zip)</button>' +
                '<button type="button" class="btn btn-quiet" id="mcd-btn-import-saves">Importar Saves (.zip)</button>' +
              "</div>" +
            "</div>"
          : "") +
        /* 10. Atalhos de teclado */
        '<div class="mcd-field">' +
          '<span class="mcd-label">Atalhos de teclado</span>' +
          '<div class="mcd-keys-card">' +
            buildKeyboardHelpHTML(layout) +
          "</div>" +
        "</div>" +
        /* 11. Diagnóstico (Log) */
        '<details class="mcd-details">' +
          "<summary><span>Diagnóstico (Log)</span><span class=\"mcd-sublabel\">Expandir</span></summary>" +
          '<div class="mcd-details-body">' +
            '<div class="mcd-sublabel" id="mcd-renderer-info">Renderer: detectando…</div>' +
            '<pre class="mcd-log" id="mcd-log"></pre>' +
          "</div>" +
        "</details>" +
        /* 12. Voltar ao catálogo */
        '<a class="btn btn-quiet" href="/web-ports/">Voltar ao catálogo</a>' +
      "</div>";
    shell.appendChild(menuEl);

    /* Element references */
    var btnSound = document.getElementById("mcd-btn-sound");
    var btnControls = document.getElementById("mcd-btn-controls");
    var btnPerf = document.getElementById("mcd-btn-perf");
    var btnFullscreen = document.getElementById("mcd-btn-fullscreen");
    var btnMenu = document.getElementById("mcd-btn-menu");
    var menuClose = document.getElementById("mcd-menu-close");
    var menuControls = document.getElementById("mcd-menu-controls");
    var menuOpacity = document.getElementById("mcd-menu-opacity");
    var opacityVal = document.getElementById("mcd-opacity-val");
    var menuHaptics = document.getElementById("mcd-menu-haptics");
    var menuPerf = document.getElementById("mcd-menu-perf");
    var menuSound = document.getElementById("mcd-menu-sound");
    var logEl = document.getElementById("mcd-log");
    var rendererInfoEl = document.getElementById("mcd-renderer-info");
    var knobEl = document.getElementById("mcd-knob");
    var stickEl = controlsEl.querySelector("[data-stick]");
    var loadingStatusEl = document.getElementById("mcd-loading-status");
    var loadingBarEl = document.getElementById("mcd-loading-bar");
    var loadingFillEl = document.getElementById("mcd-loading-fill");
    var loadingErrorEl = document.getElementById("mcd-loading-error");

    /* WebGL Renderer Diagnostic */
    var rendererName = detectWebGLRenderer();
    rendererInfoEl.textContent = "WebGL: " + rendererName;
    perfEl.title = "WebGL: " + rendererName;

    function appendLog(msg) {
      if (!logEl) return;
      logEl.textContent += msg + "\n";
      if (logEl.textContent.length > 180000) {
        logEl.textContent = logEl.textContent.slice(-140000);
      }
      logEl.scrollTop = logEl.scrollHeight;
    }
    appendLog("[player] WebGL renderer: " + rendererName);

    /* Toast Notification */
    var toastTimer = 0;
    function notify(msg) {
      if (!msg) return;
      toastEl.textContent = msg;
      toastEl.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        toastEl.classList.remove("show");
      }, 4200);
    }

    /* Cross-Origin Isolation Check (§3.5) */
    if (config.requireCrossOriginIsolated && !window.crossOriginIsolated) {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.register("/coi-serviceworker.js").catch(function () {
          navigator.serviceWorker.register("../../coi-serviceworker.js").catch(function () {});
        });
      }
      loadingErrorEl.hidden = false;
      loadingErrorEl.className = "notice notice-danger";
      loadingErrorEl.innerHTML =
        "<div>Esta página precisa de isolamento Cross-Origin (SharedArrayBuffer). Recarregue a página para ativar o Service Worker.</div>" +
        '<button type="button" class="btn btn-primary" id="mcd-btn-reload">Recarregar página</button>';
      var reloadBtn = document.getElementById("mcd-btn-reload");
      if (reloadBtn) {
        reloadBtn.addEventListener("click", function () {
          location.reload();
        });
      }
    }

    /* Touch & Synthetic Input State */
    var touchPad = { buttons: 0, x: 0, y: 0, stick: false };
    var activeKeys = {};
    var fingers = {};
    var mouseActive = false;

    function releaseAllInputs() {
      fingers = {};
      mouseActive = false;
      touchPad = { buttons: 0, x: 0, y: 0, stick: false };

      if (layout === "n64") {
        for (var k in activeKeys) {
          if (activeKeys[k] && N64_KEYMAP[k]) {
            dispatchSyntheticKey("keyup", N64_KEYMAP[k], canvas);
          }
        }
      }
      activeKeys = {};

      if (knobEl) knobEl.style.transform = "";
      if (stickEl) stickEl.classList.remove("on");
      controlsEl.querySelectorAll(".on").forEach(function (el) {
        el.classList.remove("on");
      });

      if (config.onInput) config.onInput(touchPad);
    }

    function vibrateTap() {
      if (prefs.haptics && navigator.vibrate) {
        try {
          navigator.vibrate(8);
        } catch (e) {}
      }
    }

    function evaluatePoints(points) {
      if (resolveControls() === "off") return;

      var seenIds = {};
      var nextButtons = 0;
      var nextKeys = {};
      var sx = 0;
      var sy = 0;
      var stickActive = false;

      for (var i = 0; i < points.length; i++) {
        var pt = points[i];
        seenIds[pt.identifier] = true;
        var f = fingers[pt.identifier];
        if (!f) {
          var hit = document.elementFromPoint(pt.clientX, pt.clientY);
          var zone = hit && hit.closest("[data-stick],[data-dpad]");
          f = fingers[pt.identifier] = zone
            ? {
                kind: zone.hasAttribute("data-stick") ? "stick" : "dpad",
                el: zone
              }
            : { kind: "button" };
        }

        if (f.kind === "stick") {
          var c = circleOf(f.el);
          var px = (pt.clientX - c.x) / c.r;
          var py = (pt.clientY - c.y) / c.r;
          var dist = Math.hypot(px, py);
          if (dist > 1) {
            px /= dist;
            py /= dist;
          }
          sx = px;
          sy = py;
          stickActive = true;
          if (knobEl) {
            knobEl.style.transform =
              "translate(" +
              (px * c.r * 0.58).toFixed(1) +
              "px," +
              (py * c.r * 0.58).toFixed(1) +
              "px)";
          }
          if (layout === "n64" && dist > 0.22) {
            var angS = (180 * Math.atan2(py, px)) / Math.PI;
            if (angS > -67.5 && angS < 67.5) nextKeys.right = true;
            if (angS > 22.5 && angS < 157.5) nextKeys.down = true;
            if (angS > 112.5 || angS < -112.5) nextKeys.left = true;
            if (angS > -157.5 && angS < -22.5) nextKeys.up = true;
          }
        } else if (f.kind === "dpad") {
          var dc = circleOf(f.el);
          var dx = pt.clientX - dc.x;
          var dy = pt.clientY - dc.y;
          if (Math.hypot(dx, dy) > 0.18 * dc.r) {
            var angD = (180 * Math.atan2(dy, dx)) / Math.PI;
            if (layout === "n64") {
              if (angD > -67.5 && angD < 67.5) nextKeys.right = true;
              if (angD > 22.5 && angD < 157.5) nextKeys.down = true;
              if (angD > 112.5 || angD < -112.5) nextKeys.left = true;
              if (angD > -157.5 && angD < -22.5) nextKeys.up = true;
            } else {
              if (angD > -67.5 && angD < 67.5) nextButtons |= 32;
              if (angD > 22.5 && angD < 157.5) nextButtons |= 64;
              if (angD > 112.5 || angD < -112.5) nextButtons |= 128;
              if (angD > -157.5 && angD < -22.5) nextButtons |= 16;
            }
          }
        } else {
          var bEl = document.elementFromPoint(pt.clientX, pt.clientY);
          var btn = bEl && bEl.closest("[data-btn],[data-key]");
          if (btn && controlsEl.contains(btn)) {
            if (btn.dataset.btn) nextButtons |= Number(btn.dataset.btn);
            if (btn.dataset.key) nextKeys[btn.dataset.key] = true;
          }
        }
      }

      for (var id in fingers) {
        if (!seenIds[id]) delete fingers[id];
      }

      if (!stickActive && knobEl) {
        knobEl.style.transform = "";
      }
      if (stickEl) {
        stickEl.classList.toggle("on", stickActive);
      }

      /* Haptics on newly pressed button or key */
      var newlyPressed = (nextButtons & ~touchPad.buttons) !== 0;
      if (!newlyPressed && layout === "n64") {
        for (var nk in nextKeys) {
          if (!activeKeys[nk]) {
            newlyPressed = true;
            break;
          }
        }
      }
      if (newlyPressed) vibrateTap();

      /* Dispatch N64 synthetic keyboard events on state transitions */
      if (layout === "n64") {
        for (var keyName in N64_KEYMAP) {
          var wasOn = !!activeKeys[keyName];
          var isOn = !!nextKeys[keyName];
          if (isOn && !wasOn) {
            dispatchSyntheticKey("keydown", N64_KEYMAP[keyName], canvas);
          } else if (!isOn && wasOn) {
            dispatchSyntheticKey("keyup", N64_KEYMAP[keyName], canvas);
          }
        }
        activeKeys = nextKeys;
      }

      touchPad = {
        buttons: nextButtons,
        x: sx,
        y: sy,
        stick: stickActive
      };

      /* Visual feedback (.on) */
      controlsEl.querySelectorAll("[data-btn]").forEach(function (el) {
        el.classList.toggle("on", (nextButtons & Number(el.dataset.btn)) !== 0);
      });
      controlsEl.querySelectorAll("[data-key]").forEach(function (el) {
        el.classList.toggle("on", !!nextKeys[el.dataset.key]);
      });
      controlsEl.querySelectorAll("[data-dir]").forEach(function (el) {
        var dir = el.dataset.dir;
        var on =
          layout === "n64"
            ? !!nextKeys[dir]
            : (nextButtons & Number(dir)) !== 0;
        el.classList.toggle("on", on);
      });

      if (config.onInput) config.onInput(touchPad);
    }

    function onTouchEvent(e) {
      if (e.cancelable) e.preventDefault();
      var pts = [];
      for (var i = 0; i < e.touches.length; i++) {
        pts.push({
          identifier: e.touches[i].identifier,
          clientX: e.touches[i].clientX,
          clientY: e.touches[i].clientY
        });
      }
      evaluatePoints(pts);
    }

    ["touchstart", "touchmove", "touchend", "touchcancel"].forEach(function (evName) {
      controlsEl.addEventListener(evName, onTouchEvent, { passive: false });
    });

    /* Mouse fallback on controls for desktop testing & touch notebooks */
    controlsEl.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      mouseActive = true;
      evaluatePoints([{ identifier: "mouse", clientX: e.clientX, clientY: e.clientY }]);
    });
    window.addEventListener("mousemove", function (e) {
      if (!mouseActive) return;
      evaluatePoints([{ identifier: "mouse", clientX: e.clientX, clientY: e.clientY }]);
    });
    window.addEventListener("mouseup", function () {
      if (!mouseActive) return;
      mouseActive = false;
      evaluatePoints([]);
    });
    window.addEventListener("blur", releaseAllInputs);

    /* Apply & Synchronize UI State */
    function isNativeFullscreen() {
      return !!(document.fullscreenElement || document.webkitFullscreenElement);
    }

    function applyState() {
      var mode = resolveMode();
      var ctlState = resolveControls();

      root.setAttribute("data-mode", mode);
      root.setAttribute("data-controls", ctlState);
      root.setAttribute("data-ctl-size", prefs.ctlSize || "md");
      root.setAttribute("data-perf", prefs.showPerf ? "on" : "off");
      root.style.setProperty("--ctl-opacity", String((prefs.opacity || 75) / 100));

      if (ctlState === "off") {
        releaseAllInputs();
      }

      /* Update Topbar Buttons */
      var controlsOn = ctlState === "on";
      btnControls.setAttribute("aria-pressed", String(controlsOn));
      btnControls.classList.toggle("active", controlsOn);

      menuControls.setAttribute("aria-pressed", String(controlsOn));
      menuControls.textContent = controlsOn ? "Visível" : "Oculto";

      btnPerf.setAttribute("aria-pressed", String(!!prefs.showPerf));
      btnPerf.classList.toggle("active", !!prefs.showPerf);
      menuPerf.setAttribute("aria-pressed", String(!!prefs.showPerf));
      menuPerf.textContent = prefs.showPerf ? "Visível" : "Oculto";

      var soundOn = !prefs.muted;
      btnSound.setAttribute("aria-pressed", String(soundOn));
      btnSound.innerHTML = prefs.muted ? ICONS.volumeX : ICONS.volume2;
      menuSound.setAttribute("aria-pressed", String(soundOn));
      menuSound.textContent = prefs.muted ? "Mudo" : "Ligado";

      menuHaptics.setAttribute("aria-pressed", String(!!prefs.haptics));
      menuHaptics.textContent = prefs.haptics ? "Ligado" : "Desligado";

      menuOpacity.value = String(prefs.opacity || 75);
      opacityVal.textContent = (prefs.opacity || 75) + "%";

      var fsActive = isNativeFullscreen();
      btnFullscreen.setAttribute("aria-pressed", String(fsActive));
      btnFullscreen.innerHTML = fsActive ? ICONS.minimize : ICONS.maximize;

      /* Segmented buttons in menu */
      menuEl.querySelectorAll("[data-mode-opt]").forEach(function (b) {
        b.setAttribute("aria-pressed", String(b.dataset.modeOpt === mode));
      });
      menuEl.querySelectorAll("[data-size-opt]").forEach(function (b) {
        b.setAttribute(
          "aria-pressed",
          String(b.dataset.sizeOpt === (prefs.ctlSize || "md"))
        );
      });
      menuEl.querySelectorAll("[data-scale-opt]").forEach(function (b) {
        b.setAttribute(
          "aria-pressed",
          String(Number(b.dataset.scaleOpt) === Number(prefs.scale))
        );
      });

      /* Notify SDL2/Emscripten canvas of layout change */
      requestAnimationFrame(function () {
        window.dispatchEvent(new Event("resize"));
      });
    }

    /* Menu Open / Close */
    var menuOpen = false;
    function setMenuOpen(open) {
      menuOpen = !!open;
      menuEl.classList.toggle("open", menuOpen);
      backdropEl.classList.toggle("open", menuOpen);
      btnMenu.setAttribute("aria-expanded", String(menuOpen));
      if (menuOpen) {
        releaseAllInputs();
        topbar.classList.remove("idle");
      } else {
        resetIdleTimer();
      }
    }

    /* Topbar Idle Auto-Hide (3s) */
    var idleTimer = 0;
    function resetIdleTimer() {
      topbar.classList.remove("idle");
      clearTimeout(idleTimer);
      if (!menuOpen) {
        idleTimer = setTimeout(function () {
          if (!menuOpen && resolveMode() === "fullscreen") {
            topbar.classList.add("idle");
          }
        }, 3000);
      }
    }

    ["pointermove", "pointerdown", "touchstart", "keydown"].forEach(function (ev) {
      window.addEventListener(ev, resetIdleTimer, { passive: true });
    });

    /* Native Fullscreen Toggle */
    function toggleFullscreen() {
      var req = root.requestFullscreen || root.webkitRequestFullscreen;
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (isNativeFullscreen()) {
        if (exit) exit.call(document).catch(function () {});
      } else if (req) {
        var p = req.call(root, { navigationUI: "hide" });
        if (p && p.then) {
          p.then(function () {
            if (
              isTouchEnvironment() &&
               resolveMode() !== "gameboy" &&
              screen.orientation &&
              screen.orientation.lock
            ) {
              screen.orientation.lock("landscape").catch(function () {});
            }
          }).catch(function () {});
        }
      }
    }

    document.addEventListener("fullscreenchange", applyState);
    document.addEventListener("webkitfullscreenchange", applyState);

    var orientMedia =
      window.matchMedia && window.matchMedia("(orientation: portrait)");
    if (orientMedia) {
      if (orientMedia.addEventListener) {
        orientMedia.addEventListener("change", applyState);
      } else if (orientMedia.addListener) {
        orientMedia.addListener(applyState);
      }
    }

    /* Button Listeners */
    function toggleControls() {
      var next = resolveControls() === "on" ? "off" : "on";
      prefs.controls = next;
      savePrefs();
      applyState();
    }

    function togglePerf() {
      prefs.showPerf = !prefs.showPerf;
      savePrefs();
      applyState();
    }

    function toggleSound() {
      prefs.muted = !prefs.muted;
      savePrefs();
      applyState();
      if (config.onMuteChange) config.onMuteChange(prefs.muted);
    }

    btnControls.addEventListener("click", toggleControls);
    menuControls.addEventListener("click", toggleControls);
    btnPerf.addEventListener("click", togglePerf);
    menuPerf.addEventListener("click", togglePerf);
    btnSound.addEventListener("click", toggleSound);
    menuSound.addEventListener("click", toggleSound);
    btnFullscreen.addEventListener("click", toggleFullscreen);

    btnMenu.addEventListener("click", function () {
      setMenuOpen(!menuOpen);
    });
    cleanFab.addEventListener("click", function () {
      setMenuOpen(!menuOpen);
    });
    menuClose.addEventListener("click", function () {
      setMenuOpen(false);
    });
    backdropEl.addEventListener("click", function () {
      setMenuOpen(false);
    });

    menuOpacity.addEventListener("input", function () {
      prefs.opacity = Number(menuOpacity.value);
      savePrefs();
      applyState();
    });

    menuHaptics.addEventListener("click", function () {
      prefs.haptics = !prefs.haptics;
      savePrefs();
      applyState();
      if (prefs.haptics) vibrateTap();
    });

    menuEl.querySelectorAll("[data-mode-opt]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        prefs.mode = btn.dataset.modeOpt;
        savePrefs();
        applyState();
      });
    });

    menuEl.querySelectorAll("[data-size-opt]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        prefs.ctlSize = btn.dataset.sizeOpt;
        savePrefs();
        applyState();
      });
    });

    menuEl.querySelectorAll("[data-scale-opt]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var s = Number(btn.dataset.scaleOpt);
        prefs.scale = s;
        savePrefs();
        applyState();
        if (config.onScaleChange) config.onScaleChange(s);
      });
    });

    var exportBtn = document.getElementById("mcd-btn-export-saves");
    if (exportBtn && config.onExportSaves) {
      exportBtn.addEventListener("click", function () {
        config.onExportSaves();
      });
    }
    var importBtn = document.getElementById("mcd-btn-import-saves");
    if (importBtn && config.onImportSaves) {
      importBtn.addEventListener("click", function () {
        config.onImportSaves();
      });
    }

    /* Global Keyboard Shortcuts (§3.3) */
    window.addEventListener("keydown", function (e) {
      if (e._mcdSynthetic || !e.isTrusted) return;
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      var tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.code === "Escape") {
        if (config.isExternalModalOpen && config.isExternalModalOpen()) return;
        e.preventDefault();
        setMenuOpen(!menuOpen);
      } else if (e.code === "KeyF") {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.code === "KeyH") {
        e.preventDefault();
        toggleControls();
      } else if (e.code === "KeyO") {
        e.preventDefault();
        togglePerf();
      }
    });

    /* Loading & Status API */
    var loadingHidden = false;
    function hideLoading() {
      if (loadingHidden) return;
      if (config.requireCrossOriginIsolated && !window.crossOriginIsolated) return;
      loadingHidden = true;
      loadingEl.classList.add("hidden");
    }

    function setStatus(text) {
      if (!text) {
        hideLoading();
        return;
      }
      var m = /\((\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\)/.exec(text);
      if (m) {
        var cur = Number(m[1]);
        var tot = Number(m[2]);
        var pct = tot > 0 ? Math.min(100, Math.round((100 * cur) / tot)) : 0;
        loadingBarEl.classList.remove("indeterminate");
        loadingFillEl.style.width = pct + "%";
        if (tot > 1048576) {
          loadingStatusEl.textContent =
            "Baixando dados… " +
            (cur / 1048576).toFixed(1) +
            " / " +
            (tot / 1048576).toFixed(1) +
            " MB (" +
            pct +
            "%)";
        } else {
          loadingStatusEl.textContent = "Carregando… " + pct + "%";
        }
      } else {
        var clean = text
          .replace(/^Downloading data\.{0,3}/i, "Baixando dados do jogo…")
          .replace(/^Downloading\.{0,3}/i, "Baixando…")
          .replace(/^Loading\.{0,3}/i, "Carregando…")
          .replace(/^Preparing\.{0,3}/i, "Preparando…")
          .replace(/^Running\.{0,3}/i, "Em execução");
        loadingStatusEl.textContent = clean;
      }
    }

    function setPerfText(text) {
      if (perfEl) perfEl.textContent = text;
    }

    /* Built-in FPS counter if autoFps is enabled */
    if (config.autoFps) {
      var afFrames = 0;
      var afLast = performance.now();
      function tickFps(now) {
        afFrames++;
        if (now - afLast >= 1000) {
          var fps = Math.round((1000 * afFrames) / (now - afLast));
          setPerfText(fps + " FPS");
          afFrames = 0;
          afLast = now;
        }
        requestAnimationFrame(tickFps);
      }
      requestAnimationFrame(tickFps);
    }

    /* Dentro do app MemoryCard (iframe do player): a seta de voltar fecha o player do app em vez de
       navegar o iframe para o catálogo, e o app fica sabendo que o jogo carregou. */
    var embedded = false;
    try {
      embedded = window.parent !== window;
    } catch (e) {
      embedded = true;
    }
    if (embedded) {
      var backLink = topbar.querySelector("a.mcd-icon-btn");
      if (backLink) {
        backLink.setAttribute("title", "Voltar ao app");
        backLink.setAttribute("aria-label", "Voltar ao app");
        backLink.addEventListener("click", function (ev) {
          ev.preventDefault();
          window.parent.postMessage({ type: "mcd-player:close", id: config.id || "" }, "*");
        });
      }
      window.parent.postMessage({ type: "mcd-player:ready", id: config.id || "" }, "*");
    }

    /* Initial state sync */
    applyState();
    resetIdleTimer();
    if (config.onMuteChange) config.onMuteChange(prefs.muted);
    if (config.onScaleChange) config.onScaleChange(prefs.scale);

    return {
      getTouchPad: function () {
        return touchPad;
      },
      getScale: function () {
        return prefs.scale;
      },
      isMuted: function () {
        return !!prefs.muted;
      },
      setScale: function (s) {
        prefs.scale = Number(s);
        savePrefs();
        applyState();
      },
      setStatus: setStatus,
      hideLoading: hideLoading,
      setPerfText: setPerfText,
      appendLog: appendLog,
      notify: notify,
      releaseAllInputs: releaseAllInputs,
      dispatchSyntheticKey: function (type, keyId) {
        if (N64_KEYMAP[keyId]) {
          dispatchSyntheticKey(type, N64_KEYMAP[keyId], canvas);
        }
      }
    };
  }

  window.MCDPlayer = {
    init: init,
    N64_KEYMAP: N64_KEYMAP
  };
})();
