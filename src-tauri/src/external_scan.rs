//! Varredura de ports e emuladores que o usuário já tinha instalado ANTES do MemoryCard (fora das nossas
//! pastas recomps/ e emulators/): Downloads, Área de Trabalho, Documentos, Jogos, Program Files,
//! %LOCALAPPDATA%\Programs, /Applications, ~/Applications, /opt… mais as pastas de biblioteca do usuário.
//!
//! O front manda os candidatos do catálogo (nomes de executável conhecidos e "chaves" de nome: repositório,
//! id, executável sem extensão) e recebe o melhor executável achado para cada um. Nada é alterado aqui:
//! vincular é outro comando (ports_manager / emulators_manager), sempre com a confirmação do usuário.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Deserialize, Debug, Clone)]
pub struct ExternalCandidate {
    pub id: String,
    /// "port" | "emulator"
    pub kind: String,
    /// Nomes exatos de executável (ex.: "Dolphin.exe", "pcsx2-qt.exe", "Zelda64Recompiled.exe").
    #[serde(default)]
    pub exe_names: Vec<String>,
    /// Nomes do projeto que costumam aparecer no executável ou na pasta (ex.: "Zelda64Recomp", "SpeedBreaker").
    #[serde(default)]
    pub keys: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct ExternalMatch {
    pub id: String,
    pub kind: String,
    pub executable_path: String,
    pub install_dir: String,
    /// 100 = nome exato do executável; 80 = executável começa com o nome do projeto; 60 = só a pasta.
    pub score: u32,
    /// Por que casou (mostrado ao usuário antes de vincular).
    pub reason: String,
}

const MAX_DEPTH: usize = 5;
const MAX_ENTRIES: usize = 250_000;
const TIME_BUDGET: Duration = Duration::from_secs(25);
const MIN_KEY_LEN: usize = 6;

/// Palavras que não identificam um jogo sozinhas ("recomp", "launcher"…): nunca viram chave.
const GENERIC_KEYS: &[&str] = &[
    "recomp", "recompiled", "decomp", "native", "nativeport", "pcport", "android", "windows", "launcher", "release",
    "portable", "installer", "setup", "client", "server", "engine", "source", "sourceport", "remake", "remastered",
    "game", "games", "project", "update", "updater", "x86_64", "x64", "arm64", "linux", "macos",
    // nomes de arquivo de release que não dizem o jogo ("install.exe", "CONFIG.EXE")
    "config", "configure", "install", "settings", "launch", "start", "play", "main", "data", "tools", "binary",
];

/// Pastas que nunca têm jogo e custam caro para percorrer.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", ".svn", "windows", "$recycle.bin", "system volume information", "programdata",
    "appdata", "library", ".cache", ".npm", ".cargo", ".rustup", "site-packages", "__pycache__", "winsxs",
    "microsoft", "common files", "windowsapps", "package cache", "nvidia corporation", "intel", "amd",
    "steamapps", "shadercache", "temp", "tmp", ".gradle", "android studio", "sdk", "jdk", "go", "python",
    "memorycard",
    // programas do sistema e de desenvolvimento (Program Files): nunca são jogo
    "git", "windows defender", "windows nt", "windowspowershell", "internet explorer", "dotnet", "nodejs",
    "microsoft office", "windows kits", "reference assemblies", "msbuild", "iis express", "windows mail",
    "windows media player", "windows photo viewer", "windows portable devices", "windows security",
    "windows sidebar", "modifiablewindowsapps", "microsoft visual studio", "microsoft sdks", "dotnet-sdk",
];

/// Executáveis que estão em toda pasta de jogo mas não são o jogo.
fn is_helper_exe(stem: &str) -> bool {
    let s = stem;
    s.starts_with("unins")
        || s.starts_with("setup")
        || s.starts_with("vc_redist")
        || s.starts_with("vcredist")
        || s.starts_with("dxsetup")
        || s.starts_with("crashpad")
        || s.starts_with("crashhandler")
        || s.starts_with("crashreport")
        || s.starts_with("updater")
        || s.starts_with("update")
        || s.starts_with("installer")
        || s.ends_with("installer")
        || s.ends_with("uninstall")
        || s == "notification_helper"
        || s == "elevate"
        || s == "7z"
        || s == "unrar"
        || s.starts_with("ffmpeg")
        || s.starts_with("ffprobe")
        || s.starts_with("vulkaninfo")
        || s.starts_with("extractxiso")
        || s.starts_with("dxwebsetup")
}

pub fn normalize(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

fn strip_exe_ext(name: &str) -> &str {
    let lower = name.to_ascii_lowercase();
    for ext in [".exe", ".appimage", ".app", ".x86_64", ".sh"] {
        if lower.ends_with(ext) {
            return &name[..name.len() - ext.len()];
        }
    }
    name
}

/// Raízes da varredura neste sistema (só as que existem), mais as pastas extras do usuário.
pub fn default_roots(extra: &[String]) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let home = dirs_home();
    if let Some(h) = &home {
        for sub in ["Downloads", "Desktop", "Documents", "Games", "Jogos", "Área de Trabalho", "Documentos", "Emulators", "Emuladores"] {
            roots.push(h.join(sub));
        }
    }
    #[cfg(target_os = "windows")]
    {
        for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Ok(p) = std::env::var(var) {
                roots.push(PathBuf::from(p));
            }
        }
        if let Ok(p) = std::env::var("LOCALAPPDATA") {
            roots.push(PathBuf::from(&p).join("Programs"));
        }
        if let Ok(p) = std::env::var("OneDrive") {
            roots.push(PathBuf::from(&p).join("Desktop"));
            roots.push(PathBuf::from(&p).join("Documents"));
        }
        // pastas de jogos/emuladores na raiz de cada disco (C:\Games, D:\Emuladores, D:\RetroArch…)
        for letter in b'C'..=b'H' {
            let drive = PathBuf::from(format!("{}:\\", letter as char));
            if !drive.exists() {
                continue;
            }
            for sub in ["Games", "Jogos", "Emulators", "Emuladores", "Emulation", "Recomps", "Ports", "RetroArch", "RetroArch-Win64"] {
                roots.push(drive.join(sub));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        roots.push(PathBuf::from("/Applications"));
        if let Some(h) = &home {
            roots.push(h.join("Applications"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        roots.push(PathBuf::from("/opt"));
        if let Some(h) = &home {
            roots.push(h.join("Applications"));
            roots.push(h.join(".local").join("bin"));
            roots.push(h.join(".local").join("share").join("applications"));
        }
    }
    for e in extra {
        roots.push(PathBuf::from(e));
    }
    let mut seen = HashSet::new();
    roots
        .into_iter()
        .filter(|r| r.is_dir())
        .filter(|r| seen.insert(normalize(&r.to_string_lossy())))
        .collect()
}

fn dirs_home() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

/// Um arquivo (ou pacote .app) que pode ser o executável de um jogo neste sistema.
fn launchable(path: &Path, is_dir: bool) -> bool {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_ascii_lowercase();
    if is_dir {
        return cfg!(target_os = "macos") && name.ends_with(".app");
    }
    #[cfg(target_os = "windows")]
    {
        name.ends_with(".exe")
    }
    #[cfg(target_os = "linux")]
    {
        if name.ends_with(".appimage") || name.ends_with(".x86_64") {
            return true;
        }
        if name.contains('.') {
            return false;
        }
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(target_os = "macos")]
    {
        // no Mac o jogo é o pacote .app (tratado acima como pasta)
        let _ = name;
        false
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = name;
        false
    }
}

/// Pedaços do nome do projeto (≥ 4 letras, não genéricos): "simpsons-game-recomp" → ["simpsons"].
fn tokens_of(c: &ExternalCandidate) -> Vec<String> {
    let generic: HashSet<&str> = GENERIC_KEYS.iter().copied().collect();
    let mut out: Vec<String> = Vec::new();
    for s in std::iter::once(&c.id).chain(c.keys.iter()) {
        for t in s.split(|ch: char| !ch.is_ascii_alphanumeric()) {
            let t = t.to_ascii_lowercase();
            if t.len() >= 4 && !generic.contains(t.as_str()) && !out.contains(&t) {
                out.push(t);
            }
        }
    }
    out
}

struct Index {
    /// nome exato (minúsculo) → candidatos
    exact: HashMap<String, Vec<usize>>,
    /// chaves normalizadas (≥ MIN_KEY_LEN, não genéricas) → candidatos
    keys: Vec<(String, usize)>,
}

fn build_index(cands: &[ExternalCandidate]) -> Index {
    let generic: HashSet<&str> = GENERIC_KEYS.iter().copied().collect();
    let mut exact: HashMap<String, Vec<usize>> = HashMap::new();
    let mut keys: Vec<(String, usize)> = Vec::new();
    for (i, c) in cands.iter().enumerate() {
        let mut ks: HashSet<String> = HashSet::new();
        for e in &c.exe_names {
            let base = Path::new(e).file_name().and_then(|n| n.to_str()).unwrap_or(e);
            if base.is_empty() || base.starts_with("android:") {
                continue;
            }
            exact.entry(base.to_ascii_lowercase()).or_default().push(i);
            ks.insert(normalize(strip_exe_ext(base)));
        }
        for k in &c.keys {
            ks.insert(normalize(k));
        }
        for k in ks {
            if k.len() >= MIN_KEY_LEN && !generic.contains(k.as_str()) {
                keys.push((k, i));
            }
        }
    }
    // chave mais longa primeiro: "zelda64recompiled" ganha de "zelda64recomp" quando os dois existem
    keys.sort_by(|a, b| b.0.len().cmp(&a.0.len()));
    Index { exact, keys }
}

fn best_key(idx: &Index, text: &str) -> Option<(usize, String)> {
    idx.keys.iter().find(|(k, _)| text.starts_with(k.as_str())).map(|(k, i)| (*i, k.clone()))
}

/// Varre as raízes e devolve o melhor executável para cada candidato (no máximo um por id).
pub fn scan(cands: &[ExternalCandidate], roots: &[PathBuf], exclude: &[PathBuf]) -> Vec<ExternalMatch> {
    let idx = build_index(cands);
    let skip: HashSet<&str> = SKIP_DIRS.iter().copied().collect();
    let exclude_norm: Vec<String> = exclude.iter().map(|p| normalize(&p.to_string_lossy())).collect();
    let started = Instant::now();
    let mut visited = 0usize;
    // (match, desempate): no casamento pela pasta, o .exe com o nome do jogo e maior ganha (não o ffmpeg.exe)
    let mut best: HashMap<usize, (ExternalMatch, (bool, u64))> = HashMap::new();
    let tokens: Vec<Vec<String>> = cands.iter().map(tokens_of).collect();

    let mut stack: Vec<(PathBuf, usize)> = roots.iter().map(|r| (r.clone(), 0)).collect();
    while let Some((dir, depth)) = stack.pop() {
        if visited > MAX_ENTRIES || started.elapsed() > TIME_BUDGET {
            break;
        }
        let dir_norm = normalize(&dir.to_string_lossy());
        if exclude_norm.iter().any(|e| !e.is_empty() && dir_norm.starts_with(e.as_str())) {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let dir_name = normalize(dir.file_name().and_then(|n| n.to_str()).unwrap_or_default());
        for entry in rd.flatten() {
            visited += 1;
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let lname = name.to_ascii_lowercase();
            let is_dir = ft.is_dir();
            if launchable(&path, is_dir) {
                let stem = normalize(strip_exe_ext(&name));
                if stem.is_empty() || is_helper_exe(&stem) {
                    continue;
                }
                let mut hit: Option<(usize, u32, String)> = None;
                if let Some(ids) = idx.exact.get(&lname) {
                    hit = Some((ids[0], 100, format!("executável {}", name)));
                } else if let Some((i, _)) = best_key(&idx, &stem) {
                    hit = Some((i, 80, format!("executável {}", name)));
                } else if let Some((i, _)) = best_key(&idx, &dir_name) {
                    hit = Some((i, 60, format!("pasta {}", dir.file_name().and_then(|n| n.to_str()).unwrap_or_default())));
                }
                if let Some((i, score, reason)) = hit {
                    let cand = &cands[i];
                    let m = ExternalMatch {
                        id: cand.id.clone(),
                        kind: cand.kind.clone(),
                        executable_path: path.to_string_lossy().to_string(),
                        install_dir: dir.to_string_lossy().to_string(),
                        score,
                        reason,
                    };
                    let named = tokens[i].iter().any(|t| stem.contains(t.as_str()));
                    let size = if is_dir { 0 } else { entry.metadata().map(|md| md.len()).unwrap_or(0) };
                    let rank = (named, size);
                    let better = match best.get(&i) {
                        None => true,
                        Some((prev, prank)) => {
                            score > prev.score
                                || (score == prev.score && prev.install_dir == m.install_dir && rank > *prank)
                                || (score == prev.score && prev.install_dir != m.install_dir && m.executable_path.len() < prev.executable_path.len())
                        }
                    };
                    if better {
                        best.insert(i, (m, rank));
                    }
                }
                if is_dir {
                    continue; // não entra no pacote .app
                }
            } else if is_dir && depth < MAX_DEPTH && !lname.starts_with('.') && !skip.contains(lname.as_str()) {
                stack.push((path, depth + 1));
            }
        }
    }
    let mut out: Vec<ExternalMatch> = best.into_values().map(|(m, _)| m).collect();
    out.sort_by(|a, b| b.score.cmp(&a.score).then(a.id.cmp(&b.id)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(id: &str, kind: &str, exe: &[&str], keys: &[&str]) -> ExternalCandidate {
        ExternalCandidate {
            id: id.into(),
            kind: kind.into(),
            exe_names: exe.iter().map(|s| s.to_string()).collect(),
            keys: keys.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn finds_ports_and_emulators_outside_the_app() {
        let tmp = std::env::temp_dir().join(format!("mc-extscan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        // port baixado e extraído no Downloads, com o nome do repositório só no executável
        touch(&tmp.join("Downloads").join("MM-v1.2-Windows").join("Zelda64Recompiled.exe"));
        touch(&tmp.join("Downloads").join("MM-v1.2-Windows").join("unins000.exe"));
        // emulador instalado com o nome exato do executável
        touch(&tmp.join("Program Files").join("Dolphin-x64").join("Dolphin.exe"));
        // só a pasta tem o nome do projeto
        touch(&tmp.join("Games").join("SpeedBreaker-1.0").join("ffmpeg.exe"));
        std::fs::write(tmp.join("Games").join("SpeedBreaker-1.0").join("game.exe"), vec![0u8; 4096]).unwrap();
        touch(&tmp.join("Games").join("SpeedBreaker-1.0").join("tool.exe"));
        // pasta gerenciada pelo app: não pode aparecer
        touch(&tmp.join("App").join("recomps").join("x").join("Zelda64Recompiled.exe"));
        // genérico: "recomp" sozinho não casa nada
        touch(&tmp.join("Downloads").join("recomp.exe"));

        let cands = vec![
            cand("zelda64recomp", "port", &[], &["Zelda64Recomp", "recomp"]),
            cand("dolphin", "emulator", &["Dolphin.exe"], &["dolphin"]),
            cand("speedbreaker", "port", &[], &["SpeedBreaker"]),
            cand("nada", "port", &[], &["xyzxyzxyz"]),
        ];
        let roots = vec![tmp.join("Downloads"), tmp.join("Program Files"), tmp.join("Games"), tmp.join("App")];
        let found = scan(&cands, &roots, &[tmp.join("App").join("recomps")]);
        let by: HashMap<_, _> = found.iter().map(|m| (m.id.as_str(), m)).collect();
        assert_eq!(by["dolphin"].score, 100);
        assert!(by["zelda64recomp"].executable_path.ends_with("Zelda64Recompiled.exe"));
        assert!(!by["zelda64recomp"].executable_path.contains("recomps"));
        assert_eq!(by["speedbreaker"].score, 60);
        assert!(by["speedbreaker"].executable_path.ends_with("game.exe"), "{}", by["speedbreaker"].executable_path);
        assert!(!by.contains_key("nada"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn generic_and_short_keys_are_ignored() {
        let idx = build_index(&[cand("a", "port", &[], &["recomp", "smw", "Launcher"])]);
        assert!(idx.keys.is_empty());
    }
}
