import React, { useState, useEffect, useRef } from 'react';
import { MediaItem, MediaEdits, Recipe } from '../types';
import { presets, defaultEdits } from '../data';
import { getFilterStyle } from '../lib/filters';
import { X, Undo2, Redo2, SlidersHorizontal, Image as ImageIcon, Download, Loader2, Sparkles, Plus } from 'lucide-react';
import { cn } from '../lib/utils';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { LutFilterCanvas } from './LutFilterCanvas';
import { LutExporter } from '../lib/lutExport';

interface StudioProps {
  item: MediaItem;
  onClose: () => void;
  onUpdate: (updatedItem: MediaItem) => void;
  recipes: Recipe[];
  setRecipes: React.Dispatch<React.SetStateAction<Recipe[]>>;
}

type Tab = 'presets' | 'adjust' | 'recipes';

export function Studio({ item, onClose, onUpdate, recipes, setRecipes }: StudioProps) {
  const [history, setHistory] = useState<MediaEdits[]>([item.edits]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<Tab>('presets');
  const [currentEdits, setCurrentEdits] = useState<MediaEdits>(item.edits);
  const [isExporting, setIsExporting] = useState(false);
  const [isCreatingRecipe, setIsCreatingRecipe] = useState(false);
  const [newRecipeName, setNewRecipeName] = useState('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const isMounted = useRef(false);

  // Sync currentEdits to parent, but skip the initial mount so we don't
  // fire onUpdate with the unchanged initial edits (which would cause App
  // to call setEditingItem unnecessarily and trigger extra re-renders).
  useEffect(() => {
    if (!isMounted.current) {
      isMounted.current = true;
      return;
    }
    onUpdate({ ...item, edits: currentEdits });
  }, [currentEdits]); // eslint-disable-line react-hooks/exhaustive-deps

  const pushHistory = (newEdits: MediaEdits) => {
    const newHistory = history.slice(0, historyIndex + 1);
    newHistory.push(newEdits);
    setHistory(newHistory);
    setHistoryIndex(newHistory.length - 1);
    setCurrentEdits(newEdits);
  };

  const handleUndo = () => {
    if (historyIndex > 0) {
      setHistoryIndex(historyIndex - 1);
      setCurrentEdits(history[historyIndex - 1]);
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      setHistoryIndex(historyIndex + 1);
      setCurrentEdits(history[historyIndex + 1]);
    }
  };

  const handleSliderChange = (key: keyof MediaEdits, value: number) => {
    setCurrentEdits((prev) => ({ ...prev, [key]: value }));
  };

  const handleSliderRelease = (key: keyof MediaEdits, value: number) => {
    pushHistory({ ...currentEdits, [key]: value });
  };

  const handlePresetSelect = (presetId: string) => {
    pushHistory({ ...currentEdits, preset: presetId === 'none' ? null : presetId });
  };

  const handleSaveRecipe = () => {
    if (!newRecipeName.trim()) return;
    const newRecipe: Recipe = {
      id: Math.random().toString(36).substring(2, 9),
      name: newRecipeName.trim(),
      edits: { ...currentEdits }
    };
    setRecipes(prev => [...prev, newRecipe]);
    setIsCreatingRecipe(false);
    setNewRecipeName('');
  };

  const handleApplyRecipe = (recipe: Recipe) => {
    pushHistory({ ...recipe.edits });
  };

  const handleExport = async () => {
    if (isExporting) return;
    setIsExporting(true);

    try {
      // CSS filter string for manual adjustments (brightness/contrast/etc.)
      // For LUT presets cssFilter is 'none', so filterString only carries
      // manual slider values — perfect for compositing on top of the LUT output.
      const filterString = getFilterStyle(currentEdits).filter as string;

      // Resolve active LUT preset URL (null if CSS-only or no preset)
      const activeLutUrl = currentEdits.preset
        ? (presets.find(p => p.id === currentEdits.preset)?.lutUrl ?? null)
        : null;
      const lutStrength = currentEdits.filterStrength ?? 100;

      if (item.type === 'image') {
        // ── Image export ────────────────────────────────────────────────────
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Could not get canvas context');

        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = item.url;
        });

        canvas.width  = img.naturalWidth;
        canvas.height = img.naturalHeight;

        if (activeLutUrl) {
          // LUT is active — render through WebGL first, then blit to 2D canvas
          const exporter = await LutExporter.create(activeLutUrl, lutStrength);
          if (exporter) {
            exporter.render(img, img.naturalWidth, img.naturalHeight, lutStrength);
            // Apply manual adjustments on top via CSS filter
            ctx.filter = filterString !== 'none' ? filterString : 'none';
            ctx.drawImage(exporter.canvas, 0, 0, canvas.width, canvas.height);
            ctx.filter = 'none';
            exporter.destroy();
          } else {
            // WebGL2 not available — fall back to CSS-only
            ctx.filter = filterString;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          }
        } else {
          // CSS preset or no preset
          ctx.filter = filterString;
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        }

        const dataUrl = canvas.toDataURL('image/jpeg', 1.0);
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `column-export-${Date.now()}.jpg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

      } else {
        // ── Video export ────────────────────────────────────────────────────
        await new Promise<void>((resolve, reject) => {
          const video = document.createElement('video');
          video.crossOrigin = 'anonymous';
          video.src = item.url;
          video.muted = true;
          video.playsInline = true;

          video.onloadedmetadata = async () => {
            try {
              const canvas = document.createElement('canvas');
              canvas.width  = Math.round(video.videoWidth  / 2) * 2;
              canvas.height = Math.round(video.videoHeight / 2) * 2;
              const ctx = canvas.getContext('2d');
              if (!ctx) return reject(new Error('Could not get canvas context'));

              // Create LUT exporter once so the shader + 3D texture are
              // compiled/uploaded only once and reused for every frame.
              let lutExporter: LutExporter | null = null;
              if (activeLutUrl) {
                lutExporter = await LutExporter.create(activeLutUrl, lutStrength);
              }

              // Helper: draw one video frame to the 2D encoding canvas,
              // applying LUT (via WebGL) and manual adjustments (via CSS filter).
              const drawFrame = () => {
                if (lutExporter) {
                  lutExporter.render(video, canvas.width, canvas.height, lutStrength);
                  ctx.filter = filterString !== 'none' ? filterString : 'none';
                  ctx.drawImage(lutExporter.canvas, 0, 0, canvas.width, canvas.height);
                  ctx.filter = 'none';
                } else {
                  ctx.filter = filterString;
                  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                }
              };

              if (typeof VideoEncoder !== 'undefined') {
                // ── WebCodecs path ─────────────────────────────────────────
                let audioBuffer: AudioBuffer | null = null;
                try {
                  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
                  if (AudioContextClass) {
                    const audioCtx = new AudioContextClass();
                    const res = await fetch(item.url);
                    const buf = await res.arrayBuffer();
                    audioBuffer = await audioCtx.decodeAudioData(buf);
                  }
                } catch (e) {
                  console.warn('Audio extraction failed:', e);
                }

                const muxerOptions: any = {
                  target: new ArrayBufferTarget(),
                  video: { codec: 'avc', width: canvas.width, height: canvas.height },
                  fastStart: 'in-memory',
                };
                if (audioBuffer) {
                  muxerOptions.audio = {
                    codec: 'aac',
                    numberOfChannels: audioBuffer.numberOfChannels,
                    sampleRate: audioBuffer.sampleRate,
                  };
                }

                const muxer = new Muxer(muxerOptions);

                const videoEncoder = new VideoEncoder({
                  output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
                  error: (e) => reject(e),
                });
                videoEncoder.configure({
                  codec: 'avc1.4d002a',
                  width: canvas.width,
                  height: canvas.height,
                  bitrate: 5_000_000,
                  framerate: 30,
                });

                let audioEncodePromise = Promise.resolve();
                if (audioBuffer) {
                  // @ts-ignore
                  const audioEncoder = new AudioEncoder({
                    output: (chunk: any, meta: any) => muxer.addAudioChunk(chunk, meta),
                    error: (e: any) => console.error('Audio encoding error:', e),
                  });
                  audioEncoder.configure({
                    codec: 'mp4a.40.2',
                    sampleRate: audioBuffer.sampleRate,
                    numberOfChannels: audioBuffer.numberOfChannels,
                    bitrate: 128000,
                  });
                  audioEncodePromise = (async () => {
                    const numberOfFrames = audioBuffer!.length;
                    const chunkSize = 44100;
                    for (let start = 0; start < numberOfFrames; start += chunkSize) {
                      const end       = Math.min(start + chunkSize, numberOfFrames);
                      const frameCount = end - start;
                      const data = new Float32Array(frameCount * audioBuffer!.numberOfChannels);
                      for (let c = 0; c < audioBuffer!.numberOfChannels; c++) {
                        data.set(audioBuffer!.getChannelData(c).subarray(start, end), c * frameCount);
                      }
                      // @ts-ignore
                      const audioData = new AudioData({
                        format: 'f32-planar',
                        sampleRate: audioBuffer!.sampleRate,
                        numberOfChannels: audioBuffer!.numberOfChannels,
                        numberOfFrames: frameCount,
                        timestamp: (start / audioBuffer!.sampleRate) * 1e6,
                        data,
                      });
                      audioEncoder.encode(audioData);
                      audioData.close();
                    }
                    await audioEncoder.flush();
                  })();
                }

                const fps = 30;
                const totalFrames = Math.floor(video.duration * fps);
                let currentFrame = 0;

                video.onseeked = async () => {
                  try {
                    drawFrame();
                    const frame = new VideoFrame(canvas, { timestamp: (currentFrame / fps) * 1e6 });
                    videoEncoder.encode(frame, { keyFrame: currentFrame % 30 === 0 });
                    frame.close();

                    currentFrame++;
                    if (currentFrame < totalFrames) {
                      video.currentTime = currentFrame / fps;
                    } else {
                      await videoEncoder.flush();
                      await audioEncodePromise;
                      muxer.finalize();
                      lutExporter?.destroy();
                      const buffer = (muxer.target as ArrayBufferTarget).buffer;
                      const blob = new Blob([buffer], { type: 'video/mp4' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `column-export-${Date.now()}.mp4`;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      URL.revokeObjectURL(url);
                      resolve();
                    }
                  } catch (e) {
                    lutExporter?.destroy();
                    reject(e);
                  }
                };

                video.currentTime = 0;

              } else {
                // ── MediaRecorder fallback ─────────────────────────────────
                let mimeType = 'video/mp4';
                if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm;codecs=vp9';
                if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';

                const stream   = canvas.captureStream(30);
                const recorder = new MediaRecorder(stream, { mimeType });
                const chunks: BlobPart[] = [];

                recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
                recorder.onstop = () => {
                  lutExporter?.destroy();
                  const blob = new Blob(chunks, { type: mimeType });
                  const url  = URL.createObjectURL(blob);
                  const a    = document.createElement('a');
                  a.href = url;
                  a.download = `column-export-${Date.now()}.${mimeType.includes('mp4') ? 'mp4' : 'webm'}`;
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  URL.revokeObjectURL(url);
                  resolve();
                };

                recorder.start();
                video.play().catch(reject);

                const rafDraw = () => {
                  if (video.paused || video.ended) return;
                  drawFrame();
                  requestAnimationFrame(rafDraw);
                };
                video.onplay  = () => rafDraw();
                video.onended = () => recorder.stop();
                video.onerror = reject;
              }
            } catch (e) {
              reject(e);
            }
          };

          video.onerror = reject;
        });
      }
    } catch (error) {
      console.error('Export failed:', error);
      alert('Failed to export media.');
    } finally {
      setIsExporting(false);
    }
  };

  const filterStyle = getFilterStyle(currentEdits);

  // Resolve the LUT URL from the active preset's data definition
  const activeLutUrl = currentEdits.preset
    ? (presets.find(p => p.id === currentEdits.preset)?.lutUrl ?? null)
    : null;

  return (
    <div className="fixed inset-0 z-50 bg-black flex flex-col text-white">
      {/* Header */}
      <div className="flex items-center justify-between p-4 bg-black/50 backdrop-blur-md absolute top-0 left-0 right-0 z-10">
        <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
          <X className="w-6 h-6" />
        </button>
        <div className="flex items-center gap-4">
          <button
            onClick={handleUndo}
            disabled={historyIndex === 0}
            className="p-2 disabled:opacity-30 hover:bg-white/10 rounded-full transition-colors"
          >
            <Undo2 className="w-5 h-5" />
          </button>
          <button
            onClick={handleRedo}
            disabled={historyIndex === history.length - 1}
            className="p-2 disabled:opacity-30 hover:bg-white/10 rounded-full transition-colors"
          >
            <Redo2 className="w-5 h-5" />
          </button>
          <button
            onClick={handleExport}
            disabled={isExporting}
            className="p-2 hover:bg-white/10 rounded-full transition-colors ml-2"
            title="Export"
          >
            {isExporting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Main Media Preview */}
      <div className="flex-1 flex items-center justify-center overflow-hidden pt-16 pb-48">
        <div className="w-full h-full max-w-2xl mx-auto flex items-center justify-center p-4">
          {item.type === 'image' ? (
            activeLutUrl ? (
              <LutFilterCanvas
                src={item.url}
                lutUrl={activeLutUrl}
                strength={currentEdits.filterStrength ?? 100}
                className="max-w-full max-h-full object-contain"
                style={{ height: 'auto', ...filterStyle }}
              />
            ) : (
              <img
                src={item.url}
                alt=""
                className="max-w-full max-h-full object-contain"
                style={filterStyle}
              />
            )
          ) : activeLutUrl ? (
            // Video with LUT — render every frame through WebGL
            <LutFilterCanvas
              src={item.url}
              srcType="video"
              lutUrl={activeLutUrl}
              strength={currentEdits.filterStrength ?? 100}
              playing={true}
              className="max-w-full max-h-full object-contain"
              style={{ height: 'auto', ...filterStyle }}
            />
          ) : (
            <video
              ref={videoRef}
              src={item.url}
              className="max-w-full max-h-full object-contain"
              style={filterStyle}
              autoPlay
              loop
              playsInline
              muted
            />
          )}
        </div>
      </div>

      {/* Bottom Controls */}
      <div className="absolute bottom-0 left-0 right-0 bg-black border-t border-white/10 pb-safe">
        {/* Tab Content */}
        <div className="h-32 p-4 overflow-y-auto">
          {activeTab === 'presets' ? (
            <div className="flex gap-4 overflow-x-auto pb-2 snap-x hide-scrollbar">
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => handlePresetSelect(preset.id)}
                  className={cn(
                    'flex flex-col items-center gap-2 snap-center min-w-[64px]',
                    currentEdits.preset === preset.id || (preset.id === 'none' && !currentEdits.preset)
                      ? 'opacity-100'
                      : 'opacity-50 hover:opacity-80'
                  )}
                >
                  <div className="w-16 h-16 rounded-md overflow-hidden bg-neutral-900 border border-white/20 relative">
                    {preset.lutUrl ? (
                      <LutFilterCanvas
                        src={item.type === 'image' ? item.url : 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?q=80&w=200&auto=format&fit=crop'}
                        lutUrl={preset.lutUrl}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <img
                        src={item.type === 'image' ? item.url : 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?q=80&w=200&auto=format&fit=crop'}
                        alt={preset.name}
                        className="w-full h-full object-cover"
                        style={getFilterStyle({ ...defaultEdits, preset: preset.id === 'none' ? null : preset.id })}
                        referrerPolicy="no-referrer"
                      />
                    )}
                  </div>
                  <span className="text-xs font-medium tracking-wider uppercase">{preset.name}</span>
                </button>
              ))}
            </div>
          ) : activeTab === 'recipes' ? (
            <div className="flex gap-4 overflow-x-auto pb-2 snap-x hide-scrollbar items-center h-full">
              {isCreatingRecipe ? (
                <div className="flex items-center gap-2 w-full max-w-sm mx-auto px-4">
                  <input
                    type="text"
                    value={newRecipeName}
                    onChange={(e) => setNewRecipeName(e.target.value)}
                    placeholder="Recipe Name"
                    className="flex-1 bg-white/10 border border-white/20 rounded px-3 py-2 text-sm text-white outline-none focus:border-white/50"
                    autoFocus
                  />
                  <button onClick={handleSaveRecipe} className="px-3 py-2 bg-white text-black text-sm font-medium rounded">Save</button>
                  <button onClick={() => setIsCreatingRecipe(false)} className="px-3 py-2 bg-white/10 text-white text-sm font-medium rounded">Cancel</button>
                </div>
              ) : (
                <>
                  <button
                    onClick={() => setIsCreatingRecipe(true)}
                    className="flex flex-col items-center justify-center gap-2 snap-center min-w-[64px] h-16 rounded-md border border-dashed border-white/30 hover:border-white/60 hover:bg-white/5 transition-colors"
                  >
                    <Plus className="w-6 h-6 opacity-70" />
                  </button>
                  {recipes.map((recipe) => (
                    <button
                      key={recipe.id}
                      onClick={() => handleApplyRecipe(recipe)}
                      className="flex flex-col items-center gap-2 snap-center min-w-[64px] opacity-80 hover:opacity-100"
                    >
                      <div className="w-16 h-16 rounded-md overflow-hidden bg-neutral-900 border border-white/20 relative">
                        <img
                          src={item.type === 'image' ? item.url : 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?q=80&w=200&auto=format&fit=crop'}
                          alt={recipe.name}
                          className="w-full h-full object-cover"
                          style={getFilterStyle(recipe.edits)}
                          referrerPolicy="no-referrer"
                        />
                      </div>
                      <span className="text-xs font-medium tracking-wider uppercase truncate w-16 text-center">{recipe.name}</span>
                    </button>
                  ))}
                  {recipes.length === 0 && (
                    <div className="text-xs text-white/50 italic px-4">No recipes saved yet.</div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4 max-w-md mx-auto">
              <SliderControl
                label="Brightness"
                value={currentEdits.brightness}
                min={0} max={200}
                onChange={(val) => handleSliderChange('brightness', val)}
                onRelease={(val) => handleSliderRelease('brightness', val)}
              />
              <SliderControl
                label="Contrast"
                value={currentEdits.contrast}
                min={0} max={200}
                onChange={(val) => handleSliderChange('contrast', val)}
                onRelease={(val) => handleSliderRelease('contrast', val)}
              />
              <SliderControl
                label="Saturation"
                value={currentEdits.saturation}
                min={0} max={200}
                onChange={(val) => handleSliderChange('saturation', val)}
                onRelease={(val) => handleSliderRelease('saturation', val)}
              />
              <SliderControl
                label="Temperature"
                value={currentEdits.temperature}
                min={-100} max={100}
                onChange={(val) => handleSliderChange('temperature', val)}
                onRelease={(val) => handleSliderRelease('temperature', val)}
              />
              <SliderControl
                label="Tint"
                value={currentEdits.tint}
                min={-100} max={100}
                onChange={(val) => handleSliderChange('tint', val)}
                onRelease={(val) => handleSliderRelease('tint', val)}
              />
            </div>
          )}
        </div>

        {/* Filter Strength — visible whenever a non-Original preset is active */}
        {currentEdits.preset && (
          <div className="px-6 py-2 border-t border-white/10">
            <SliderControl
              label="Strength"
              value={currentEdits.filterStrength ?? 100}
              min={0} max={100}
              onChange={(val) => handleSliderChange('filterStrength', val)}
              onRelease={(val) => handleSliderRelease('filterStrength', val)}
            />
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex items-center justify-center gap-8 p-4 border-t border-white/10">
          <button
            onClick={() => setActiveTab('presets')}
            className={cn('flex flex-col items-center gap-1 transition-opacity',
              activeTab === 'presets' ? 'opacity-100' : 'opacity-50 hover:opacity-80')}
          >
            <ImageIcon className="w-5 h-5" />
            <span className="text-[10px] uppercase tracking-widest">Presets</span>
          </button>
          <button
            onClick={() => setActiveTab('recipes')}
            className={cn('flex flex-col items-center gap-1 transition-opacity',
              activeTab === 'recipes' ? 'opacity-100' : 'opacity-50 hover:opacity-80')}
          >
            <Sparkles className="w-5 h-5" />
            <span className="text-[10px] uppercase tracking-widest">Recipes</span>
          </button>
          <button
            onClick={() => setActiveTab('adjust')}
            className={cn('flex flex-col items-center gap-1 transition-opacity',
              activeTab === 'adjust' ? 'opacity-100' : 'opacity-50 hover:opacity-80')}
          >
            <SlidersHorizontal className="w-5 h-5" />
            <span className="text-[10px] uppercase tracking-widest">Adjust</span>
          </button>
        </div>
      </div>
    </div>
  );
}

interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onRelease: (value: number) => void;
}

function SliderControl({ label, value, min, max, onChange, onRelease }: SliderControlProps) {
  return (
    <div className="flex items-center gap-4">
      <span className="text-xs uppercase tracking-wider w-24 text-white/70">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={(e) => onRelease(Number((e.target as HTMLInputElement).value))}
        onTouchEnd={(e) => onRelease(Number((e.target as HTMLInputElement).value))}
        className="flex-1 h-1 bg-white/20 rounded-full appearance-none outline-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full"
      />
      <span className="text-xs font-mono w-8 text-right">{value}</span>
    </div>
  );
}
