export type MediaType = 'image' | 'video';

export interface MediaEdits {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  preset: string | null;
}

export interface MediaItem {
  id: string;
  type: MediaType;
  url: string;
  stack?: string[]; // URLs for carousel
  edits: MediaEdits;
}

export interface Preset {
  id: string;
  name: string;
  lutUrl?: string; // URL to a Hald LUT image
  cssFilter?: string; // Fallback CSS filter
}

export interface Recipe {
  id: string;
  name: string;
  edits: MediaEdits;
}
