/**
 * parseCubeLut.ts
 *
 * Fetch and parse Adobe / DaVinci Resolve `.cube` 3D LUT files.
 *
 * .cube format summary
 * ──────────────────────────────────────────────────────────────────────────
 *  LUT_3D_SIZE N        — cube dimension (typically 16, 25, 32, or 64)
 *  N³ data lines        — each "R G B" output triplet in [0,1]
 *                         R varies fastest (innermost), B slowest (outermost)
 *  # comment lines,
 *  TITLE, DOMAIN_MIN,
 *  DOMAIN_MAX …         — silently skipped
 */

export interface CubeLut {
  /** Side length of the cube — total entries = size³ */
  size: number;

  /**
   * Flat Float32 RGB values in standard .cube axis order:
   *   index = (b * size + g) * size + r   (R fastest, B slowest)
   * Length: size * size * size * 3
   *
   * This layout maps directly to a WebGL2 TEXTURE_3D where
   *   X (width)  = R axis
   *   Y (height) = G axis
   *   Z (depth)  = B axis
   */
  data: Float32Array;
}

/**
 * Fetch `url`, parse it as a .cube file, and return the LUT.
 * Uses the browser's `fetch()` so the standard CORS / credential rules apply.
 */
export async function fetchParseCubeLut(url: string): Promise<CubeLut> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`LUT fetch failed for "${url}": HTTP ${res.status}`);
  }
  return parseCubeLut(await res.text());
}

/**
 * Parse raw .cube text synchronously.
 * Throws a descriptive error if the data is malformed or the entry count
 * doesn't match LUT_3D_SIZE³.
 */
export function parseCubeLut(text: string): CubeLut {
  let size = 0;
  const values: number[] = [];

  for (let raw of text.split(/\r?\n/)) {
    const line = raw.trim();

    // Blank lines and comments
    if (!line || line.startsWith('#')) continue;

    // LUT size declaration
    if (line.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }

    // Skip known header keywords that may end in numbers and could
    // accidentally pass the "three numbers" heuristic below.
    if (
      line.startsWith('TITLE')       ||
      line.startsWith('DOMAIN_MIN')  ||
      line.startsWith('DOMAIN_MAX')  ||
      line.startsWith('LUT_1D_SIZE') ||
      line.startsWith('LUT_')
    ) continue;

    // Data line: exactly three whitespace-separated finite floats.
    // Number() handles plain decimals *and* scientific notation (1.23e-05).
    const parts = line.split(/\s+/);
    if (parts.length !== 3) continue;
    const nums = parts.map(Number);
    if (nums.some((n) => !isFinite(n))) continue;

    values.push(nums[0], nums[1], nums[2]);
  }

  if (!size) {
    throw new Error('.cube parse error: LUT_3D_SIZE declaration not found');
  }

  const expectedValues = size * size * size * 3;
  if (values.length !== expectedValues) {
    throw new Error(
      `.cube parse error: expected ${expectedValues / 3} entries for ` +
      `LUT_3D_SIZE ${size}, but parsed ${values.length / 3}`
    );
  }

  return { size, data: new Float32Array(values) };
}
