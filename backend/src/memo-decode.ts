import { createHash } from 'node:crypto';

/**
 * Decodes a Mina base58check-encoded user command memo (as returned by the
 * daemon's GraphQL `zkappCommands[].zkappCommand.memo` field) to its
 * human-readable UTF-8 text.
 *
 * Mina memo wire format (post base58check decode, 39 bytes total):
 *   - byte 0           : version (0x14 / 20 for userCommandMemo)
 *   - bytes 1..34      : raw memo payload (34 bytes)
 *       - byte 0       : 0x01 (string indicator)
 *       - byte 1       : text length n (0..32)
 *       - bytes 2..2+n : UTF-8 text
 *       - zero-padded to 34 bytes total
 *   - bytes 35..38     : checksum = first 4 bytes of sha256(sha256(v+payload))
 *
 * Returns null if the input isn't a valid Mina memo — callers can fall back
 * to storing the raw base58 so no data is lost.
 */

const B58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MINA_MEMO_VERSION = 20;
const B58_MAP = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < B58_ALPHABET.length; i++) m.set(B58_ALPHABET[i], i);
  return m;
})();

function base58Decode(s: string): Buffer {
  let num = 0n;
  for (const c of s) {
    const v = B58_MAP.get(c);
    if (v === undefined) throw new Error('invalid base58');
    num = num * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  // Leading '1' characters map to leading zero bytes.
  let leadingOnes = 0;
  for (const c of s) {
    if (c === '1') leadingOnes++;
    else break;
  }
  for (let i = 0; i < leadingOnes; i++) bytes.unshift(0);
  return Buffer.from(bytes);
}

function doubleSha256First4(buf: Buffer): Buffer {
  const h1 = createHash('sha256').update(buf).digest();
  const h2 = createHash('sha256').update(h1).digest();
  return h2.subarray(0, 4);
}

export function decodeMinaMemo(base58memo: string | null | undefined): string | null {
  if (!base58memo) return null;
  try {
    const decoded = base58Decode(base58memo);
    if (decoded.length !== 39) return null;
    if (decoded[0] !== MINA_MEMO_VERSION) return null;
    const versionAndPayload = decoded.subarray(0, 35);
    const checksum = decoded.subarray(35, 39);
    const expected = doubleSha256First4(versionAndPayload);
    if (!checksum.equals(expected)) return null;
    const payload = decoded.subarray(1, 35);
    if (payload[0] !== 0x01) return null;
    const len = payload[1];
    if (len > 32) return null;
    return payload.subarray(2, 2 + len).toString('utf-8');
  } catch {
    return null;
  }
}
