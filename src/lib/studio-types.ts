// Maximum number of images the portrait edit endpoint accepts in a single
// request: the source photo + contextual guide + makeup layers + wardrobe
// references combined. Shared by the client budget guard and the server.
export const MAX_INPUT_IMAGES = 14;

// Per-type sub-caps enforced by the edit endpoint. Wardrobe references and
// makeup layers each have their own ceiling in addition to the combined image
// budget above, and they are the binding limits before the total is reached.
export const MAX_WARDROBE_REFERENCES = 8;
export const MAX_MAKEUP_LAYERS = 4;

export type StudioTab = "makeup" | "wardrobe" | "create";
export type CanvasTool = "select" | "brush" | "eraser";
export type AssetCategory = "jewelry" | "eyewear" | "hair" | "garment" | "accessory";
export type MakeupProductId = "lipstick" | "blush" | "eyeshadow" | "eyeliner";
export type RenderMode = "fast" | "max";
export type ImageAspectRatio =
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9";

export interface StudioAsset {
  id: string;
  name: string;
  category: AssetCategory;
  prompt: string;
  src: string;
  accent: string;
  custom?: boolean;
  createdAt?: number;
}

export interface PlacedAsset {
  instanceId: string;
  asset: StudioAsset;
  x: number;
  y: number;
  scale: number;
  stretchX: number;
  stretchY: number;
  rotation: number;
}

export interface BrushSettings {
  product: MakeupProductId;
  color: string;
  size: number;
  opacity: number;
}

export interface MakeupShade {
  name: string;
  color: string;
}

export interface MakeupProduct {
  id: MakeupProductId;
  name: string;
  shortName: string;
  note: string;
  instruction: string;
  src: string;
  shades: MakeupShade[];
  defaultSize: number;
  minSize: number;
  maxSize: number;
  opacity: number;
  baseHue: number;
}

export interface HistoryItem {
  id: string;
  image: string;
  label: string;
  createdAt: number;
}

export interface GenerationIntent {
  makeupLayers: Array<{
    product: MakeupProductId;
    colors: string[];
  }>;
  placedAssets: Array<{
    name: string;
    category: AssetCategory;
    prompt: string;
    x: number;
    y: number;
    scale: number;
    stretchX: number;
    stretchY: number;
    rotation: number;
    referenceIndex?: number;
  }>;
}
