/**
 * QR CODES — A SMALL, DEPENDENCY-FREE ENCODER (V3 Phase F, spec §21)
 * ===========================================================================
 *
 * Every approved company gets a QR code that resolves to its PUBLIC company
 * page. Two decisions are worth stating up front, because both are about what
 * this file deliberately does not do.
 *
 * WHY NO NPM PACKAGE.
 * ------------------
 * The only thing the app needs is "turn one short https URL into a matrix of
 * black and white modules". That is byte mode, one error-correction level and
 * the low version range — perhaps 300 lines of well-specified arithmetic
 * (ISO/IEC 18004). Adding a dependency to the tree, the lockfile and the
 * supply chain for that is a poor trade in an app whose whole point is that
 * money rules are auditable in one place. So the encoder lives here, is pure
 * (no I/O, no clock, no randomness) and is verified against an INDEPENDENT
 * decoder in scripts/test/test_v3_social.ts: the test renders the matrix and
 * asserts the payload decodes back byte for byte.
 *
 * WHY IT IS AN INLINE SVG COMPUTED ON THE SERVER.
 * ----------------------------------------------
 * `companyQrSvg()` returns a string of SVG. It is rendered directly into the
 * page by a server component, so there is no image endpoint to hit, no file
 * written anywhere, no cache to invalidate and — the part that matters —
 * NOTHING THAT COULD RECORD A SCAN. A QR code in this app is a link, not a
 * tracking channel: there is no redirect hop, no per-scan token and no scan
 * table in the schema (spec §21, §53).
 *
 * WHAT A QR CODE MAY CONTAIN.
 * ---------------------------
 * `companyQrPayload()` is the ONLY way this app turns a company into a QR
 * payload, and it can return exactly one shape of string: the public profile
 * URL `<origin>/c/<username>`. It takes a username, not a company row, so
 * there is no balance, no order, no invoice and no transaction anywhere near
 * it — a private field cannot be leaked by a code path that never receives
 * one. Whether the code still WORKS is decided at scan time by the public
 * page itself: a revoked or destroyed company's page refuses, so an old
 * printed code stops resolving without anything having to be revoked here.
 *
 * SCOPE. Byte mode, error-correction level M, versions 1-10. That comfortably
 * covers any `https://host/c/<=24-char-username` URL; longer input throws
 * rather than silently producing something unscannable.
 */

export class QrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QrError";
  }
}

// ---------------------------------------------------------------------------
// Capacity tables (error-correction level M, versions 1-10)
// ---------------------------------------------------------------------------

type BlockSpec = {
  /** Error-correction codewords per block. */
  ecCodewords: number;
  /** [blockCount, dataCodewordsPerBlock] groups; the second group may be absent. */
  groups: [number, number][];
};

/** Index 0 is unused so the array index is the version number. */
const EC_LEVEL_M: (BlockSpec | null)[] = [
  null,
  { ecCodewords: 10, groups: [[1, 16]] },
  { ecCodewords: 16, groups: [[1, 28]] },
  { ecCodewords: 26, groups: [[1, 44]] },
  { ecCodewords: 18, groups: [[2, 32]] },
  { ecCodewords: 24, groups: [[2, 43]] },
  { ecCodewords: 16, groups: [[4, 27]] },
  { ecCodewords: 18, groups: [[4, 31]] },
  { ecCodewords: 22, groups: [[2, 38], [2, 39]] },
  { ecCodewords: 22, groups: [[3, 36], [2, 37]] },
  { ecCodewords: 26, groups: [[4, 43], [1, 44]] },
];

const MAX_VERSION = 10;

/** Alignment-pattern centre coordinates per version. */
const ALIGNMENT_CENTRES: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

function dataCapacityCodewords(version: number): number {
  const spec = EC_LEVEL_M[version];
  if (!spec) throw new QrError("Unsupported QR version.");
  return spec.groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

// ---------------------------------------------------------------------------
// GF(256) arithmetic for Reed-Solomon
// ---------------------------------------------------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    // Primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D).
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** The generator polynomial for `degree` error-correction codewords. */
function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = Uint8Array.from([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Error-correction codewords for one block of data codewords. */
function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const generator = rsGeneratorPoly(ecCount);
  const remainder = new Uint8Array(data.length + ecCount);
  remainder.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = remainder[i];
    if (factor === 0) continue;
    for (let j = 0; j < generator.length; j++) {
      remainder[i + j] ^= gfMul(generator[j], factor);
    }
  }
  return remainder.slice(data.length);
}

// ---------------------------------------------------------------------------
// Bit buffer
// ---------------------------------------------------------------------------

class BitBuffer {
  private bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  toCodewords(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    for (let i = 0; i < this.bits.length; i++) {
      if (this.bits[i]) out[i >>> 3] |= 0x80 >>> (i & 7);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function characterCountBits(version: number): number {
  // Byte mode: 8 bits for versions 1-9, 16 bits from version 10 up.
  return version <= 9 ? 8 : 16;
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const capacityBits = dataCapacityCodewords(version) * 8;
    const needed = 4 + characterCountBits(version) + byteLength * 8;
    if (needed <= capacityBits) return version;
  }
  throw new QrError("That value is too long to encode as a QR code here.");
}

/** Data codewords, padded and split into the version's interleaved blocks. */
function buildCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const spec = EC_LEVEL_M[version]!;
  const capacity = dataCapacityCodewords(version);

  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // byte mode
  buffer.push(bytes.length, characterCountBits(version));
  for (const byte of bytes) buffer.push(byte, 8);

  // Terminator: up to four zero bits, then pad to a byte boundary.
  const capacityBits = capacity * 8;
  const terminator = Math.min(4, capacityBits - buffer.length);
  buffer.push(0, terminator);
  if (buffer.length % 8 !== 0) buffer.push(0, 8 - (buffer.length % 8));

  const data = new Uint8Array(capacity);
  data.set(buffer.toCodewords());
  // Alternating pad codewords, as the standard specifies.
  for (let i = buffer.toCodewords().length; i < capacity; i++) {
    data[i] = (i - buffer.toCodewords().length) % 2 === 0 ? 0xec : 0x11;
  }

  // Split into blocks, compute EC per block, then interleave both sets.
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, size] of spec.groups) {
    for (let b = 0; b < count; b++) {
      const block = data.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, spec.ecCodewords));
    }
  }

  const out: number[] = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < spec.ecCodewords; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

type Matrix = {
  size: number;
  /** 1 = dark, 0 = light. */
  modules: Uint8Array;
  /** 1 = a function pattern that data placement and masking must not touch. */
  reserved: Uint8Array;
};

function newMatrix(size: number): Matrix {
  return { size, modules: new Uint8Array(size * size), reserved: new Uint8Array(size * size) };
}

function setModule(m: Matrix, row: number, col: number, dark: boolean, reserved = true): void {
  m.modules[row * m.size + col] = dark ? 1 : 0;
  if (reserved) m.reserved[row * m.size + col] = 1;
}

function isReserved(m: Matrix, row: number, col: number): boolean {
  return m.reserved[row * m.size + col] === 1;
}

function placeFinder(m: Matrix, row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= m.size || cc < 0 || cc >= m.size) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      setModule(m, rr, cc, inRing || inCore);
    }
  }
}

function placeAlignment(m: Matrix, version: number): void {
  const centres = ALIGNMENT_CENTRES[version];
  for (const row of centres) {
    for (const col of centres) {
      // Skip the three corners occupied by finder patterns.
      const last = m.size - 7;
      if ((row === 6 && col === 6) || (row === 6 && col === last) || (row === last && col === 6)) {
        continue;
      }
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          setModule(m, row + r, col + c, dark);
        }
      }
    }
  }
}

function placeTiming(m: Matrix): void {
  for (let i = 8; i < m.size - 8; i++) {
    const dark = i % 2 === 0;
    setModule(m, 6, i, dark);
    setModule(m, i, 6, dark);
  }
}

/** Marks the format-information cells so data placement skips them. */
function reserveFormatAreas(m: Matrix, version: number): void {
  for (let i = 0; i < 9; i++) {
    if (!isReserved(m, 8, i)) setModule(m, 8, i, false);
    if (!isReserved(m, i, 8)) setModule(m, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    setModule(m, 8, m.size - 1 - i, false);
    setModule(m, m.size - 1 - i, 8, false);
  }
  // The always-dark module below the top-left finder.
  setModule(m, m.size - 8, 8, true);

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const row = Math.floor(i / 3);
      const col = m.size - 11 + (i % 3);
      setModule(m, row, col, false);
      setModule(m, col, row, false);
    }
  }
}

/** BCH(15,5) format information for level M and the chosen mask. */
function formatInformationBits(mask: number): number {
  const levelM = 0b00;
  const data = (levelM << 3) | mask;
  let value = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((value >>> (i + 10)) & 1) value ^= 0b10100110111 << i;
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

/** BCH(18,6) version information, versions 7 and up. */
function versionInformationBits(version: number): number {
  let value = version << 12;
  for (let i = 5; i >= 0; i--) {
    if ((value >>> (i + 12)) & 1) value ^= 0b1111100100101 << i;
  }
  return (version << 12) | value;
}

function applyFormatInformation(m: Matrix, mask: number): void {
  const bits = formatInformationBits(mask);
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    // Copy 1, wrapped around the top-left finder: up column 8, then along
    // row 8. Bits 6 and 8 step over the two timing modules at (6,8)/(8,6).
    if (i < 6) setModule(m, i, 8, dark);
    else if (i === 6) setModule(m, 7, 8, dark);
    else if (i === 7) setModule(m, 8, 8, dark);
    else if (i === 8) setModule(m, 8, 7, dark);
    else setModule(m, 8, 14 - i, dark);

    // Copy 2, split between the other two finders.
    if (i < 8) setModule(m, 8, m.size - 1 - i, dark);
    else setModule(m, m.size - 15 + i, 8, dark);
  }
}

function applyVersionInformation(m: Matrix, version: number): void {
  if (version < 7) return;
  const bits = versionInformationBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = m.size - 11 + (i % 3);
    setModule(m, row, col, dark);
    setModule(m, col, row, dark);
  }
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: throw new QrError("Unknown QR mask pattern.");
  }
}

/** Zig-zag placement of the codeword bit stream into the free modules. */
function placeData(m: Matrix, codewords: Uint8Array, mask: number): void {
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  let upward = true;

  for (let right = m.size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern; the column pairing steps over
    // it entirely rather than pairing with it.
    if (right === 6) right = 5;
    for (let step = 0; step < m.size; step++) {
      const row = upward ? m.size - 1 - step : step;
      for (let offset = 0; offset < 2; offset++) {
        const col = right - offset;
        if (isReserved(m, row, col)) continue;
        let dark = false;
        if (bitIndex < totalBits) {
          dark = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
        if (maskBit(mask, row, col)) dark = !dark;
        setModule(m, row, col, dark, false);
      }
    }
    upward = !upward;
  }
}

/** The four standard penalty rules, used to pick the least ugly mask. */
function penalty(m: Matrix): number {
  const size = m.size;
  const at = (r: number, c: number) => m.modules[r * size + c];
  let score = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let i = 0; i < size; i++) {
    let rowRun = 1;
    let colRun = 1;
    for (let j = 1; j < size; j++) {
      rowRun = at(i, j) === at(i, j - 1) ? rowRun + 1 : 1;
      if (rowRun === 5) score += 3;
      else if (rowRun > 5) score += 1;
      colRun = at(j, i) === at(j - 1, i) ? colRun + 1 : 1;
      if (colRun === 5) score += 3;
      else if (colRun > 5) score += 1;
    }
  }

  // Rule 2: 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  // Rule 3: the 1:1:3:1:1 finder-like pattern with four light modules beside it.
  const a = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const b = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (get: (k: number) => number, start: number, pattern: number[]) => {
    for (let k = 0; k < pattern.length; k++) if (get(start + k) !== pattern[k]) return false;
    return true;
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      if (matches((k) => at(i, k), j, a) || matches((k) => at(i, k), j, b)) score += 40;
      if (matches((k) => at(k, i), j, a) || matches((k) => at(k, i), j, b)) score += 40;
    }
  }

  // Rule 4: deviation from a 50/50 dark/light balance.
  let dark = 0;
  for (let i = 0; i < size * size; i++) dark += m.modules[i];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Encodes `text` and returns the finished module matrix (no quiet zone).
 * Pure: the same input always produces the same matrix.
 */
export function encodeQr(
  text: string,
  forcedMask?: number,
): { size: number; modules: boolean[][]; version: number; mask: number } {
  if (typeof text !== "string" || text.length === 0) {
    throw new QrError("Nothing to encode.");
  }
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  const size = version * 4 + 17;

  let best: Matrix | null = null;
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;

  const masks =
    forcedMask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [forcedMask];
  for (const mask of masks) {
    const m = newMatrix(size);
    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);
    placeAlignment(m, version);
    placeTiming(m);
    reserveFormatAreas(m, version);
    placeData(m, codewords, mask);
    applyFormatInformation(m, mask);
    applyVersionInformation(m, version);

    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = m;
      bestMask = mask;
    }
  }

  const chosen = best!;
  const modules: boolean[][] = [];
  for (let r = 0; r < size; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < size; c++) row.push(chosen.modules[r * size + c] === 1);
    modules.push(row);
  }
  return { size, modules, version, mask: bestMask };
}

// ---------------------------------------------------------------------------
// SVG rendering
// ---------------------------------------------------------------------------

const QUIET_ZONE = 4;

/**
 * An inline SVG string for `text`.
 *
 * Deliberately plain: black modules on a white plate, `shape-rendering
 * crispEdges` so it stays sharp at any size, and one `<path>` rather than a
 * rect per module so the markup stays small. It uses the app's existing
 * colours and adds no new design language.
 */
export function renderQrSvg(
  text: string,
  options: { pixelSize?: number; title?: string; className?: string } = {},
): string {
  const { size, modules } = encodeQr(text);
  const total = size + QUIET_ZONE * 2;
  const pixelSize = options.pixelSize ?? 220;

  let path = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) path += `M${c + QUIET_ZONE} ${r + QUIET_ZONE}h1v1h-1z`;
    }
  }

  const titleMarkup = options.title
    ? `<title>${escapeXml(options.title)}</title>`
    : "";
  const classAttr = options.className ? ` class="${escapeXml(options.className)}"` : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixelSize}" height="${pixelSize}"` +
    ` viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img"` +
    ` aria-label="${escapeXml(options.title ?? "QR code")}"${classAttr}>` +
    titleMarkup +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#111111"/>` +
    `</svg>`
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// The only payload this app puts in a QR code
// ---------------------------------------------------------------------------

/**
 * The public profile URL for a company username — the entire contents of a
 * company QR code.
 *
 * It takes a USERNAME, not a company row, on purpose. A function that never
 * receives a balance, an order or a ledger row cannot leak one, so "the QR
 * code exposes only public information" is a property of the signature rather
 * than a rule someone has to remember (spec §21).
 */
export function companyQrPayload(origin: string, username: string): string {
  const handle = String(username).trim().toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(handle)) {
    throw new QrError("That is not a valid company username.");
  }
  const base = origin.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+$/i.test(base)) {
    throw new QrError("A QR code needs a valid site origin.");
  }
  return `${base}/c/${handle}`;
}

/** The inline SVG for a company's public-profile QR code. */
export function companyQrSvg(
  origin: string,
  username: string,
  options: { pixelSize?: number } = {},
): { svg: string; url: string } {
  const url = companyQrPayload(origin, username);
  return {
    url,
    svg: renderQrSvg(url, {
      pixelSize: options.pixelSize ?? 220,
      title: `QR code linking to @${username.toLowerCase()}`,
    }),
  };
}
