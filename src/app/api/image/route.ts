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
import type {
  AssetCategory,
  GenerationIntent,
  MakeupProductId,
} from "@/lib/studio-types";

export const runtime = "nodejs";
export const maxDuration = 300;

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const OPENAI_ASSET_MODEL =
  process.env.OPENAI_ASSET_MODEL || "gpt-image-1.5";
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
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const MAX_INPUT_IMAGES = 14;
const MAX_FILE_SIZE = 24 * 1024 * 1024;
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

function safeIntent(raw: FormDataEntryValue | null): GenerationIntent | null {
  if (typeof raw !== "string" || raw.length > 20_000) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<GenerationIntent>;
    if (!Array.isArray(parsed.makeupLayers) || !Array.isArray(parsed.placedAssets)) {
      return null;
    }

    const seenProducts = new Set<MakeupProductId>();
    const makeupLayers: GenerationIntent["makeupLayers"] = [];
    for (const layer of parsed.makeupLayers.slice(0, 4)) {
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

    return {
      makeupLayers,
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

interface InputLayout {
  sourceIndex: number;
  contextualGuideIndex?: number;
  makeupLayers: MakeupLayerLayout[];
}

function physicalIntegrationRule(
  asset: GenerationIntent["placedAssets"][number],
) {
  const normalizedName = asset.name.toLowerCase();
  if (normalizedName.includes("tiara") || normalizedName.includes("crown")) {
    return "Rebuild it as a genuinely three-dimensional crown: curve its band around the skull as an ellipse in perspective, let the far side pass naturally behind the head or hair, give metal and stones real thickness, contact points, cast shadows, reflections, and camera-matched depth of field.";
  }
  if (
    normalizedName.includes("necklace") ||
    normalizedName.includes("chain") ||
    normalizedName.includes("choker")
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
  return "Infer complete three-dimensional geometry, thickness, attachment, perspective, contact shadows, material response, and correct front/behind occlusion in the photographed scene.";
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

  const sourceHierarchy = `- Input image ${layout.sourceIndex} is the clean, current accepted photograph immediately before this edit. It already contains every previously accepted change and is the sole source of truth for identity, face, skin, body, pose, crop, camera, lighting, environment, and existing styling.`;
  const contextualGuideHierarchy = layout.contextualGuideIndex
    ? `- Input image ${layout.contextualGuideIndex} is a contextual after-guide made from the current photograph with translucent product-colored strokes and artifact proxies. Use it only to understand anatomical context, the combined placement preview, and each piece's approximate position, scale, rotation, stretched proportions, silhouette, and front/behind relationships. The separate labeled makeup layers below are authoritative for product meaning. Never copy guide strokes, transparency, pasted edges, lighting, or accidental facial overlap.`
    : "- There is no contextual after-guide for this edit.";
  const makeupGuideHierarchy = layout.makeupLayers.length
    ? layout.makeupLayers
        .map(({ product, colors, index }) => {
          const rule = MAKEUP_LAYER_RULES[product];
          return `- Input image ${index} is the isolated ${rule.label} instruction layer, aligned edge-for-edge with input image ${layout.sourceIndex}. White means no ${rule.label.toLowerCase()} edit. Its colored marks use ${colors.join(", ")} and communicate only requested location, shape, hue, and intensity for this named product.`;
        })
        .join("\n")
    : "- There is no makeup instruction map for this edit.";
  const localEdit = Boolean(
    layout.contextualGuideIndex ||
      layout.makeupLayers.length ||
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
  const editScope = localEdit
    ? `SURGICAL EDIT SCOPE
- This is a localized edit, not a request to regenerate or reinterpret the photograph.
- Change only the pixels needed to integrate the requested makeup or pieces.
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
- Every remaining input image is an isolated artifact design reference. It defines what a requested piece should look like, not how its 2D pixels should be pasted.

${editScope}

REQUESTED PIECES
${pieces}

BEAUTY INTERPRETATION
${beautyInterpretation}
- Product labels outrank color assumptions: a plum mark in an EYELINER layer is eyeliner, while the same hue in an EYESHADOW layer is eyeshadow.
- Treat each white map as a semantic mask, not a visual layer to paste. Apply only the named cosmetic, respect anatomical boundaries, preserve real skin and hair detail, and leave no white background, halo, guide edge, or digital stroke texture.

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
            : "fashion accessory";

  return `
Create exactly one standalone ${subject} as a premium retail product cutout.

DESIGN BRIEF
${description.trim()}

OUTPUT RULES
- Show one complete product, centered and fully visible, in a useful front or three-quarter product view.
- Transparent background with clean, precise alpha edges.
- No wearer, model, mannequin, display stand, text, label, logo, border, scenery, or duplicate item.
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
          "Describe only the garment's material, color, cut, construction, and embellishments.",
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
  if (mode === "asset" && !process.env.OPENAI_API_KEY) {
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
    mode === "asset" ? OPENAI_ASSET_MODEL : geminiModelForMode(renderMode);
  const imageSize = geminiImageSizeForMode(renderMode);
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  console.info(
    `[RIYA ${requestId}] ${String(mode)} request started · ${renderMode} · ${selectedModel} · ${mode === "edit" ? `${aspectRatio} ${imageSize}` : "1024x1024"} · ${contentLength || "unknown"} bytes`,
  );

  try {
    if (mode === "asset") {
      const promptValue = form.get("prompt");
      const categoryValue = form.get("category");
      if (
        typeof promptValue !== "string" ||
        promptValue.trim().length < 8 ||
        promptValue.length > 800 ||
        typeof categoryValue !== "string" ||
        !ALLOWED_CATEGORIES.has(categoryValue as AssetCategory)
      ) {
        return errorResponse(
          400,
          "Describe the piece in more detail",
          "Use 8–800 characters and choose a supported piece type.",
        );
      }

      const category = categoryValue as AssetCategory;
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
      makeupLayerEntries.length > 4 ||
      makeupLayerEntries.length !== intent.makeupLayers.length ||
      !makeupLayerEntries.every(isImageFile)
    ) {
      return errorResponse(
        400,
        "A makeup product layer is invalid",
        "Clear the beauty strokes, repaint the requested products, and try again.",
      );
    }
    const referenceEntries = form.getAll("references");
    if (referenceEntries.length > 8 || !referenceEntries.every(isImageFile)) {
      return errorResponse(
        400,
        "A wardrobe reference is invalid",
        "Use up to 8 JPG, PNG, or WebP reference images.",
      );
    }
    const totalInputCount =
      1 +
      Number(isImageFile(contextualGuideEntry)) +
      makeupLayerEntries.length +
      referenceEntries.length;
    if (totalInputCount > MAX_INPUT_IMAGES) {
      return errorResponse(
        400,
        "Too many visual references",
        `Use no more than ${MAX_INPUT_IMAGES} combined source, guide, makeup, and wardrobe images.`,
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
    files.push(...(referenceEntries as File[]));

    const result = await generateGeminiImage({
      mode: renderMode,
      images: files,
      prompt: editPrompt(intent, {
        sourceIndex,
        contextualGuideIndex,
        makeupLayers,
      }),
      aspectRatio,
      outputMimeType: "image/jpeg",
    });

    console.info(
      `[RIYA ${requestId}] edit completed in ${Date.now() - startedAt}ms · ${result.model} · ${files.length} inputs`,
    );
    return Response.json(
      {
        image: imageDataUrl(result.base64, result.mimeType),
        model: result.model,
        interactionId: result.interactionId,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error(
      `[RIYA ${requestId}] ${String(mode)} failed after ${Date.now() - startedAt}ms`,
      error instanceof Error ? error.message : error,
    );
    return providerError(error, mode === "asset" ? "OpenAI" : "Gemini");
  }
}
