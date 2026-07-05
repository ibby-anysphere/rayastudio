import type { ImageAspectRatio } from "@/lib/studio-types";

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
  name: string;
}

const SUPPORTED_UPLOAD_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_UPLOAD_SIZE = 24 * 1024 * 1024;
const MAX_ARTIFACT_UPLOAD_SIZE = 3.8 * 1024 * 1024;

export function loadHtmlImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The image could not be decoded"));
    image.src = source;
  });
}

function validateImageUpload(file: File) {
  if (!SUPPORTED_UPLOAD_TYPES.has(file.type)) {
    throw new Error("Choose a JPG, PNG, or WebP image");
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new Error("Choose an image smaller than 24 MB");
  }
}

async function rasterizeUpload(
  file: File,
  {
    maxDimension,
    quality,
    fallbackName,
  }: {
    maxDimension: number;
    quality: number;
    fallbackName: string;
  },
): Promise<PreparedImage> {
  validateImageUpload(file);

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await loadHtmlImage(objectUrl);
    const ratio = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * ratio));
    const height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Image processing is unavailable in this browser");
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);

    try {
      return {
        blob: await canvasToBlob(canvas, "image/jpeg", quality),
        width,
        height,
        name: file.name.replace(/\.[^.]+$/, "") || fallbackName,
      };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function prepareUpload(file: File): Promise<PreparedImage> {
  return rasterizeUpload(file, {
    maxDimension: 2048,
    quality: 0.93,
    fallbackName: "Untitled portrait",
  });
}

export async function prepareArtifactUpload(file: File): Promise<PreparedImage> {
  const prepared = await rasterizeUpload(file, {
    maxDimension: 1800,
    quality: 0.86,
    fallbackName: "Artifact reference",
  });
  if (prepared.blob.size > MAX_ARTIFACT_UPLOAD_SIZE) {
    throw new Error("Choose a less detailed image or crop it closer to the products");
  }
  return prepared;
}

export async function dataUrlToFile(dataUrl: string, filename: string): Promise<File> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], filename, { type: blob.type || "image/png" });
}

const GEMINI_ASPECT_RATIOS: Array<{
  label: ImageAspectRatio;
  value: number;
}> = [
  { label: "1:1", value: 1 },
  { label: "2:3", value: 2 / 3 },
  { label: "3:2", value: 3 / 2 },
  { label: "3:4", value: 3 / 4 },
  { label: "4:3", value: 4 / 3 },
  { label: "4:5", value: 4 / 5 },
  { label: "5:4", value: 5 / 4 },
  { label: "9:16", value: 9 / 16 },
  { label: "16:9", value: 16 / 9 },
  { label: "21:9", value: 21 / 9 },
];

export function aspectRatioForDimensions(
  width: number,
  height: number,
): ImageAspectRatio {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "1:1";
  }

  const ratio = width / height;
  return GEMINI_ASPECT_RATIOS.reduce(
    (closest, candidate) =>
      Math.abs(Math.log(ratio / candidate.value)) <
      Math.abs(Math.log(ratio / closest.value))
        ? candidate
        : closest,
    GEMINI_ASPECT_RATIOS[0],
  ).label;
}

export async function recommendedAspectRatio(
  source: string,
): Promise<ImageAspectRatio> {
  const image = await loadHtmlImage(source);
  return aspectRatioForDimensions(
    image.naturalWidth,
    image.naturalHeight,
  );
}

export async function createImageThumbnail(
  source: Blob,
  maxDimension = 360,
): Promise<string> {
  const objectUrl = URL.createObjectURL(source);

  try {
    const image = await loadHtmlImage(objectUrl);
    const scale = Math.min(
      1,
      maxDimension / Math.max(1, image.naturalWidth, image.naturalHeight),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not prepare the history preview");

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    try {
      return canvas.toDataURL("image/webp", 0.72);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function assetSourceToPngFile(
  source: string,
  filename: string,
): Promise<File> {
  const image = await loadHtmlImage(source);
  const maxDimension = 1024;
  const scale = Math.min(
    maxDimension / Math.max(1, image.naturalWidth),
    maxDimension / Math.max(1, image.naturalHeight),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Could not prepare the wardrobe reference");
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  try {
    const blob = await canvasToBlob(canvas, "image/png");
    return new File([blob], filename, { type: "image/png" });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export type ImageSaveResult = "shared" | "downloaded" | "cancelled";

export async function saveImageToDevice(
  source: string,
  filenameBase: string,
): Promise<ImageSaveResult> {
  const response = await fetch(source);
  if (!response.ok) throw new Error("The photo could not be prepared for download");

  const blob = await response.blob();
  if (!blob.size || !blob.type.startsWith("image/")) {
    throw new Error("The photo is not in a downloadable image format");
  }

  const extension =
    blob.type === "image/jpeg"
      ? "jpg"
      : blob.type === "image/png"
        ? "png"
        : blob.type === "image/webp"
          ? "webp"
          : "jpg";
  const filename = `${filenameBase.replace(/\.[a-z0-9]+$/i, "")}.${extension}`;
  const file = new File([blob], filename, {
    type: blob.type,
    lastModified: Date.now(),
  });
  const mobileDevice =
    navigator.maxTouchPoints > 0 &&
    /Android|iPad|iPhone|iPod|Mobile/i.test(navigator.userAgent);
  const canShareFile =
    mobileDevice &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });

  if (canShareFile) {
    try {
      await navigator.share({
        files: [file],
        title: "RIYA photo",
      });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return "cancelled";
      }
      // Fall back to a normal download if the device share sheet fails.
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  return "downloaded";
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/png",
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Could not prepare the visual guide"));
      }
    }, type, quality);
  });
}
