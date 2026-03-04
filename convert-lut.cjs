/**
 * convert-lut.cjs
 *
 * Converts a standard .cube 3D LUT file into the 2D-grid PNG format that
 * LutFilterCanvas.tsx (WebGL) expects.
 *
 * Layout convention — must stay in sync with the fragment shader:
 *   • Blue  (B) axis  →  tile selection, tiles laid out left→right then top→bottom
 *   • Red   (R) axis  →  X position within each tile
 *   • Green (G) axis  →  Y position within each tile
 *   • Grid cols = ceil(√size),  grid rows = ceil(size / cols)
 *   • Image width  = size × cols
 *   • Image height = size × rows   (= size × cols for all standard LUT sizes)
 *
 * Run from the project root:
 *   node convert-lut.cjs
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

/**
 * Parse a .cube file and write a 2D-grid PNG to `outputPath`.
 * @param {string} inputPath   Path to the .cube file
 * @param {string} outputPath  Destination PNG path (directory is created if needed)
 */
function convertCubeToPng(inputPath, outputPath) {
  console.log(`\nConverting: ${inputPath}`);
  console.log(`       To: ${outputPath}`);

  // ── 1. Read & parse ──────────────────────────────────────────────────────
  let cubeData;
  try {
    cubeData = fs.readFileSync(inputPath, 'utf8');
  } catch (err) {
    console.error(`  ✗ Cannot read input file: ${err.message}`);
    return;
  }

  let size = 0;
  const rgbValues = [];

  for (let line of cubeData.split(/\r?\n/)) {
    line = line.trim();

    // Skip blank lines and comments
    if (!line || line.startsWith('#')) continue;

    // Parse LUT size
    if (line.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(/\s+/)[1], 10);
      continue;
    }

    // Explicitly skip known header keywords so we never accidentally
    // parse them as data (DOMAIN_MIN / DOMAIN_MAX have trailing numbers).
    if (
      line.startsWith('TITLE')      ||
      line.startsWith('DOMAIN_MIN') ||
      line.startsWith('DOMAIN_MAX') ||
      line.startsWith('LUT_1D_SIZE')
    ) continue;

    // Data line: exactly 3 whitespace-separated finite numbers.
    // Using Number() instead of a regex so that scientific notation
    // (e.g. 1.23e-05) is handled correctly.
    const parts = line.split(/\s+/);
    if (parts.length !== 3) continue;
    const nums = parts.map(Number);
    if (nums.some(n => !isFinite(n))) continue;

    rgbValues.push(nums);
  }

  // ── 2. Validate ───────────────────────────────────────────────────────────
  if (size === 0) {
    console.error('  ✗ LUT_3D_SIZE not found — is this a valid .cube file?');
    return;
  }

  const expected = size * size * size;
  if (rgbValues.length !== expected) {
    console.error(
      `  ✗ Data count mismatch: expected ${expected} entries for size=${size}, ` +
      `but parsed ${rgbValues.length}. Aborting to avoid a corrupt PNG.`
    );
    return;
  }

  // ── 3. Compute grid geometry ─────────────────────────────────────────────
  // Must exactly match detectLutParams() in LutFilterCanvas.tsx:
  //   cols = ceil(√size)
  //   rows = ceil(size / cols)
  // For all standard LUT sizes (8, 16, 25, 32, 64) cols === rows (square grid).
  const gridCols = Math.ceil(Math.sqrt(size));
  const gridRows = Math.ceil(size / gridCols);
  const width    = size * gridCols;
  const height   = size * gridRows;

  console.log(`  LUT_3D_SIZE: ${size}`);
  console.log(`  Grid: ${gridCols} cols × ${gridRows} rows  →  PNG ${width}×${height}`);

  // ── 4. Write pixels ───────────────────────────────────────────────────────
  // Standard .cube axis order: R varies fastest (innermost), B slowest (outermost).
  // Our loops mirror that order so rgbValues[i] is read in the same sequence.
  //
  // Shader UV → PNG pixel mapping:
  //   tile column  = blueIndex  % cols       gridX = b % gridCols
  //   tile row     = blueIndex  / cols        gridY = b / gridCols  (floor)
  //   pixel X      = gridX * size + redIndex
  //   pixel Y      = gridY * size + greenIndex
  //
  // Math.round() is essential: without it, typed-array truncation turns
  // 0.9999×255 = 254.97 into 254 instead of 255, introducing a systematic
  // darkening bias across the entire LUT.
  const png = new PNG({ width, height });
  let i = 0;

  for (let b = 0; b < size; b++) {
    const gridX = b % gridCols;
    const gridY = Math.floor(b / gridCols);

    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const pixelX = gridX * size + r;
        const pixelY = gridY * size + g;
        const idx = (width * pixelY + pixelX) * 4;

        const [red, green, blue] = rgbValues[i++];
        png.data[idx]     = Math.round(Math.max(0, Math.min(255, red   * 255)));
        png.data[idx + 1] = Math.round(Math.max(0, Math.min(255, green * 255)));
        png.data[idx + 2] = Math.round(Math.max(0, Math.min(255, blue  * 255)));
        png.data[idx + 3] = 255;
      }
    }
  }

  // ── 5. Write PNG ──────────────────────────────────────────────────────────
  const outDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  png.pack()
    .pipe(fs.createWriteStream(outputPath))
    .on('finish', () => console.log(`  ✓ Done → ${outputPath}`))
    .on('error',  (err) => console.error(`  ✗ Write error: ${err.message}`));
}

// ── Convert all LUTs ────────────────────────────────────────────────────────
// Output goes into public/ so Vite serves them at the URLs declared in data.ts.
// Run this script from the project root whenever a .cube file changes:
//   node convert-lut.cjs

convertCubeToPng('Presetpro-Moody_Film.cube', 'public/moody_film.png');
convertCubeToPng('Favebrown.cube',             'public/Favebrown.png');
