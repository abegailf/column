import React, { useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MediaItem } from '../types';
import { cn } from '../lib/utils';
import { Play, Layers } from 'lucide-react';
import { getFilterStyle } from '../lib/filters';
import { presets } from '../data';
import { LutFilterCanvas } from './LutFilterCanvas';

interface SortableMediaItemProps {
  key?: string | number;
  item: MediaItem;
  onClick: () => void;
}

export function SortableMediaItem({ item, onClick }: SortableMediaItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 1,
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const [isHovered, setIsHovered] = useState(false);

  const handleMouseEnter = () => {
    setIsHovered(true);
    if (item.type === 'video' && videoRef.current) {
      videoRef.current.play().catch(() => {});
    }
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    if (item.type === 'video' && videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  };

  const filterStyle = getFilterStyle(item.edits);

  // Resolve the active LUT preset (if any) so the thumbnail renders through WebGL
  const activeLutPreset = item.edits.preset
    ? presets.find((p) => p.id === item.edits.preset && p.lutUrl)
    : undefined;
  const lutUrl   = activeLutPreset?.lutUrl ?? null;
  const strength = item.edits.filterStrength ?? 100;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'relative aspect-[4/5] bg-neutral-200 dark:bg-neutral-800 overflow-hidden cursor-pointer touch-manipulation',
        isDragging && 'opacity-50 ring-2 ring-neutral-900 dark:ring-neutral-100'
      )}
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      {...attributes}
      {...listeners}
    >
      {item.type === 'image' ? (
        lutUrl ? (
          // LUT preset active — render through WebGL so the grid thumbnail
          // actually shows the colour grade.
          <LutFilterCanvas
            src={item.url}
            lutUrl={lutUrl}
            strength={strength}
            className="w-full h-full object-cover pointer-events-none"
            style={filterStyle}
          />
        ) : (
          <img
            src={item.url}
            alt=""
            className="w-full h-full object-cover pointer-events-none"
            style={filterStyle}
            referrerPolicy="no-referrer"
          />
        )
      ) : lutUrl ? (
        // Video with LUT — WebGL canvas with rAF loop; `playing` mirrors hover state
        <LutFilterCanvas
          src={item.url}
          srcType="video"
          lutUrl={lutUrl}
          strength={strength}
          playing={isHovered}
          className="w-full h-full object-cover pointer-events-none"
          style={filterStyle}
        />
      ) : (
        <video
          ref={videoRef}
          src={item.url}
          className="w-full h-full object-cover pointer-events-none"
          style={filterStyle}
          muted
          loop
          playsInline
        />
      )}

      {/* Icons for Video or Stack */}
      <div className="absolute top-2 right-2 flex gap-1 pointer-events-none">
        {item.type === 'video' && (
          <Play className="w-4 h-4 text-white drop-shadow-md fill-white" />
        )}
        {item.stack && item.stack.length > 1 && (
          <Layers className="w-4 h-4 text-white drop-shadow-md" />
        )}
      </div>
    </div>
  );
}
