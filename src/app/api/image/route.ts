import "server-only";

import { randomUUID } from "node:crypto";
import { ApiError } from "@google/genai";
import OpenAI from "openai";
import {
  generateGeminiImage,
  geminiImageSizeForMode,
  geminiModelForMode,
  type GeminiAspectRatio,
  type GeminiRenderMode,
} from "@/lib/gemini-image";
import {
  artifactizeImage,
  materializeFashionArtifacts,
  NoArtifactsFoundError,
} from "@/lib/openai-artifacts";
import {
  fashionCategory,
  fashionMaterial,
  fashionPattern,
} from "@/lib/fashion-catalog";
import {
  MAX_FASHION_LAYERS,
  MAX_INPUT_IMAGES,
  MAX_MAKEUP_LAYERS,
  MAX_WARDROBE_REFERENCES,
  type ArtifactExtractionStreamEvent,
  type AssetCategory,
  type FashionCategory,
  type FashionMaterialId,
  type FashionPatternId,
  type GenerationIntent,
  type MakeupProductId,
} from "@/lib/studio-types";

export const runtime = "nodejs";
export const maxDuration = 300;

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const OPENAI_ASSET_MODEL =
  process.env.OPENAI_ASSET_MODEL || "gpt-image-1.5";
const OPENAI_VISION_MODEL =
  process.env.OPENAI_VISION_MODEL || "gpt-5.4-nano";
const OPENAI_FASHION_GROUPING_MODEL =
  process.env.OPENAI_FASHION_GROUPING_MODEL || "gpt-5.4-mini";
const ALLOWED_CATEGORIES = new Set<AssetCategory>([
  "jewelry",
  "eyewear",
  "hair",
  "garment",
  "accessory",
]);
const ALLOWED_MAKEUP_PRODUCTS = new Set<MakeupProductId>([
  "lipstick",
  "blush",
  "eyeshadow",
  "eyeliner",
]);
const ALLOWED_FASHION_CATEGORIES = new Set<FashionCategory>([
  "auto",
  "top",
  "dress",
  "skirt",
  "pants",
  "outerwear",
  "bag",
  "shoes",
  "accessory",
]);
const ALLOWED_FASHION_MATERIALS = new Set<FashionMaterialId>([
  "cotton",
  "denim",
  "silk",
  "cashmere",
  "leather",
  "sequins",
]);
const ALLOWED_FASHION_PATTERNS = new Set<FashionPatternId>([
  "solid",
  "stripes",
  "polka-dots",
  "hearts",
  "stars",
  "floral",
]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MAX_FILE_SIZE = 24 * 1024 * 1024;
const MAX_ARTIFACT_SOURCE_SIZE = 4 * 1024 * 1024;
const MAX_ARTIFACT_RESPONSE_CHARS = 4_000_000;
const MAX_REQUEST_SIZE = 14 * 1024 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 12;

interface RateBucket {
  startedAt: number;
  requests: number;
}

const globalRateStore = globalThis as typeof globalThis & {
  __riyaRateLimits?: Map<string, RateBucket>;
};
const rateLimits = globalRateStore.__riyaRateLimits ?? new Map<string, RateBucket>();
globalRateStore.__riyaRateLimits = rateLimits;

function clientAddress(request: Request) {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local"
  );
}

function withinRateLimit(address: string) {
  const now = Date.now();
  const current = rateLimits.get(address);

  if (!current || now - current.startedAt > RATE_WINDOW_MS) {
    rateLimits.set(address, { startedAt: now, requests: 1 });
    return true;
  }
  if (current.requests >= RATE_LIMIT) return false;
  current.requests += 1;
  return true;
}

function errorResponse(status: number, error: string, detail: string) {
  return Response.json(
    { error, detail },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

function isImageFile(value: FormDataEntryValue | null): value is File {
  return (
    value instanceof File &&
    ALLOWED_IMAGE_TYPES.has(value.type) &&
    value.size > 0 &&
    value.size <= MAX_FILE_SIZE
  );
}

function isArtifactSource(value: FormDataEntryValue | null): value is File {
  return isImageFile(value) && value.size <= MAX_ARTIFACT_SOURCE_SIZE;
}

function safeIntent(raw: FormDataEntryValue | null): GenerationIntent | null {
  if (typeof raw !== "string" || raw.length > 20_000) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<GenerationIntent>;
    if (
      !Array.isArray(parsed.makeupLayers) ||
      !Array.isArray(parsed.fashionLayers) ||
      !Array.isArray(parsed.placedAssets)
    ) {
      return null;
    }

    const seenProducts = new Set<MakeupProductId>();
    const makeupLayers: GenerationIntent["makeupLayers"] = [];
    for (const layer of parsed.makeupLayers.slice(0, MAX_MAKEUP_LAYERS)) {
      if (
        !layer ||
        !ALLOWED_MAKEUP_PRODUCTS.has(layer.product) ||
        !Array.isArray(layer.colors) ||
        seenProducts.has(layer.product)
      ) {
        continue;
      }
      const colors = Array.from(
        new Set(
          layer.colors
            .filter((color): color is string => typeof color === "string")
            .map((color) => color.toLowerCase())
            .filter((color) => HEX_COLOR.test(color)),
        ),
      ).slice(0, 8);
      if (colors.length === 0) continue;
      seenProducts.add(layer.product);
      makeupLayers.push({ product: layer.product, colors });
    }

    const fashionLayers: GenerationIntent["fashionLayers"] = [];
    for (const layer of parsed.fashionLayers.slice(0, MAX_FASHION_LAYERS)) {
      if (
        !layer ||
        (layer.kind !== "filled-region" && layer.kind !== "outline") ||
        !ALLOWED_FASHION_CATEGORIES.has(layer.category) ||
        !ALLOWED_FASHION_MATERIALS.has(layer.material) ||
        !ALLOWED_FASHION_PATTERNS.has(layer.pattern) ||
        typeof layer.color !== "string" ||
        (!HEX_COLOR.test(layer.color) && layer.color !== "rainbow") ||
        !layer.bounds ||
        typeof layer.bounds.x !== "number" ||
        typeof layer.bounds.y !== "number" ||
        typeof layer.bounds.width !== "number" ||
        typeof layer.bounds.height !== "number"
      ) {
        continue;
      }
      fashionLayers.push({
        kind: layer.kind,
        category: layer.category,
        material: layer.material,
        pattern: layer.pattern,
        color: layer.color.toLowerCase(),
        bounds: {
          x: Math.min(1, Math.max(0, layer.bounds.x)),
          y: Math.min(1, Math.max(0, layer.bounds.y)),
          width: Math.min(1, Math.max(0.01, layer.bounds.width)),
          height: Math.min(1, Math.max(0.01, layer.bounds.height)),
        },
      });
    }

    return {
      makeupLayers,
      fashionLayers,
      placedAssets: parsed.placedAssets.slice(0, 12).flatMap((asset) => {
        if (
          !asset ||
          typeof asset.name !== "string" ||
          typeof asset.prompt !== "string" ||
          !ALLOWED_CATEGORIES.has(asset.category) ||
          typeof asset.x !== "number" ||
          typeof asset.y !== "number" ||
          typeof asset.scale !== "number" ||
          typeof asset.rotation !== "number"
        ) {
          return [];
        }
        return [
          {
            name: asset.name.slice(0, 100),
            category: asset.category,
            prompt: asset.prompt.slice(0, 1_200),
            x: Math.min(1, Math.max(0, asset.x)),
            y: Math.min(1, Math.max(0, asset.y)),
            scale: Math.min(100, Math.max(1, asset.scale)),
            stretchX:
              typeof asset.stretchX === "number"
                ? Math.min(3, Math.max(0.3, asset.stretchX))
                : 1,
            stretchY:
              typeof asset.stretchY === "number"
                ? Math.min(3, Math.max(0.3, asset.stretchY))
                : 1,
            rotation: Math.min(180, Math.max(-180, asset.rotation)),
            referenceIndex:
              typeof asset.referenceIndex === "number"
                ? Math.max(2, Math.floor(asset.referenceIndex))
                : undefined,
          },
        ];
      }),
    };
  } catch {
    return null;
  }
}

function describePosition(x: number, y: number) {
  const horizontal = x < 0.34 ? "left" : x > 0.66 ? "right" : "center";
  const vertical = y < 0.3 ? "upper" : y > 0.67 ? "lower" : "middle";
  return `${vertical}-${horizontal} area (normalized position ${x.toFixed(2)}, ${y.toFixed(2)})`;
}

const MAKEUP_LAYER_RULES: Record<
  MakeupProductId,
  { label: string; instruction: string }
> = {
  lipstick: {
    label: "LIPSTICK",
    instruction:
      "Interpret the marks only as lip color. Snap rough edges to the subject's real vermilion border, preserve natural lip lines, texture, volume, highlights, and expression, and produce a refined satin cosmetic finish. Never treat these marks as blush, face paint, or a change to lip anatomy.",
  },
  blush: {
    label: "POWDER BLUSH",
    instruction:
      "Interpret the marks only as softly diffused cheek blush. Feather the pigment into the skin with a believable powder-to-skin transition while preserving pores, freckles, highlights, and facial structure. Never create hard painted circles or use these marks as lipstick or eyeshadow.",
  },
  eyeshadow: {
    label: "EYESHADOW",
    instruction:
      "Interpret the marks only as eyeshadow on the eyelid and crease. Blend them into a controlled cosmetic gradient that follows lid anatomy while preserving lashes, brows, sclera, iris, catchlights, and eye shape. Never tint the whole eye region or convert the marks into eyeliner.",
  },
  eyeliner: {
    label: "EYELINER",
    instruction:
      "Interpret the marks only as precision eyeliner aligned to the nearest upper or lower lash line. Refine the rough guide into a clean, tapered cosmetic stroke while preserving individual lashes, eyelid anatomy, iris, sclera, and eye shape. Never broaden it into eyeshadow.",
  },
};

interface MakeupLayerLayout {
  product: MakeupProductId;
  colors: string[];
  index: number;
}

type FashionLayerLayout = GenerationIntent["fashionLayers"][number] & {
  index: number;
};

interface InputLayout {
  sourceIndex: number;
  contextualGuideIndex?: number;
  makeupLayers: MakeupLayerLayout[];
  fashionLayers: FashionLayerLayout[];
}

function physicalIntegrationRule(
  asset: GenerationIntent["placedAssets"][number],
) {
  const normalizedDescription = `${asset.name} ${asset.prompt}`.toLowerCase();
  if (
    /\b(gloves?|mittens?|mitts?|gauntlets?)\b/.test(normalizedDescription)
  ) {
    return "Rebuild it as a real fitted glove product over the intended hand and wrist, with articulated fingers, thumb construction, seams, material thickness, grip, folds, and contact shadows. If the hand is cropped by the photograph, continue the glove naturally to the frame edge without turning it into a sleeve or inventing exposed anatomy.";
  }
  if (
    /\b(bags?|purses?|handbags?|totes?|clutches?)\b/.test(
      normalizedDescription,
    )
  ) {
    return "Rebuild it as a complete dimensional bag rather than a flat clothing patch: preserve its body, opening, handles or strap, gussets, hardware, material thickness, and believable contents volume, then attach or place it naturally at the nearest plausible hand, shoulder, or hip with gravity and contact shadows.";
  }
  if (
    normalizedDescription.includes("tiara") ||
    normalizedDescription.includes("crown")
  ) {
    return "Fit it to the person's actual head rather than copying the flat placement proxy: seat the band at the natural hairline, curve it around the skull as an ellipse in perspective, and let the far side pass behind the head or hair. Give the metal and stones real thickness, contact points, cast shadows, reflections, and camera-matched depth of field.";
  }
  if (
    /\b(keychains?|key rings?|keyrings?|lobster clasps?)\b/.test(
      normalizedDescription,
    )
  ) {
    return "Clip the keychain's clasp securely onto the nearest plausible jeans belt loop, waistband loop, or pocket edge. Keep it small, preserve every ring, chain link, charm, and hardware detail, and let the chain and charm hang downward under gravity with realistic metal thickness, denim contact, front/behind occlusion, movement, and contact shadows. Never turn it into a necklace or let it float.";
  }
  if (
    normalizedDescription.includes("necklace") ||
    normalizedDescription.includes("chain") ||
    normalizedDescription.includes("choker")
  ) {
    return "Fit it around the anatomical neck and clavicle—not across the cheeks, mouth, or face—with a perspective-correct back section, natural drape, real metal and gemstone thickness, skin contact, gravity, reflections, and contact shadows.";
  }
  if (asset.category === "hair") {
    return "Rebuild it as biologically plausible hair rooted into the subject's scalp and existing hairline. Match strand scale, density, roots, gravity, flyaways, translucency, highlights, and depth of field. Route locks around the forehead and face instead of pasting a wig-shaped card over facial features.";
  }
  if (asset.category === "eyewear") {
    return "Fit it to the bridge of the nose and both ears in perspective, with real frame thickness, lens refraction, reflections, transparent occlusion, and contact shadows.";
  }
  if (asset.category === "garment") {
    return "Tailor it around the subject's actual anatomy and pose with believable seams, thickness, folds, tension, gravity, skin contact, and occlusion behind arms and hair.";
  }
  if (asset.category === "jewelry") {
    return "Give it real metal and gemstone thickness, correct attachment to anatomy, physically plausible curvature, contact shadows, specular reflections, refraction, and front/behind occlusion.";
  }
  return "First infer the most plausible specific real-world item from the full design description, reference appearance, material, shape, scale, placement, and nearby anatomy or clothing. Then rebuild that item with complete three-dimensional geometry, thickness, construction, attachment, perspective, contact shadows, material response, and correct front/behind occlusion in the photographed scene.";
}

function editPrompt(intent: GenerationIntent, layout: InputLayout) {
  const pieces =
    intent.placedAssets.length === 0
      ? "No separate wardrobe pieces were requested."
      : intent.placedAssets
          .map((asset, index) => {
            const reference = asset.referenceIndex
              ? ` Input image ${asset.referenceIndex} is the isolated design reference; copy its design language and construction, never its flat lighting or 2D appearance.`
              : "";
            const proportions =
              Math.abs(asset.stretchX - 1) > 0.04 ||
              Math.abs(asset.stretchY - 1) > 0.04
                ? ` The user intentionally adjusted its proportions to ${asset.stretchX.toFixed(2)}× width and ${asset.stretchY.toFixed(2)}× height; honor that final silhouette while keeping the object physically plausible.`
                : "";
            return `${index + 1}. ${asset.name} (${asset.category}): ${asset.prompt}. Place it in the ${describePosition(
              asset.x,
              asset.y,
            )}, visually about ${Math.round(asset.scale)}% of the image width, rotated ${Math.round(
              asset.rotation,
            )} degrees.${proportions}${reference} ${physicalIntegrationRule(asset)}`;
          })
          .join("\n");
  const fashionDesigns =
    layout.fashionLayers.length === 0
      ? "No hand-drawn fashion shapes were requested."
      : layout.fashionLayers
          .map((layer, index) => {
            const category = fashionCategory(layer.category);
            const material = fashionMaterial(layer.material);
            const pattern = fashionPattern(layer.pattern);
            const centerX = layer.bounds.x + layer.bounds.width / 2;
            const centerY = layer.bounds.y + layer.bounds.height / 2;
            const categoryHint =
              layer.category === "auto"
                ? ""
                : ` The user labeled it a ${category.label.toLowerCase()}.`;
            return `${index + 1}. Input image ${layer.index}: a coverage stencil aligned pixel-for-pixel with the photograph, in the ${describePosition(centerX, centerY)}. Its ${layer.color} pixels mark exactly where a new ${material.label.toLowerCase()} garment (${material.prompt}) with ${pattern.prompt} sits on the body; white pixels are left untouched. Paint the new material within every colored pixel and only those pixels. The colored shape is the garment's exact silhouette—its sleeves or lack of them, length, openings, straps, and extensions all follow the drawing. Reproduce that outline faithfully, smoothing only tiny hand jitter; do not add, remove, lengthen, shorten, or reshape coverage into a different garment.${categoryHint}`;
          })
          .join("\n");

  const contextualGuide = layout.contextualGuideIndex
    ? `- Input image ${layout.contextualGuideIndex} is a translucent contextual guide. Use it only for approximate placement, scale, pose relationships, and the user's combined intent. Do not copy its pasted edges, transparency, flat lighting, or accidental overlap.`
    : "- No contextual guide was supplied.";
  const makeupDesigns = layout.makeupLayers.length
    ? layout.makeupLayers
        .map(({ product, colors, index }) => {
          const rule = MAKEUP_LAYER_RULES[product];
          return `- Input image ${index}: source-aligned ${rule.label} map using ${colors.join(", ")}. White means no edit in this map. ${rule.instruction}`;
        })
        .join("\n")
    : "- No makeup change was requested.";
  const hasRequestedEdits = Boolean(
    layout.makeupLayers.length ||
      layout.fashionLayers.length ||
      intent.placedAssets.length,
  );

  return `
You are RIYA, a photorealistic image editor. Turn the user's visual intent into a result that looks physically real in the source photograph.

GOAL
${hasRequestedEdits ? "Apply every requested styling change below." : "No styling change was requested; reproduce the source photograph."}
- Input image ${layout.sourceIndex} is the current accepted photograph and the source of truth for the person's identity, face, skin, body, pose, camera, crop, environment, and all previously accepted styling.
${contextualGuide}
- Isolated maps and placement proxies communicate intent; they are not pixels to paste. Isolated design references define appearance and construction, not flat pose or lighting.

REQUESTED PIECES
${pieces}

HAND-DRAWN FASHION DESIGNS
${fashionDesigns}

MAKEUP DESIGNS
${makeupDesigns}

INTENT AND FIT
- One rule governs every fashion map: colored pixels become the new garment; white pixels stay exactly as the current photograph. The existing shirt, skin, and background under white pixels are untouched, so any gap or opening drawn inside a garment keeps the original clothing showing through there.
- The colored coverage is the garment's exact silhouette and is the whole intent. Whatever the user drew—short or long sleeves, a sleeveless vest, a hood, gloves, straps, a cropped or floor-length hem—render precisely that. Do not add, remove, lengthen, shorten, or reshape coverage into a more familiar garment; a sleeveless drawing stays sleeveless and a sleeved drawing keeps its sleeves.
- Smooth only small hand-drawn wobble into clean seams while keeping the shape, length, and proportions the user drew.
- Connected maps, or maps with matching styling, are one garment.
- Render each named material and print as real fabric with believable thickness, folds, seams, and the photograph's own lighting and shadows—never a flat sticker or a simple recolor.
- Placement proxies and coordinates are approximate anchors; fit the garment to the person's real anatomy and pose.
- Apply makeup only as the named cosmetic in its aligned map, refining rough marks to real anatomy while preserving pores, texture, lashes, and brows. Leave no white map, digital stroke, halo, or pasted edge.

REALISM AND PRESERVATION
- Reconstruct additions as physically present three-dimensional objects. Infer hidden geometry, thickness, attachment, gravity, collision, and which parts pass behind or in front of hair, head, ears, neck, hands, body, and clothing.
- Match the photograph's actual illumination, color temperature, perspective, focal character, depth of field, grain, sharpness, reflections, material response, contact shadows, and edge softness.
- Preserve the exact recognizable person, facial geometry, expression, skin tone and texture, body, pose, framing, background, and lighting. Do not beautify, smooth, relight, restyle, zoom, or crop the untouched photograph.
- Keep eyes, eyebrows, nose, and mouth recognizable. If an approximate proxy crosses the face, recover the face from input image ${layout.sourceIndex} and fit the item naturally around or behind it.
- Add only requested styling. No unrelated objects, text, logos, watermarks, duplicate pieces, or extra anatomy.
- Before output, verify that every requested region and substantial extension is present, every item fits its anatomical anchor, and every addition looks photographed in-camera rather than pasted on.
`.trim();
}

function imageDataUrl(base64: string, mimeType: string) {
  return `data:${mimeType};base64,${base64}`;
}

// Persists the exact images and prompt handed to Gemini so the authoritative
// coverage map can be inspected against on-canvas intent. Opt-in via the
// RIYA_DEBUG_MASKS env flag; output lands in the gitignored .riya-debug folder.
async function dumpEditDebug(
  requestId: string,
  files: File[],
  prompt: string,
  intent: GenerationIntent,
) {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const dir = join(process.cwd(), ".riya-debug", requestId);
    await mkdir(dir, { recursive: true });
    await Promise.all(
      files.map(async (file, index) => {
        const extension = file.type.split("/")[1] || "png";
        const label = index === 0 ? "1-source" : `${index + 1}-${file.name}`;
        const safe = label.replace(/[^a-z0-9._-]/gi, "-");
        await writeFile(
          join(dir, `${safe}.${extension}`),
          Buffer.from(await file.arrayBuffer()),
        );
      }),
    );
    await writeFile(join(dir, "prompt.txt"), prompt, "utf8");
    await writeFile(
      join(dir, "intent.json"),
      JSON.stringify(intent, null, 2),
      "utf8",
    );
    console.info(`[RIYA ${requestId}] debug dump written to ${dir}`);
  } catch (error) {
    console.warn(
      `[RIYA ${requestId}] debug dump failed`,
      error instanceof Error ? error.message : error,
    );
  }
}

function requestedRenderMode(form: FormData): GeminiRenderMode {
  return form.get("renderMode") === "max" ? "max" : "fast";
}

const GEMINI_ASPECT_RATIOS = new Set<GeminiAspectRatio>([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);

function requestedAspectRatio(form: FormData): GeminiAspectRatio {
  const value = form.get("aspectRatio");
  return typeof value === "string" &&
    GEMINI_ASPECT_RATIOS.has(value as GeminiAspectRatio)
    ? (value as GeminiAspectRatio)
    : "1:1";
}

const ASSET_CATEGORY_PATTERNS: Array<{
  category: Exclude<AssetCategory, "accessory">;
  pattern: RegExp;
}> = [
  {
    category: "hair",
    pattern:
      /\b(hair|hairstyle|haircut|wig|bangs?|fringe|braids?|bob|curls?|ponytail|bun|updo|locs?|dreadlocks?)\b/i,
  },
  {
    category: "eyewear",
    pattern: /\b(eye\s?wear|glasses|sunglasses|goggles|spectacles|frames|monocle)\b/i,
  },
  {
    category: "jewelry",
    pattern:
      /\b(jewelry|jewel|earrings?|necklace|chain|pendant|choker|bracelet|bangle|ring|brooch|tiara|crown|anklet|cufflinks?|piercing)\b/i,
  },
  {
    category: "garment",
    pattern:
      /\b(garment|clothing|outfit|dress|gown|skirt|shirts?|blouse|tops?|tee|t-shirt|turtlenecks?|pants|trousers|jeans|shorts|suit|jacket|coat|blazer|sweater|hoodie|cardigan|corset|bodysuit|jumpsuit|romper|vest|robe|cape|kimono|lingerie|swimsuit|bikini|uniform|sari|saree|lehenga)\b/i,
  },
];

function inferAssetCategory(description: string): AssetCategory {
  return (
    ASSET_CATEGORY_PATTERNS.find(({ pattern }) => pattern.test(description))?.category ??
    "accessory"
  );
}

function assetGenerationPrompt(
  description: string,
  category: AssetCategory,
  conservative = false,
) {
  const subject =
    category === "garment"
      ? "adult-sized fashion garment"
      : category === "hair"
        ? "adult hairpiece or wig"
        : category === "jewelry"
          ? "fashion jewelry piece"
          : category === "eyewear"
            ? "eyewear product"
            : "physical object or wearable accessory";

  return `
Create exactly one standalone ${subject} as a premium retail product cutout.

DESIGN BRIEF
${description.trim()}

OUTPUT RULES
- Show one complete retail product, centered and fully visible, in a useful front or three-quarter product view. A conventional matched set such as gloves, shoes, or earrings counts as one product and should be shown together.
- Transparent background with clean, precise alpha edges.
- No wearer, model, mannequin, display stand, text, label, logo, border, scenery, unrelated duplicate, or extra product.
- Photorealistic materials, construction, stitching, gems, reflections, and dimensional detail.
- Treat the brief strictly as product-design attributes, not as a request to depict a person or scene.
${
  conservative
    ? "- Keep the result non-suggestive and suitable for a mainstream adult fashion catalog. Omit any detail that requires showing anatomy or a wearer."
    : ""
}
- The product must be coherent enough to use as an isolated design reference in a later portrait edit.
  `.trim();
}

function isSafetyRejection(error: unknown) {
  const status =
    error instanceof ApiError ||
    (typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number")
      ? error.status
      : null;
  return (
    status === 400 &&
    error instanceof Error &&
    /safety|policy|blocked|prohibited|responsible/i.test(error.message)
  );
}

function providerError(error: unknown, provider: "Gemini" | "OpenAI") {
  const status =
    error instanceof ApiError ||
    (typeof error === "object" &&
      error !== null &&
      "status" in error &&
      typeof error.status === "number")
      ? error.status
      : null;

  if (status !== null) {
    if (status === 401 || status === 403) {
      return errorResponse(
        502,
        "Image model authentication failed",
        `The server-side ${provider} API key is invalid or unauthorized. Add a fresh key and restart.`,
      );
    }
    if (status === 429) {
      return errorResponse(
        429,
        "Image generation is temporarily limited",
        `The ${provider} project is rate-limited or out of image credits. Wait briefly or check project billing.`,
      );
    }
    if (status === 400) {
      if (isSafetyRejection(error)) {
        return errorResponse(
          400,
          `The design was blocked by ${provider}'s safety filter`,
          "Use a clear product image or describe only the item's visible design details.",
        );
      }
      return errorResponse(
        400,
        "The image request was declined",
        error instanceof Error
          ? error.message
          : "Try fewer pieces or a different source image.",
      );
    }
  }

  if (
    error instanceof Error &&
    /20 MB inline limit|returned no image/i.test(error.message)
  ) {
    return errorResponse(502, "The image request could not be completed", error.message);
  }

  console.error(`RIYA ${provider} generation failed`, error);
  return errorResponse(
    502,
    "The image service did not complete the request",
    "No credits were stored in the browser. Please try again.",
  );
}

function artifactFailureDetail(reason: unknown) {
  if (!(reason instanceof Error)) return "This piece could not be extracted.";
  return reason.message.replace(/\s+/g, " ").trim().slice(0, 280);
}

function artifactizeStreamResponse({
  request,
  source,
  requestId,
  startedAt,
}: {
  request: Request;
  source: File;
  requestId: string;
  startedAt: number;
}) {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let streamClosed = false;
  const abortFromRequest = () => abortController.abort();

  if (request.signal.aborted) {
    abortController.abort();
  } else {
    request.signal.addEventListener("abort", abortFromRequest, { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: ArtifactExtractionStreamEvent) => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          streamClosed = true;
          abortController.abort();
        }
      };

      const run = async () => {
        let responseChars = 0;
        let deliveredCount = 0;
        let payloadOmissions = 0;

        try {
          send({ type: "started" });
          const result = await artifactizeImage({
            source,
            imageModel: OPENAI_ASSET_MODEL,
            visionModel: OPENAI_VISION_MODEL,
            signal: abortController.signal,
            onInventory: (candidates) => {
              send({
                type: "inventory",
                detectedCount: candidates.length,
                items: candidates.map((candidate, index) => ({
                  id: `${requestId}-${index}`,
                  index,
                  name: candidate.name,
                  category: candidate.category,
                  prompt: candidate.description,
                })),
              });
            },
            onSettled: (_candidate, index, settled) => {
              const id = `${requestId}-${index}`;
              if (settled.status === "rejected") {
                send({
                  type: "artifact-error",
                  id,
                  index,
                  detail: artifactFailureDetail(settled.reason),
                });
                return;
              }

              const artifact = settled.value;
              if (
                responseChars + artifact.base64.length >
                MAX_ARTIFACT_RESPONSE_CHARS
              ) {
                payloadOmissions += 1;
                send({
                  type: "artifact-error",
                  id,
                  index,
                  detail: "This piece was too large to deliver. Try a tighter crop.",
                });
                return;
              }

              responseChars += artifact.base64.length;
              deliveredCount += 1;
              send({
                type: "artifact",
                id,
                index,
                artifact: {
                  image: imageDataUrl(artifact.base64, artifact.mimeType),
                  name: artifact.name,
                  category: artifact.category,
                  prompt: artifact.description,
                },
              });
            },
          });

          if (payloadOmissions > 0) {
            console.warn(
              `[RIYA ${requestId}] omitted ${payloadOmissions} artifact outputs to stay within the response budget`,
            );
          }
          if (deliveredCount === 0) {
            send({
              type: "error",
              error: "No generated artifacts could be delivered",
              detail: "Try a tighter crop around the products.",
            });
            return;
          }

          const failedCount = result.failedCount + payloadOmissions;
          console.info(
            `[RIYA ${requestId}] artifactized ${deliveredCount}/${result.detectedCount} products in ${Date.now() - startedAt}ms · ${OPENAI_ASSET_MODEL}`,
          );
          send({
            type: "complete",
            detectedCount: result.detectedCount,
            completedCount: deliveredCount,
            failedCount,
          });
        } catch (error) {
          if (abortController.signal.aborted) return;
          console.error(
            `[RIYA ${requestId}] artifactize failed after ${Date.now() - startedAt}ms`,
            error instanceof Error ? error.message : error,
          );
          if (error instanceof NoArtifactsFoundError) {
            send({
              type: "error",
              error: "No reusable artifacts were found",
              detail:
                "Try an image with a clearly visible garment, accessory, hairstyle, or object.",
            });
            return;
          }

          const response = providerError(error, "OpenAI");
          const payload = (await response.json()) as {
            error?: string;
            detail?: string;
          };
          send({
            type: "error",
            error: payload.error || "The image service did not complete the request",
            detail: payload.detail || "Please try again.",
          });
        } finally {
          request.signal.removeEventListener("abort", abortFromRequest);
          if (!streamClosed) {
            streamClosed = true;
            controller.close();
          }
        }
      };

      void run();
    },
    cancel() {
      streamClosed = true;
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function POST(request: Request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_SIZE) {
    return errorResponse(413, "Upload is too large", "Use smaller source and reference images.");
  }

  const address = clientAddress(request);
  if (!withinRateLimit(address)) {
    return errorResponse(
      429,
      "Atelier limit reached",
      "Wait a few minutes before starting another high-quality render.",
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse(400, "Invalid request", "The uploaded form could not be read.");
  }

  const mode = form.get("mode");
  const isOpenAIAssetMode =
    mode === "asset" ||
    mode === "artifactize" ||
    mode === "fashion-artifactize";
  if (isOpenAIAssetMode && !process.env.OPENAI_API_KEY) {
    return errorResponse(
      503,
      "Artifact model is not connected",
      "Add OPENAI_API_KEY to .env.local and restart the studio.",
    );
  }
  if (mode === "edit" && !process.env.GEMINI_API_KEY) {
    return errorResponse(
      503,
      "Portrait model is not connected",
      "Add GEMINI_API_KEY to .env.local and restart the studio.",
    );
  }
  const renderMode = requestedRenderMode(form);
  const aspectRatio = requestedAspectRatio(form);
  const selectedModel =
    isOpenAIAssetMode
      ? mode === "artifactize"
        ? `${OPENAI_VISION_MODEL} + ${OPENAI_ASSET_MODEL}`
        : mode === "fashion-artifactize"
          ? `${OPENAI_FASHION_GROUPING_MODEL} + ${OPENAI_ASSET_MODEL}`
          : OPENAI_ASSET_MODEL
      : geminiModelForMode(renderMode);
  const imageSize = geminiImageSizeForMode(renderMode);
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  console.info(
    `[RIYA ${requestId}] ${String(mode)} request started · ${renderMode} · ${selectedModel} · ${mode === "edit" ? `${aspectRatio} ${imageSize}` : "1024x1024"} · ${contentLength || "unknown"} bytes`,
  );

  try {
    if (mode === "fashion-artifactize") {
      const source = form.get("source");
      const guideEntries = form.getAll("fashionLayers");
      const intent = safeIntent(form.get("intent"));
      if (!isArtifactSource(source) || !intent) {
        return errorResponse(
          400,
          "The finished look could not be prepared",
          "Use a valid finished JPG, PNG, or WebP image and try again.",
        );
      }
      if (
        intent.fashionLayers.length === 0 ||
        guideEntries.length > MAX_FASHION_LAYERS ||
        guideEntries.length !== intent.fashionLayers.length ||
        !guideEntries.every(isArtifactSource)
      ) {
        return errorResponse(
          400,
          "The fashion drawing layers are incomplete",
          "Keep the finished drawing layers aligned with the imagined look.",
        );
      }

      const result = await materializeFashionArtifacts({
        source,
        guides: guideEntries as File[],
        instructions: intent.fashionLayers,
        imageModel: OPENAI_ASSET_MODEL,
        groupingModel: OPENAI_FASHION_GROUPING_MODEL,
        signal: request.signal,
      });
      let responseChars = 0;
      const deliverableArtifacts = result.artifacts.filter((artifact) => {
        if (
          responseChars + artifact.base64.length >
          MAX_ARTIFACT_RESPONSE_CHARS
        ) {
          return false;
        }
        responseChars += artifact.base64.length;
        return true;
      });
      const payloadOmissions =
        result.artifacts.length - deliverableArtifacts.length;
      if (deliverableArtifacts.length === 0) {
        return errorResponse(
          502,
          "The closet pieces were too large to deliver",
          "Your imagined look is safe. Try materializing fewer drawn pieces at once.",
        );
      }

      console.info(
        `[RIYA ${requestId}] materialized ${deliverableArtifacts.length}/${result.detectedCount} grouped drawn pieces in ${Date.now() - startedAt}ms · ${OPENAI_FASHION_GROUPING_MODEL} + ${OPENAI_ASSET_MODEL}`,
      );
      return Response.json(
        {
          artifacts: deliverableArtifacts.map((artifact) => ({
            image: imageDataUrl(artifact.base64, artifact.mimeType),
            name: artifact.name,
            category: artifact.category,
            prompt: artifact.description,
          })),
          detectedCount: result.detectedCount,
          failedCount: result.failedCount + payloadOmissions,
          model: OPENAI_ASSET_MODEL,
          groupingModel: OPENAI_FASHION_GROUPING_MODEL,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (mode === "artifactize") {
      const source = form.get("source");
      if (!isArtifactSource(source)) {
        return errorResponse(
          400,
          "Choose a valid reference image",
          "Upload one JPG, PNG, or WebP image smaller than 4 MB.",
        );
      }
      if (form.get("stream") === "1") {
        return artifactizeStreamResponse({
          request,
          source,
          requestId,
          startedAt,
        });
      }

      let result;
      try {
        result = await artifactizeImage({
          source,
          imageModel: OPENAI_ASSET_MODEL,
          visionModel: OPENAI_VISION_MODEL,
          signal: request.signal,
        });
      } catch (error) {
        if (error instanceof NoArtifactsFoundError) {
          return errorResponse(
            422,
            "No reusable artifacts were found",
            "Try an image with a clearly visible garment, accessory, hairstyle, or object.",
          );
        }
        throw error;
      }

      let responseChars = 0;
      const deliverableArtifacts = result.artifacts.filter((artifact) => {
        if (
          responseChars + artifact.base64.length >
          MAX_ARTIFACT_RESPONSE_CHARS
        ) {
          return false;
        }
        responseChars += artifact.base64.length;
        return true;
      });
      const payloadOmissions =
        result.artifacts.length - deliverableArtifacts.length;
      if (deliverableArtifacts.length === 0) {
        return errorResponse(
          502,
          "The generated artifact was too large to deliver",
          "Try a tighter crop around the product.",
        );
      }
      if (payloadOmissions > 0) {
        console.warn(
          `[RIYA ${requestId}] omitted ${payloadOmissions} artifact outputs to stay within the response budget`,
        );
      }

      console.info(
        `[RIYA ${requestId}] artifactized ${deliverableArtifacts.length}/${result.detectedCount} products in ${Date.now() - startedAt}ms · ${OPENAI_ASSET_MODEL}`,
      );
      return Response.json(
        {
          artifacts: deliverableArtifacts.map((artifact) => ({
            image: imageDataUrl(artifact.base64, artifact.mimeType),
            name: artifact.name,
            category: artifact.category,
            prompt: artifact.description,
          })),
          detectedCount: result.detectedCount,
          failedCount: result.failedCount + payloadOmissions,
          model: OPENAI_ASSET_MODEL,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (mode === "asset") {
      const promptValue = form.get("prompt");
      if (
        typeof promptValue !== "string" ||
        promptValue.trim().length < 3 ||
        promptValue.length > 2_000
      ) {
        return errorResponse(
          400,
          "Describe the piece in more detail",
          "Use 3–2,000 characters.",
        );
      }

      const category = inferAssetCategory(promptValue);
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const generateAsset = (conservative = false) =>
        openai.images.generate({
          model: OPENAI_ASSET_MODEL,
          prompt: assetGenerationPrompt(promptValue, category, conservative),
          background: "transparent",
          moderation: "auto",
          quality: "high",
          size: "1024x1024",
          output_format: "png",
          n: 1,
        });
      let result;
      try {
        result = await generateAsset();
      } catch (error) {
        if (!isSafetyRejection(error)) throw error;
        console.warn(
          `[RIYA ${requestId}] asset safety retry after ${Date.now() - startedAt}ms`,
        );
        result = await generateAsset(true);
      }

      const base64 = result.data?.[0]?.b64_json;
      if (!base64) {
        return errorResponse(502, "No image was returned", "Try creating the piece again.");
      }
      console.info(
        `[RIYA ${requestId}] asset completed in ${Date.now() - startedAt}ms · ${OPENAI_ASSET_MODEL}`,
      );
      return Response.json(
        {
          image: imageDataUrl(base64, "image/png"),
          category,
          model: OPENAI_ASSET_MODEL,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (mode !== "edit") {
      return errorResponse(400, "Unknown image operation", "Choose portrait edit or asset creation.");
    }

    const sourceEntry = form.get("source");
    const contextualGuideEntry = form.get("contextualGuide");
    const makeupLayerEntries = form.getAll("makeupLayers");
    const fashionLayerEntries = form.getAll("fashionLayers");
    const intent = safeIntent(form.get("intent"));
    if (!isImageFile(sourceEntry) || !intent) {
      return errorResponse(
        400,
        "The portrait request is incomplete",
        "Use a valid JPG, PNG, or WebP source image and try again.",
      );
    }
    if (contextualGuideEntry !== null && !isImageFile(contextualGuideEntry)) {
      return errorResponse(
        400,
        "The contextual guide is invalid",
        "Reapply the makeup or wardrobe placement and try again.",
      );
    }
    if (
      makeupLayerEntries.length > MAX_MAKEUP_LAYERS ||
      makeupLayerEntries.length !== intent.makeupLayers.length ||
      !makeupLayerEntries.every(isImageFile)
    ) {
      return errorResponse(
        400,
        "A makeup product layer is invalid",
        "Clear the beauty strokes, repaint the requested products, and try again.",
      );
    }
    if (
      fashionLayerEntries.length > MAX_FASHION_LAYERS ||
      fashionLayerEntries.length !== intent.fashionLayers.length ||
      !fashionLayerEntries.every(isImageFile)
    ) {
      return errorResponse(
        400,
        "A fashion sketch layer is invalid",
        "Return to Draw anything, refill the requested shapes, and try again.",
      );
    }
    const referenceEntries = form.getAll("references");
    if (
      referenceEntries.length > MAX_WARDROBE_REFERENCES ||
      !referenceEntries.every(isImageFile)
    ) {
      return errorResponse(
        400,
        "A wardrobe reference is invalid",
        `Use up to ${MAX_WARDROBE_REFERENCES} JPG, PNG, or WebP reference images.`,
      );
    }
    const totalInputCount =
      1 +
      Number(isImageFile(contextualGuideEntry)) +
      makeupLayerEntries.length +
      fashionLayerEntries.length +
      referenceEntries.length;
    if (totalInputCount > MAX_INPUT_IMAGES) {
      return errorResponse(
        400,
        "Too many visual references",
        `Use no more than ${MAX_INPUT_IMAGES} combined source, guide, makeup, fashion, and wardrobe images.`,
      );
    }

    const files: File[] = [sourceEntry];
    const sourceIndex = 1;
    let contextualGuideIndex: number | undefined;
    if (isImageFile(contextualGuideEntry)) {
      files.push(contextualGuideEntry);
      contextualGuideIndex = files.length;
    }
    const makeupLayers: MakeupLayerLayout[] = [];
    for (const [index, entry] of makeupLayerEntries.entries()) {
      const layer = intent.makeupLayers[index];
      files.push(entry as File);
      makeupLayers.push({
        ...layer,
        index: files.length,
      });
    }
    const fashionLayers: FashionLayerLayout[] = [];
    for (const [index, entry] of fashionLayerEntries.entries()) {
      const layer = intent.fashionLayers[index];
      files.push(entry as File);
      fashionLayers.push({
        ...layer,
        index: files.length,
      });
    }
    files.push(...(referenceEntries as File[]));

    const editPromptText = editPrompt(intent, {
      sourceIndex,
      contextualGuideIndex,
      makeupLayers,
      fashionLayers,
    });

    if (process.env.RIYA_DEBUG_MASKS || process.env.NODE_ENV !== "production") {
      await dumpEditDebug(requestId, files, editPromptText, intent);
    }

    const result = await generateGeminiImage({
      mode: renderMode,
      images: files,
      prompt: editPromptText,
      aspectRatio,
      outputMimeType: "image/jpeg",
    });

    console.info(
      `[RIYA ${requestId}] edit completed in ${Date.now() - startedAt}ms · ${result.model} · ${files.length} inputs`,
    );
    return new Response(Buffer.from(result.base64, "base64"), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": result.mimeType,
        "X-Riya-Model": result.model,
        "X-Riya-Interaction": result.interactionId,
      },
    });
  } catch (error) {
    console.error(
      `[RIYA ${requestId}] ${String(mode)} failed after ${Date.now() - startedAt}ms`,
      error instanceof Error ? error.message : error,
    );
    return providerError(error, isOpenAIAssetMode ? "OpenAI" : "Gemini");
  }
}
