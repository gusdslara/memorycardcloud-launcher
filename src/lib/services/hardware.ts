/**
 * Descreve o aparelho para a avaliação de um port: "Ryzen 5 5600 · RTX 3060 · 16 GB · Windows 11".
 * CPU, memória e sistema vêm do Tauri (sysinfo); a placa de vídeo, do WebGL do próprio webview.
 */
import { invoke } from "@tauri-apps/api/core";

interface NativeHardware {
  cpu: string;
  cores: number;
  ram_gb: number;
  os: string;
}

/** Nome da GPU que o webview usa ("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 …)" → "NVIDIA GeForce RTX 3060"). */
export function gpuName(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const raw = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
    return cleanGpu(raw);
  } catch {
    return "";
  }
}

export function cleanGpu(raw: string): string {
  const angle = /^ANGLE \((?:[^,]+),\s*([^,]+?)(?:\s+(?:Direct3D|D3D|OpenGL|Vulkan|Metal)[^,]*)?(?:,|\))/i.exec(raw);
  const name = (angle?.[1] ?? raw).replace(/\(0x[0-9a-f]+\)/gi, "").replace(/\s+/g, " ").trim();
  return /^(webkit webgl|google swiftshader|mesa offscreen)$/i.test(name) ? "" : name;
}

export function shortCpu(cpu: string): string {
  return cpu
    .replace(/\((R|TM)\)/gi, "")
    .replace(/\b(CPU|Processor|with Radeon Graphics|\d+-Core)\b/gi, "")
    .replace(/@.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Linha de hardware pronta para a avaliação (o usuário pode editar antes de enviar). */
export async function describeHardware(): Promise<string> {
  let native: NativeHardware | null = null;
  try {
    native = await invoke<NativeHardware>("get_hardware_info_cmd");
  } catch {
    native = null; // fora do Tauri (dev no navegador)
  }
  const ram = native?.ram_gb || (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const parts = [native?.cpu ? shortCpu(native.cpu) : "", gpuName(), ram ? `${ram} GB` : "", native?.os ?? ""];
  return parts.filter(Boolean).join(" · ").slice(0, 300);
}
