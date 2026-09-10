const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 8;
const TOKEN_BYTES = 24;
const HEX_RADIX = 16;
const HEX_CHAR_WIDTH = 2;

function generateId(prefix: string): string {
  let id = `${prefix}_`;
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length));
  }
  return id;
}

export function generateSessionId(): string {
  return generateId("ses");
}

export function generateQuestionId(): string {
  return generateId("q");
}

/**
 * Session URLs double as capabilities, so unlike ids these must be
 * unguessable: 192 bits from a CSPRNG, hex-encoded.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(HEX_RADIX).padStart(HEX_CHAR_WIDTH, "0")).join("");
}
