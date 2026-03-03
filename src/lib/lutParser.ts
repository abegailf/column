export interface ParsedLUT {
  size: number;
  data: Uint8Array;
}

export function parseCubeLUT(cubeText: string): ParsedLUT {
  const lines = cubeText.split('\n');
  let size = 0;
  const data: number[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    
    // Extract the 3D LUT size
    if (trimmed.startsWith('LUT_3D_SIZE')) {
      size = parseInt(trimmed.split(/\s+/)[1], 10);
    } 
    // Extract the RGB data points
    else if (
      trimmed.length > 0 &&
      !trimmed.startsWith('#') &&
      !/[a-zA-Z]/.test(trimmed.charAt(0))
    ) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 3) {
        const r = parseFloat(parts[0]);
        const g = parseFloat(parts[1]);
        const b = parseFloat(parts[2]);
        
        // Convert float [0.0, 1.0] to Uint8 [0, 255] for better mobile WebGL compatibility
        data.push(
          Math.max(0, Math.min(255, Math.round(r * 255))),
          Math.max(0, Math.min(255, Math.round(g * 255))),
          Math.max(0, Math.min(255, Math.round(b * 255)))
        );
      }
    }
  }

  return {
    size,
    data: new Uint8Array(data),
  };
}
