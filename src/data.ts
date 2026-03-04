import { MediaItem, Preset } from './types';

export const defaultEdits = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  temperature: 0,
  tint: 0,
  preset: null,
  filterStrength: 100,
};

export const sampleMedia: MediaItem[] = [
  {
    id: '1',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?q=80&w=1000&auto=format&fit=crop',
    edits: { ...defaultEdits },
  },
  {
    id: '2',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?q=80&w=1000&auto=format&fit=crop',
    edits: { ...defaultEdits },
  },
  {
    id: '3',
    type: 'video',
    url: 'https://assets.mixkit.co/videos/preview/mixkit-fashion-model-walking-on-a-catwalk-34440-large.mp4',
    edits: { ...defaultEdits },
  },
  {
    id: '4',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1492633423870-43d1cd2a4c24?q=80&w=1000&auto=format&fit=crop',
    stack: [
      'https://images.unsplash.com/photo-1492633423870-43d1cd2a4c24?q=80&w=1000&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1529139574466-a303027c1d8b?q=80&w=1000&auto=format&fit=crop',
    ],
    edits: { ...defaultEdits },
  },
  {
    id: '5',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1509631179647-0177331693ae?q=80&w=1000&auto=format&fit=crop',
    edits: { ...defaultEdits },
  },
  {
    id: '6',
    type: 'image',
    url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?q=80&w=1000&auto=format&fit=crop',
    edits: { ...defaultEdits },
  },
];

export const presets: Preset[] = [
  { id: 'none', name: 'Original', cssFilter: 'none' },
  // ADD YOUR NEW PRESET HERE:
  { id: 'moody_film', name: 'Moody Film', lutUrl: '/moody_film.cube', cssFilter: 'none' },
  { id: 'fave_brown', name: 'Fave Brown', lutUrl: '/Favebrown.cube', cssFilter: 'none' },
  { id: 'a4', name: 'A4', cssFilter: 'sepia(0.2) contrast(1.1) saturate(0.9) hue-rotate(-5deg)' },
  { id: 'a6', name: 'A6', cssFilter: 'sepia(0.1) contrast(1.2) saturate(0.8) brightness(1.05)' },
  { id: 'c1', name: 'C1', cssFilter: 'saturate(1.3) contrast(1.1) brightness(1.1) hue-rotate(5deg)' },
  { id: 'hb1', name: 'HB1', cssFilter: 'grayscale(0.2) contrast(1.1) brightness(1.05) sepia(0.1)' },
  { id: 'm5', name: 'M5', cssFilter: 'sepia(0.3) contrast(0.9) saturate(0.7) brightness(0.9)' },
  { id: 'b1', name: 'B1', cssFilter: 'grayscale(1) contrast(1.2) brightness(1.1)' },
];
