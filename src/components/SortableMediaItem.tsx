import React, { useRef, useState } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MediaItem } from '../types';
import { cn } from '../lib/utils';
import { Play, Layers } from 'lucide-react';
import { getFilterStyle } from '../lib/filters';

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
        <img
          src={item.url}
          alt=""
          className="w-full h-full object-cover pointer-events-none"
          style={filterStyle}
          referrerPolicy="no-referrer"
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
