/**
 * A tiny deterministic hash (FNV-1a 32bit) to avoid Node crypto dependency.
 * Output: 8-hex chars.
 */
export function fnv1a32(input: string): string {
  let h = 0x811c9dc5;
  const s = input ?? "";
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // h *= 16777619 (with 32-bit overflow)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

export function randomUUID(): string {
  const anyCrypto: any = (globalThis as any).crypto;
  if (anyCrypto?.randomUUID) return anyCrypto.randomUUID();

  // fallback: RFC4122 v4-ish
  const rnd = () => Math.floor(Math.random() * 0xffffffff);
  const a = rnd().toString(16).padStart(8, "0");
  const b = rnd().toString(16).padStart(8, "0");
  const c = rnd().toString(16).padStart(8, "0");
  const d = rnd().toString(16).padStart(8, "0");
  return `${a.slice(0, 8)}-${b.slice(0, 4)}-4${b.slice(5, 8)}-a${c.slice(1, 4)}-${c.slice(4, 8)}${d.slice(0, 4)}`;
}
