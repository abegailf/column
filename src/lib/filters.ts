import React from 'react';
import { MediaEdits } from '../types';
import { presets } from '../data';

export function getFilterStyle(edits: MediaEdits): React.CSSProperties {
  const { brightness, contrast, saturation, temperature, tint, preset } = edits;

  const filters: string[] = [];

  // Apply preset first if exists
  if (preset) {
    const presetData = presets.find((p) => p.id === preset);
    if (presetData && presetData.cssFilter && presetData.cssFilter !== 'none') {
      filters.push(presetData.cssFilter);
    }
  }

  // Apply manual edits
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
