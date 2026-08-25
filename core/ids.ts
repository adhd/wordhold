// Ids are minted once at creation and never derived from content (AGENTS.md rule 3).

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomBase36(n: number): string {
  let out = "";
  while (out.length < n) {
    const buf = new Uint8Array(n * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // reject 252..255 so modulo 36 stays unbiased
      if (b < 252) {
        out += ALPHABET[b % 36];
        if (out.length === n) break;
      }
    }
  }
  return out;
}

export function mintItemId(): string {
  return "pt_" + randomBase36(10);
}

export function mintHighlightId(): string {
  return "hl_" + randomBase36(10);
}

export function mintCaptureContextId(): string {
  return "cx_" + randomBase36(10);
}
