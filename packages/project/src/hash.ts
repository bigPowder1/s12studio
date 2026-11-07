/** Small non-cryptographic content hash (cyrb53 over two lanes) for change detection: 16 hex digits. */
export function hashBytes(b: Uint8Array): string {
  let h1 = 0xdeadbeef ^ b.length, h2 = 0x41c6ce57 ^ b.length;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export function hashText(s: string): string {
  return hashBytes(new TextEncoder().encode(s));
}
