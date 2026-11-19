/**
 * Normalize Windows/Unix file path for consistent cross-platform comparison
 */
export function normalizePath(p?: string): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").toLowerCase().trim();
}
