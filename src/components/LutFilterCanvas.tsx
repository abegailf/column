/**
 * LutFilterCanvas.tsx
 *
 * WebGL2 canvas component that applies a 3D LUT colour grade to an image
 * or video source.
 *
 * Supports two modes (srcType prop):
 *   'image'  – static image, renders once then only on strength changes (default)
 *   'video'  – continuous rAF loop; re-uploads each decoded video frame per tick
 *
 * The `playing` prop (video mode only) controls playback.  When false the
 * internal video element is paused but the canvas keeps displaying the last
 * rendered frame.
 */

import React, { useEffect, useRef } from 'react';
import { fetchParseCubeLut } from '../lib/parseCubeLut';

// ── Shaders ───────────────────────────────────────────────────────────────────
const vertexShaderSource = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord  = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
}
`;

const fragmentShaderSource = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 v_texCoord;
uniform sampler2D u_image;
uniform sampler3D u_lut;
uniform bool      u_hasLut;
uniform float     u_lutSize;
uniform float     u_strength;
out vec4 outColor;
void main() {
  vec4 color = texture(u_image, v_texCoord);
  if (u_hasLut) {
    vec3 c = clamp(color.rgb, 0.0, 1.0);
    float scale  = (u_lutSize - 1.0) / u_lutSize;
    float offset = 0.5 / u_lutSize;
    vec3 lutCoord = c * scale + offset;
    vec3 lut_rgb  = texture(u_lut, lutCoord).rgb;
    outColor = vec4(mix(color.rgb, lut_rgb, u_strength), color.a);
  } else {
    outColor = color;
  }
}
`;

// ── GL helpers ────────────────────────────────────────────────────────────────
function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
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

function createProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

// ── Component ─────────────────────────────────────────────────────────────────
interface LutFilterCanvasProps {
  src: string;
  /** 'image' (default) renders once; 'video' runs a per-frame rAF loop */
  srcType?: 'image' | 'video';
  /** URL to a .cube LUT file served from public/ */
  lutUrl?: string | null;
  className?: string;
  style?: React.CSSProperties;
  /** Filter strength 0–100 (default 100) */
  strength?: number;
  /** Video mode only – whether the video is playing (default true) */
  playing?: boolean;
}

export function LutFilterCanvas({
  src,
  srcType = 'image',
  lutUrl,
  className,
  style,
  strength = 100,
  playing = true,
}: LutFilterCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strengthRef = useRef(strength);
  strengthRef.current = strength;

  // Lightweight redraw closure (image mode only)
  const renderRef = useRef<((s: number) => void) | null>(null);
  // Internal video element (video mode only)
  const internalVideoRef = useRef<HTMLVideoElement | null>(null);

  // ── Main effect — re-runs when src, lutUrl, or srcType changes ──────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let rafId: number | null = null;

    // Blob URLs created for the image source — revoked on cleanup
    const blobUrls: string[] = [];

    const gl = canvas.getContext('webgl2');
    if (!gl) {
      console.error('LutFilterCanvas: WebGL2 is not supported in this browser.');
      return;
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // GL resource handles for cleanup
    let imageTexture:   WebGLTexture | null = null;
    let lutTexture:     WebGLTexture | null = null;
    let program:        WebGLProgram | null = null;
    let positionBuffer: WebGLBuffer  | null = null;
    let texCoordBuffer: WebGLBuffer  | null = null;
    let vao:            WebGLVertexArrayObject | null = null;

    // ── Shared GL setup (shaders, VAO, LUT texture) ───────────────────────────
    // Returns uniform locations and a draw function, or null on failure.
    const setupGL = (lutData: { size: number; data: Float32Array } | null, width: number, height: number) => {
      const dpr = window.devicePixelRatio || 1;
      const maxW = 2048;
      let cw = width, ch = height;
      if (cw > maxW) { ch = Math.floor(ch * maxW / cw); cw = maxW; }

      canvas.width  = cw * dpr;
      canvas.height = ch * dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);

      const vs = createShader(gl, gl.VERTEX_SHADER,   vertexShaderSource);
      const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
      if (!vs || !fs) return null;

      program = createProgram(gl, vs, fs);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!program) return null;
      gl.useProgram(program);

      const posLoc = gl.getAttribLocation(program, 'a_position');
      const texLoc = gl.getAttribLocation(program, 'a_texCoord');

      positionBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,  1, -1, -1,  1,
        -1,  1,  1, -1,  1,  1,
      ]), gl.STATIC_DRAW);

      texCoordBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        0, 0,  1, 0,  0, 1,
        0, 1,  1, 0,  1, 1,
      ]), gl.STATIC_DRAW);

      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      gl.enableVertexAttribArray(posLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

      gl.enableVertexAttribArray(texLoc);
      gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
      gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);

      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      // Image texture (unit 0) — pixels uploaded separately per frame/image
      imageTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, imageTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      // Placeholder so the sampler binding is valid before the first frame
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

      // LUT texture (unit 1)
      lutTexture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, lutTexture);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      const hasLutLoc   = gl.getUniformLocation(program, 'u_hasLut');
      const lutSizeLoc  = gl.getUniformLocation(program, 'u_lutSize');
      const strengthLoc = gl.getUniformLocation(program, 'u_strength');
      gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'u_lut'),   1);

      if (lutData) {
        const { size, data } = lutData;
        const pixels = new Uint8Array(size * size * size * 4);
        for (let i = 0; i < size * size * size; i++) {
          pixels[i * 4]     = Math.round(Math.max(0, Math.min(255, data[i * 3]     * 255)));
          pixels[i * 4 + 1] = Math.round(Math.max(0, Math.min(255, data[i * 3 + 1] * 255)));
          pixels[i * 4 + 2] = Math.round(Math.max(0, Math.min(255, data[i * 3 + 2] * 255)));
          pixels[i * 4 + 3] = 255;
        }
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, size, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        gl.uniform1i(hasLutLoc,  1);
        gl.uniform1f(lutSizeLoc, size);
      } else {
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        gl.uniform1i(hasLutLoc,  0);
        gl.uniform1f(lutSizeLoc, 1.0);
      }

      return { strengthLoc };
    };

    // Upload a TexImageSource (image or video frame) to the image texture and draw
    const drawSource = (source: TexImageSource, s: number) => {
      if (!program || !vao || !imageTexture) return;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, imageTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      const strengthLoc = gl.getUniformLocation(program, 'u_strength');
      gl.uniform1f(strengthLoc, s / 100);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };

    // ── VIDEO PATH ────────────────────────────────────────────────────────────
    if (srcType === 'video') {
      const videoEl = document.createElement('video');
      videoEl.muted       = true;
      videoEl.loop        = true;
      videoEl.playsInline = true;
      videoEl.autoplay    = true;
      // Only set crossOrigin for non-blob URLs (blob URLs from uploads don't need it)
      if (!src.startsWith('blob:')) videoEl.crossOrigin = 'anonymous';
      videoEl.src = src;
      internalVideoRef.current = videoEl;

      const lutPromise = lutUrl ? fetchParseCubeLut(lutUrl) : Promise.resolve(null);

      lutPromise.then((lut) => {
        if (cancelled) return;

        const onMetadata = () => {
          if (cancelled) return;

          const w = videoEl.videoWidth;
          const h = videoEl.videoHeight;
          if (!w || !h) return;

          const glState = setupGL(lut, w, h);
          if (!glState) return;

          // Render loop — runs every animation frame
          const loop = () => {
            if (cancelled) return;
            // Draw the current video frame (even if paused — shows static frame)
            if (videoEl.readyState >= 2) {
              drawSource(videoEl, strengthRef.current);
            }
            rafId = requestAnimationFrame(loop);
          };
          rafId = requestAnimationFrame(loop);

          // Start playback if `playing` prop is true at mount time
          if (playing) videoEl.play().catch(() => {});
        };

        if (videoEl.readyState >= 1) {
          onMetadata();
        } else {
          videoEl.addEventListener('loadedmetadata', onMetadata, { once: true });
        }
      }).catch((err: unknown) => {
        if (!cancelled) console.error('LutFilterCanvas video render error:', err);
      });

    // ── IMAGE PATH (existing behaviour, unchanged) ────────────────────────────
    } else {
      const loadImage = async (url: string): Promise<HTMLImageElement> => {
        let imgSrc = url;
        if (!url.startsWith('blob:') && !url.startsWith('data:')) {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`Image fetch failed (${res.status}): ${url}`);
          const blob = await res.blob();
          imgSrc = URL.createObjectURL(blob);
          blobUrls.push(imgSrc);
        }
        return new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload  = () => resolve(img);
          img.onerror = reject;
          img.src     = imgSrc;
        });
      };

      Promise.all([
        loadImage(src),
        lutUrl ? fetchParseCubeLut(lutUrl) : Promise.resolve(null),
      ]).then(([image, lut]) => {
        if (cancelled) return;

        const glState = setupGL(lut, image.naturalWidth, image.naturalHeight);
        if (!glState) return;

        // Draw once with the loaded image
        drawSource(image, strengthRef.current);

        // Expose a lightweight redraw that only updates u_strength
        const render = (s: number) => {
          if (!program) return;
          gl.useProgram(program);
          gl.bindVertexArray(vao);
          gl.uniform1f(glState.strengthLoc, s / 100);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        };
        renderRef.current = render;
      }).catch((err: unknown) => {
        if (!cancelled) console.error('LutFilterCanvas render error:', err);
      });
    }

    // ── Cleanup ───────────────────────────────────────────────────────────────
    return () => {
      cancelled = true;
      renderRef.current        = null;
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (internalVideoRef.current) {
        internalVideoRef.current.pause();
        internalVideoRef.current.src = '';
        internalVideoRef.current = null;
      }
      blobUrls.forEach((u) => URL.revokeObjectURL(u));
      if (imageTexture)   gl.deleteTexture(imageTexture);
      if (lutTexture)     gl.deleteTexture(lutTexture);
      if (positionBuffer) gl.deleteBuffer(positionBuffer);
      if (texCoordBuffer) gl.deleteBuffer(texCoordBuffer);
      if (vao)            gl.deleteVertexArray(vao);
      if (program)        gl.deleteProgram(program);
    };
  }, [src, lutUrl, srcType]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Strength effect (image mode) ─────────────────────────────────────────────
  // Video mode reads strengthRef directly in the rAF loop — no effect needed.
  useEffect(() => {
    if (srcType !== 'video') {
      renderRef.current?.(strength);
    }
  }, [strength, srcType]);

  // ── Playing effect (video mode) ───────────────────────────────────────────────
  useEffect(() => {
    const v = internalVideoRef.current;
    if (srcType !== 'video' || !v) return;
    if (playing) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [playing, srcType]);

  return <canvas ref={canvasRef} className={className} style={style} />;
}
