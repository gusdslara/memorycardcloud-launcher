//! Identifies game files and game folders: platform, format, serial / game id, region, title.
//!
//! Detection order: magic bytes / headers (exact) → file extension (when unambiguous) →
//! names of the parent folders ("PS2", "GameCube"…) → nothing. Every check reads only a few
//! KB at known offsets, so identifying a 40 GB image is as fast as a 4 MB ROM.
//!
//! Everything here is pure (no Tauri), so it is covered by unit tests with synthetic buffers.

use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntryInfo {
    pub name: String,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct IdentifiedFile {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    /// lower-case extension without dot ("" for folders)
    pub extension: String,
    /// platform id (n64, ps2, xbox360…) or None when unknown
    pub platform: Option<String>,
    /// header | extension | folder | filename | none
    pub confidence: String,
    /// iso, rvz, chd, cue, nsp, xex-folder, god, zip…
    pub format: String,
    /// disc | compressed | cartridge | folder | archive | package | bios | data | other
    pub format_kind: String,
    /// Title cleaned from the file name (No-Intro / Redump tags removed)
    pub title: String,
    /// Title read from the header, when the format has one
    pub header_title: Option<String>,
    /// Game id / serial (GALE01, SLUS-20062, 4D5307E6, 0100ABCD…)
    pub serial: Option<String>,
    /// Canonical region names (USA, Europe, Japan, World, Region Free…)
    pub regions: Vec<String>,
    /// filename | serial | header
    pub region_source: Option<String>,
    pub languages: Vec<String>,
    pub disc: Option<u32>,
    pub revision: Option<String>,
    /// beta, demo, proto, hack, translation, bad-dump, verified, update, dlc, encrypted, nkit…
    pub flags: Vec<String>,
    /// Files that must travel together with this one (cue → bins, gdi → tracks)
    pub companions: Vec<String>,
    /// For archives: the entries inside (first 200)
    pub archive_entries: Vec<ArchiveEntryInfo>,
    /// Human notes (pt-BR) shown in the review table
    pub notes: Vec<String>,
    pub is_bios: bool,
}

// ---------------------------------------------------------------------------
// Small byte helpers
// ---------------------------------------------------------------------------

fn read_at(f: &mut File, offset: u64, len: usize) -> Option<Vec<u8>> {
    f.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = vec![0u8; len];
    let mut got = 0;
    while got < len {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(_) => return None,
        }
    }
    if got == 0 {
        return None;
    }
    buf.truncate(got);
    Some(buf)
}

fn u16_le(b: &[u8], o: usize) -> Option<u16> {
    b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
}
fn u32_le(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o + 4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}
fn u32_be(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}
fn u64_be(b: &[u8], o: usize) -> Option<u64> {
    b.get(o..o + 8).map(|s| {
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        u64::from_be_bytes(a)
    })
}
fn u64_le(b: &[u8], o: usize) -> Option<u64> {
    b.get(o..o + 8).map(|s| {
        let mut a = [0u8; 8];
        a.copy_from_slice(s);
        u64::from_le_bytes(a)
    })
}

/// ASCII text from a fixed-size header field (stops at NUL, trims spaces).
fn ascii_field(b: &[u8], o: usize, len: usize) -> Option<String> {
    let s = b.get(o..o + len)?;
    let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
    let txt: String = s[..end]
        .iter()
        .map(|&c| if (0x20..0x7f).contains(&c) { c as char } else { ' ' })
        .collect();
    let t = txt.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

fn utf16_field(b: &[u8], o: usize, max_chars: usize, big_endian: bool) -> Option<String> {
    let mut units = Vec::new();
    for i in 0..max_chars {
        let p = o + i * 2;
        let Some(s) = b.get(p..p + 2) else { break };
        let u = if big_endian { u16::from_be_bytes([s[0], s[1]]) } else { u16::from_le_bytes([s[0], s[1]]) };
        if u == 0 {
            break;
        }
        units.push(u);
    }
    let s = String::from_utf16_lossy(&units).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn is_alnum_ascii(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric())
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

/// pt-BR label for a platform id (the frontend has its own copy with icons and categories).
pub fn platform_label(id: &str) -> &'static str {
    match id {
        "n64" => "Nintendo 64",
        "snes" => "Super Nintendo",
        "nes" => "NES",
        "fds" => "Famicom Disk System",
        "gb" => "Game Boy",
        "gbc" => "Game Boy Color",
        "gba" => "Game Boy Advance",
        "nds" => "Nintendo DS",
        "3ds" => "Nintendo 3DS",
        "gamecube" => "GameCube",
        "wii" => "Wii",
        "wiiu" => "Wii U",
        "switch" => "Nintendo Switch",
        "ps1" => "PlayStation",
        "ps2" => "PlayStation 2",
        "ps3" => "PlayStation 3",
        "ps4" => "PlayStation 4",
        "psp" => "PSP",
        "psvita" => "PS Vita",
        "xbox" => "Xbox",
        "xbox360" => "Xbox 360",
        "genesis" => "Mega Drive / Genesis",
        "segacd" => "Sega CD",
        "sega32x" => "32X",
        "saturn" => "Sega Saturn",
        "dreamcast" => "Dreamcast",
        "sms" => "Master System",
        "gamegear" => "Game Gear",
        "pce" => "PC Engine",
        "arcade" => "Arcade",
        "atari2600" => "Atari 2600",
        "lynx" => "Atari Lynx",
        "jaguar" => "Atari Jaguar",
        "ngp" => "Neo Geo Pocket",
        "wonderswan" => "WonderSwan",
        "virtualboy" => "Virtual Boy",
        "pc" => "PC",
        _ => "Desconhecida",
    }
}

/// Extensions that alone say which platform a file is for.
fn platform_from_extension(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "z64" | "n64" | "v64" => "n64",
        "sfc" | "smc" => "snes",
        "nes" | "unf" => "nes",
        "fds" => "fds",
        "gb" => "gb",
        "gbc" => "gbc",
        "gba" => "gba",
        "nds" | "dsi" => "nds",
        "3ds" | "cci" | "cxi" | "cia" | "3dsx" => "3ds",
        "nsp" | "nsz" | "xci" | "xcz" => "switch",
        "wud" | "wux" | "wua" | "rpx" => "wiiu",
        "wbfs" => "wii",
        "gcm" => "gamecube",
        "pbp" => "psp",
        "cso" | "zso" => "psp",
        "vpk" => "psvita",
        "gdi" | "cdi" => "dreamcast",
        "md" | "gen" | "smd" => "genesis",
        "32x" => "sega32x",
        "sms" => "sms",
        "gg" => "gamegear",
        "pce" => "pce",
        "xex" => "xbox360",
        "xbe" => "xbox",
        "a26" => "atari2600",
        "lnx" => "lynx",
        "j64" => "jaguar",
        "ngp" | "ngc" => "ngp",
        "ws" | "wsc" => "wonderswan",
        "vb" => "virtualboy",
        "mpq" | "rsdk" | "wad" | "pak" | "agg" | "esm" | "grp" => "pc",
        _ => return None,
    })
}

/// File extensions the organizer cares about (game images, ROMs, packages, archives).
pub const GAME_EXTENSIONS: &[&str] = &[
    "z64", "n64", "v64", "sfc", "smc", "nes", "unf", "fds", "gb", "gbc", "gba", "nds", "dsi", "3ds", "cci", "cxi", "cia",
    "3dsx", "nsp", "nsz", "xci", "xcz", "wud", "wux", "wua", "rpx", "wbfs", "gcm", "rvz", "wia", "gcz", "ciso", "iso",
    "bin", "img", "cue", "chd", "cso", "zso", "pbp", "vpk", "gdi", "cdi", "md", "gen", "smd", "32x", "sms", "gg", "pce",
    "xex", "xbe", "a26", "lnx", "j64", "ngp", "ngc", "ws", "wsc", "vb", "pkg", "mdf", "ecm", "zip", "7z", "rar", "mpq",
    "rsdk",
];

pub fn is_game_extension(ext: &str) -> bool {
    GAME_EXTENSIONS.contains(&ext)
}

const BIOS_HINTS: &[(&str, &str)] = &[
    ("prod.keys", "switch"),
    ("title.keys", "switch"),
    ("ps3updat.pup", "ps3"),
    ("psp2updat.pup", "psvita"),
    ("dc_boot.bin", "dreamcast"),
    ("dc_flash.bin", "dreamcast"),
    ("dc_bios.bin", "dreamcast"),
    ("gba_bios.bin", "gba"),
    ("bios7.bin", "nds"),
    ("bios9.bin", "nds"),
    ("aes_keys.txt", "3ds"),
    ("sega_101.bin", "saturn"),
    ("saturn_bios.bin", "saturn"),
    ("mpr-17933.bin", "saturn"),
    ("neogeo.zip", "arcade"),
    ("keys.txt", "wiiu"),
    ("scph", "ps1"), // refined by size below
    ("ps2-", "ps2"),
    ("ps2_", "ps2"),
    ("ps2bios", "ps2"),
    ("psxbios", "ps1"),
    ("bios_cd_", "segacd"),
];

/// BIOS / firmware / keys by file name. Returns the platform when recognised.
pub fn bios_platform(name_lower: &str, size: u64) -> Option<&'static str> {
    for (needle, plat) in BIOS_HINTS {
        if name_lower.contains(needle) {
            if *needle == "scph" {
                // PS1 BIOS = 512 KB, PS2 BIOS = 4 MB
                return Some(if size >= 2 * 1024 * 1024 { "ps2" } else { "ps1" });
            }
            return Some(plat);
        }
    }
    None
}

/// Folder names that hint at a platform (used only when the file itself is ambiguous).
pub fn platform_from_folder_name(name: &str) -> Option<&'static str> {
    let n: String = name.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    Some(match n.as_str() {
        "ps1" | "psx" | "psone" | "playstation" | "playstation1" => "ps1",
        "ps2" | "playstation2" => "ps2",
        "ps3" | "playstation3" => "ps3",
        "ps4" | "playstation4" => "ps4",
        "psp" => "psp",
        "vita" | "psvita" => "psvita",
        "gc" | "ngc" | "gamecube" => "gamecube",
        "wii" => "wii",
        "wiiu" => "wiiu",
        "switch" | "nintendoswitch" => "switch",
        "xbox" | "xboxoriginal" | "ogxbox" => "xbox",
        "xbox360" | "x360" | "360" => "xbox360",
        "dc" | "dreamcast" => "dreamcast",
        "saturn" | "segasaturn" => "saturn",
        "segacd" | "megacd" => "segacd",
        "n64" | "nintendo64" => "n64",
        "snes" | "supernintendo" | "sfc" => "snes",
        "nes" | "famicom" => "nes",
        "gba" => "gba",
        "gbc" => "gbc",
        "gb" | "gameboy" => "gb",
        "nds" | "ds" => "nds",
        "3ds" | "n3ds" => "3ds",
        "genesis" | "megadrive" | "md" => "genesis",
        "arcade" | "mame" | "fbneo" => "arcade",
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

/// Nintendo-style region letter (last char of GC/Wii/N64/GBA/NDS/3DS/Wii U game codes).
pub fn region_from_nintendo_code(c: char) -> Option<&'static str> {
    Some(match c.to_ascii_uppercase() {
        'E' | 'N' | 'T' => "USA",
        'P' | 'X' | 'Y' | 'Z' | 'L' | 'M' | 'V' => "Europe",
        'J' => "Japan",
        'K' | 'Q' => "Korea",
        'D' => "Germany",
        'F' => "France",
        'S' => "Spain",
        'I' => "Italy",
        'H' => "Netherlands",
        'U' => "Australia",
        'W' => "Taiwan",
        'C' => "China",
        'R' => "Russia",
        'B' => "Brazil",
        'A' => "World",
        _ => return None,
    })
}

/// Region from a Sony serial prefix (PS1/PS2/PS3/PSP/Vita) or a PSN content id.
pub fn region_from_sony_serial(serial: &str) -> Option<&'static str> {
    let s = serial.to_uppercase();
    let p: String = s.chars().take(4).collect();
    let r = match p.as_str() {
        "SLUS" | "SCUS" | "LSP0" => "USA",
        "SLES" | "SCES" | "SCED" | "SLED" => "Europe",
        "SLPS" | "SLPM" | "SCPS" | "SCPM" | "SIPS" | "SLAJ" | "SCAJ" | "PAPX" => "Japan",
        "SLKA" | "SCKA" => "Korea",
        "ULUS" | "UCUS" | "NPUH" | "NPUG" | "NPUZ" | "BLUS" | "BCUS" | "NPUB" | "NPUA" | "PCSA" | "PCSE" => "USA",
        "ULES" | "UCES" | "NPEH" | "NPEG" | "NPEZ" | "BLES" | "BCES" | "NPEB" | "NPEA" | "PCSB" | "PCSF" => "Europe",
        "ULJS" | "ULJM" | "UCJS" | "UCJM" | "NPJH" | "NPJG" | "BLJS" | "BLJM" | "BCJS" | "BCJM" | "NPJB" | "NPJA"
        | "PCSG" | "PCSC" => "Japan",
        "ULAS" | "UCAS" | "NPHH" | "BLAS" | "BCAS" | "NPHB" | "PCSH" | "PCSD" => "Asia",
        "ULKS" | "UCKS" | "NPKH" | "BLKS" | "BCKS" | "NPKB" => "Korea",
        _ => return None,
    };
    Some(r)
}

/// Region from a PSN content id ("UP0001-CUSA00001_00-…": first letter).
pub fn region_from_content_id(cid: &str) -> Option<&'static str> {
    Some(match cid.chars().next()?.to_ascii_uppercase() {
        'U' => "USA",
        'E' => "Europe",
        'J' => "Japan",
        'H' => "Asia",
        'K' => "Korea",
        _ => return None,
    })
}

/// Xbox 360 XEX "game regions" bitmask → regions.
pub fn regions_from_xex_mask(mask: u32) -> Vec<String> {
    if mask == 0xFFFF_FFFF || mask & 0x00FF_FFFF == 0x00FF_FFFF {
        return vec!["Region Free".into()];
    }
    let mut out = Vec::new();
    if mask & 0x0000_00FF != 0 {
        out.push("USA".into());
    }
    if mask & 0x0000_0100 != 0 {
        out.push("Japan".into());
    }
    if mask & 0x0000_0200 != 0 {
        out.push("China".into());
    }
    if mask & 0x0000_FC00 != 0 {
        out.push("Asia".into());
    }
    if mask & 0x00FF_0000 != 0 {
        out.push("Europe".into());
    }
    out
}

/// Original Xbox XBE certificate region bits.
pub fn regions_from_xbe_mask(mask: u32) -> Vec<String> {
    let mut out = Vec::new();
    if mask & 0x7 == 0x7 {
        return vec!["Region Free".into()];
    }
    if mask & 1 != 0 {
        out.push("USA".into());
    }
    if mask & 2 != 0 {
        out.push("Japan".into());
    }
    if mask & 4 != 0 {
        out.push("Europe".into());
    }
    out
}

// ---------------------------------------------------------------------------
// File name tags (No-Intro / Redump / GoodTools / scene)
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, PartialEq)]
pub struct NameInfo {
    pub title: String,
    pub regions: Vec<String>,
    pub languages: Vec<String>,
    pub disc: Option<u32>,
    pub revision: Option<String>,
    pub flags: Vec<String>,
    /// Switch title id in brackets, e.g. [0100ABCD12345000]
    pub title_id: Option<String>,
    /// Serial written in the name, e.g. "SLUS-20062" or "[GALE01]"
    pub serial: Option<String>,
}

fn region_word(tok: &str) -> Option<&'static str> {
    let t = tok.trim().to_lowercase();
    Some(match t.as_str() {
        "usa" | "us" | "u" | "ntsc-u" | "ntsc-us" | "ntscu" | "america" => "USA",
        "europe" | "eu" | "eur" | "e" | "pal" | "pal-e" => "Europe",
        "japan" | "jp" | "jpn" | "j" | "ntsc-j" | "ntscj" => "Japan",
        "world" | "w" => "World",
        "brazil" | "br" | "b" | "brasil" => "Brazil",
        "korea" | "kr" | "k" => "Korea",
        "asia" => "Asia",
        "australia" | "au" | "a" => "Australia",
        "china" | "cn" | "ch" => "China",
        "taiwan" | "tw" => "Taiwan",
        "hong kong" | "hk" => "Hong Kong",
        "germany" | "de" | "g" => "Germany",
        "france" | "fr" | "f" => "France",
        "spain" | "es" | "s" => "Spain",
        "italy" | "it" | "i" => "Italy",
        "netherlands" | "nl" | "holland" => "Netherlands",
        "sweden" | "se" => "Sweden",
        "scandinavia" => "Scandinavia",
        "russia" | "ru" => "Russia",
        "canada" | "ca" => "Canada",
        "uk" | "united kingdom" => "UK",
        "latin america" => "Latin America",
        "mexico" => "Mexico",
        "portugal" | "pt" => "Portugal",
        "region free" => "Region Free",
        _ => return None,
    })
}

const LANGS: &[&str] = &[
    "en", "fr", "de", "es", "it", "pt", "pt-br", "ja", "nl", "sv", "no", "da", "fi", "zh", "zh-hans", "zh-hant", "ko",
    "ru", "pl", "ca", "el", "tr", "cs", "hu", "ar",
];

fn is_lang_token(t: &str) -> bool {
    LANGS.contains(&t.trim().to_lowercase().as_str())
}

/// GoodTools compact codes: (JUE), (UE), (JU)…
fn goodtools_combo(tok: &str) -> Option<Vec<&'static str>> {
    let t = tok.trim();
    if t.len() < 2 || t.len() > 4 || !t.chars().all(|c| "JUEWBKAFGSI".contains(c)) {
        return None;
    }
    let mut out = Vec::new();
    for c in t.chars() {
        let r = region_word(&c.to_string())?;
        if !out.contains(&r) {
            out.push(r);
        }
    }
    Some(out)
}

fn push_unique(v: &mut Vec<String>, s: &str) {
    if !v.iter().any(|x| x == s) {
        v.push(s.to_string());
    }
}

/// Parses the tags of a game file name (without extension).
pub fn parse_name_tags(stem: &str) -> NameInfo {
    let mut info = NameInfo::default();
    let mut title = String::new();
    let mut depth_char: Option<char> = None;
    let mut group = String::new();
    let mut groups: Vec<(char, String)> = Vec::new();
    for ch in stem.chars() {
        match (depth_char, ch) {
            (None, '(') | (None, '[') => {
                depth_char = Some(ch);
                group.clear();
            }
            (Some('('), ')') | (Some('['), ']') => {
                groups.push((depth_char.unwrap(), group.clone()));
                depth_char = None;
            }
            (Some(_), c) => group.push(c),
            (None, c) => title.push(c),
        }
    }
    if depth_char.is_some() {
        title.push_str(&group);
    }

    let disc_re = regex::Regex::new(r"(?i)^(?:disc|disk|cd|dvd)\s*([0-9]+)(?:\s*of\s*[0-9]+)?$").unwrap();
    let rev_re = regex::Regex::new(r"(?i)^(?:rev\s*[0-9a-z.]+|v\s?[0-9]+(?:\.[0-9a-z]+)*)$").unwrap();
    let tid_re = regex::Regex::new(r"^(?i)0100[0-9a-f]{12}$").unwrap();
    let sony_re = regex::Regex::new(r"^(?i)[a-z]{4}[-_ ]?[0-9]{3}\.?[0-9]{2}$").unwrap();
    let gc_re = regex::Regex::new(r"^[A-Z0-9]{6}$").unwrap();

    for (kind, g) in &groups {
        let g = g.trim();
        if g.is_empty() {
            continue;
        }
        let lower = g.to_lowercase();
        if kind == &'[' {
            if tid_re.is_match(g) {
                info.title_id = Some(g.to_uppercase());
                continue;
            }
            if lower == "!" {
                push_unique(&mut info.flags, "verified");
                continue;
            }
            if lower.starts_with('b') && lower.len() <= 3 && lower[1..].chars().all(|c| c.is_ascii_digit()) {
                push_unique(&mut info.flags, "bad-dump");
                continue;
            }
            if lower.starts_with('h') && lower.len() <= 4 && lower[1..].chars().all(|c| c.is_ascii_alphanumeric()) && lower != "hk" {
                push_unique(&mut info.flags, "hack");
                continue;
            }
            if lower.starts_with("t+") || lower.starts_with("t-") {
                push_unique(&mut info.flags, "translation");
                continue;
            }
            if lower == "upd" || lower == "update" || lower.starts_with("v") && lower[1..].chars().all(|c| c.is_ascii_digit()) && lower.len() > 2 && lower != "v0" {
                if lower == "upd" || lower == "update" {
                    push_unique(&mut info.flags, "update");
                }
                continue;
            }
            if lower == "dlc" {
                push_unique(&mut info.flags, "dlc");
                continue;
            }
            if lower == "base" || lower == "v0" {
                continue;
            }
            if sony_re.is_match(g) {
                info.serial = Some(normalize_sony_serial(g));
                continue;
            }
            if gc_re.is_match(g) && g.chars().any(|c| c.is_ascii_digit()) && g.chars().any(|c| c.is_ascii_uppercase()) {
                info.serial = Some(g.to_string());
                continue;
            }
            if let Some(r) = region_word(g).filter(|_| g.len() == 2 || g.len() > 3) {
                push_unique(&mut info.regions, r);
                continue;
            }
            continue;
        }

        // ( … ) groups
        if let Some(c) = disc_re.captures(g) {
            info.disc = c.get(1).and_then(|m| m.as_str().parse().ok());
            continue;
        }
        if rev_re.is_match(g) {
            info.revision = Some(g.to_string());
            continue;
        }
        if sony_re.is_match(g) {
            info.serial = Some(normalize_sony_serial(g));
            continue;
        }
        match lower.as_str() {
            "beta" | "proto" | "prototype" | "demo" | "sample" | "kiosk" | "unl" | "pirate" | "aftermarket" => {
                let f = if lower == "prototype" { "proto" } else { lower.as_str() };
                push_unique(&mut info.flags, f);
                continue;
            }
            _ => {}
        }
        if lower.starts_with("beta") || lower.starts_with("proto") || lower.starts_with("demo") {
            push_unique(&mut info.flags, if lower.starts_with("beta") { "beta" } else if lower.starts_with("proto") { "proto" } else { "demo" });
            continue;
        }
        let toks: Vec<&str> = g.split(',').map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
        // In ( ) only full names (USA, Europe, EUR…) or a lone GoodTools letter are regions:
        // two-letter codes there are languages, "(Fr,De)".
        if !toks.is_empty() && toks.iter().all(|t| region_word(t).is_some() && (t.len() > 2 || (t.len() == 1 && toks.len() == 1))) {
            for t in &toks {
                push_unique(&mut info.regions, region_word(t).unwrap());
            }
            continue;
        }
        if toks.len() == 1 {
            if let Some(list) = goodtools_combo(toks[0]) {
                for r in list {
                    push_unique(&mut info.regions, r);
                }
                continue;
            }
        }
        if !toks.is_empty() && toks.iter().all(|t| is_lang_token(t) || t.contains('+') && t.split('+').all(is_lang_token)) {
            for t in toks {
                for l in t.split('+') {
                    let l = l.trim();
                    let norm = if l.len() > 2 { l.to_string() } else {
                        let mut c = l.chars();
                        match c.next() {
                            Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                            None => continue,
                        }
                    };
                    push_unique(&mut info.languages, &norm);
                }
            }
            continue;
        }
    }

    // Scene-style names without brackets: "Game.Name.USA.PS2-GROUP"
    let mut t = title.replace('_', " ");
    if !t.contains(' ') && t.matches('.').count() >= 2 {
        t = t.replace('.', " ");
    }
    let mut t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    t = t.trim_matches(|c: char| c == '-' || c == ' ').to_string();
    // No-Intro puts the article at the end: "Legend of Zelda, The - …" → "The Legend of Zelda - …"
    for art in [", The", ", A", ", An", ", Les", ", Le", ", La", ", Die", ", Der", ", Das", ", O", ", Os"] {
        if let Some(pos) = t.find(art) {
            let after = &t[pos + art.len()..];
            if after.is_empty() || after.starts_with(" -") || after.starts_with(':') {
                t = format!("{} {}{}", &art[2..], &t[..pos], after);
                break;
            }
        }
    }
    info.title = t;
    info
}

/// "SLUS_200.62" / "slus-20062" → "SLUS-20062"
pub fn normalize_sony_serial(s: &str) -> String {
    let up = s.to_uppercase();
    let letters: String = up.chars().filter(|c| c.is_ascii_alphabetic()).take(4).collect();
    let digits: String = up.chars().filter(|c| c.is_ascii_digit()).collect();
    if letters.len() == 4 && !digits.is_empty() {
        format!("{}-{}", letters, digits)
    } else {
        up
    }
}

// ---------------------------------------------------------------------------
// Cartridge headers
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, PartialEq)]
pub struct HeaderInfo {
    pub platform: Option<&'static str>,
    pub format: Option<String>,
    pub title: Option<String>,
    pub serial: Option<String>,
    pub regions: Vec<String>,
    pub flags: Vec<String>,
    pub notes: Vec<String>,
}

impl HeaderInfo {
    fn plat(p: &'static str) -> Self {
        HeaderInfo { platform: Some(p), ..Default::default() }
    }
    fn region(&mut self, r: Option<&str>) {
        if let Some(r) = r {
            push_unique(&mut self.regions, r);
        }
    }
}

/// N64 ROM byte order from the first 4 bytes: z64 (big endian), v64 (byte-swapped), n64 (little endian).
pub fn n64_byte_order(b: &[u8]) -> Option<&'static str> {
    match b.get(0..4)? {
        [0x80, 0x37, 0x12, 0x40] => Some("z64"),
        [0x37, 0x80, 0x40, 0x12] => Some("v64"),
        [0x40, 0x12, 0x37, 0x80] => Some("n64"),
        _ => None,
    }
}

/// Converts N64 ROM bytes in place to big endian (.z64) order.
pub fn n64_to_z64(buf: &mut [u8], order: &str) {
    match order {
        "v64" => {
            for c in buf.chunks_exact_mut(2) {
                c.swap(0, 1);
            }
        }
        "n64" => {
            for c in buf.chunks_exact_mut(4) {
                c.swap(0, 3);
                c.swap(1, 2);
            }
        }
        _ => {}
    }
}

pub fn parse_n64(head: &[u8]) -> Option<HeaderInfo> {
    let order = n64_byte_order(head)?;
    let mut b = head.get(..0x40)?.to_vec();
    n64_to_z64(&mut b, order);
    let mut h = HeaderInfo::plat("n64");
    h.format = Some(order.to_string());
    h.title = ascii_field(&b, 0x20, 20);
    let code = ascii_field(&b, 0x3B, 4).filter(|c| c.len() == 4 && is_alnum_ascii(c));
    if let Some(c) = &code {
        h.region(region_from_nintendo_code(c.chars().last().unwrap()));
        h.serial = Some(c.clone());
    }
    if order != "z64" {
        h.notes.push(format!(
            "ROM em ordem de bytes .{} — a maioria dos ports pede .z64 (big endian). Use \"Converter para .z64\".",
            order
        ));
    }
    Some(h)
}

const NINTENDO_LOGO_START: [u8; 4] = [0x24, 0xFF, 0xAE, 0x51];

pub fn parse_gba(b: &[u8]) -> Option<HeaderInfo> {
    if b.get(0x04..0x08)? != NINTENDO_LOGO_START || *b.get(0xB2)? != 0x96 {
        return None;
    }
    let mut h = HeaderInfo::plat("gba");
    h.title = ascii_field(b, 0xA0, 12);
    if let Some(code) = ascii_field(b, 0xAC, 4).filter(|c| c.len() == 4) {
        h.region(region_from_nintendo_code(code.chars().last().unwrap()));
        h.serial = Some(format!("AGB-{}", code));
    }
    Some(h)
}

pub fn parse_nds(b: &[u8]) -> Option<HeaderInfo> {
    if b.get(0xC0..0xC4)? != NINTENDO_LOGO_START {
        return None;
    }
    let unit = *b.get(0x12)?;
    let mut h = HeaderInfo::plat("nds");
    h.title = ascii_field(b, 0x00, 12);
    if let Some(code) = ascii_field(b, 0x0C, 4).filter(|c| c.len() == 4) {
        h.region(region_from_nintendo_code(code.chars().last().unwrap()));
        h.serial = Some(format!("{}-{}", if unit >= 2 { "TWL" } else { "NTR" }, code));
    }
    if unit == 3 {
        h.flags.push("dsi-only".into());
    }
    Some(h)
}

pub fn parse_gb(b: &[u8]) -> Option<HeaderInfo> {
    if b.get(0x104..0x108)? != [0xCE, 0xED, 0x66, 0x66] {
        return None;
    }
    let cgb = *b.get(0x143)?;
    let mut h = HeaderInfo::plat(if cgb == 0x80 || cgb == 0xC0 { "gbc" } else { "gb" });
    h.title = ascii_field(b, 0x134, if cgb & 0x80 != 0 { 11 } else { 16 });
    h.region(Some(if *b.get(0x14A)? == 0 { "Japan" } else { "World" }));
    Some(h)
}

pub fn parse_snes(b: &[u8], file_size: u64) -> Option<HeaderInfo> {
    let copier = if file_size % 1024 == 512 { 512 } else { 0 };
    for hdr in [0x7FC0usize, 0xFFC0, 0x40FFC0] {
        let o = copier + hdr;
        let (Some(cmp), Some(sum)) = (u16_le(b, o + 0x1C), u16_le(b, o + 0x1E)) else { continue };
        if cmp ^ sum != 0xFFFF || sum == 0 && cmp == 0xFFFF && b.get(o..o + 21).map_or(true, |t| t.iter().all(|&c| c == 0)) {
            continue;
        }
        let title = ascii_field(b, o, 21);
        let mut h = HeaderInfo::plat("snes");
        h.title = title;
        let region = match b.get(o + 0x19)? {
            0 => "Japan",
            1 => "USA",
            2 => "Europe",
            3 => "Sweden",
            6 => "France",
            7 => "Netherlands",
            8 => "Spain",
            9 => "Germany",
            10 => "Italy",
            11 => "China",
            13 => "Korea",
            15 => "Canada",
            16 => "Brazil",
            17 => "Australia",
            _ => "",
        };
        if !region.is_empty() {
            h.region(Some(region));
        }
        if copier > 0 {
            h.notes.push("ROM com cabeçalho de copiadora (512 bytes) — alguns ports pedem a ROM sem ele.".into());
        }
        return Some(h);
    }
    None
}

pub fn parse_genesis(b: &[u8]) -> Option<HeaderInfo> {
    let sys = ascii_field(b, 0x100, 16)?;
    if !sys.starts_with("SEGA") {
        return None;
    }
    let mut h = HeaderInfo::plat(if sys.contains("32X") { "sega32x" } else { "genesis" });
    h.title = ascii_field(b, 0x150, 48).or_else(|| ascii_field(b, 0x120, 48));
    h.serial = ascii_field(b, 0x180, 14);
    if let Some(reg) = ascii_field(b, 0x1F0, 3) {
        if reg.contains('U') || reg == "4" {
            h.region(Some("USA"));
        }
        if reg.contains('E') || reg == "8" {
            h.region(Some("Europe"));
        }
        if reg.contains('J') || reg == "1" {
            h.region(Some("Japan"));
        }
    }
    Some(h)
}

pub fn parse_sms(b: &[u8]) -> Option<HeaderInfo> {
    for o in [0x7FF0usize, 0x3FF0, 0x1FF0] {
        if b.get(o..o + 8) == Some(b"TMR SEGA") {
            let code = *b.get(o + 0xF)? >> 4;
            let mut h = HeaderInfo::plat(if (5..=7).contains(&code) { "gamegear" } else { "sms" });
            h.region(match code {
                3 | 5 => Some("Japan"),
                4 | 6 => Some("World"),
                7 => Some("World"),
                _ => None,
            });
            return Some(h);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Nintendo optical discs (GameCube / Wii / RVZ / WIA / WBFS / Wii U)
// ---------------------------------------------------------------------------

const GC_MAGIC: u32 = 0xC233_9F3D;
const WII_MAGIC: u32 = 0x5D1C_9EA3;

/// Parses a GameCube/Wii disc header located at `o` inside `b`.
pub fn parse_gc_wii_header(b: &[u8], o: usize) -> Option<HeaderInfo> {
    let is_wii = u32_be(b, o + 0x18)? == WII_MAGIC;
    let is_gc = u32_be(b, o + 0x1C)? == GC_MAGIC;
    if !is_wii && !is_gc {
        return None;
    }
    let mut h = HeaderInfo::plat(if is_wii { "wii" } else { "gamecube" });
    let id = ascii_field(b, o, 6).filter(|s| s.len() == 6 && is_alnum_ascii(s));
    if let Some(id) = &id {
        h.region(region_from_nintendo_code(id.chars().nth(3).unwrap()));
        h.serial = Some(id.clone());
    }
    h.title = ascii_field(b, o + 0x20, 0x60);
    Some(h)
}

/// Whole-file magic for Nintendo disc containers.
pub fn parse_nintendo_disc_container(b: &[u8]) -> Option<HeaderInfo> {
    // plain GCM/ISO
    if let Some(h) = parse_gc_wii_header(b, 0) {
        let mut h = h;
        h.format = Some("iso".into());
        return Some(h);
    }
    // RVZ / WIA: disc header copy at 0x58 (after the 0x48-byte file header + 0x10 of disc struct)
    if let Some(m) = b.get(0..4) {
        if m == b"RVZ\x01" || m == b"WIA\x01" {
            let fmt = if m[0] == b'R' { "rvz" } else { "wia" };
            let mut h = parse_gc_wii_header(b, 0x58).unwrap_or_default();
            h.format = Some(fmt.into());
            return Some(h);
        }
        if m == b"WBFS" {
            let shift = *b.get(8)? as u32;
            let o = 1usize.checked_shl(shift).unwrap_or(0x200);
            let mut h = parse_gc_wii_header(b, o).unwrap_or_else(|| HeaderInfo::plat("wii"));
            if h.platform.is_none() {
                h.platform = Some("wii");
            }
            h.format = Some("wbfs".into());
            return Some(h);
        }
        if m == [0x01, 0xC0, 0x0B, 0xB1] {
            let mut h = HeaderInfo::default();
            h.format = Some("gcz".into());
            return Some(h);
        }
        if m == b"CISO" && b.len() > 0x8000 + 0x20 {
            // GC/Wii CISO: 0x8000 header then the disc
            if let Some(mut h) = parse_gc_wii_header(b, 0x8000) {
                h.format = Some("ciso".into());
                return Some(h);
            }
        }
        if m == b"WUX0" {
            let mut h = HeaderInfo::plat("wiiu");
            h.format = Some("wux".into());
            return Some(h);
        }
    }
    if b.starts_with(b"WUP-P-") {
        let mut h = HeaderInfo::plat("wiiu");
        h.format = Some("wud".into());
        if let Some(code) = ascii_field(b, 6, 4).filter(|c| c.len() == 4) {
            h.region(region_from_nintendo_code(code.chars().last().unwrap()));
            h.serial = Some(format!("WUP-P-{}", code));
        }
        return Some(h);
    }
    None
}

// ---------------------------------------------------------------------------
// Sega discs
// ---------------------------------------------------------------------------

pub fn parse_sega_disc(b: &[u8]) -> Option<HeaderInfo> {
    for o in [0usize, 0x10] {
        let Some(sys) = b.get(o..o + 16) else { continue };
        let (plat, kind) = if sys.starts_with(b"SEGA SEGASATURN") {
            ("saturn", 0)
        } else if sys.starts_with(b"SEGADISCSYSTEM") || sys.starts_with(b"SEGA SEGACD") {
            ("segacd", 1)
        } else if sys.starts_with(b"SEGA SEGAKATANA") {
            ("dreamcast", 2)
        } else {
            continue;
        };
        let mut h = HeaderInfo::plat(plat);
        match kind {
            0 => {
                h.serial = ascii_field(b, o + 0x20, 10);
                if let Some(area) = ascii_field(b, o + 0x40, 10) {
                    if area.contains('U') {
                        h.region(Some("USA"));
                    }
                    if area.contains('E') {
                        h.region(Some("Europe"));
                    }
                    if area.contains('J') {
                        h.region(Some("Japan"));
                    }
                }
                h.title = ascii_field(b, o + 0x60, 0x70);
            }
            2 => {
                h.serial = ascii_field(b, o + 0x40, 10);
                if let Some(area) = ascii_field(b, o + 0x30, 8) {
                    if area.contains('U') {
                        h.region(Some("USA"));
                    }
                    if area.contains('E') {
                        h.region(Some("Europe"));
                    }
                    if area.contains('J') {
                        h.region(Some("Japan"));
                    }
                }
                h.title = ascii_field(b, o + 0x80, 0x80);
            }
            _ => {
                h.title = ascii_field(b, o + 0x120, 48).or_else(|| ascii_field(b, o + 0x150, 48));
            }
        }
        return Some(h);
    }
    None
}

// ---------------------------------------------------------------------------
// ISO 9660 (PlayStation 1/2/PSP/PS3) over plain, raw (2352) and CSO images
// ---------------------------------------------------------------------------

pub trait SectorSource {
    /// Reads one 2048-byte user-data sector.
    fn read_sector(&mut self, lba: u64) -> Option<Vec<u8>>;
}

/// Plain .iso (2048) or raw .bin (2352/2336 with sync + header).
pub struct ImageSource<R: Read + Seek> {
    r: R,
    sector_size: u64,
    data_offset: u64,
}

impl<R: Read + Seek> ImageSource<R> {
    pub fn detect(mut r: R) -> Option<Self> {
        // Raw CD sector: 00 FF×10 00 sync, mode byte at 15
        let mut sync = [0u8; 16];
        r.seek(SeekFrom::Start(16 * 2352)).ok()?;
        let raw = r.read_exact(&mut sync).is_ok()
            && sync[0] == 0
            && sync[1..11].iter().all(|&b| b == 0xFF)
            && sync[11] == 0;
        if raw {
            let off = if sync[15] == 2 { 24 } else { 16 };
            return Some(ImageSource { r, sector_size: 2352, data_offset: off });
        }
        Some(ImageSource { r, sector_size: 2048, data_offset: 0 })
    }
}

impl<R: Read + Seek> SectorSource for ImageSource<R> {
    fn read_sector(&mut self, lba: u64) -> Option<Vec<u8>> {
        self.r.seek(SeekFrom::Start(lba * self.sector_size + self.data_offset)).ok()?;
        let mut buf = vec![0u8; 2048];
        self.r.read_exact(&mut buf).ok()?;
        Some(buf)
    }
}

/// CSO v1 (PSP / PS2 compressed ISO): deflate blocks + u32 index table.
pub struct CsoSource<R: Read + Seek> {
    r: R,
    block_size: u64,
    align: u32,
    total: u64,
    cache: Option<(u64, Vec<u8>)>,
}

impl<R: Read + Seek> CsoSource<R> {
    pub fn open(mut r: R) -> Option<Self> {
        let mut h = [0u8; 0x18];
        r.seek(SeekFrom::Start(0)).ok()?;
        r.read_exact(&mut h).ok()?;
        if &h[0..4] != b"CISO" {
            return None;
        }
        let total = u64_le(&h, 8)?;
        let block_size = u32_le(&h, 0x10)? as u64;
        if block_size == 0 || block_size > 1 << 20 {
            return None;
        }
        Some(CsoSource { r, block_size, align: h[0x15] as u32, total, cache: None })
    }

    fn block(&mut self, idx: u64) -> Option<Vec<u8>> {
        if let Some((i, data)) = &self.cache {
            if *i == idx {
                return Some(data.clone());
            }
        }
        let mut e = [0u8; 8];
        self.r.seek(SeekFrom::Start(0x18 + idx * 4)).ok()?;
        self.r.read_exact(&mut e).ok()?;
        let a = u32::from_le_bytes([e[0], e[1], e[2], e[3]]);
        let b = u32::from_le_bytes([e[4], e[5], e[6], e[7]]);
        let plain = a & 0x8000_0000 != 0;
        let start = ((a & 0x7FFF_FFFF) as u64) << self.align;
        let end = ((b & 0x7FFF_FFFF) as u64) << self.align;
        let len = end.checked_sub(start)?.min(self.block_size * 2);
        let mut raw = vec![0u8; len as usize];
        self.r.seek(SeekFrom::Start(start)).ok()?;
        self.r.read_exact(&mut raw).ok()?;
        let data = if plain {
            raw.truncate(self.block_size as usize);
            raw
        } else {
            let mut out = Vec::with_capacity(self.block_size as usize);
            flate2::read::DeflateDecoder::new(&raw[..])
                .take(self.block_size)
                .read_to_end(&mut out)
                .ok()?;
            out
        };
        self.cache = Some((idx, data.clone()));
        Some(data)
    }
}

impl<R: Read + Seek> SectorSource for CsoSource<R> {
    fn read_sector(&mut self, lba: u64) -> Option<Vec<u8>> {
        let off = lba * 2048;
        if off >= self.total {
            return None;
        }
        let block = self.block(off / self.block_size)?;
        let inner = (off % self.block_size) as usize;
        block.get(inner..inner + 2048).map(|s| s.to_vec())
    }
}

#[derive(Debug, Clone)]
pub struct IsoEntry {
    pub name: String,
    pub lba: u64,
    pub size: u64,
    pub is_dir: bool,
}

pub struct Pvd {
    pub system_id: String,
    pub volume_id: String,
    pub root_lba: u64,
    pub root_size: u64,
}

pub fn iso_pvd(src: &mut dyn SectorSource) -> Option<Pvd> {
    let s = src.read_sector(16)?;
    if s[0] != 1 || &s[1..6] != b"CD001" {
        return None;
    }
    Some(Pvd {
        system_id: ascii_field(&s, 8, 32).unwrap_or_default(),
        volume_id: ascii_field(&s, 40, 32).unwrap_or_default(),
        root_lba: u32_le(&s, 156 + 2)? as u64,
        root_size: u32_le(&s, 156 + 10)? as u64,
    })
}

pub fn iso_list_dir(src: &mut dyn SectorSource, lba: u64, size: u64) -> Vec<IsoEntry> {
    let mut out = Vec::new();
    let sectors = size.div_ceil(2048).min(64);
    for i in 0..sectors {
        let Some(s) = src.read_sector(lba + i) else { break };
        let mut p = 0usize;
        while p < 2048 {
            let len = s[p] as usize;
            if len == 0 || p + len > 2048 || len < 34 {
                break;
            }
            let rec = &s[p..p + len];
            let name_len = rec[32] as usize;
            if 33 + name_len <= len {
                let raw = &rec[33..33 + name_len];
                if raw != [0] && raw != [1] {
                    let name = String::from_utf8_lossy(raw).to_string();
                    let name = name.split(';').next().unwrap_or("").to_string();
                    out.push(IsoEntry {
                        name,
                        lba: u32_le(rec, 2).unwrap_or(0) as u64,
                        size: u32_le(rec, 10).unwrap_or(0) as u64,
                        is_dir: rec[25] & 2 != 0,
                    });
                }
            }
            p += len;
        }
    }
    out
}

pub fn iso_read_file(src: &mut dyn SectorSource, e: &IsoEntry, max: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let want = (e.size as usize).min(max);
    let mut lba = e.lba;
    while out.len() < want {
        let Some(s) = src.read_sector(lba) else { break };
        out.extend_from_slice(&s);
        lba += 1;
    }
    out.truncate(want);
    out
}

/// Parses SYSTEM.CNF: BOOT2 → PS2, BOOT → PS1. Returns (platform, serial).
pub fn parse_system_cnf(txt: &str) -> Option<(&'static str, Option<String>)> {
    let re = regex::Regex::new(r"(?im)^\s*(BOOT2?)\s*=\s*cdrom0?:\\?\\?([^;\s]+)").ok()?;
    let c = re.captures(txt)?;
    let plat = if c[1].eq_ignore_ascii_case("BOOT2") { "ps2" } else { "ps1" };
    let file = c[2].rsplit(['\\', '/']).next().unwrap_or(&c[2]).to_string();
    let serial_re = regex::Regex::new(r"^(?i)[a-z]{4}[_-][0-9]{3}\.?[0-9]{2}").unwrap();
    let serial = serial_re.find(&file).map(|m| normalize_sony_serial(m.as_str()));
    Some((plat, serial))
}

/// PlayStation family identification on an ISO 9660 image.
pub fn identify_iso9660(src: &mut dyn SectorSource) -> Option<HeaderInfo> {
    let pvd = iso_pvd(src)?;
    let root = iso_list_dir(src, pvd.root_lba, pvd.root_size);
    let find = |n: &str| root.iter().find(|e| e.name.eq_ignore_ascii_case(n)).cloned();

    if let Some(sfb) = find("PS3_DISC.SFB") {
        let data = iso_read_file(src, &sfb, 0x400);
        let mut h = HeaderInfo::plat("ps3");
        let txt = String::from_utf8_lossy(&data);
        let re = regex::Regex::new(r"(?i)\b(B[CL][AEJKU][SM]|NP[AEJUHK][AB])[0-9]{5}\b").unwrap();
        if let Some(m) = re.find(&txt) {
            let s = m.as_str().to_uppercase();
            h.region(region_from_sony_serial(&s));
            h.serial = Some(format!("{}-{}", &s[..4], &s[4..]));
        }
        h.title = Some(pvd.volume_id.clone()).filter(|v| !v.is_empty() && v != "PS3VOLUME");
        h.notes.push("ISO de PS3: o RPCS3 só abre ISO descriptografada ou a pasta do jogo (PS3_GAME). Use \"Extrair ISO\" em uma ISO descriptografada.".into());
        return Some(h);
    }
    if let Some(umd) = find("UMD_DATA.BIN") {
        let data = iso_read_file(src, &umd, 64);
        let mut h = HeaderInfo::plat("psp");
        let txt = String::from_utf8_lossy(&data);
        if let Some(serial) = txt.split('|').next().filter(|s| s.len() >= 9) {
            let s = normalize_sony_serial(serial.trim());
            h.region(region_from_sony_serial(&s));
            h.serial = Some(s);
        }
        return Some(h);
    }
    if root.iter().any(|e| e.is_dir && e.name.eq_ignore_ascii_case("PSP_GAME")) {
        return Some(HeaderInfo::plat("psp"));
    }
    if let Some(cnf) = find("SYSTEM.CNF") {
        let data = iso_read_file(src, &cnf, 2048);
        if let Some((plat, serial)) = parse_system_cnf(&String::from_utf8_lossy(&data)) {
            let mut h = HeaderInfo::plat(plat);
            if let Some(s) = &serial {
                h.region(region_from_sony_serial(s));
            }
            h.serial = serial;
            h.title = Some(pvd.volume_id.clone()).filter(|v| !v.is_empty());
            return Some(h);
        }
    }
    if pvd.system_id.to_uppercase().contains("PLAYSTATION") {
        return Some(HeaderInfo::plat("ps1"));
    }
    None
}

// ---------------------------------------------------------------------------
// Xbox / Xbox 360 (XDVDFS)
// ---------------------------------------------------------------------------

pub const XDVDFS_MAGIC: &[u8; 20] = b"MICROSOFT*XBOX*MEDIA";
/// Game partition offsets: plain xiso, XGD1 (Xbox redump), XGD2 and XGD3 (Xbox 360 redump).
pub const XISO_OFFSETS: [u64; 4] = [0, 0x1830_0000, 0x0FD9_0000, 0x0208_0000];

/// Finds an entry in an XDVDFS directory table. Returns (sector, size).
pub fn xdvdfs_find(dir: &[u8], name: &str) -> Option<(u32, u32)> {
    let n = name.len();
    let lname = name.to_lowercase();
    let lname = lname.as_bytes();
    if dir.len() < n + 14 {
        return None;
    }
    for i in 14..=dir.len() - n {
        if dir[i - 1] as usize == n && dir[i..i + n].eq_ignore_ascii_case(lname) {
            return Some((u32_le(dir, i - 10)?, u32_le(dir, i - 6)?));
        }
    }
    None
}

/// XEX2: (title id, regions, disc number/count).
pub fn parse_xex(b: &[u8]) -> Option<(Option<String>, Vec<String>, Option<(u8, u8)>)> {
    if b.get(0..4)? != b"XEX2" {
        return None;
    }
    let sec = u32_be(b, 0x10)? as usize;
    let count = u32_be(b, 0x14)? as usize;
    let mut title = None;
    let mut disc = None;
    for i in 0..count.min(64) {
        let key = u32_be(b, 0x18 + i * 8)?;
        let val = u32_be(b, 0x18 + i * 8 + 4)? as usize;
        if key == 0x0004_0006 {
            if let Some(tid) = u32_be(b, val + 0x0C) {
                title = Some(format!("{:08X}", tid));
            }
            if let (Some(&d), Some(&n)) = (b.get(val + 0x12), b.get(val + 0x13)) {
                disc = Some((d, n));
            }
        }
    }
    let regions = u32_be(b, sec + 0x178).map(regions_from_xex_mask).unwrap_or_default();
    Some((title, regions, disc))
}

/// XBE certificate: (title id "MS-004", title, regions).
pub fn parse_xbe(b: &[u8]) -> Option<(Option<String>, Option<String>, Vec<String>)> {
    if b.get(0..4)? != b"XBEH" {
        return None;
    }
    let base = u32_le(b, 0x104)?;
    let cert = u32_le(b, 0x118)?.checked_sub(base)? as usize;
    let tid = u32_le(b, cert + 0x8)?;
    let pub_hi = ((tid >> 24) & 0xFF) as u8;
    let pub_lo = ((tid >> 16) & 0xFF) as u8;
    let tid_s = if pub_hi.is_ascii_alphanumeric() && pub_lo.is_ascii_alphanumeric() {
        format!("{}{}-{:03}", pub_hi as char, pub_lo as char, tid & 0xFFFF)
    } else {
        format!("{:08X}", tid)
    };
    let name = utf16_field(b, cert + 0xC, 40, false);
    let regions = u32_le(b, cert + 0xA0).map(regions_from_xbe_mask).unwrap_or_default();
    Some((Some(tid_s), name, regions))
}

pub fn identify_xiso(f: &mut File, file_size: u64) -> Option<HeaderInfo> {
    for base in XISO_OFFSETS {
        if base + 0x10000 + 32 > file_size {
            continue;
        }
        let vd = read_at(f, base + 0x10000, 32)?;
        if vd.get(0..20)? != XDVDFS_MAGIC {
            continue;
        }
        let root_sector = u32_le(&vd, 20)? as u64;
        let root_size = (u32_le(&vd, 24)? as usize).min(256 * 1024);
        let dir = read_at(f, base + root_sector * 2048, root_size).unwrap_or_default();
        let mut h = HeaderInfo::default();
        h.format = Some("iso".into());
        if let Some((sec, size)) = xdvdfs_find(&dir, "default.xex") {
            h.platform = Some("xbox360");
            if let Some(x) = read_at(f, base + sec as u64 * 2048, (size as usize).min(0x10000)) {
                if let Some((tid, regions, disc)) = parse_xex(&x) {
                    h.serial = tid;
                    h.regions = regions;
                    if let Some((d, n)) = disc.filter(|(_, n)| *n > 1) {
                        h.notes.push(format!("Disco {} de {}", d, n));
                    }
                }
            }
        } else if let Some((sec, size)) = xdvdfs_find(&dir, "default.xbe") {
            h.platform = Some("xbox");
            if let Some(x) = read_at(f, base + sec as u64 * 2048, (size as usize).min(0x4000)) {
                if let Some((tid, name, regions)) = parse_xbe(&x) {
                    h.serial = tid;
                    h.title = name;
                    h.regions = regions;
                }
            }
        } else {
            h.platform = Some(if base == 0x1830_0000 { "xbox" } else { "xbox360" });
        }
        if base == 0 {
            h.flags.push("xiso".into());
        }
        return Some(h);
    }
    None
}

// ---------------------------------------------------------------------------
// Sony packages / PBP / SFO
// ---------------------------------------------------------------------------

/// PARAM.SFO → key/value strings.
pub fn parse_sfo(b: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if b.get(0..4) != Some(b"\0PSF") {
        return out;
    }
    let (Some(kt), Some(dt), Some(n)) = (u32_le(b, 0x08), u32_le(b, 0x0C), u32_le(b, 0x10)) else { return out };
    for i in 0..(n as usize).min(64) {
        let e = 0x14 + i * 16;
        let (Some(ko), Some(fmt), Some(len), Some(dofs)) = (u16_le(b, e), u16_le(b, e + 2), u32_le(b, e + 4), u32_le(b, e + 12)) else { break };
        let kstart = kt as usize + ko as usize;
        let key_end = b[kstart.min(b.len())..].iter().position(|&c| c == 0).map(|p| kstart + p).unwrap_or(b.len());
        let key = String::from_utf8_lossy(b.get(kstart..key_end).unwrap_or(&[])).to_string();
        let dstart = dt as usize + dofs as usize;
        let val = if fmt == 0x0404 {
            u32_le(b, dstart).map(|v| v.to_string()).unwrap_or_default()
        } else {
            let raw = b.get(dstart..dstart + len as usize).unwrap_or(&[]);
            let end = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
            String::from_utf8_lossy(&raw[..end]).trim().to_string()
        };
        out.push((key, val));
    }
    out
}

fn sfo_get<'a>(kv: &'a [(String, String)], key: &str) -> Option<&'a str> {
    kv.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str()).filter(|v| !v.is_empty())
}

fn platform_from_sony_title_id(id: &str) -> Option<&'static str> {
    let u = id.to_uppercase();
    if u.starts_with("CUSA") || u.starts_with("PPSA") {
        return Some("ps4");
    }
    if u.starts_with("PCS") {
        return Some("psvita");
    }
    if u.starts_with("BL") || u.starts_with("BC") || (u.starts_with("NP") && u.len() > 3 && matches!(&u[3..4], "A" | "B")) {
        return Some("ps3");
    }
    if u.starts_with("UL") || u.starts_with("UC") || (u.starts_with("NP") && u.len() > 3 && matches!(&u[3..4], "G" | "H" | "Z")) {
        return Some("psp");
    }
    if u.starts_with("SL") || u.starts_with("SC") {
        return None;
    }
    None
}

pub fn parse_pbp(b: &[u8]) -> Option<HeaderInfo> {
    if b.get(0..4)? != b"\0PBP" {
        return None;
    }
    let sfo_start = u32_le(b, 0x08)? as usize;
    let sfo_end = u32_le(b, 0x0C)? as usize;
    let sfo = parse_sfo(b.get(sfo_start..sfo_end.min(b.len()))?);
    let cat = sfo_get(&sfo, "CATEGORY").unwrap_or("");
    let mut h = HeaderInfo::plat(if cat == "ME" { "ps1" } else { "psp" });
    h.title = sfo_get(&sfo, "TITLE").map(String::from);
    if let Some(id) = sfo_get(&sfo, "DISC_ID") {
        let s = normalize_sony_serial(id);
        h.region(region_from_sony_serial(&s));
        h.serial = Some(s);
    }
    if cat == "ME" {
        h.notes.push("EBOOT de PS1 (PS1 Classics) — roda no DuckStation e no PSP/PPSSPP.".into());
    }
    Some(h)
}

pub fn parse_pkg(b: &[u8]) -> Option<HeaderInfo> {
    let magic = b.get(0..4)?;
    let (cid_off, ps4) = if magic == [0x7F, b'C', b'N', b'T'] {
        (0x40, true)
    } else if magic == [0x7F, b'P', b'K', b'G'] {
        (0x30, false)
    } else {
        return None;
    };
    let cid = ascii_field(b, cid_off, 36)?;
    let tid = cid.get(7..16).unwrap_or("").to_string();
    let plat = if ps4 { Some("ps4") } else { platform_from_sony_title_id(&tid).or(Some("ps3")) };
    let mut h = HeaderInfo { platform: plat, ..Default::default() };
    h.region(region_from_content_id(&cid));
    if !tid.is_empty() {
        h.serial = Some(if ps4 { tid.clone() } else { format!("{}-{}", &tid[..4.min(tid.len())], tid.get(4..).unwrap_or("")) });
    }
    h.format = Some("pkg".into());
    h.notes.push(format!("Content ID {}", cid));
    Some(h)
}

// ---------------------------------------------------------------------------
// Switch / 3DS
// ---------------------------------------------------------------------------

/// PFS0 (NSP/NSZ): entry names → (is_nsz, title id from the ticket name).
pub fn parse_pfs0(b: &[u8]) -> Option<(bool, Option<String>, Vec<String>)> {
    if b.get(0..4)? != b"PFS0" {
        return None;
    }
    let n = u32_le(b, 4)? as usize;
    let st_size = u32_le(b, 8)? as usize;
    let st = 0x10 + n * 0x18;
    let table = b.get(st..(st + st_size).min(b.len()))?;
    let mut names = Vec::new();
    for i in 0..n.min(256) {
        let off = u32_le(b, 0x10 + i * 0x18 + 0x10)? as usize;
        let rest = table.get(off..).unwrap_or(&[]);
        let end = rest.iter().position(|&c| c == 0).unwrap_or(rest.len());
        names.push(String::from_utf8_lossy(&rest[..end]).to_string());
    }
    let nsz = names.iter().any(|n| n.to_lowercase().ends_with(".ncz"));
    let tid = names
        .iter()
        .find(|n| n.to_lowercase().ends_with(".tik") && n.len() >= 32)
        .map(|n| n[..16].to_uppercase());
    Some((nsz, tid, names))
}

/// Switch title id → content kind.
pub fn switch_title_kind(tid: &str) -> &'static str {
    let t = tid.to_uppercase();
    if t.len() != 16 {
        return "base";
    }
    if t.ends_with("800") {
        "update"
    } else if t.ends_with("000") {
        "base"
    } else {
        "dlc"
    }
}

pub fn parse_3ds(b: &[u8]) -> Option<HeaderInfo> {
    let ncch_at = |o: usize| -> Option<HeaderInfo> {
        if b.get(o + 0x100..o + 0x104)? != b"NCCH" {
            return None;
        }
        let mut h = HeaderInfo::plat("3ds");
        if let Some(code) = ascii_field(b, o + 0x150, 16) {
            if let Some(last) = code.chars().last() {
                h.region(region_from_nintendo_code(last));
            }
            h.serial = Some(code);
        }
        let flags7 = *b.get(o + 0x18F).unwrap_or(&0);
        if flags7 & 0x04 == 0 {
            h.flags.push("encrypted".into());
            h.notes.push("Imagem 3DS criptografada — o Azahar só abre .3ds/.cci descriptografados.".into());
        }
        Some(h)
    };
    if b.get(0x100..0x104)? == b"NCSD" {
        let p0 = u32_le(b, 0x120)? as usize * 0x200;
        let mut h = ncch_at(p0).unwrap_or_else(|| HeaderInfo::plat("3ds"));
        h.format = Some("3ds".into());
        return Some(h);
    }
    if let Some(mut h) = ncch_at(0) {
        h.format = Some("cxi".into());
        return Some(h);
    }
    if u32_le(b, 0)? == 0x2020 {
        let mut h = HeaderInfo::plat("3ds");
        h.format = Some("cia".into());
        return Some(h);
    }
    if b.get(0..4)? == b"3DSX" {
        let mut h = HeaderInfo::plat("3ds");
        h.format = Some("3dsx".into());
        return Some(h);
    }
    None
}

// ---------------------------------------------------------------------------
// CHD
// ---------------------------------------------------------------------------

/// Reads CHD metadata tags to tell CD / GD-ROM / DVD apart.
pub fn chd_media_kind(f: &mut File) -> Option<&'static str> {
    let h = read_at(f, 0, 0x7C)?;
    if h.get(0..8)? != b"MComprHD" {
        return None;
    }
    let version = u32_be(&h, 0x0C)?;
    let mut meta = match version {
        5 => u64_be(&h, 0x30)?,
        3 | 4 => u64_be(&h, 0x24)?,
        _ => return Some("chd"),
    };
    for _ in 0..64 {
        if meta == 0 {
            break;
        }
        let m = read_at(f, meta, 16)?;
        match m.get(0..4)? {
            b"CHGT" | b"CHGD" => return Some("gdrom"),
            b"DVD " => return Some("dvd"),
            b"CHT2" | b"CHTR" | b"CHCD" => return Some("cd"),
            b"GDDD" | b"IDNT" => return Some("hdd"),
            _ => {}
        }
        meta = u64_be(&m, 8)?;
    }
    Some("chd")
}

// ---------------------------------------------------------------------------
// CUE / GDI companions
// ---------------------------------------------------------------------------

pub fn cue_files(txt: &str) -> Vec<String> {
    let re = regex::Regex::new(r#"(?im)^\s*FILE\s+(?:"([^"]+)"|(\S+))"#).unwrap();
    re.captures_iter(txt)
        .filter_map(|c| c.get(1).or_else(|| c.get(2)).map(|m| m.as_str().to_string()))
        .collect()
}

pub fn gdi_files(txt: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in txt.lines().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // "1 0 4 2352 "track01.bin" 0" or without quotes
        if let Some(start) = line.find('"') {
            if let Some(end) = line[start + 1..].find('"') {
                out.push(line[start + 1..start + 1 + end].to_string());
                continue;
            }
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 5 {
            out.push(parts[4].to_string());
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------

pub fn list_archive(path: &Path, ext: &str) -> Result<Vec<ArchiveEntryInfo>, String> {
    match ext {
        "zip" => {
            let f = File::open(path).map_err(|e| e.to_string())?;
            let mut z = zip::ZipArchive::new(std::io::BufReader::new(f)).map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for i in 0..z.len().min(200) {
                if let Ok(e) = z.by_index_raw(i) {
                    if !e.is_dir() {
                        out.push(ArchiveEntryInfo { name: e.name().to_string(), size: e.size() });
                    }
                }
            }
            Ok(out)
        }
        "7z" => {
            let a = sevenz_rust2::Archive::open(path).map_err(|e| e.to_string())?;
            Ok(a.files
                .iter()
                .filter(|e| !e.is_directory())
                .take(200)
                .map(|e| ArchiveEntryInfo { name: e.name().to_string(), size: e.size() })
                .collect())
        }
        _ => Ok(Vec::new()),
    }
}

/// Platform guess from what is inside an archive.
pub fn platform_from_entries(entries: &[ArchiveEntryInfo]) -> Option<&'static str> {
    let mut best: Option<(&'static str, u64)> = None;
    for e in entries {
        let ext = Path::new(&e.name).extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        if let Some(p) = platform_from_extension(&ext) {
            if best.map_or(true, |(_, s)| e.size > s) {
                best = Some((p, e.size));
            }
        }
    }
    if let Some((p, _)) = best {
        return Some(p);
    }
    // MAME/FBNeo romset: many small chips (.bin/.rom/.u1…) and nothing recognisable
    let small = entries.iter().filter(|e| e.size <= 16 * 1024 * 1024).count();
    if entries.len() >= 4 && small == entries.len() && entries.iter().all(|e| !e.name.contains('/')) {
        let known = entries.iter().any(|e| {
            let ext = Path::new(&e.name).extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            is_game_extension(&ext) && !matches!(ext.as_str(), "bin" | "rom")
        });
        if !known {
            return Some("arcade");
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Folders (extracted games)
// ---------------------------------------------------------------------------

fn child_ci(dir: &Path, name: &str) -> Option<std::path::PathBuf> {
    let direct = dir.join(name);
    if direct.exists() {
        return Some(direct);
    }
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name))
        .map(|e| e.path())
}

fn is_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn read_head(path: &Path, len: usize) -> Option<Vec<u8>> {
    let mut f = File::open(path).ok()?;
    read_at(&mut f, 0, len)
}

/// STFS/CON header (Games on Demand part 0): (title id, display name).
pub fn parse_stfs(b: &[u8]) -> Option<(String, Option<String>)> {
    let m = b.get(0..4)?;
    if m != b"LIVE" && m != b"PIRS" && m != b"CON " {
        return None;
    }
    let tid = u32_be(b, 0x360)?;
    Some((format!("{:08X}", tid), utf16_field(b, 0x411, 128, true)))
}

/// Recognises extracted / installed game folders. `None` = an ordinary folder.
pub fn identify_folder(dir: &Path) -> Option<HeaderInfo> {
    let name = dir.file_name()?.to_string_lossy().to_string();

    // Xbox 360 extracted (default.xex) / Xbox extracted (default.xbe)
    if let Some(xex) = child_ci(dir, "default.xex") {
        let mut h = HeaderInfo::plat("xbox360");
        h.format = Some("xex-folder".into());
        if let Some(b) = read_head(&xex, 0x10000) {
            if let Some((tid, regions, _)) = parse_xex(&b) {
                h.serial = tid;
                h.regions = regions;
            }
        }
        return Some(h);
    }
    if let Some(xbe) = child_ci(dir, "default.xbe") {
        let mut h = HeaderInfo::plat("xbox");
        h.format = Some("xbe-folder".into());
        if let Some(b) = read_head(&xbe, 0x4000) {
            if let Some((tid, title, regions)) = parse_xbe(&b) {
                h.serial = tid;
                h.title = title;
                h.regions = regions;
            }
        }
        return Some(h);
    }
    // Xbox 360 Games on Demand: <TitleID>/00007000/<hash> (00005000 = Xbox original as GOD)
    if is_hex(&name, 8) {
        for kind in ["00007000", "00005000"] {
            if let Some(sub) = child_ci(dir, kind) {
                let mut h = HeaderInfo::plat("xbox360");
                h.format = Some("god".into());
                h.serial = Some(name.to_uppercase());
                if let Some(part) = fs::read_dir(&sub).ok().and_then(|mut r| r.find_map(|e| e.ok().filter(|e| e.path().is_file()))) {
                    if let Some(b) = read_head(&part.path(), 0x1000) {
                        if let Some((tid, title)) = parse_stfs(&b) {
                            h.serial = Some(tid);
                            h.title = title;
                        }
                    }
                }
                if kind == "00005000" {
                    h.notes.push("Jogo de Xbox original empacotado como GOD (retrocompatível no 360).".into());
                }
                return Some(h);
            }
        }
    }
    // PS3 folder (JB format): PS3_GAME/PARAM.SFO
    if let Some(game) = child_ci(dir, "PS3_GAME") {
        let mut h = HeaderInfo::plat("ps3");
        h.format = Some("ps3-folder".into());
        if let Some(sfo) = child_ci(&game, "PARAM.SFO").and_then(|p| fs::read(p).ok()) {
            let kv = parse_sfo(&sfo);
            h.title = sfo_get(&kv, "TITLE").map(String::from);
            if let Some(id) = sfo_get(&kv, "TITLE_ID") {
                h.region(region_from_sony_serial(id));
                h.serial = Some(format!("{}-{}", &id[..4.min(id.len())], id.get(4..).unwrap_or("")));
            }
        }
        return Some(h);
    }
    // PS4 / PS Vita extracted (sce_sys/param.sfo + eboot.bin)
    if let Some(sce) = child_ci(dir, "sce_sys") {
        if child_ci(dir, "eboot.bin").is_some() {
            let mut h = HeaderInfo::plat(if name.to_uppercase().starts_with("PCS") { "psvita" } else { "ps4" });
            h.format = Some("game-folder".into());
            if let Some(sfo) = child_ci(&sce, "param.sfo").and_then(|p| fs::read(p).ok()) {
                let kv = parse_sfo(&sfo);
                h.title = sfo_get(&kv, "TITLE").map(String::from);
                if let Some(id) = sfo_get(&kv, "TITLE_ID") {
                    if let Some(p) = platform_from_sony_title_id(id) {
                        h.platform = Some(p);
                    }
                    h.serial = Some(id.to_string());
                }
                if let Some(cid) = sfo_get(&kv, "CONTENT_ID") {
                    h.region(region_from_content_id(cid));
                }
            }
            return Some(h);
        }
    }
    // PSP extracted
    if let Some(game) = child_ci(dir, "PSP_GAME") {
        let mut h = HeaderInfo::plat("psp");
        h.format = Some("game-folder".into());
        if let Some(sfo) = child_ci(&game, "PARAM.SFO").and_then(|p| fs::read(p).ok()) {
            let kv = parse_sfo(&sfo);
            h.title = sfo_get(&kv, "TITLE").map(String::from);
            if let Some(id) = sfo_get(&kv, "DISC_ID") {
                let s = normalize_sony_serial(id);
                h.region(region_from_sony_serial(&s));
                h.serial = Some(s);
            }
        }
        return Some(h);
    }
    // Wii U loadiine / extracted: code + content + meta
    if child_ci(dir, "code").is_some() && child_ci(dir, "content").is_some() && child_ci(dir, "meta").is_some() {
        let mut h = HeaderInfo::plat("wiiu");
        h.format = Some("game-folder".into());
        if let Some(xml) = child_ci(dir, "meta").and_then(|m| child_ci(&m, "meta.xml")).and_then(|p| fs::read_to_string(p).ok()) {
            let tag = |t: &str| {
                let re = regex::Regex::new(&format!(r"<{}[^>]*>([^<]+)</{}>", t, t)).ok()?;
                re.captures(&xml).map(|c| c[1].trim().to_string())
            };
            h.title = tag("longname_en").map(|s| s.replace('\n', " "));
            h.serial = tag("title_id").map(|s| s.to_uppercase());
            if let Some(pc) = tag("product_code") {
                if let Some(last) = pc.chars().last() {
                    h.region(region_from_nintendo_code(last));
                }
            }
        }
        return Some(h);
    }
    // PS4 dumps named after the title id (CUSA01127) — kept from the old scanner
    if name.to_uppercase().starts_with("CUSA") && name.len() >= 9 {
        let mut h = HeaderInfo::plat("ps4");
        h.format = Some("game-folder".into());
        h.serial = Some(name[..9].to_uppercase());
        return Some(h);
    }
    None
}

// ---------------------------------------------------------------------------
// Top-level identification
// ---------------------------------------------------------------------------

fn kind_for_format(fmt: &str) -> &'static str {
    match fmt {
        "iso" | "bin" | "img" | "cue" | "gdi" | "cdi" | "gcm" | "wud" | "mdf" => "disc",
        "rvz" | "wia" | "gcz" | "ciso" | "wbfs" | "chd" | "cso" | "zso" | "nsz" | "xcz" | "wux" | "wua" | "ecm" => "compressed",
        "nsp" | "xci" | "pkg" | "cia" | "vpk" | "pbp" => "package",
        "xex-folder" | "xbe-folder" | "god" | "ps3-folder" | "game-folder" => "folder",
        "zip" | "7z" | "rar" => "archive",
        "mpq" | "rsdk" | "wad" | "pak" | "agg" | "esm" | "grp" => "data",
        "" => "other",
        _ => "cartridge",
    }
}

fn folder_hint(path: &Path) -> Option<&'static str> {
    path.ancestors().skip(1).take(4).find_map(|a| a.file_name().and_then(|n| platform_from_folder_name(&n.to_string_lossy())))
}

fn apply_header(out: &mut IdentifiedFile, h: HeaderInfo) {
    if let Some(p) = h.platform {
        out.platform = Some(p.to_string());
        out.confidence = "header".into();
    }
    if let Some(f) = h.format {
        out.format = f;
    }
    if h.title.is_some() {
        out.header_title = h.title;
    }
    if h.serial.is_some() {
        out.serial = h.serial;
    }
    if out.regions.is_empty() && !h.regions.is_empty() {
        out.regions = h.regions;
        out.region_source = Some(if out.serial.is_some() { "serial" } else { "header" }.into());
    }
    for f in h.flags {
        push_unique(&mut out.flags, &f);
    }
    out.notes.extend(h.notes);
}

fn dir_size(dir: &Path) -> u64 {
    walkdir::WalkDir::new(dir)
        .max_depth(8)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok().map(|m| m.len()))
        .sum()
}

/// Identifies a game folder (see `identify_folder`). `None` when it is not one.
pub fn identify_dir(path: &Path) -> Option<IdentifiedFile> {
    let h = identify_folder(path)?;
    let name = path.file_name()?.to_string_lossy().to_string();
    let tags = parse_name_tags(&name);
    let mut out = IdentifiedFile {
        path: path.to_string_lossy().to_string(),
        name: name.clone(),
        is_dir: true,
        size_bytes: dir_size(path),
        title: tags.title.clone(),
        regions: tags.regions.clone(),
        region_source: if tags.regions.is_empty() { None } else { Some("filename".into()) },
        languages: tags.languages,
        disc: tags.disc,
        revision: tags.revision,
        flags: tags.flags,
        confidence: "folder".into(),
        ..Default::default()
    };
    apply_header(&mut out, h);
    out.format_kind = kind_for_format(&out.format).into();
    if out.title.is_empty() || is_hex(&out.title, 8) || out.title.to_uppercase().starts_with("CUSA") {
        if let Some(t) = &out.header_title {
            out.title = t.clone();
        }
    }
    Some(out)
}

/// Identifies one file.
pub fn identify_file(path: &Path) -> IdentifiedFile {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let lower = name.to_lowercase();
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let stem = stem.strip_suffix(".nkit").map(String::from).unwrap_or(stem);
    let tags = parse_name_tags(&stem);

    let mut out = IdentifiedFile {
        path: path.to_string_lossy().to_string(),
        name: name.clone(),
        is_dir: false,
        size_bytes: size,
        extension: ext.clone(),
        confidence: "none".into(),
        format: ext.clone(),
        title: tags.title.clone(),
        regions: tags.regions.clone(),
        region_source: if tags.regions.is_empty() { None } else { Some("filename".into()) },
        languages: tags.languages.clone(),
        disc: tags.disc,
        revision: tags.revision.clone(),
        flags: tags.flags.clone(),
        serial: tags.title_id.clone().or(tags.serial.clone()),
        ..Default::default()
    };
    if lower.contains(".nkit.") {
        push_unique(&mut out.flags, "nkit");
        out.notes.push("Imagem NKit: o Dolphin abre, mas alguns ports pedem a ISO original (use \"Converter\" para ISO).".into());
    }

    // BIOS / keys
    if let Some(p) = bios_platform(&lower, size).filter(|_| !matches!(ext.as_str(), "iso" | "chd" | "cue" | "rvz" | "nsp" | "xci") && size < 64 * 1024 * 1024) {
        out.is_bios = true;
        out.platform = Some(p.into());
        out.confidence = "filename".into();
        out.format_kind = "bios".into();
        return out;
    }

    let Ok(mut f) = File::open(path) else {
        out.notes.push("Não foi possível abrir o arquivo (sem permissão ou em uso).".into());
        out.format_kind = kind_for_format(&out.format).into();
        return out;
    };
    let head = read_at(&mut f, 0, 0x10000).unwrap_or_default();

    let header: Option<HeaderInfo> = match ext.as_str() {
        "z64" | "n64" | "v64" => parse_n64(&head),
        "gba" => parse_gba(&head),
        "nds" | "dsi" => parse_nds(&head),
        "gb" | "gbc" => parse_gb(&head),
        "sfc" | "smc" => {
            let big = read_at(&mut f, 0, 0x10200).unwrap_or_default();
            parse_snes(&big, size)
        }
        "md" | "gen" | "smd" | "32x" => parse_genesis(&head),
        "sms" | "gg" => parse_sms(&head),
        "nes" | "unf" => head.starts_with(b"NES\x1A").then(|| HeaderInfo::plat("nes")),
        "fds" => Some(HeaderInfo::plat("fds")),
        "3ds" | "cci" | "cxi" | "cia" | "3dsx" => parse_3ds(&head),
        "rvz" | "wia" | "gcz" | "wbfs" | "gcm" | "ciso" | "wud" | "wux" => {
            let big = if ext == "ciso" { read_at(&mut f, 0, 0x8100).unwrap_or_default() } else { head.clone() };
            parse_nintendo_disc_container(&big)
        }
        "nsp" | "nsz" => parse_pfs0(&head).map(|(nsz, tid, _)| {
            let mut h = HeaderInfo::plat("switch");
            h.format = Some(if nsz { "nsz" } else { "nsp" }.into());
            if tid.is_some() {
                h.serial = tid;
            }
            h
        }),
        "xci" | "xcz" => (head.get(0x100..0x104) == Some(b"HEAD")).then(|| HeaderInfo::plat("switch")),
        "pbp" => parse_pbp(&head),
        "pkg" => parse_pkg(&head),
        "xex" => parse_xex(&head).map(|(tid, regions, _)| {
            let mut h = HeaderInfo::plat("xbox360");
            h.serial = tid;
            h.regions = regions;
            h
        }),
        "xbe" => parse_xbe(&head).map(|(tid, title, regions)| {
            let mut h = HeaderInfo::plat("xbox");
            h.serial = tid;
            h.title = title;
            h.regions = regions;
            h
        }),
        "chd" => {
            let kind = chd_media_kind(&mut f);
            let mut h = HeaderInfo::default();
            h.format = Some("chd".into());
            match kind {
                Some("gdrom") => h.platform = Some("dreamcast"),
                Some("dvd") => h.notes.push("CHD de DVD (PS2 ou PSP).".into()),
                Some("cd") => h.notes.push("CHD de CD (PS1, PS2 em CD, Saturn, Sega CD…).".into()),
                _ => {}
            }
            Some(h)
        }
        "cso" | "zso" => {
            let mut h = None;
            if ext == "cso" {
                if let Some(mut src) = CsoSource::open(&mut f) {
                    h = identify_iso9660(&mut src);
                }
            }
            let mut h = h.unwrap_or_else(|| HeaderInfo::plat("psp"));
            h.format = Some(ext.clone());
            Some(h)
        }
        "iso" | "bin" | "img" | "mdf" => identify_disc(&mut f, &head, size, &ext),
        "cue" => {
            let txt = String::from_utf8_lossy(&head).to_string();
            let files = cue_files(&txt);
            let dir = path.parent().unwrap_or(Path::new("."));
            out.companions = files.iter().map(|n| dir.join(n).to_string_lossy().to_string()).collect();
            let missing: Vec<&String> = files.iter().filter(|n| !dir.join(n).exists()).collect();
            if !missing.is_empty() {
                out.notes.push(format!("O .cue aponta para arquivos que não estão na pasta: {}", missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
            }
            out.size_bytes += files.iter().filter_map(|n| fs::metadata(dir.join(n)).ok()).map(|m| m.len()).sum::<u64>();
            files.first().and_then(|first| {
                let p = dir.join(first);
                let mut bf = File::open(&p).ok()?;
                let bhead = read_at(&mut bf, 0, 0x10000).unwrap_or_default();
                let bsize = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                identify_disc(&mut bf, &bhead, bsize, "bin")
            })
        }
        "gdi" => {
            let txt = String::from_utf8_lossy(&head).to_string();
            let dir = path.parent().unwrap_or(Path::new("."));
            let files = gdi_files(&txt);
            out.companions = files.iter().map(|n| dir.join(n).to_string_lossy().to_string()).collect();
            out.size_bytes += files.iter().filter_map(|n| fs::metadata(dir.join(n)).ok()).map(|m| m.len()).sum::<u64>();
            Some(HeaderInfo::plat("dreamcast"))
        }
        "zip" | "7z" | "rar" => {
            let mut h = HeaderInfo::default();
            h.format = Some(ext.clone());
            if ext == "rar" {
                h.notes.push("Arquivo RAR: para ver o conteúdo e extrair é preciso o 7-Zip (baixado na aba Ferramentas).".into());
            } else {
                match list_archive(path, &ext) {
                    Ok(entries) => {
                        if let Some(p) = platform_from_entries(&entries) {
                            h.platform = Some(p);
                        }
                        if entries.len() == 1 {
                            let inner = parse_name_tags(Path::new(&entries[0].name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default().as_str());
                            for r in inner.regions {
                                push_unique(&mut out.regions, &r);
                            }
                        }
                        out.archive_entries = entries;
                    }
                    Err(e) => h.notes.push(format!("Não foi possível ler o arquivo compactado: {}", e)),
                }
            }
            Some(h)
        }
        _ => None,
    };

    if let Some(h) = header {
        let had_platform = h.platform.is_some();
        apply_header(&mut out, h);
        if !had_platform && out.platform.is_none() {
            out.confidence = "none".into();
        }
        if matches!(ext.as_str(), "zip" | "7z" | "rar") && out.platform.is_some() {
            out.confidence = "extension".into();
        }
    }
    if out.platform.is_none() {
        if let Some(p) = platform_from_extension(&ext) {
            out.platform = Some(p.into());
            out.confidence = "extension".into();
        }
    }
    if out.platform.is_none() {
        if let Some(p) = folder_hint(path) {
            out.platform = Some(p.into());
            out.confidence = "folder".into();
        }
    }
    // Switch: title id in the name → kind
    if out.platform.as_deref() == Some("switch") {
        if let Some(tid) = out.serial.clone().filter(|s| is_hex(s, 16)) {
            match switch_title_kind(&tid) {
                "update" => push_unique(&mut out.flags, "update"),
                "dlc" => push_unique(&mut out.flags, "dlc"),
                _ => {}
            }
        }
        if out.regions.is_empty() {
            out.regions.push("Region Free".into());
            out.region_source = Some("header".into());
        }
        if out.format == "nsz" || out.format == "xcz" {
            out.notes.push("Formato comprimido (NSZ/XCZ): Ryujinx e Eden abrem direto; para instalar em outro lugar converta para NSP/XCI.".into());
        }
    }
    if out.regions.is_empty() {
        if let Some(s) = out.serial.clone() {
            if let Some(r) = region_from_sony_serial(&s) {
                out.regions.push(r.into());
                out.region_source = Some("serial".into());
            }
        }
    }
    if out.title.is_empty() {
        if let Some(t) = &out.header_title {
            out.title = t.clone();
        }
    }
    out.format_kind = kind_for_format(&out.format).into();
    out
}

/// .iso / .bin / .img: Nintendo, Sega, Xbox, PlayStation, Wii U, Genesis cart.
fn identify_disc(f: &mut File, head: &[u8], size: u64, ext: &str) -> Option<HeaderInfo> {
    if let Some(mut h) = parse_nintendo_disc_container(head) {
        if h.format.as_deref() == Some("iso") && ext != "iso" {
            h.format = Some(ext.to_string());
        }
        return Some(h);
    }
    if let Some(mut h) = parse_sega_disc(head) {
        h.format = Some(ext.to_string());
        return Some(h);
    }
    // a raw 2352 Sega CD / Saturn bin keeps the header at 0x10 of the first sector (handled above)
    if ext == "bin" && size <= 64 * 1024 * 1024 {
        if let Some(mut h) = parse_genesis(head) {
            h.format = Some("bin".into());
            return Some(h);
        }
    }
    if let Some(mut src) = ImageSource::detect(&mut *f) {
        if let Some(mut h) = identify_iso9660(&mut src) {
            h.format = Some(ext.to_string());
            return Some(h);
        }
    }
    if let Some(mut h) = identify_xiso(f, size) {
        h.format = Some(ext.to_string());
        return Some(h);
    }
    None
}

/// Identifies a path: game folder, file, or `None` for an ordinary folder.
pub fn identify_path(path: &Path) -> Option<IdentifiedFile> {
    if path.is_dir() {
        identify_dir(path)
    } else {
        Some(identify_file(path))
    }
}

// ---------------------------------------------------------------------------
// Tests (synthetic headers)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mc-ident-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(path: &Path, data: &[u8]) {
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).unwrap();
        }
        let mut f = File::create(path).unwrap();
        f.write_all(data).unwrap();
    }

    // ---- file names ----

    #[test]
    fn no_intro_tags() {
        let n = parse_name_tags("Legend of Zelda, The - Majora's Mask (USA) (En,Fr) (Rev 1)");
        assert_eq!(n.title, "The Legend of Zelda - Majora's Mask");
        assert_eq!(n.regions, vec!["USA"]);
        assert_eq!(n.languages, vec!["En", "Fr"]);
        assert_eq!(n.revision.as_deref(), Some("Rev 1"));
    }

    #[test]
    fn redump_multi_region_and_disc() {
        let n = parse_name_tags("Final Fantasy VII (USA, Europe) (Disc 2)");
        assert_eq!(n.regions, vec!["USA", "Europe"]);
        assert_eq!(n.disc, Some(2));
        assert_eq!(n.title, "Final Fantasy VII");
    }

    #[test]
    fn goodtools_and_flags() {
        let n = parse_name_tags("Super Mario 64 (JU) [!]");
        assert_eq!(n.regions, vec!["Japan", "USA"]);
        assert!(n.flags.contains(&"verified".to_string()));
        let t = parse_name_tags("Chrono Trigger (U) [T+Por]");
        assert!(t.flags.contains(&"translation".to_string()));
        assert_eq!(t.regions, vec!["USA"]);
        let b = parse_name_tags("Some Game (Brazil) (Beta)");
        assert_eq!(b.regions, vec!["Brazil"]);
        assert!(b.flags.contains(&"beta".to_string()));
    }

    #[test]
    fn switch_title_id_from_name() {
        let n = parse_name_tags("Super Mario Odyssey [0100000000010000][v0][US]");
        assert_eq!(n.title_id.as_deref(), Some("0100000000010000"));
        assert_eq!(n.regions, vec!["USA"]);
        assert_eq!(n.title, "Super Mario Odyssey");
        assert_eq!(switch_title_kind("0100000000010800"), "update");
        assert_eq!(switch_title_kind("0100000000011001"), "dlc");
        assert_eq!(switch_title_kind("0100000000010000"), "base");
    }

    #[test]
    fn serial_regions() {
        assert_eq!(region_from_sony_serial("SLUS-20062"), Some("USA"));
        assert_eq!(region_from_sony_serial("SLES-50330"), Some("Europe"));
        assert_eq!(region_from_sony_serial("SLPM-65001"), Some("Japan"));
        assert_eq!(region_from_sony_serial("ULUS-10041"), Some("USA"));
        assert_eq!(region_from_sony_serial("BLES-00229"), Some("Europe"));
        assert_eq!(region_from_sony_serial("NPJB-00012"), Some("Japan"));
        assert_eq!(region_from_nintendo_code('E'), Some("USA"));
        assert_eq!(region_from_nintendo_code('P'), Some("Europe"));
        assert_eq!(region_from_nintendo_code('J'), Some("Japan"));
        assert_eq!(normalize_sony_serial("SLUS_200.62"), "SLUS-20062");
    }

    #[test]
    fn xex_region_mask() {
        assert_eq!(regions_from_xex_mask(0xFFFF_FFFF), vec!["Region Free"]);
        assert_eq!(regions_from_xex_mask(0x0000_00FF), vec!["USA"]);
        assert_eq!(regions_from_xex_mask(0x00FE_0000), vec!["Europe"]);
        assert_eq!(regions_from_xex_mask(0x0000_01FF), vec!["USA", "Japan"]);
    }

    // ---- cartridges ----

    fn n64_rom(order: &str) -> Vec<u8> {
        let mut b = vec![0u8; 0x1000];
        b[0..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
        b[0x20..0x20 + 11].copy_from_slice(b"ZELDA MAJOR");
        b[0x3B..0x3F].copy_from_slice(b"NZSE");
        match order {
            "v64" => {
                for c in b.chunks_exact_mut(2) {
                    c.swap(0, 1);
                }
            }
            "n64" => {
                for c in b.chunks_exact_mut(4) {
                    c.reverse();
                }
            }
            _ => {}
        }
        b
    }

    #[test]
    fn n64_all_byte_orders() {
        for order in ["z64", "v64", "n64"] {
            let h = parse_n64(&n64_rom(order)).expect(order);
            assert_eq!(h.platform, Some("n64"));
            assert_eq!(h.format.as_deref(), Some(order));
            assert_eq!(h.serial.as_deref(), Some("NZSE"));
            assert_eq!(h.regions, vec!["USA"]);
            assert_eq!(h.title.as_deref(), Some("ZELDA MAJOR"));
        }
        let mut v = n64_rom("v64");
        n64_to_z64(&mut v, "v64");
        assert_eq!(v, n64_rom("z64"));
        let mut n = n64_rom("n64");
        n64_to_z64(&mut n, "n64");
        assert_eq!(n, n64_rom("z64"));
    }

    #[test]
    fn gba_nds_gb_headers() {
        let mut gba = vec![0u8; 0x200];
        gba[4..8].copy_from_slice(&NINTENDO_LOGO_START);
        gba[0xB2] = 0x96;
        gba[0xA0..0xA0 + 7].copy_from_slice(b"POKEMON");
        gba[0xAC..0xB0].copy_from_slice(b"BPEP");
        let h = parse_gba(&gba).unwrap();
        assert_eq!(h.regions, vec!["Europe"]);
        assert_eq!(h.serial.as_deref(), Some("AGB-BPEP"));

        let mut nds = vec![0u8; 0x200];
        nds[0xC0..0xC4].copy_from_slice(&NINTENDO_LOGO_START);
        nds[0..8].copy_from_slice(b"NEW MARI");
        nds[0x0C..0x10].copy_from_slice(b"A2DJ");
        let h = parse_nds(&nds).unwrap();
        assert_eq!(h.platform, Some("nds"));
        assert_eq!(h.regions, vec!["Japan"]);

        let mut gb = vec![0u8; 0x200];
        gb[0x104..0x108].copy_from_slice(&[0xCE, 0xED, 0x66, 0x66]);
        gb[0x143] = 0xC0;
        gb[0x14A] = 1;
        assert_eq!(parse_gb(&gb).unwrap().platform, Some("gbc"));
    }

    #[test]
    fn snes_lorom_header() {
        let mut b = vec![0u8; 0x8000];
        let o = 0x7FC0;
        b[o..o + 11].copy_from_slice(b"SUPER MARIO");
        b[o + 0x19] = 1;
        b[o + 0x1C..o + 0x1E].copy_from_slice(&0x1234u16.to_le_bytes());
        b[o + 0x1E..o + 0x20].copy_from_slice(&(0x1234u16 ^ 0xFFFF).to_le_bytes());
        let h = parse_snes(&b, 0x80000).unwrap();
        assert_eq!(h.regions, vec!["USA"]);
        assert_eq!(h.title.as_deref(), Some("SUPER MARIO"));
    }

    #[test]
    fn genesis_header() {
        let mut b = vec![0u8; 0x200];
        b[0x100..0x110].copy_from_slice(b"SEGA GENESIS    ");
        b[0x150..0x160].copy_from_slice(b"SONIC THE HEDGEH");
        b[0x1F0..0x1F3].copy_from_slice(b"JUE");
        let h = parse_genesis(&b).unwrap();
        assert_eq!(h.platform, Some("genesis"));
        assert_eq!(h.regions, vec!["USA", "Europe", "Japan"]);
    }

    // ---- Nintendo discs ----

    fn gc_header(id: &[u8; 6], wii: bool) -> Vec<u8> {
        let mut b = vec![0u8; 0x400];
        b[0..6].copy_from_slice(id);
        if wii {
            b[0x18..0x1C].copy_from_slice(&WII_MAGIC.to_be_bytes());
        } else {
            b[0x1C..0x20].copy_from_slice(&GC_MAGIC.to_be_bytes());
        }
        b[0x20..0x20 + 13].copy_from_slice(b"Zelda TP Test");
        b
    }

    #[test]
    fn gamecube_and_wii_magic() {
        let h = parse_nintendo_disc_container(&gc_header(b"GZ2E01", false)).unwrap();
        assert_eq!(h.platform, Some("gamecube"));
        assert_eq!(h.serial.as_deref(), Some("GZ2E01"));
        assert_eq!(h.regions, vec!["USA"]);
        let w = parse_nintendo_disc_container(&gc_header(b"RZDP01", true)).unwrap();
        assert_eq!(w.platform, Some("wii"));
        assert_eq!(w.regions, vec!["Europe"]);
    }

    #[test]
    fn rvz_and_wbfs_containers() {
        let mut rvz = vec![0u8; 0x400];
        rvz[0..4].copy_from_slice(b"RVZ\x01");
        rvz[0x58..0x58 + 0x100].copy_from_slice(&gc_header(b"GZ2J01", false)[..0x100]);
        let h = parse_nintendo_disc_container(&rvz).unwrap();
        assert_eq!(h.format.as_deref(), Some("rvz"));
        assert_eq!(h.platform, Some("gamecube"));
        assert_eq!(h.regions, vec!["Japan"]);

        let mut wbfs = vec![0u8; 0x400];
        wbfs[0..4].copy_from_slice(b"WBFS");
        wbfs[8] = 9; // 512-byte sectors
        wbfs[0x200..0x300].copy_from_slice(&gc_header(b"RMGE01", true)[..0x100]);
        let h = parse_nintendo_disc_container(&wbfs).unwrap();
        assert_eq!(h.format.as_deref(), Some("wbfs"));
        assert_eq!(h.serial.as_deref(), Some("RMGE01"));
    }

    // ---- PlayStation ISO 9660 ----

    /// Builds a minimal ISO 9660 with one file in the root.
    fn iso_with_file(name: &str, content: &[u8], system_id: &str) -> Vec<u8> {
        let mut iso = vec![0u8; 2048 * 24];
        let pvd = 16 * 2048;
        iso[pvd] = 1;
        iso[pvd + 1..pvd + 6].copy_from_slice(b"CD001");
        iso[pvd + 8..pvd + 8 + system_id.len()].copy_from_slice(system_id.as_bytes());
        iso[pvd + 40..pvd + 44].copy_from_slice(b"GAME");
        // root dir record at 156: lba 20, size 2048
        let r = pvd + 156;
        iso[r] = 34;
        iso[r + 2..r + 6].copy_from_slice(&20u32.to_le_bytes());
        iso[r + 10..r + 14].copy_from_slice(&2048u32.to_le_bytes());
        iso[r + 25] = 2;
        // root directory: ".", "..", file
        let d = 20 * 2048;
        let mut p = d;
        for special in [0u8, 1u8] {
            iso[p] = 34;
            iso[p + 2..p + 6].copy_from_slice(&20u32.to_le_bytes());
            iso[p + 25] = 2;
            iso[p + 32] = 1;
            iso[p + 33] = special;
            p += 34;
        }
        let fname = format!("{};1", name);
        let len = 33 + fname.len() + (33 + fname.len()) % 2;
        iso[p] = len as u8;
        iso[p + 2..p + 6].copy_from_slice(&22u32.to_le_bytes());
        iso[p + 10..p + 14].copy_from_slice(&(content.len() as u32).to_le_bytes());
        iso[p + 32] = fname.len() as u8;
        iso[p + 33..p + 33 + fname.len()].copy_from_slice(fname.as_bytes());
        let fd = 22 * 2048;
        iso[fd..fd + content.len()].copy_from_slice(content);
        iso
    }

    #[test]
    fn ps2_system_cnf() {
        let iso = iso_with_file("SYSTEM.CNF", b"BOOT2 = cdrom0:\\SLUS_200.62;1\r\nVER = 1.00\r\n", "PLAYSTATION");
        let mut src = ImageSource::detect(Cursor::new(iso)).unwrap();
        let h = identify_iso9660(&mut src).unwrap();
        assert_eq!(h.platform, Some("ps2"));
        assert_eq!(h.serial.as_deref(), Some("SLUS-20062"));
        assert_eq!(h.regions, vec!["USA"]);
    }

    #[test]
    fn ps1_system_cnf_and_raw_bin() {
        let iso = iso_with_file("SYSTEM.CNF", b"BOOT = cdrom:\\SCES_003.44;1\r\n", "PLAYSTATION");
        // convert to raw MODE2 2352-byte sectors
        let mut raw = Vec::new();
        for s in iso.chunks(2048) {
            let mut sec = vec![0u8; 2352];
            sec[1..11].iter_mut().for_each(|b| *b = 0xFF);
            sec[15] = 2;
            sec[24..24 + 2048].copy_from_slice(s);
            raw.extend_from_slice(&sec);
        }
        let mut src = ImageSource::detect(Cursor::new(raw)).unwrap();
        let h = identify_iso9660(&mut src).unwrap();
        assert_eq!(h.platform, Some("ps1"));
        assert_eq!(h.serial.as_deref(), Some("SCES-00344"));
        assert_eq!(h.regions, vec!["Europe"]);
    }

    #[test]
    fn psp_umd_data_and_cso() {
        let iso = iso_with_file("UMD_DATA.BIN", b"ULES-00151|0001|G|", "PSP GAME");
        let mut src = ImageSource::detect(Cursor::new(iso.clone())).unwrap();
        let h = identify_iso9660(&mut src).unwrap();
        assert_eq!(h.platform, Some("psp"));
        assert_eq!(h.serial.as_deref(), Some("ULES-00151"));
        assert_eq!(h.regions, vec!["Europe"]);

        // same image as a CSO (all blocks stored uncompressed, align 0)
        let blocks = iso.len() / 2048;
        let mut cso = vec![0u8; 0x18 + (blocks + 1) * 4];
        cso[0..4].copy_from_slice(b"CISO");
        cso[4..8].copy_from_slice(&0x18u32.to_le_bytes());
        cso[8..16].copy_from_slice(&(iso.len() as u64).to_le_bytes());
        cso[16..20].copy_from_slice(&2048u32.to_le_bytes());
        cso[20] = 1;
        let data_start = cso.len();
        for i in 0..=blocks {
            let off = (data_start + i * 2048) as u32 | 0x8000_0000;
            cso[0x18 + i * 4..0x18 + i * 4 + 4].copy_from_slice(&off.to_le_bytes());
        }
        cso.extend_from_slice(&iso);
        let mut src = CsoSource::open(Cursor::new(cso)).unwrap();
        let h = identify_iso9660(&mut src).unwrap();
        assert_eq!(h.platform, Some("psp"));
    }

    #[test]
    fn ps3_disc_sfb() {
        let mut sfb = vec![0u8; 0x200];
        sfb[0..4].copy_from_slice(b".SFB");
        sfb[0x220 - 0x200..0x220 - 0x200 + 8].copy_from_slice(b"TITLE_ID");
        sfb[0x100..0x10A].copy_from_slice(b"BLUS-30443");
        // SFB stores "BLUS30443"; check both forms
        sfb[0x120..0x129].copy_from_slice(b"BLUS30443");
        let iso = iso_with_file("PS3_DISC.SFB", &sfb, "PS3");
        let mut src = ImageSource::detect(Cursor::new(iso)).unwrap();
        let h = identify_iso9660(&mut src).unwrap();
        assert_eq!(h.platform, Some("ps3"));
        assert_eq!(h.serial.as_deref(), Some("BLUS-30443"));
        assert_eq!(h.regions, vec!["USA"]);
    }

    // ---- Xbox ----

    fn xex_bytes(title_id: u32, regions: u32) -> Vec<u8> {
        let mut x = vec![0u8; 0x400];
        x[0..4].copy_from_slice(b"XEX2");
        x[0x10..0x14].copy_from_slice(&0x100u32.to_be_bytes()); // security info
        x[0x14..0x18].copy_from_slice(&1u32.to_be_bytes());
        x[0x18..0x1C].copy_from_slice(&0x0004_0006u32.to_be_bytes());
        x[0x1C..0x20].copy_from_slice(&0x40u32.to_be_bytes());
        x[0x40 + 0x0C..0x40 + 0x10].copy_from_slice(&title_id.to_be_bytes());
        x[0x40 + 0x12] = 1;
        x[0x40 + 0x13] = 1;
        let r = 0x100 + 0x178;
        x[r..r + 4].copy_from_slice(&regions.to_be_bytes());
        x
    }

    fn xiso(base: u64, exe_name: &str, exe: &[u8]) -> Vec<u8> {
        let mut iso = vec![0u8; (base + 0x10000 + 0x4000) as usize];
        let vd = (base + 0x10000) as usize;
        iso[vd..vd + 20].copy_from_slice(XDVDFS_MAGIC);
        let root_sector = 0x21u32; // 0x10800 relative
        iso[vd + 20..vd + 24].copy_from_slice(&root_sector.to_le_bytes());
        iso[vd + 24..vd + 28].copy_from_slice(&2048u32.to_le_bytes());
        let dir = (base + root_sector as u64 * 2048) as usize;
        let file_sector = 0x22u32;
        // left, right (u16), sector, size, attr, name len, name
        iso[dir + 4..dir + 8].copy_from_slice(&file_sector.to_le_bytes());
        iso[dir + 8..dir + 12].copy_from_slice(&(exe.len() as u32).to_le_bytes());
        iso[dir + 12] = 0x20;
        iso[dir + 13] = exe_name.len() as u8;
        iso[dir + 14..dir + 14 + exe_name.len()].copy_from_slice(exe_name.as_bytes());
        let fo = (base + file_sector as u64 * 2048) as usize;
        iso[fo..fo + exe.len()].copy_from_slice(exe);
        iso
    }

    #[test]
    fn xbox360_xiso_title_id_and_region() {
        let d = tmp_dir("x360");
        let p = d.join("Halo 3.iso");
        write(&p, &xiso(0, "default.xex", &xex_bytes(0x4D5307E6, 0x00FF_00FF)));
        let id = identify_file(&p);
        assert_eq!(id.platform.as_deref(), Some("xbox360"));
        assert_eq!(id.serial.as_deref(), Some("4D5307E6"));
        assert_eq!(id.regions, vec!["USA", "Europe"]);
        assert_eq!(id.confidence, "header");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn xbox360_xgd3_offset() {
        let d = tmp_dir("xgd3");
        let p = d.join("game.iso");
        write(&p, &xiso(0x0208_0000, "default.xex", &xex_bytes(0x41560817, 0xFFFF_FFFF)));
        let id = identify_file(&p);
        assert_eq!(id.platform.as_deref(), Some("xbox360"));
        assert_eq!(id.regions, vec!["Region Free"]);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn xbox_original_xbe() {
        let mut xbe = vec![0u8; 0x400];
        xbe[0..4].copy_from_slice(b"XBEH");
        xbe[0x104..0x108].copy_from_slice(&0x10000u32.to_le_bytes());
        xbe[0x118..0x11C].copy_from_slice(&0x10200u32.to_le_bytes());
        let c = 0x200;
        let tid: u32 = (b'M' as u32) << 24 | (b'S' as u32) << 16 | 4;
        xbe[c + 8..c + 12].copy_from_slice(&tid.to_le_bytes());
        for (i, ch) in "Halo".encode_utf16().enumerate() {
            xbe[c + 0xC + i * 2..c + 0xC + i * 2 + 2].copy_from_slice(&ch.to_le_bytes());
        }
        xbe[c + 0xA0..c + 0xA4].copy_from_slice(&1u32.to_le_bytes());
        let (t, name, regions) = parse_xbe(&xbe).unwrap();
        assert_eq!(t.as_deref(), Some("MS-004"));
        assert_eq!(name.as_deref(), Some("Halo"));
        assert_eq!(regions, vec!["USA"]);

        let d = tmp_dir("xbe");
        let p = d.join("Halo.iso");
        write(&p, &xiso(0, "default.xbe", &xbe));
        let id = identify_file(&p);
        assert_eq!(id.platform.as_deref(), Some("xbox"));
        assert_eq!(id.serial.as_deref(), Some("MS-004"));
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn xbox360_folders() {
        let d = tmp_dir("folders");
        let ext = d.join("Halo 3 (USA)");
        write(&ext.join("default.xex"), &xex_bytes(0x4D5307E6, 0xFF));
        let id = identify_dir(&ext).unwrap();
        assert_eq!(id.format, "xex-folder");
        assert_eq!(id.platform.as_deref(), Some("xbox360"));
        assert_eq!(id.regions, vec!["USA"]);

        let god = d.join("4D5307E6");
        let mut con = vec![0u8; 0x600];
        con[0..4].copy_from_slice(b"LIVE");
        con[0x360..0x364].copy_from_slice(&0x4D5307E6u32.to_be_bytes());
        for (i, ch) in "Halo 3".encode_utf16().enumerate() {
            con[0x411 + i * 2..0x411 + i * 2 + 2].copy_from_slice(&ch.to_be_bytes());
        }
        write(&god.join("00007000").join("ABCDEF0123456789ABCDEF0123456789ABCDEF01"), &con);
        let g = identify_dir(&god).unwrap();
        assert_eq!(g.format, "god");
        assert_eq!(g.header_title.as_deref(), Some("Halo 3"));
        assert_eq!(g.title, "Halo 3");

        assert!(identify_dir(&d.join("4D5307E6").join("00007000")).is_none());
        let _ = fs::remove_dir_all(d);
    }

    // ---- Switch / Sony packages / 3DS / CHD ----

    #[test]
    fn nsp_pfs0_ticket_title_id() {
        let names = ["0100000000010000000000000000000a.tik", "abc.ncz"];
        let mut table = Vec::new();
        let mut offs = Vec::new();
        for n in names {
            offs.push(table.len() as u32);
            table.extend_from_slice(n.as_bytes());
            table.push(0);
        }
        let mut b = vec![0u8; 0x10 + names.len() * 0x18];
        b[0..4].copy_from_slice(b"PFS0");
        b[4..8].copy_from_slice(&(names.len() as u32).to_le_bytes());
        b[8..12].copy_from_slice(&(table.len() as u32).to_le_bytes());
        for (i, o) in offs.iter().enumerate() {
            b[0x10 + i * 0x18 + 0x10..0x10 + i * 0x18 + 0x14].copy_from_slice(&o.to_le_bytes());
        }
        b.extend_from_slice(&table);
        let (nsz, tid, _) = parse_pfs0(&b).unwrap();
        assert!(nsz);
        assert_eq!(tid.as_deref(), Some("0100000000010000"));
    }

    #[test]
    fn sfo_pbp_pkg() {
        // PARAM.SFO with TITLE and DISC_ID
        let keys = b"CATEGORY\0DISC_ID\0TITLE\0";
        let vals: [&[u8]; 3] = [b"ME\0\0", b"SCUS94163\0\0\0", b"Final Fantasy VII\0\0\0"];
        let mut sfo = vec![0u8; 0x14 + 3 * 16];
        sfo[0..4].copy_from_slice(b"\0PSF");
        let kt = sfo.len() as u32;
        let dt = kt + keys.len() as u32;
        sfo[8..12].copy_from_slice(&kt.to_le_bytes());
        sfo[12..16].copy_from_slice(&dt.to_le_bytes());
        sfo[16..20].copy_from_slice(&3u32.to_le_bytes());
        let key_offs = [0u16, 9, 17];
        let mut doff = 0u32;
        for i in 0..3 {
            let e = 0x14 + i * 16;
            sfo[e..e + 2].copy_from_slice(&key_offs[i].to_le_bytes());
            sfo[e + 2..e + 4].copy_from_slice(&0x0204u16.to_le_bytes());
            sfo[e + 4..e + 8].copy_from_slice(&(vals[i].len() as u32).to_le_bytes());
            sfo[e + 12..e + 16].copy_from_slice(&doff.to_le_bytes());
            doff += vals[i].len() as u32;
        }
        sfo.extend_from_slice(keys);
        for v in vals {
            sfo.extend_from_slice(v);
        }
        let mut pbp = vec![0u8; 0x28];
        pbp[0..4].copy_from_slice(b"\0PBP");
        pbp[8..12].copy_from_slice(&0x28u32.to_le_bytes());
        pbp[12..16].copy_from_slice(&((0x28 + sfo.len()) as u32).to_le_bytes());
        pbp.extend_from_slice(&sfo);
        let h = parse_pbp(&pbp).unwrap();
        assert_eq!(h.platform, Some("ps1"));
        assert_eq!(h.serial.as_deref(), Some("SCUS-94163"));
        assert_eq!(h.title.as_deref(), Some("Final Fantasy VII"));
        assert_eq!(h.regions, vec!["USA"]);

        let mut pkg = vec![0u8; 0x100];
        pkg[0..4].copy_from_slice(&[0x7F, b'C', b'N', b'T']);
        pkg[0x40..0x40 + 36].copy_from_slice(b"EP9000-CUSA01127_00-PTEASER000000000");
        let h = parse_pkg(&pkg).unwrap();
        assert_eq!(h.platform, Some("ps4"));
        assert_eq!(h.serial.as_deref(), Some("CUSA01127"));
        assert_eq!(h.regions, vec!["Europe"]);
    }

    #[test]
    fn three_ds_ncsd() {
        let mut b = vec![0u8; 0x4400];
        b[0x100..0x104].copy_from_slice(b"NCSD");
        b[0x120..0x124].copy_from_slice(&0x20u32.to_le_bytes()); // 0x20 * 0x200 = 0x4000
        b[0x4100..0x4104].copy_from_slice(b"NCCH");
        b[0x4150..0x4150 + 10].copy_from_slice(b"CTR-P-AREE");
        b[0x418F] = 0x04; // NoCrypto
        let h = parse_3ds(&b).unwrap();
        assert_eq!(h.serial.as_deref(), Some("CTR-P-AREE"));
        assert_eq!(h.regions, vec!["USA"]);
        assert!(!h.flags.contains(&"encrypted".to_string()));
    }

    #[test]
    fn chd_metadata_gdrom() {
        let d = tmp_dir("chd");
        let p = d.join("game.chd");
        let mut b = vec![0u8; 0x200];
        b[0..8].copy_from_slice(b"MComprHD");
        b[0x0C..0x10].copy_from_slice(&5u32.to_be_bytes());
        b[0x30..0x38].copy_from_slice(&0x100u64.to_be_bytes());
        b[0x100..0x104].copy_from_slice(b"CHGT");
        write(&p, &b);
        let id = identify_file(&p);
        assert_eq!(id.platform.as_deref(), Some("dreamcast"));
        assert_eq!(id.format, "chd");
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn cue_and_gdi_companions() {
        let cue = "FILE \"Game (Track 1).bin\" BINARY\n  TRACK 01 MODE2/2352\nFILE \"Game (Track 2).bin\" BINARY\n";
        assert_eq!(cue_files(cue), vec!["Game (Track 1).bin", "Game (Track 2).bin"]);
        let gdi = "3\n1 0 4 2352 track01.bin 0\n2 600 0 2352 \"track 02.raw\" 0\n3 45000 4 2352 track03.bin 0\n";
        assert_eq!(gdi_files(gdi), vec!["track01.bin", "track 02.raw", "track03.bin"]);
    }

    #[test]
    fn archive_platform_guess() {
        let e = vec![ArchiveEntryInfo { name: "Super Mario 64 (USA).z64".into(), size: 8 << 20 }];
        assert_eq!(platform_from_entries(&e), Some("n64"));
        let arcade: Vec<ArchiveEntryInfo> = (0..6).map(|i| ArchiveEntryInfo { name: format!("sf2_{}.bin", i), size: 128 * 1024 }).collect();
        assert_eq!(platform_from_entries(&arcade), Some("arcade"));
    }

    #[test]
    fn identify_file_uses_folder_hint_for_ambiguous_chd() {
        let d = tmp_dir("hint");
        let p = d.join("PS2").join("Game (USA).chd");
        let mut b = vec![0u8; 0x200];
        b[0..8].copy_from_slice(b"MComprHD");
        b[0x0C..0x10].copy_from_slice(&5u32.to_be_bytes());
        write(&p, &b);
        let id = identify_file(&p);
        assert_eq!(id.platform.as_deref(), Some("ps2"));
        assert_eq!(id.confidence, "folder");
        assert_eq!(id.regions, vec!["USA"]);
        let _ = fs::remove_dir_all(d);
    }
}
