const fs = require('fs');
const { PNG } = require('pngjs');

function convertCubeToPng(inputPath, outputPath) {
  const cubeData = fs.readFileSync(inputPath, 'utf8');
  const lines = cubeData.split('\n');

  let size = 0;
  const rgbValues = [];

  for (let line of lines) {
    line = line.trim();
    if (line.startsWith('LUT_3D_SIZE')) {
      size = parseInt(line.split(' ')[1], 10);
    } else if (/^[\d.-]+\s+[\d.-]+\s+[\d.-]+$/.test(line)) {
      rgbValues.push(line.split(/\s+/).map(Number));
    }
  }

  const gridCols = Math.ceil(Math.sqrt(size));
  const gridRows = Math.ceil(size / gridCols);
  const width = size * gridCols;
  const height = size * gridRows;

  const png = new PNG({ width, height });

  let i = 0;
  for (let b = 0; b < size; b++) {
    const gridX = b % gridCols;
    const gridY = Math.floor(b / gridCols);
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const idx = (width * (gridY * size + g) + (gridX * size + r)) * 4;
        const [red, green, blue] = rgbValues[i++];
        png.data[idx] = Math.max(0, Math.min(255, red * 255));
        png.data[idx + 1] = Math.max(0, Math.min(255, green * 255));
        png.data[idx + 2] = Math.max(0, Math.min(255, blue * 255));
        png.data[idx + 3] = 255;
      }
    }
  }

  png.pack().pipe(fs.createWriteStream(outputPath))
    .on('finish', () => console.log(`Success! Created ${outputPath}`));
}

// Make sure the file name matches your .cube file exactly
convertCubeToPng('Presetpro-Moody_Film.cube', 'moody_film.png');