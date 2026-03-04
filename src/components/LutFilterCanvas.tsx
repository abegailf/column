import React, { useEffect, useRef } from 'react';

const vertexShaderSource = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;

void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  // Flip Y coordinate because WebGL textures are uploaded upside-down relative to the DOM
  v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
}
`;

const fragmentShaderSource = `#version 300 es
precision highp float;
in vec2 v_texCoord;

uniform sampler2D u_image;
uniform sampler2D u_lut;
uniform bool u_hasLut;
// LUT geometry — set at runtime from the actual image dimensions so that
// LUT PNGs of different sizes (e.g. 192×192 / size=32 / cols=6, or
// 512×512 / size=64 / cols=8) all work without shader changes.
uniform float u_lutSize;
uniform float u_lutCols;

out vec4 outColor;

void main() {
  vec4 color = texture(u_image, v_texCoord);

  if (u_hasLut) {
    float size = u_lutSize;
    float cols = u_lutCols;

    vec3 c = clamp(color.rgb, 0.0, 1.0);
    float blueColor = c.b * (size - 1.0);

    // Find the two Z-depth quads to interpolate between
    vec2 quad1;
    quad1.y = floor(floor(blueColor) / cols);
    quad1.x = floor(blueColor) - (quad1.y * cols);

    vec2 quad2;
    quad2.y = floor(ceil(blueColor) / cols);
    quad2.x = ceil(blueColor) - (quad2.y * cols);

    float texWidth  = size * cols;
    float texHeight = size * cols;

    // Map Red/Green to X/Y inside the specific Z-depth quad
    vec2 texPos1;
    texPos1.x = (quad1.x * size + 0.5 + c.r * (size - 1.0)) / texWidth;
    texPos1.y = (quad1.y * size + 0.5 + c.g * (size - 1.0)) / texHeight;

    vec2 texPos2;
    texPos2.x = (quad2.x * size + 0.5 + c.r * (size - 1.0)) / texWidth;
    texPos2.y = (quad2.y * size + 0.5 + c.g * (size - 1.0)) / texHeight;

    // Sample both 2D positions and mix (trilinear interpolation via two bilinear samples)
    vec3 color1 = texture(u_lut, texPos1).rgb;
    vec3 color2 = texture(u_lut, texPos2).rgb;
    outColor = vec4(mix(color1, color2, fract(blueColor)), color.a);
  } else {
    outColor = color;
  }
}
`;

function createShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader) {
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  return program;
}

/**
 * Auto-detect LUT geometry from the image dimensions.
 *
 * Common square-grid formats:
 *   192×192  →  size=32, cols=6   (32 × ceil(√32)=6 = 192)
 *   512×512  →  size=64, cols=8   (64 × ceil(√64)=8 = 512)
 *    64×64   →  size=8,  cols=8   ( 8 × ceil(√8 )=3 = 24 — non-square strip)
 *
 * The rule: given a square LUT image of side W, find the largest `size`
 * in our candidate list where `size × ceil(√size) === W`.
 */
function detectLutParams(width: number, height: number): { size: number; cols: number } {
  const candidates = [64, 32, 16, 8];
  for (const size of candidates) {
    const cols = Math.ceil(Math.sqrt(size));
    if (size * cols === width && size * cols === height) {
      return { size, cols };
    }
  }
  // Fallback: derive cols from whatever image dimensions we got
  // (handles non-square-grid or unusual sizes gracefully).
  const size = Math.round(Math.cbrt(width * height));
  const cols = width / size;
  console.warn(`LutFilterCanvas: unrecognised LUT dimensions ${width}×${height}, guessing size=${size} cols=${cols}`);
  return { size, cols };
}

interface LutFilterCanvasProps {
  src: string;
  lutUrl?: string | null;
  className?: string;
  style?: React.CSSProperties;
}

export function LutFilterCanvas({ src, lutUrl, className, style }: LutFilterCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Flag to cancel the async image load when the effect is cleaned up
    // (React StrictMode double-invokes effects, and prop changes trigger
    // cleanup + re-run on the same canvas element).
    let cancelled = false;

    const gl = canvas.getContext('webgl2');
    if (!gl) {
      console.error('WebGL2 is not supported.');
      return;
    }

    // Clear immediately so the canvas never shows a stale/white frame
    // while the new image is loading.
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let imageTexture: WebGLTexture | null = null;
    let lutTexture: WebGLTexture | null = null;
    let program: WebGLProgram | null = null;
    let positionBuffer: WebGLBuffer | null = null;
    let texCoordBuffer: WebGLBuffer | null = null;
    let vao: WebGLVertexArrayObject | null = null;

    // Track blob URLs we create so we can revoke them on cleanup.
    const blobUrls: string[] = [];

    // Load an image via fetch → blob URL so WebGL can use it as a texture
    // without CORS restrictions.  Using fetch() avoids the browser-cache
    // CORS conflict that occurs when the same URL is first loaded by a plain
    // <img> (no crossOrigin attribute) and then re-requested with
    // crossOrigin="anonymous" for WebGL — in that case the browser may serve
    // the cached opaque response, which WebGL rejects as a security violation.
    const loadImage = async (url: string): Promise<HTMLImageElement> => {
      let imgSrc = url;

      if (!url.startsWith('blob:') && !url.startsWith('data:')) {
        // Fetch as blob to get a same-origin URL that WebGL trusts.
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch image (${response.status}): ${url}`);
        const blob = await response.blob();
        imgSrc = URL.createObjectURL(blob);
        blobUrls.push(imgSrc);
      }

      return new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = imgSrc;
      });
    };

    // Wait for both the user image and the LUT PNG to load
    Promise.all([
      loadImage(src),
      lutUrl ? loadImage(lutUrl) : Promise.resolve(null)
    ]).then(([image, lutImage]) => {
      // Bail out if the effect was cleaned up while we were loading.
      if (cancelled) return;

      const dpr = window.devicePixelRatio || 1;
      const maxWidth = 2048;
      let width = image.width;
      let height = image.height;

      if (width > maxWidth) {
        height = Math.floor(height * (maxWidth / width));
        width = maxWidth;
      }

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      // Re-clear after resize: assigning canvas.width/height resets ALL WebGL
      // state including the clear color, leaving the buffer indeterminate.
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

      const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
      const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
      if (!vertexShader || !fragmentShader) return;

      program = createProgram(gl, vertexShader, fragmentShader);
      if (!program) return;
      gl.useProgram(program);

      const positionAttributeLocation = gl.getAttribLocation(program, 'a_position');
      const texCoordAttributeLocation = gl.getAttribLocation(program, 'a_texCoord');

      positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1.0, -1.0,  1.0, -1.0, -1.0,  1.0,
        -1.0,  1.0,  1.0, -1.0,  1.0,  1.0,
      ]), gl.STATIC_DRAW);

      texCoordBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0.0, 0.0,  1.0, 0.0,  0.0, 1.0,
        0.0, 1.0,  1.0, 0.0,  1.0, 1.0,
      ]), gl.STATIC_DRAW);

      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      gl.enableVertexAttribArray(positionAttributeLocation);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

      gl.enableVertexAttribArray(texCoordAttributeLocation);
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.vertexAttribPointer(texCoordAttributeLocation, 2, gl.FLOAT, false, 0, 0);

      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      // Setup Base Image Texture
      imageTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, imageTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

      // Setup LUT Texture (Now using TEXTURE_2D)
      lutTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, lutTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      const hasLutLocation  = gl.getUniformLocation(program, 'u_hasLut');
      const lutSizeLocation = gl.getUniformLocation(program, 'u_lutSize');
      const lutColsLocation = gl.getUniformLocation(program, 'u_lutCols');

      if (lutImage) {
        // Derive size / cols from the actual LUT image so any future LUT
        // PNG (different resolution) works without touching the shader.
        const { size, cols } = detectLutParams(lutImage.naturalWidth, lutImage.naturalHeight);
        gl.uniform1i(hasLutLocation, 1);
        gl.uniform1f(lutSizeLocation, size);
        gl.uniform1f(lutColsLocation, cols);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, lutImage);
      } else {
        gl.uniform1i(hasLutLocation, 0);
        gl.uniform1f(lutSizeLocation, 32.0); // dummy values — u_hasLut=false means they're unused
        gl.uniform1f(lutColsLocation, 6.0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      }

      const imageLocation = gl.getUniformLocation(program, 'u_image');
      const lutLocation   = gl.getUniformLocation(program, 'u_lut');

      gl.uniform1i(imageLocation, 0);
      gl.uniform1i(lutLocation, 1);

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }).catch(err => {
      if (!cancelled) console.error('LutFilterCanvas render error:', err);
    });

    return () => {
      cancelled = true;
      // Revoke any blob URLs we created to free memory.
      blobUrls.forEach(u => URL.revokeObjectURL(u));
      if (gl) {
        if (imageTexture) gl.deleteTexture(imageTexture);
        if (lutTexture) gl.deleteTexture(lutTexture);
        if (positionBuffer) gl.deleteBuffer(positionBuffer);
        if (texCoordBuffer) gl.deleteBuffer(texCoordBuffer);
        if (vao) gl.deleteVertexArray(vao);
        if (program) gl.deleteProgram(program);
        // DO NOT call loseContext() here.  Destroying the WebGL context in
        // cleanup causes blank/white rendering when the effect re-runs on the
        // same canvas element — React StrictMode double-invokes effects by
        // design, and changing `src`/`lutUrl` also triggers cleanup + re-run
        // on the very same <canvas> node.  Deleting the individual GL objects
        // above is sufficient to free GPU resources without nuking the context.
      }
    };
  }, [src, lutUrl]);

  return <canvas ref={canvasRef} className={className} style={style} />;
}
