/**
 * Instalação de APK pelo próprio app (Android), como um launcher de jogos:
 * 1. pede "Instalar apps desconhecidos" para o MemoryCard (só na primeira vez; abre a tela do sistema e volta),
 * 2. baixa o APK dentro do app, com progresso (download_apk_cmd, mesmo canal "install-progress"),
 * 3. entrega ao instalador do Android (PackageInstaller): aparece a confirmação do sistema e o resultado volta,
 * 4. registra o port como instalado ("android:<pacote>") para o card mostrar "Jogar".
 *
 * Plugin nativo: src-tauri/plugins/tauri-plugin-apk-installer. Fora do Android tudo responde "não suportado".
 */
import { invoke } from "@tauri-apps/api/core";
import type { InstalledPort } from "../types/ports";

const P = "plugin:apk-installer|";
const ANDROID_PREFIX = "android:";

export interface ApkInstallResult {
  installed: boolean;
  cancelled: boolean;
  packageName?: string | null;
  versionName?: string | null;
  message?: string | null;
}

/** Pacote Android de um port instalado por APK, ou null se não for esse o caso. */
export function androidPackageOf(inst?: Pick<InstalledPort, "executable_name"> | null): string | null {
  const exe = inst?.executable_name ?? "";
  return exe.startsWith(ANDROID_PREFIX) ? exe.slice(ANDROID_PREFIX.length) || null : null;
}

export const AndroidApk = {
  async canInstall(): Promise<boolean> {
    const r = await invoke<{ supported?: boolean; allowed?: boolean }>(`${P}can_install`);
    return r?.allowed === true;
  },

  /** Garante a permissão de instalar; abre a tela do sistema se faltar. Resolve false se o usuário não permitir. */
  async ensurePermission(): Promise<boolean> {
    if (await this.canInstall()) return true;
    const r = await invoke<{ allowed?: boolean }>(`${P}open_install_settings`);
    return r?.allowed === true;
  },

  /** Baixa o APK para o cache do app e devolve o caminho. */
  download(id: string, url: string, assetName?: string | null, sha256?: string | null): Promise<string> {
    return invoke<string>("download_apk_cmd", { id, url, assetName: assetName ?? null, sha256: sha256 ?? null });
  },

  /** Abre a confirmação do sistema; resolve depois que o usuário instala ou cancela. */
  install(path: string): Promise<ApkInstallResult> {
    return invoke<ApkInstallResult>(`${P}install`, { options: { path, deleteAfter: true } });
  },

  async isInstalled(packageName: string): Promise<boolean> {
    const r = await invoke<{ installed?: boolean }>(`${P}is_installed`, { options: { packageName } });
    return r?.installed === true;
  },

  async launch(packageName: string): Promise<boolean> {
    const r = await invoke<{ launched?: boolean }>(`${P}launch`, { options: { packageName } });
    return r?.launched === true;
  },

  async uninstall(packageName: string): Promise<boolean> {
    const r = await invoke<{ uninstalled?: boolean }>(`${P}uninstall`, { options: { packageName } });
    return r?.uninstalled === true;
  },

  register(portId: string, packageName: string, version?: string | null, assetName?: string | null): Promise<InstalledPort> {
    return invoke<InstalledPort>("register_android_package_cmd", {
      portId,
      packageName,
      version: version ?? null,
      assetName: assetName ?? null,
    });
  },
};
