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
uniform sampler2D u_lut; // Switched to 2D
uniform bool u_hasLut;

out vec4 outColor;

void main() {
  vec4 color = texture(u_image, v_texCoord);
  
  if (u_hasLut) {
    // Math configuration for our 64-size LUT converted to an 8x8 grid on a 512x512 texture
    float size = 64.0;
    float cols = 8.0;
    
    vec3 c = clamp(color.rgb, 0.0, 1.0);
    float blueColor = c.b * (size - 1.0);
    
    // Find the two Z-depth quads to interpolate between
    vec2 quad1;
    quad1.y = floor(floor(blueColor) / cols);
    quad1.x = floor(blueColor) - (quad1.y * cols);
    
    vec2 quad2;
    quad2.y = floor(ceil(blueColor) / cols);
    quad2.x = ceil(blueColor) - (quad2.y * cols);
    
    float texWidth = size * cols;
    float texHeight = size * cols;
    
    // Map Red/Green to X/Y inside the specific Z-depth quad
    vec2 texPos1;
    texPos1.x = (quad1.x * size + 0.5 + c.r * (size - 1.0)) / texWidth;
    texPos1.y = (quad1.y * size + 0.5 + c.g * (size - 1.0)) / texHeight;
    
    vec2 texPos2;
    texPos2.x = (quad2.x * size + 0.5 + c.r * (size - 1.0)) / texWidth;
    texPos2.y = (quad2.y * size + 0.5 + c.g * (size - 1.0)) / texHeight;
    
    // Sample both 2D points and mix (Simulated Trilinear Interpolation)
    vec3 color1 = texture(u_lut, texPos1).rgb;
    vec3 color2 = texture(u_lut, texPos2).rgb;
    vec3 finalColor = mix(color1, color2, fract(blueColor));
    
    outColor = vec4(finalColor, color.a);
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

    const gl = canvas.getContext('webgl2');
    if (!gl) {
      console.error('WebGL2 is not supported.');
      return;
    }

    // Clear to transparent immediately so the canvas never sits in an
    // indeterminate (often white) state while images are loading.
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    let imageTexture: WebGLTexture | null = null;
    let lutTexture: WebGLTexture | null = null;
    let program: WebGLProgram | null = null;
    let positionBuffer: WebGLBuffer | null = null;
    let texCoordBuffer: WebGLBuffer | null = null;
    let vao: WebGLVertexArrayObject | null = null;

    // Helper to load images as promises.
    // crossOrigin = 'anonymous' is only needed for non-local URLs (LUT PNGs
    // served from /public). Blob URLs (user-uploaded files) are same-origin
    // and must NOT set crossOrigin, otherwise some browsers refuse to load them.
    const loadImage = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      const isLocalUrl = url.startsWith('blob:') || url.startsWith('data:');
      if (!isLocalUrl) {
        img.crossOrigin = 'anonymous';
      }
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });

    // Wait for both the user image and the LUT PNG to load
    Promise.all([
      loadImage(src),
      lutUrl ? loadImage(lutUrl) : Promise.resolve(null)
    ]).then(([image, lutImage]) => {
      
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

      const hasLutLocation = gl.getUniformLocation(program, 'u_hasLut');

      if (lutImage) {
        gl.uniform1i(hasLutLocation, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, lutImage);
      } else {
        gl.uniform1i(hasLutLocation, 0);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      }

      const imageLocation = gl.getUniformLocation(program, 'u_image');
      const lutLocation = gl.getUniformLocation(program, 'u_lut');

      gl.uniform1i(imageLocation, 0);
      gl.uniform1i(lutLocation, 1);

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }).catch(console.error);

    return () => {
      if (gl) {
        if (imageTexture) gl.deleteTexture(imageTexture);
        if (lutTexture) gl.deleteTexture(lutTexture);
        if (positionBuffer) gl.deleteBuffer(positionBuffer);
        if (texCoordBuffer) gl.deleteBuffer(texCoordBuffer);
        if (vao) gl.deleteVertexArray(vao);
        if (program) gl.deleteProgram(program);
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      }
    };
  }, [src, lutUrl]);

  return <canvas ref={canvasRef} className={className} style={style} />;
}