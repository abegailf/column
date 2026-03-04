import React from 'react';
import { MediaEdits } from '../types';
import { presets } from '../data';

/**
 * Scale each function in a CSS filter string linearly from its identity value
 * toward the preset value, based on `strength` (0–100).
 *
 * Identity values:  sepia/grayscale/invert → 0
 *                   contrast/brightness/saturate/opacity → 1
 *                   hue-rotate/blur → 0
 *
 * At strength=100 the original cssFilter is returned unchanged.
 * At strength=0   all functions collapse to their identity (no-op) values.
 */
function scaleFilterToStrength(cssFilter: string, strength: number): string {
  if (strength >= 100) return cssFilter;
  if (strength <= 0) return '';

  const t = strength / 100;

  // Identity values for every CSS filter function we use in presets.
  const identity: Record<string, number> = {
    sepia: 0,
    grayscale: 0,
    invert: 0,
    blur: 0,
    'hue-rotate': 0,
    contrast: 1,
    brightness: 1,
    saturate: 1,
    opacity: 1,
  };

  return cssFilter.replace(/([\w-]+)\(([^)]+)\)/g, (_match, fn: string, args: string) => {
    const id = identity[fn] ?? 0;
    const trimmed = args.trim();
    const isDeg = trimmed.endsWith('deg');
    const value = parseFloat(trimmed);
    const scaled = id + (value - id) * t;
    return `${fn}(${scaled.toFixed(4)}${isDeg ? 'deg' : ''})`;
  });
}

export function getFilterStyle(edits: MediaEdits): React.CSSProperties {
  const {
    brightness,
    contrast,
    saturation,
    temperature,
    tint,
    preset,
    filterStrength = 100,
  } = edits;

  const filters: string[] = [];

  // Apply preset first if exists, scaled by filterStrength
  if (preset) {
    const presetData = presets.find((p) => p.id === preset);
    if (presetData && presetData.cssFilter && presetData.cssFilter !== 'none') {
      const scaledFilter = scaleFilterToStrength(presetData.cssFilter, filterStrength);
      if (scaledFilter) filters.push(scaledFilter);
    }
  }

  // Apply manual edits (always at full value — strength only affects the preset)
  if (brightness !== 100) filters.push(`brightness(${brightness / 100})`);
  if (contrast !== 100) filters.push(`contrast(${contrast / 100})`);
  if (saturation !== 100) filters.push(`saturate(${saturation / 100})`);

  // Temperature and Tint are complex to do with pure CSS filters perfectly,
  // but we can approximate with hue-rotate and sepia
  if (temperature !== 0) {
    // warm: sepia + hue-rotate towards orange/red
    // cool: hue-rotate towards blue
    if (temperature > 0) {
      filters.push(`sepia(${temperature / 200}) hue-rotate(-${temperature / 10}deg)`);
    } else {
      filters.push(`hue-rotate(${Math.abs(temperature) / 2}deg)`);
    }
  }

  if (tint !== 0) {
    // tint: green to magenta
    filters.push(`hue-rotate(${tint}deg)`);
  }

  return {
    filter: filters.length > 0 ? filters.join(' ') : 'none',
  };
}
