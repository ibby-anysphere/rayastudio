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
    return "Rebuild it as a genuinely three-dimensional crown: curve its band around the skull as an ellipse in perspective, let the far side pass naturally behind the head or hair, give metal and stones real thickness, contact points, cast shadows, reflections, and camera-matched depth of field.";
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
            const shapeInstruction =
              layer.kind === "outline"
                ? "The user supplied an outline rather than a fill. Treat every major branch, lobe, and extension of that contour as mandatory product coverage, bridge only tiny accidental gaps, and close the intended interior without deleting or shortening any substantial section. A contour extending from the torso onto or around an arm defines a sleeve with that mapped length and volume—never trim a sleeved outline back into a vest or sleeveless garment."
                : "The colored region is the intended outer silhouette and coverage.";
            const categoryInstruction =
              layer.category === "auto"
                ? "Use your visual and fashion knowledge to make the best supported guess at the specific intended item and whether this is the complete wearable, part of another mapped product, or an integrated surface detail. Consider its silhouette, topology, material, pattern, scale, image location, anatomical anchor, and relationship to the source and other maps; do not force it into a preset category."
                : `Use the explicit ${category.label.toLowerCase()} label while deciding whether this region defines the whole item, one component, or a surface detail of that item.`;
            return `${index + 1}. Input image ${layer.index}: one hand-drawn fashion design region using ${material.label.toLowerCase()} (${material.prompt}), colored ${layer.color}, with ${pattern.prompt}. ${categoryInstruction} ${shapeInstruction} It occupies the ${describePosition(centerX, centerY)} and roughly ${Math.round(layer.bounds.width * 100)}% × ${Math.round(layer.bounds.height * 100)}% of the photograph.`;
          })
          .join("\n");

  const sourceHierarchy = `- Input image ${layout.sourceIndex} is the clean, current accepted photograph immediately before this edit. It already contains every previously accepted change and is the sole source of truth for identity, face, skin, body, pose, crop, camera, lighting, environment, and existing styling.`;
  const contextualGuideHierarchy = layout.contextualGuideIndex
    ? `- Input image ${layout.contextualGuideIndex} is a contextual after-guide made from the current photograph with translucent makeup, hand-drawn fashion, and artifact proxies. Use it only to understand anatomical context, combined placement, approximate silhouette, scale, rotation, stretched proportions, and front/behind relationships. The separate labeled instruction maps below are authoritative for meaning. Never copy guide strokes, transparency, pasted edges, lighting, or accidental facial overlap.`
    : "- There is no contextual after-guide for this edit.";
  const makeupGuideHierarchy = layout.makeupLayers.length
    ? layout.makeupLayers
        .map(({ product, colors, index }) => {
          const rule = MAKEUP_LAYER_RULES[product];
          return `- Input image ${index} is the isolated ${rule.label} instruction layer, aligned edge-for-edge with input image ${layout.sourceIndex}. White means no ${rule.label.toLowerCase()} edit. Its colored marks use ${colors.join(", ")} and communicate only requested location, shape, hue, and intensity for this named product.`;
        })
        .join("\n")
    : "- There is no makeup instruction map for this edit.";
  const fashionGuideHierarchy = layout.fashionLayers.length
    ? layout.fashionLayers
        .map((layer) => {
          const category = fashionCategory(layer.category);
          const material = fashionMaterial(layer.material);
          const pattern = fashionPattern(layer.pattern);
          return `- Input image ${layer.index} is an isolated FASHION SKETCH map for one ${category.label.toUpperCase()} design region, aligned edge-for-edge with input image ${layout.sourceIndex}. White means no change. The ${layer.color} ${layer.kind === "outline" ? "linework" : "filled/patterned region"} communicates the user's requested shape and coverage. Jointly with the other maps, it may define a complete item, one component, or ornament integrated into a larger mapped item. Rebuild it as real ${material.label.toLowerCase()} with ${pattern.label.toLowerCase()} styling; never paste the map's pixels.`;
        })
        .join("\n")
    : "- There is no hand-drawn fashion instruction map for this edit.";
  const localEdit = Boolean(
    layout.contextualGuideIndex ||
      layout.makeupLayers.length ||
      layout.fashionLayers.length ||
      intent.placedAssets.length,
  );
  const beautyInterpretation = layout.makeupLayers.length
    ? layout.makeupLayers
        .map(({ product, index }) => {
          const rule = MAKEUP_LAYER_RULES[product];
          return `- ${rule.label} — input image ${index}: ${rule.instruction} Transfer the guide's hue, coverage, intensity, and aligned placement onto input image ${layout.sourceIndex}, then remove every trace of the white map and digital brush texture.`;
        })
        .join("\n")
    : "Preserve the source image's existing makeup exactly. Do not invent new makeup or face paint.";
  const fashionInterpretation = layout.fashionLayers.length
    ? `- Read all aligned fashion maps together before rendering. Decide whether each region is an independent product, a component of another mapped product, or a surface treatment contained within it; separate maps do not automatically mean separate objects.
- Perform a contour-accounting pass before rendering: every substantial mapped branch, lobe, extension, and disconnected-but-related segment must become corresponding product geometry. Do not silently omit a section because it is rough, crosses anatomy, or differs from existing clothing.
- Preserve topology, not merely the general garment category. A torso outline with contours extending along or around the arms is a sleeved jacket, coat, shirt, or dress as supported by the label—not a vest. Likewise preserve mapped legs, straps, handles, panels, and other defining extensions. Fast mode does not relax this requirement.
- Use your general visual, fashion, and physical-world knowledge to make the best supported semantic guess at what the user is trying to create. Weigh all evidence together: contour and topology, material and pattern, color, scale, placement in the image, anatomical anchor, pose, interaction with the body or existing clothing, and relationships among maps. A rough, incomplete, unusual, or cropped drawing still requires a specific plausible interpretation; do not default to a generic patch or garment merely because it is ambiguous.
- The following are illustrative cues, not a closed list: a fitted region around a hand, wrist, or distal forearm—especially in leather—suggests a glove rather than a sleeve; a curved narrow design at the neck or clavicle suggests a necklace or choker rather than a collar; a handled or strapped volume beside the torso or hip suggests a purse or bag rather than a clothing patch. Apply the same contextual reasoning to any other item.
- A source-frame crop is not a designed edge. Continue an intended glove, shoe, bag, or other wearable naturally to the frame boundary without zooming, recropping, inventing exposed anatomy, or changing it into a different item.
- Treat the user's rough contour as design intent, not finished artwork. Smooth hand wobble into a deliberate couture cut, bridge tiny accidental gaps, preserve intentional corners and unusual proportions, and remove every trace of digital linework.
- For a product or component, the authored contour defines its silhouette. For a nested surface motif, the contour defines the ornament's boundary. If either overlaps existing clothing, locally replace, recut, or decorate that clothing only where needed; do not simply tint it.
- Treat a smaller shape drawn inside or across a garment as physically integrated embroidery, topstitching, appliqué, inset fabric, trim, or print unless its explicit type and geometry clearly identify a separate object. It must inherit the host cloth's folds, perspective, tension, seams, wear, lighting, and occlusion—never float as a sticker or flat painted blob.
- On denim, render such motifs with native denim construction: visible thread and stitch relief, denim-on-denim appliqué or patch edges, woven/washed texture, and deformation across folds as appropriate to the drawing. Preserve the authored motif and color instead of replacing it with a generic all-over print.
- Reconstruct each named material physically: correct thickness, weave or pile, seams, hems, folds, tension, gravity, highlights, and contact shadows. Make the named print part of the textile so it follows folds, perspective, and occlusion.
- Keep each map's authored color, fabric, pattern, and spatial boundary distinct even when multiple maps combine into one product.
- Fit tops, dresses, skirts, pants, and outerwear around the subject's real anatomy and pose. Build gloves, necklaces, bags, shoes, and other accessories as coherent three-dimensional wearables attached, wrapped, or held at the nearest plausible anatomical anchor.
- A color value is the intended textile color, not a translucent overlay. Match it faithfully while relighting it under the photograph's real illumination.`
    : "Preserve all existing clothing and accessories unless a separate wardrobe piece explicitly changes them.";
  const editScope = localEdit
    ? `SURGICAL EDIT SCOPE
- This is a localized edit, not a request to regenerate or reinterpret the photograph.
- Change only the pixels needed to integrate the requested makeup, hand-drawn fashion, or pieces.
- Everywhere else, reproduce input image ${layout.sourceIndex} exactly: same background detail, face, skin texture, existing hair and clothing, lighting, exposure, color, grain, sharpness, and composition. Do not repaint, relight, smooth, stylize, or replace untouched areas.
- If an addition overlaps the face in the contextual after-guide, recover the unobstructed face from input image ${layout.sourceIndex} and fit the addition naturally around it.`
    : `NO-OP EDIT SCOPE
- No makeup or wardrobe changes were supplied. Reproduce the source photograph exactly.`;

  return `
You are RIYA, a precision photorealistic image editor and physically based 3D compositor. Make the smallest possible edit to the source photograph. Do not beautify, art-direct, color-grade, relight, or reinterpret it. The finished image must look like the same untouched photograph with only the requested real-world additions present.

INPUT HIERARCHY
${sourceHierarchy}
${contextualGuideHierarchy}
${makeupGuideHierarchy}
${fashionGuideHierarchy}
- Every remaining input image is an isolated artifact design reference. It defines what a requested piece should look like, not how its 2D pixels should be pasted.

${editScope}

REQUESTED PIECES
${pieces}

HAND-DRAWN FASHION DESIGNS
${fashionDesigns}

BEAUTY INTERPRETATION
${beautyInterpretation}
- Product labels outrank color assumptions: a plum mark in an EYELINER layer is eyeliner, while the same hue in an EYESHADOW layer is eyeshadow.
- Treat each white map as a semantic mask, not a visual layer to paste. Apply only the named cosmetic, respect anatomical boundaries, preserve real skin and hair detail, and leave no white background, halo, guide edge, or digital stroke texture.

FASHION SKETCH INTERPRETATION
${fashionInterpretation}

MANDATORY 2D-TO-3D RECONSTRUCTION
- Recreate every requested piece from scratch as a physically present three-dimensional object or hairstyle in the scene. Never paste, decal, sticker, or simply blend the reference pixels onto the portrait.
- Placement coordinates and translucent proxies are approximate composition hints. Anatomically correct attachment and keeping the face recognizable always take priority; move a piece to the nearest plausible attachment point if the raw proxy position is physically impossible.
- Infer unseen geometry, thickness, curvature, attachment, gravity, collision, and how the object wraps around the head or body.
- Solve scene depth explicitly: which portions pass behind hair, head, ears, neck, hands, and clothing, and which portions sit in front.
- Re-light every addition from the portrait's actual key light, fill light, color temperature, exposure, and environment. Add physically correct contact shadows, reflections, refraction, translucency, strand/fabric response, lens blur, grain, and edge softness.
- Match the original camera perspective, focal length, sensor character, depth of field, resolution, and photographic noise.
- If a translucent placement proxy overlaps an eye, eyebrow, nose, mouth, or other facial feature, treat that as an accidental 2D overlap. Recover the unobstructed feature from input image ${layout.sourceIndex} and fit the piece naturally around or behind it.

NON-NEGOTIABLE FIDELITY RULES
- Preserve the exact same recognizable person from input image ${layout.sourceIndex}. The current accepted photograph outranks every guide and artifact reference. Do not change facial geometry, ethnicity, age, expression, eye shape/color, brows, nose, lips, jaw, ears, skin tone, body, or pose.
- Before output, compare every hand-drawn fashion map against the result and confirm that each major mapped component is present at its intended coverage. No missing sleeves, shortened extensions, or conversion of mapped garment area into exposed anatomy.
- Keep eyes, eyebrows, nose, and mouth clearly recognizable and unobstructed by newly added hair or accessories.
- Preserve pores, stubble, freckles, fine hair, wrinkles, under-eye detail, and natural skin variation. No waxy skin, plastic texture, beauty-filter smoothing, face replacement, or identity drift.
- Keep the current canvas framing, subject scale, perspective, background, and lighting. Do not zoom in or crop away visible parts of the subject to fit an addition.
- Apply only requested styling. Do not add text, logos, watermarks, extra jewelry, extra limbs, duplicate objects, or unrelated props.
- Final acceptance test: the face must match input image ${layout.sourceIndex}, every addition must pass as a real 3D object photographed in-camera, and no pasted 2D edge or guide artifact may remain.
`.trim();
}

function imageDataUrl(base64: string, mimeType: string) {
  return `data:${mimeType};base64,${base64}`;
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
      /\b(garment|clothing|outfit|dress|gown|skirt|shirts?|blouse|tops?|tee|t-shirt|pants|trousers|jeans|shorts|suit|jacket|coat|blazer|sweater|hoodie|cardigan|corset|bodysuit|jumpsuit|romper|vest|robe|cape|kimono|lingerie|swimsuit|bikini|uniform|sari|saree|lehenga)\b/i,
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

    const result = await generateGeminiImage({
      mode: renderMode,
      images: files,
      prompt: editPrompt(intent, {
        sourceIndex,
        contextualGuideIndex,
        makeupLayers,
        fashionLayers,
      }),
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
