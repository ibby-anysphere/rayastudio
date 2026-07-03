import type { ImageAspectRatio } from "@/lib/studio-types";

export interface PreparedImage {
  dataUrl: string;
  width: number;
  height: number;
  name: string;
}

export function loadHtmlImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The image could not be decoded"));
    image.src = source;
  });
}

export async function prepareUpload(file: File): Promise<PreparedImage> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Choose a JPG, PNG, or WebP image");
  }

  if (file.size > 24 * 1024 * 1024) {
    throw new Error("Choose an image smaller than 24 MB");
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await loadHtmlImage(objectUrl);
    const maxDimension = 2048;
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

    return {
      dataUrl: canvas.toDataURL("image/jpeg", 0.93),
      width,
      height,
      name: file.name.replace(/\.[^.]+$/, "") || "Untitled portrait",
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
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

  const blob = await canvasToBlob(canvas, "image/png");
  return new File([blob], filename, { type: "image/png" });
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
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
