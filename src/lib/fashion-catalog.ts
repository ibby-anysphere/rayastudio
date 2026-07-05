import type {
  FashionCategory,
  FashionMaterialId,
  FashionPatternId,
} from "@/lib/studio-types";

export interface FashionCategoryOption {
  id: FashionCategory;
  label: string;
  hint: string;
}

export interface FashionMaterialOption {
  id: FashionMaterialId;
  label: string;
  prompt: string;
  image: string;
}

export interface FashionPatternOption {
  id: FashionPatternId;
  label: string;
  prompt: string;
  image: string;
}

export const fashionCategories: FashionCategoryOption[] = [
  {
    id: "auto",
    label: "Fashion piece",
    hint: "infer the intended garment or accessory from its shape and placement",
  },
  { id: "top", label: "Top", hint: "shirts, tees, corsets" },
  { id: "dress", label: "Dress", hint: "mini to ball gown" },
  { id: "skirt", label: "Skirt", hint: "any length or shape" },
  { id: "pants", label: "Pants", hint: "shorts count too" },
  { id: "outerwear", label: "Jacket", hint: "coats, capes, layers" },
  { id: "bag", label: "Bag", hint: "purses and totes" },
  { id: "shoes", label: "Shoes", hint: "heels, boots, sneakers" },
  { id: "accessory", label: "Anything", hint: "your wild-card shape" },
];

export const fashionMaterials: FashionMaterialOption[] = [
  {
    id: "cotton",
    label: "Cotton",
    prompt: "soft woven cotton with subtle natural fibers and believable drape",
    image: "/fashion/fabrics/cotton.webp",
  },
  {
    id: "denim",
    label: "Denim",
    prompt: "structured denim with diagonal twill, seams, topstitching, and natural wear",
    image: "/fashion/fabrics/denim.webp",
  },
  {
    id: "silk",
    label: "Shiny",
    prompt: "fluid silk with fine fibers, graceful folds, and a soft directional sheen",
    image: "/fashion/fabrics/shiny.webp",
  },
  {
    id: "cashmere",
    label: "Wool",
    prompt:
      "soft cozy cashmere-wool knit with visible yarn loops, a plush halo, and gentle structure",
    image: "/fashion/fabrics/wool.webp",
  },
  {
    id: "leather",
    label: "Leather",
    prompt: "supple premium leather with realistic grain, edge thickness, seams, and highlights",
    image: "/fashion/fabrics/leather.webp",
  },
  {
    id: "sequins",
    label: "Sparkle",
    prompt: "dense couture sequins with individual scale, dimensional sparkle, and fabric movement",
    image: "/fashion/fabrics/sparkle.webp",
  },
];

export const fashionPatterns: FashionPatternOption[] = [
  {
    id: "solid",
    label: "Plain",
    prompt: "a clean solid color with no printed motif",
    image: "/fashion/prints/plain.webp",
  },
  {
    id: "stripes",
    label: "Stripes",
    prompt: "clean, evenly spaced fashion stripes that follow the garment's folds and construction",
    image: "/fashion/prints/stripes.webp",
  },
  {
    id: "polka-dots",
    label: "Dots",
    prompt: "playful, evenly scaled polka dots that distort naturally with perspective and folds",
    image: "/fashion/prints/dots.webp",
  },
  {
    id: "hearts",
    label: "Hearts",
    prompt:
      "a cheerful all-over heart print with bold, evenly scaled heart motifs that follow folds",
    image: "/fashion/prints/hearts.webp",
  },
  {
    id: "stars",
    label: "Stars",
    prompt:
      "a playful all-over star print with bold gold and coral stars that follow folds and perspective",
    image: "/fashion/prints/stars.webp",
  },
  {
    id: "floral",
    label: "Flowers",
    prompt:
      "a cheerful all-over daisy flower print with simple bold petals scaled for the piece",
    image: "/fashion/prints/flowers.webp",
  },
];

export const fashionColors = [
  { name: "Cherry", color: "#f43f5e" },
  { name: "Bubblegum", color: "#ff5fa2" },
  { name: "Tangerine", color: "#ff7a45" },
  { name: "Sunshine", color: "#ffd447" },
  { name: "Lime", color: "#a8d84e" },
  { name: "Mint", color: "#49c99a" },
  { name: "Aqua", color: "#42c7d9" },
  { name: "Sky", color: "#4f9fe8" },
  { name: "Violet", color: "#7c5ce7" },
  { name: "Grape", color: "#9b4bc7" },
  { name: "Cocoa", color: "#8b5a45" },
  { name: "Midnight", color: "#2c2940" },
  {
    name: "Rainbow",
    color: "rainbow",
  },
  { name: "Gold", color: "#d7a928" },
  { name: "Silver", color: "#aab2bf" },
] as const;

export function fashionColorPreview(color: string) {
  return color === "rainbow"
    ? "conic-gradient(#ff3d93, #ff7a45, #ffd447, #49c99a, #42c7d9, #7c5ce7, #ff3d93)"
    : color;
}

export function fashionColorHex(color: string) {
  return color === "rainbow" ? "#ff3d93" : color;
}

export function fashionMaterial(id: FashionMaterialId) {
  return fashionMaterials.find((material) => material.id === id) ?? fashionMaterials[0];
}

export function fashionPattern(id: FashionPatternId) {
  return fashionPatterns.find((pattern) => pattern.id === id) ?? fashionPatterns[0];
}

export function fashionCategory(id: FashionCategory) {
  return fashionCategories.find((category) => category.id === id) ?? fashionCategories[0];
}
