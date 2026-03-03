import React, { useEffect, useRef } from 'react';
import { ParsedLUT } from '../lib/lutParser';

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
uniform highp sampler3D u_lut;
uniform bool u_hasLut;

out vec4 outColor;

void main() {
  vec4 color = texture(u_image, v_texCoord);
  
  if (u_hasLut) {
    // Sample the 3D LUT using the original pixel's RGB values as 3D coordinates.
    // We clamp to [0.0, 1.0] to ensure we don't sample outside the LUT boundaries.
    // The texture() function with sampler3D automatically handles trilinear interpolation.
    vec3 lutColor = texture(u_lut, clamp(color.rgb, 0.0, 1.0)).rgb;
    outColor = vec4(lutColor, color.a);
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
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

interface LutFilterCanvasProps {
  src: string;
  lutData: ParsedLUT | null;
  className?: string;
  style?: React.CSSProperties;
}

export function LutFilterCanvas({ src, lutData, className, style }: LutFilterCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // We must use WebGL2 for native 3D texture support (sampler3D)
    const gl = canvas.getContext('webgl2');
    if (!gl) {
      console.error('WebGL2 is not supported by your browser.');
      return;
    }

    let imageTexture: WebGLTexture | null = null;
    let lutTexture: WebGLTexture | null = null;
    let program: WebGLProgram | null = null;
    let positionBuffer: WebGLBuffer | null = null;
    let texCoordBuffer: WebGLBuffer | null = null;
    let vao: WebGLVertexArrayObject | null = null;

    const image = new Image();
    image.crossOrigin = 'anonymous';
    
    image.onload = () => {
      // 1. Mobile Optimization: Handle device pixel ratio for sharp rendering
      const dpr = window.devicePixelRatio || 1;
      
      // Constrain max texture size to prevent memory crashes on mobile devices
      const maxWidth = 2048;
      let width = image.width;
      let height = image.height;
      
      if (width > maxWidth) {
        height = Math.floor(height * (maxWidth / width));
        width = maxWidth;
      }
      
      // Set actual canvas resolution (internal buffer size)
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

      // 2. Compile Shaders
      const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
      const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
      if (!vertexShader || !fragmentShader) return;

      program = createProgram(gl, vertexShader, fragmentShader);
      if (!program) return;

      gl.useProgram(program);

      // 3. Setup Geometry (Full-screen quad)
      const positionAttributeLocation = gl.getAttribLocation(program, 'a_position');
      const texCoordAttributeLocation = gl.getAttribLocation(program, 'a_texCoord');

      positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          -1.0, -1.0,
           1.0, -1.0,
          -1.0,  1.0,
          -1.0,  1.0,
           1.0, -1.0,
           1.0,  1.0,
        ]),
        gl.STATIC_DRAW
      );

      texCoordBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          0.0, 0.0,
          1.0, 0.0,
          0.0, 1.0,
          0.0, 1.0,
          1.0, 0.0,
          1.0, 1.0,
        ]),
        gl.STATIC_DRAW
      );

      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      gl.enableVertexAttribArray(positionAttributeLocation);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

      gl.enableVertexAttribArray(texCoordAttributeLocation);
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.vertexAttribPointer(texCoordAttributeLocation, 2, gl.FLOAT, false, 0, 0);

      // Ensure proper byte alignment for textures (crucial for RGB8 format)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      // 4. Setup Image Texture
      imageTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, imageTexture);
      
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);

      // 5. Setup LUT 3D Texture
      lutTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, lutTexture);
      
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      const hasLutLocation = gl.getUniformLocation(program, 'u_hasLut');

      if (lutData) {
        gl.uniform1i(hasLutLocation, 1);
        gl.texImage3D(
          gl.TEXTURE_3D,
          0,
          gl.RGB8, // Internal format
          lutData.size,
          lutData.size,
          lutData.size,
          0,
          gl.RGB, // Format
          gl.UNSIGNED_BYTE, // Type (Uint8Array ensures linear filtering works on all mobile devices)
          lutData.data
        );
      } else {
        gl.uniform1i(hasLutLocation, 0);
        // Bind a dummy 1x1x1 texture to satisfy WebGL state requirements
        gl.texImage3D(
          gl.TEXTURE_3D,
          0,
          gl.RGB8,
          1, 1, 1,
          0,
          gl.RGB,
          gl.UNSIGNED_BYTE,
          new Uint8Array([0, 0, 0])
        );
      }

      const imageLocation = gl.getUniformLocation(program, 'u_image');
      const lutLocation = gl.getUniformLocation(program, 'u_lut');

      gl.uniform1i(imageLocation, 0); // Bind to TEXTURE0
      gl.uniform1i(lutLocation, 1);   // Bind to TEXTURE1

      // 6. Draw
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    image.src = src;

    // 7. Cleanup: Prevent memory leaks when navigating away
    return () => {
      if (gl) {
        if (imageTexture) gl.deleteTexture(imageTexture);
        if (lutTexture) gl.deleteTexture(lutTexture);
        if (positionBuffer) gl.deleteBuffer(positionBuffer);
        if (texCoordBuffer) gl.deleteBuffer(texCoordBuffer);
        if (vao) gl.deleteVertexArray(vao);
        if (program) gl.deleteProgram(program);
        
        // Lose context to free up hardware resources immediately
        const ext = gl.getExtension('WEBGL_lose_context');
        if (ext) ext.loseContext();
      }
    };
  }, [src, lutData]);

  return <canvas ref={canvasRef} className={className} style={style} />;
}
