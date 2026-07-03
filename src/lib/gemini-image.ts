import "server-only";

import { GoogleGenAI } from "@google/genai";
import type { ImageAspectRatio } from "@/lib/studio-types";

export type GeminiRenderMode = "fast" | "max";
export type GeminiImageSize = "1K" | "2K";
export type GeminiAspectRatio = ImageAspectRatio;

export const GEMINI_FAST_MODEL =
  process.env.GEMINI_FAST_IMAGE_MODEL || "gemini-3.1-flash-lite-image";
export const GEMINI_PRO_MODEL =
  process.env.GEMINI_PRO_IMAGE_MODEL || "gemini-3-pro-image";

const MAX_INLINE_REQUEST_BYTES = 20 * 1024 * 1024;
let client: GoogleGenAI | null = null;

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
  client ??= new GoogleGenAI({ apiKey });
  return client;
}

function inputMimeType(file: File) {
  if (
    file.type === "image/png" ||
    file.type === "image/webp" ||
    file.type === "image/heic" ||
    file.type === "image/heif"
  ) {
    return file.type;
  }
  return "image/jpeg" as const;
}

async function imageContent(file: File) {
  return {
    type: "image" as const,
    data: Buffer.from(await file.arrayBuffer()).toString("base64"),
    mime_type: inputMimeType(file),
  };
}

export function geminiModelForMode(mode: GeminiRenderMode) {
  return mode === "max" ? GEMINI_PRO_MODEL : GEMINI_FAST_MODEL;
}

export function geminiImageSizeForMode(mode: GeminiRenderMode): GeminiImageSize {
  return mode === "max" ? "2K" : "1K";
}

interface GenerateGeminiImageOptions {
  mode: GeminiRenderMode;
  prompt: string;
  images?: File[];
  aspectRatio: GeminiAspectRatio;
  outputMimeType: "image/jpeg" | "image/png";
}

export async function generateGeminiImage({
  mode,
  prompt,
  images = [],
  aspectRatio,
  outputMimeType,
}: GenerateGeminiImageOptions) {
  const model = geminiModelForMode(mode);
  const input = [
    { type: "text" as const, text: prompt },
    ...(await Promise.all(images.map(imageContent))),
  ];
  const request = {
    model,
    input,
    // The Interactions API only emits an image when the image modality is
    // requested explicitly. Without this the model can spend its budget on a
    // text/thinking turn and return status "incomplete" with no output_image
    // (most often on heavier multi-image edits with the flash-lite model).
    response_modalities: ["image"],
    response_format: {
      type: "image" as const,
      mime_type: outputMimeType,
      aspect_ratio: aspectRatio,
      image_size: geminiImageSizeForMode(mode),
    },
    ...(mode === "fast"
      ? {
          generation_config: {
            thinking_level: "low" as const,
          },
        }
      : {}),
    store: false,
  };

  if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_INLINE_REQUEST_BYTES) {
    throw new Error("The combined Gemini image request exceeds the 20 MB inline limit");
  }

  const interaction = await getClient().interactions.create(request);
  const output = interaction.output_image;
  if (!output?.data) {
    throw new Error(
      `Gemini returned no image${interaction.status ? ` (${interaction.status})` : ""}`,
    );
  }

  return {
    base64: output.data,
    mimeType: output.mime_type || outputMimeType,
    model,
    interactionId: interaction.id,
  };
}
