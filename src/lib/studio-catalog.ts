import type { MakeupProduct, StudioAsset } from "@/lib/studio-types";

const svgData = (markup: string) => {
  const stretchableMarkup = markup.replace(
    "<svg ",
    '<svg preserveAspectRatio="none" ',
  );
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(stretchableMarkup)}`;
};

export const catalogAssets: StudioAsset[] = [
  {
    id: "aurelia-tiara",
    name: "Aurelia tiara",
    category: "jewelry",
    accent: "#d8b66a",
    prompt:
      "a delicate high-jewelry gold tiara with slender botanical arches, champagne diamonds, and one luminous pear-cut center stone",
    src: svgData(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">
        <defs>
          <linearGradient id="g" x1="0" x2="1"><stop stop-color="#8e6b2d"/><stop offset=".48" stop-color="#fff0aa"/><stop offset="1" stop-color="#9a7332"/></linearGradient>
          <radialGradient id="d"><stop stop-color="#fff"/><stop offset=".35" stop-color="#e7f7ff"/><stop offset="1" stop-color="#a9c9d5"/></radialGradient>
          <filter id="s"><feDropShadow dx="0" dy="4" stdDeviation="5" flood-opacity=".24"/></filter>
        </defs>
        <g fill="none" stroke="url(#g)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" filter="url(#s)">
          <path d="M34 141c36-14 65-20 126-20s90 6 126 20"/>
          <path d="M52 132 85 76l29 45 46-92 46 92 29-45 33 56"/>
          <path d="M85 76c16 7 25 4 29-14 8 22 24 21 46-33 22 54 38 55 46 33 4 18 13 21 29 14"/>
        </g>
        <g fill="url(#d)" stroke="#d7b867" stroke-width="3">
          <path d="M160 22c-19 18-21 35 0 52 21-17 19-34 0-52Z"/>
          <circle cx="84" cy="74" r="9"/><circle cx="114" cy="61" r="8"/><circle cx="206" cy="61" r="8"/><circle cx="236" cy="74" r="9"/>
          <circle cx="49" cy="132" r="6"/><circle cx="270" cy="132" r="6"/>
        </g>
      </svg>`),
  },
  {
    id: "lumiere-pearls",
    name: "Lumière drops",
    category: "jewelry",
    accent: "#f0e6d4",
    prompt:
      "a matched pair of refined pearl drop earrings with tiny brushed-gold hoops and softly luminous baroque ivory pearls",
    src: svgData(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">
        <defs><radialGradient id="p" cx=".35" cy=".25"><stop stop-color="#fff"/><stop offset=".35" stop-color="#f8f0df"/><stop offset="1" stop-color="#b8a990"/></radialGradient><filter id="s"><feDropShadow dx="0" dy="6" stdDeviation="6" flood-opacity=".25"/></filter></defs>
        <g filter="url(#s)" stroke="#ad8540" stroke-width="7" fill="none">
          <circle cx="96" cy="45" r="23"/><circle cx="224" cy="45" r="23"/>
          <path d="M96 69v24M224 69v24"/>
        </g>
        <g fill="url(#p)" stroke="#d8c7aa" stroke-width="3" filter="url(#s)">
          <path d="M96 84c-24 19-34 43-19 61 10 13 29 13 39 0 15-18 4-42-20-61Z"/>
          <path d="M224 84c-24 19-34 43-19 61 10 13 29 13 39 0 15-18 4-42-20-61Z"/>
        </g>
      </svg>`),
  },
  {
    id: "noir-frames",
    name: "Noir ovals",
    category: "eyewear",
    accent: "#392f32",
    prompt:
      "slim 1990s-inspired oval sunglasses in translucent espresso acetate with warm smoke lenses and discreet gold temple details",
    src: svgData(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">
        <defs><linearGradient id="l" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#4d3937"/><stop offset=".55" stop-color="#171216"/><stop offset="1" stop-color="#76534a"/></linearGradient><linearGradient id="r"><stop stop-color="#9d7772" stop-opacity=".72"/><stop offset="1" stop-color="#241d23" stop-opacity=".9"/></linearGradient><filter id="s"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-opacity=".3"/></filter></defs>
        <g filter="url(#s)" stroke="url(#l)" stroke-width="10" fill="url(#r)">
          <ellipse cx="92" cy="92" rx="62" ry="39"/><ellipse cx="228" cy="92" rx="62" ry="39"/>
          <path d="M152 88c6-8 10-8 16 0" fill="none" stroke-linecap="round"/>
          <path d="M31 82 8 69M289 82l23-13" fill="none" stroke-linecap="round"/>
        </g>
        <path d="M47 69c21-18 70-22 94 2M183 71c24-24 74-20 92-2" fill="none" stroke="#fff" stroke-opacity=".25" stroke-width="5" stroke-linecap="round"/>
      </svg>`),
  },
  {
    id: "rose-ribbon",
    name: "Rose satin bow",
    category: "hair",
    accent: "#b76e79",
    prompt:
      "an oversized couture hair bow in dusty-rose duchess satin, with sculptural loops, long softly curled tails, and realistic silk sheen",
    src: svgData(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 220">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f2bec2"/><stop offset=".35" stop-color="#a7485c"/><stop offset=".68" stop-color="#d98691"/><stop offset="1" stop-color="#772f42"/></linearGradient><filter id="s"><feDropShadow dx="0" dy="8" stdDeviation="8" flood-opacity=".25"/></filter></defs>
        <g fill="url(#g)" stroke="#85384b" stroke-width="4" filter="url(#s)">
          <path d="M149 90C99 39 36 35 28 65c-8 32 36 77 121 48Z"/>
          <path d="M171 90c50-51 113-55 121-25 8 32-36 77-121 48Z"/>
          <path d="M140 108c-7 38-13 70-38 101l48-25 13 30 10-101Z"/>
          <path d="M178 108c7 37 23 66 48 97l-49-21-13 30-7-101Z"/>
          <rect x="140" y="79" width="40" height="49" rx="14"/>
        </g>
        <path d="M45 63c35-10 68 0 91 28M275 63c-35-10-68 0-91 28" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="7" stroke-linecap="round"/>
      </svg>`),
  },
  {
    id: "celeste-necklace",
    name: "Céleste chain",
    category: "jewelry",
    accent: "#92a8c5",
    prompt:
      "a fine white-gold celestial necklace with a tiny diamond crescent, scattered star charms, and an icy-blue sapphire teardrop",
    src: svgData(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 220">
        <defs><linearGradient id="g"><stop stop-color="#8b9cad"/><stop offset=".5" stop-color="#f5fbff"/><stop offset="1" stop-color="#748696"/></linearGradient><radialGradient id="b"><stop stop-color="#fff"/><stop offset=".3" stop-color="#bde8ff"/><stop offset="1" stop-color="#4a72ad"/></radialGradient><filter id="s"><feDropShadow dx="0" dy="5" stdDeviation="5" flood-opacity=".22"/></filter></defs>
        <path d="M27 33c19 97 74 144 133 144S274 130 293 33" fill="none" stroke="url(#g)" stroke-width="5" filter="url(#s)"/>
        <g fill="url(#g)" filter="url(#s)"><path d="m73 95 5 11 12 2-9 8 2 12-10-6-11 6 3-12-9-8 12-2Z"/><path d="m247 95 5 11 12 2-9 8 2 12-10-6-11 6 3-12-9-8 12-2Z"/></g>
        <path d="M129 151a25 25 0 1 0 27-38 20 20 0 1 1-27 38Z" fill="#edf7ff" stroke="#97aebe" stroke-width="3"/>
        <path d="M160 166c-19 18-20 34 0 47 20-13 19-29 0-47Z" fill="url(#b)" stroke="#c5e8ff" stroke-width="3" filter="url(#s)"/>
      </svg>`),
  },
  {
    id: "silk-scarf",
    name: "Iris silk scarf",
    category: "accessory",
    accent: "#7665a7",
    prompt:
      "a fluid square silk scarf with an abstract iris, saffron and cream marbled print, hand-rolled edges, styled with graceful movement",
    src: svgData(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f3d79c"/><stop offset=".25" stop-color="#694f98"/><stop offset=".5" stop-color="#f6eee2"/><stop offset=".72" stop-color="#ce744f"/><stop offset="1" stop-color="#4a3976"/></linearGradient><filter id="s"><feDropShadow dx="0" dy="8" stdDeviation="9" flood-opacity=".25"/></filter></defs>
        <path d="M49 37c76 15 151-2 217 25-31 42-46 80-39 137-67-13-120 18-184-4 26-50 25-108 6-158Z" fill="url(#g)" stroke="#d8ba84" stroke-width="5" filter="url(#s)"/>
        <path d="M58 58c54 25 112 14 174 18-34 24-56 65-73 106-24-32-58-60-91-77 26-4 66 7 98 18" fill="none" stroke="#fff" stroke-opacity=".48" stroke-width="8" stroke-linecap="round"/>
        <path d="M44 194c69 23 120-9 184 5" fill="none" stroke="#f7e5bd" stroke-width="6" stroke-dasharray="3 8"/>
      </svg>`),
  },
  {
    id: "midnight-dress",
    name: "Midnight column",
    category: "garment",
    accent: "#252a55",
    prompt:
      "an elegant floor-length midnight-blue column gown with an asymmetric draped neckline, sculpted waist, subtle crystal embroidery, and fluid satin train",
    src: svgData(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 360">
        <defs><linearGradient id="g" x1="0" x2="1"><stop stop-color="#111634"/><stop offset=".45" stop-color="#525b99"/><stop offset=".7" stop-color="#20264f"/><stop offset="1" stop-color="#090d25"/></linearGradient><filter id="s"><feDropShadow dx="0" dy="10" stdDeviation="9" flood-opacity=".3"/></filter></defs>
        <path d="M101 35c-8 25-17 42-42 59l30 52-26 173c38 22 96 22 136 0l-28-175 30-50c-25-16-33-35-41-59-13 13-46 13-59 0Z" fill="url(#g)" stroke="#151a3a" stroke-width="5" filter="url(#s)"/>
        <path d="M99 42c17 29 46 42 77 18-4 20-21 34-43 34-20 0-34-13-45-26Z" fill="#767daf" opacity=".7"/>
        <path d="M92 145c22 10 51 10 77-1M84 177c29 12 65 12 93 0M75 233c38 17 78 17 111 0" fill="none" stroke="#b7c5f0" stroke-opacity=".28" stroke-width="4"/>
        <g fill="#d9e9ff"><circle cx="103" cy="119" r="3"/><circle cx="113" cy="129" r="2"/><circle cx="155" cy="115" r="3"/><circle cx="148" cy="129" r="2"/></g>
      </svg>`),
  },
  {
    id: "petal-clutch",
    name: "Petal clutch",
    category: "accessory",
    accent: "#d08b98",
    prompt:
      "a small sculptural evening clutch shaped like overlapping blush-pink flower petals, with a champagne-gold frame and jewel clasp",
    src: svgData(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 220">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ffe0de"/><stop offset=".4" stop-color="#d78291"/><stop offset="1" stop-color="#8d405c"/></linearGradient><filter id="s"><feDropShadow dx="0" dy="8" stdDeviation="9" flood-opacity=".25"/></filter></defs>
        <path d="M36 73c79-43 174-43 248 2l-12 97c-61 25-166 25-224 0Z" fill="url(#g)" stroke="#9a5363" stroke-width="5" filter="url(#s)"/>
        <path d="M42 78c53 60 100 80 118 88 18-8 67-29 118-87M160 166C112 126 90 92 84 57M160 166c48-40 70-73 76-107" fill="none" stroke="#ffe1dd" stroke-opacity=".52" stroke-width="6"/>
        <path d="M36 74c79-43 174-43 248 2" fill="none" stroke="#d9b15d" stroke-width="9"/>
        <circle cx="160" cy="51" r="13" fill="#f5d581" stroke="#9f752c" stroke-width="4"/>
      </svg>`),
  },
];

export const makeupProducts: MakeupProduct[] = [
  {
    id: "lipstick",
    name: "Satin lip",
    shortName: "Lipstick",
    note: "Color and shape",
    instruction: "Trace the natural lip surface",
    src: "/makeup/lipstick.png",
    shades: [
      { name: "Rose veil", color: "#c64f6a" },
      { name: "Berry", color: "#8d3150" },
      { name: "Coral", color: "#d66b5f" },
      { name: "Mulberry", color: "#6f3155" },
      { name: "Brick", color: "#a64c3f" },
      { name: "Warm rose", color: "#b87972" },
    ],
    defaultSize: 18,
    minSize: 8,
    maxSize: 34,
    opacity: 0.68,
    baseHue: 347,
  },
  {
    id: "blush",
    name: "Cloud blush",
    shortName: "Blush",
    note: "Diffused warmth",
    instruction: "Sweep softly over the cheeks",
    src: "/makeup/blush.png",
    shades: [
      { name: "Petal", color: "#e88994" },
      { name: "Apricot", color: "#e99a79" },
      { name: "Berry", color: "#bd637f" },
      { name: "Rosewood", color: "#a76568" },
      { name: "Mauve", color: "#a8798e" },
      { name: "Terracotta", color: "#c5795e" },
    ],
    defaultSize: 52,
    minSize: 30,
    maxSize: 88,
    opacity: 0.26,
    baseHue: 354,
  },
  {
    id: "eyeshadow",
    name: "Velvet shadow",
    shortName: "Eyeshadow",
    note: "Soft eye color",
    instruction: "Paint over the lids and crease",
    src: "/makeup/eyeshadow.png",
    shades: [
      { name: "Plum", color: "#72536f" },
      { name: "Cocoa", color: "#6b514a" },
      { name: "Taupe", color: "#8e7a70" },
      { name: "Dusty rose", color: "#b96d82" },
      { name: "Bronze", color: "#9a6b45" },
      { name: "Champagne", color: "#d8b98f" },
    ],
    defaultSize: 28,
    minSize: 14,
    maxSize: 50,
    opacity: 0.36,
    baseHue: 327,
  },
  {
    id: "eyeliner",
    name: "Precision liner",
    shortName: "Eyeliner",
    note: "Clean definition",
    instruction: "Follow the upper or lower lash line",
    src: "/makeup/eyeliner.png",
    shades: [
      { name: "Soft ink", color: "#252127" },
      { name: "Espresso", color: "#4a302c" },
      { name: "Plum", color: "#4b2c46" },
      { name: "Midnight", color: "#28344e" },
      { name: "Moss", color: "#3d4739" },
      { name: "Aubergine", color: "#392239" },
    ],
    defaultSize: 6,
    minSize: 2,
    maxSize: 16,
    opacity: 0.82,
    baseHue: 351,
  },
];

export const assetStarterPrompts = [
  "A liquid-silver corset with hand-set moonstones",
  "A blush organza gown with ten pearl buttons and blue silk stitches",
  "Sculptural emerald earrings inspired by orchid petals",
  "A glossy 1960s bob with softly curved ends",
];
