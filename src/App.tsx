import React, { useState, useRef } from 'react';
import { Grid } from './components/Grid';
import { Studio } from './components/Studio';
import { MediaItem, Recipe } from './types';
import { sampleMedia, defaultEdits } from './data';
import { Camera, Plus } from 'lucide-react';

export default function App() {
  const [items, setItems] = useState<MediaItem[]>(sampleMedia);
  const [editingItem, setEditingItem] = useState<MediaItem | null>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleItemUpdate = (updatedItem: MediaItem) => {
    setItems((prev) => prev.map((item) => (item.id === updatedItem.id ? updatedItem : item)));
    // Keep Studio in sync: without this the `item` prop is a stale snapshot
    // from the moment the user clicked and edits applied mid-session are lost.
    setEditingItem(updatedItem);
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const newItems: MediaItem[] = Array.from(files).map((file: File) => {
      const isVideo = file.type.startsWith('video/');
      return {
        id: Math.random().toString(36).substring(2, 9),
        type: isVideo ? 'video' : 'image',
        url: URL.createObjectURL(file),
        edits: { ...defaultEdits },
      };
    });

    setItems((prev) => [...newItems, ...prev]);
    
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="min-h-screen bg-[#FAFAFA] dark:bg-[#0A0A0A] text-[#171717] dark:text-[#E5E5E5] font-sans selection:bg-black/10 dark:selection:bg-white/10">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-[#FAFAFA]/80 dark:bg-[#0A0A0A]/80 backdrop-blur-md border-b border-black/5 dark:border-white/5">
        <div className="max-w-md mx-auto px-4 h-14 flex items-center justify-between">
          <h1 className="font-serif text-xl italic tracking-tight">column</h1>
          <div className="flex items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept="image/*,video/*"
              multiple
              className="hidden"
            />
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors"
              title="Upload Media"
            >
              <Plus className="w-5 h-5" />
            </button>
            <button className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors">
              <Camera className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="pb-safe">
        <Grid items={items} setItems={setItems} onItemClick={setEditingItem} />
      </main>

      {/* Studio Overlay */}
      {editingItem && (
        <Studio
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onUpdate={handleItemUpdate}
          recipes={recipes}
          setRecipes={setRecipes}
        />
      )}
    </div>
  );
}

