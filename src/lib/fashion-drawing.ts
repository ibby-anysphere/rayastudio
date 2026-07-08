import type {
  FashionCategory,
  FashionMaterialId,
  FashionPatternId,
  FashionSettings,
} from "@/lib/studio-types";
import { fashionColorHex } from "@/lib/fashion-catalog";

export interface FashionPoint {
  x: number;
  y: number;
}

export interface FashionStroke {
  id: string;
  mode: "draw" | "erase";
  color: string;
  size: number;
  category: FashionCategory;
  material: FashionMaterialId;
  pattern: FashionPatternId;
  points: FashionPoint[];
}

export interface FashionFill {
  id: string;
  seed: FashionPoint;
  color: string;
  category: FashionCategory;
  material: FashionMaterialId;
  pattern: FashionPatternId;
}

export type FashionOperation =
  | { type: "stroke"; stroke: FashionStroke }
  | { type: "fill"; fill: FashionFill };

export interface FashionRegionMask {
  width: number;
  height: number;
  pixels: Uint8Array;
  canvas: HTMLCanvasElement;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  repaired: boolean;
}

interface Endpoint {
  strokeIndex: number;
  point: FashionPoint;
}

function midpoint(a: FashionPoint, b: FashionPoint) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function drawFashionStroke(
  context: CanvasRenderingContext2D,
  stroke: FashionStroke,
  width: number,
  height: number,
  color = stroke.color,
) {
  if (stroke.points.length === 0) return;
  const lineWidth = Math.max(1.5, stroke.size * width);

  context.save();
  context.globalCompositeOperation =
    stroke.mode === "erase" ? "destination-out" : "source-over";
  context.globalAlpha = stroke.mode === "erase" ? 1 : 0.94;
  context.strokeStyle = fashionColorHex(color);
  context.fillStyle = fashionColorHex(color);
  context.lineWidth = lineWidth;
  context.lineCap = "round";
  context.lineJoin = "round";

  const first = stroke.points[0];
  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(first.x * width, first.y * height, lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  context.beginPath();
  context.moveTo(first.x * width, first.y * height);
  for (let index = 1; index < stroke.points.length - 1; index += 1) {
    const current = stroke.points[index];
    const next = stroke.points[index + 1];
    const middle = midpoint(current, next);
    context.quadraticCurveTo(
      current.x * width,
      current.y * height,
      middle.x * width,
      middle.y * height,
    );
  }
  const last = stroke.points[stroke.points.length - 1];
  context.lineTo(last.x * width, last.y * height);
  context.stroke();
  context.restore();
}

function renderBoundary(
  strokes: FashionStroke[],
  width: number,
  height: number,
  maxGap: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  for (const stroke of strokes) {
    drawFashionStroke(context, stroke, width, height, "#ffffff");
  }

  const endpoints: Endpoint[] = strokes.flatMap((stroke, strokeIndex) => {
    if (stroke.mode !== "draw" || stroke.points.length < 2) return [];
    return [
      { strokeIndex, point: stroke.points[0] },
      { strokeIndex, point: stroke.points[stroke.points.length - 1] },
    ];
  });
  const used = new Set<number>();
  const connectorWidth = Math.max(
    2.5,
    ...strokes
      .filter((stroke) => stroke.mode === "draw")
      .map((stroke) => stroke.size * width * 1.08),
  );
  context.save();
  context.strokeStyle = "#ffffff";
  context.lineWidth = connectorWidth;
  context.lineCap = "round";

  for (let endpointIndex = 0; endpointIndex < endpoints.length; endpointIndex += 1) {
    if (used.has(endpointIndex)) continue;
    const endpoint = endpoints[endpointIndex];
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (
      let candidateIndex = endpointIndex + 1;
      candidateIndex < endpoints.length;
      candidateIndex += 1
    ) {
      if (used.has(candidateIndex)) continue;
      const candidate = endpoints[candidateIndex];
      const distance = Math.hypot(
        (endpoint.point.x - candidate.point.x) * width,
        (endpoint.point.y - candidate.point.y) * height,
      );
      if (
        distance <= maxGap &&
        distance < nearestDistance &&
        (candidate.strokeIndex !== endpoint.strokeIndex || distance > connectorWidth)
      ) {
        nearestDistance = distance;
        nearestIndex = candidateIndex;
      }
    }

    if (nearestIndex >= 0) {
      const candidate = endpoints[nearestIndex];
      context.beginPath();
      context.moveTo(endpoint.point.x * width, endpoint.point.y * height);
      context.lineTo(candidate.point.x * width, candidate.point.y * height);
      context.stroke();
      used.add(endpointIndex);
      used.add(nearestIndex);
    }
  }
  context.restore();

  return { canvas, context };
}

function nearestInteriorSeed(
  exterior: Uint8Array,
  width: number,
  height: number,
  seedX: number,
  seedY: number,
) {
  const index = seedY * width + seedX;
  if (!exterior[index]) return index;

  for (let radius = 2; radius <= 22; radius += 2) {
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 10) {
      const x = Math.min(
        width - 1,
        Math.max(0, Math.round(seedX + Math.cos(angle) * radius)),
      );
      const y = Math.min(
        height - 1,
        Math.max(0, Math.round(seedY + Math.sin(angle) * radius)),
      );
      if (!exterior[y * width + x]) return y * width + x;
    }
  }
  return null;
}

// Fills the whole silhouette the outline encloses, not just the one pocket
// under the tap. We first flood the exterior inward from the image borders
// (stopping at drawn boundary pixels), then take the connected region of
// "not exterior" that contains the seed. Because drawn boundary pixels are
// themselves "not exterior", the flood crosses internal seams like an armhole
// line into the sleeve, capturing every enclosed lobe (both sleeves + torso)
// in one operation. Openings that reach the frame edge — an open front, a
// cropped hem — stay exterior, so the underlying photo shows through there,
// and genuinely separate drawings remain separate regions.
function floodEnclosedRegion(
  boundary: Uint8ClampedArray,
  width: number,
  height: number,
  seed: FashionPoint,
) {
  const total = width * height;
  const isBoundary = (index: number) => boundary[index * 4 + 3] > 24;

  const exterior = new Uint8Array(total);
  const queue = new Int32Array(total);
  let readIndex = 0;
  let writeIndex = 0;

  const enqueueExterior = (index: number) => {
    if (index < 0 || index >= total || exterior[index] || isBoundary(index)) {
      return;
    }
    exterior[index] = 1;
    queue[writeIndex++] = index;
  };

  for (let x = 0; x < width; x += 1) {
    enqueueExterior(x);
    enqueueExterior((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueueExterior(y * width);
    enqueueExterior(y * width + width - 1);
  }
  while (readIndex < writeIndex) {
    const pixelIndex = queue[readIndex++];
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (x > 0) enqueueExterior(pixelIndex - 1);
    if (x < width - 1) enqueueExterior(pixelIndex + 1);
    if (y > 0) enqueueExterior(pixelIndex - width);
    if (y < height - 1) enqueueExterior(pixelIndex + width);
  }

  const seedX = Math.min(width - 1, Math.max(0, Math.round(seed.x * (width - 1))));
  const seedY = Math.min(height - 1, Math.max(0, Math.round(seed.y * (height - 1))));
  const start = nearestInteriorSeed(exterior, width, height, seedX, seedY);
  if (start === null) return null;

  const filled = new Uint8Array(total);
  readIndex = 0;
  writeIndex = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  filled[start] = 1;
  queue[writeIndex++] = start;

  while (readIndex < writeIndex) {
    const pixelIndex = queue[readIndex++];
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);

    const visit = (nextIndex: number) => {
      if (
        nextIndex < 0 ||
        nextIndex >= total ||
        filled[nextIndex] ||
        exterior[nextIndex]
      ) {
        return;
      }
      filled[nextIndex] = 1;
      queue[writeIndex++] = nextIndex;
    };

    if (x > 0) visit(pixelIndex - 1);
    if (x < width - 1) visit(pixelIndex + 1);
    if (y > 0) visit(pixelIndex - width);
    if (y < height - 1) visit(pixelIndex + width);
  }

  if (writeIndex < 16 || writeIndex / total > 0.9) return null;
  return {
    pixels: filled,
    count: writeIndex,
    bounds: { minX, minY, maxX, maxY },
  };
}

function pointsInsidePolygon(point: FashionPoint, polygon: FashionPoint[]) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const a = polygon[index];
    const b = polygon[previous];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || 1e-6) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function convexHull(points: FashionPoint[]) {
  const unique = Array.from(
    new Map(points.map((point) => [`${point.x.toFixed(4)}:${point.y.toFixed(4)}`, point])).values(),
  ).sort((a, b) => a.x - b.x || a.y - b.y);
  if (unique.length < 3) return [];

  const cross = (origin: FashionPoint, a: FashionPoint, b: FashionPoint) =>
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
  const lower: FashionPoint[] = [];
  for (const point of unique) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: FashionPoint[] = [];
  for (let index = unique.length - 1; index >= 0; index -= 1) {
    const point = unique[index];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function fallbackHullMask(
  strokes: FashionStroke[],
  width: number,
  height: number,
  seed: FashionPoint,
) {
  const drawStrokes = strokes.filter(
    (stroke) => stroke.mode === "draw" && stroke.points.length > 1,
  );
  if (drawStrokes.length === 0) return null;

  const candidates = drawStrokes
    .map((stroke) => {
      const hull = convexHull(stroke.points);
      return { hull, area: polygonArea(hull) };
    })
    .filter(({ hull }) => hull.length >= 3 && pointsInsidePolygon(seed, hull));

  const allHull = convexHull(drawStrokes.flatMap((stroke) => stroke.points));
  if (allHull.length >= 3 && pointsInsidePolygon(seed, allHull)) {
    candidates.push({ hull: allHull, area: polygonArea(allHull) });
  }
  const candidate = candidates.sort((a, b) => a.area - b.area)[0];
  if (!candidate) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.moveTo(candidate.hull[0].x * width, candidate.hull[0].y * height);
  for (const point of candidate.hull.slice(1)) {
    context.lineTo(point.x * width, point.y * height);
  }
  context.closePath();
  context.fill();
  const image = context.getImageData(0, 0, width, height);
  const pixels = new Uint8Array(width * height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    if (image.data[index * 4 + 3] <= 24) continue;
    pixels[index] = 1;
    count += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return count > 15
    ? { canvas, pixels, bounds: { minX, minY, maxX, maxY } }
    : null;
}

function polygonArea(points: FashionPoint[]) {
  if (points.length < 3) return 0;
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area) / 2;
}

function maskCanvas(
  pixels: Uint8Array,
  width: number,
  height: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const image = context.createImageData(width, height);
  for (let index = 0; index < pixels.length; index += 1) {
    if (!pixels[index]) continue;
    image.data[index * 4] = 255;
    image.data[index * 4 + 1] = 255;
    image.data[index * 4 + 2] = 255;
    image.data[index * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

export function buildFashionRegionMask(
  strokes: FashionStroke[],
  width: number,
  height: number,
  seed: FashionPoint,
): FashionRegionMask | null {
  if (width < 2 || height < 2) return null;
  const paintStrokes = strokes.filter((stroke) => stroke.points.length > 0);
  if (!paintStrokes.some((stroke) => stroke.mode === "draw")) return null;

  const shortestSide = Math.min(width, height);
  const gapAttempts = [0.022, 0.038, 0.06].map((ratio) =>
    Math.max(9, shortestSide * ratio),
  );

  for (const [attemptIndex, maxGap] of gapAttempts.entries()) {
    const rendered = renderBoundary(paintStrokes, width, height, maxGap);
    if (!rendered) continue;
    const boundary = rendered.context.getImageData(0, 0, width, height).data;
    const region = floodEnclosedRegion(boundary, width, height, seed);
    rendered.canvas.width = 0;
    rendered.canvas.height = 0;
    if (!region) continue;

    const canvas = maskCanvas(region.pixels, width, height);
    const { minX, minY, maxX, maxY } = region.bounds;
    return {
      width,
      height,
      pixels: region.pixels,
      canvas,
      bounds: {
        x: minX / width,
        y: minY / height,
        width: (maxX - minX + 1) / width,
        height: (maxY - minY + 1) / height,
      },
      repaired: attemptIndex > 0,
    };
  }

  const fallback = fallbackHullMask(paintStrokes, width, height, seed);
  if (!fallback) return null;
  const { minX, minY, maxX, maxY } = fallback.bounds;
  return {
    width,
    height,
    pixels: fallback.pixels,
    canvas: fallback.canvas,
    bounds: {
      x: minX / width,
      y: minY / height,
      width: (maxX - minX + 1) / width,
      height: (maxY - minY + 1) / height,
    },
    repaired: true,
  };
}

export function fashionRegionContains(
  mask: FashionRegionMask,
  point: FashionPoint,
) {
  const x = Math.min(mask.width - 1, Math.max(0, Math.round(point.x * (mask.width - 1))));
  const y = Math.min(
    mask.height - 1,
    Math.max(0, Math.round(point.y * (mask.height - 1))),
  );
  return Boolean(mask.pixels[y * mask.width + x]);
}

function shiftColor(hex: string, amount: number) {
  const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : "a94f67";
  const channels = [0, 2, 4].map((offset) =>
    Math.min(
      255,
      Math.max(0, Number.parseInt(clean.slice(offset, offset + 2), 16) + amount),
    ),
  );
  return `rgb(${channels[0]} ${channels[1]} ${channels[2]})`;
}

function drawPattern(
  context: CanvasRenderingContext2D,
  settings: Pick<FashionSettings, "color" | "pattern" | "material">,
  width: number,
  height: number,
) {
  const unit = Math.max(8, Math.min(width, height) * 0.025);
  const baseColor = fashionColorHex(settings.color);
  if (settings.color === "rainbow") {
    const rainbow = context.createLinearGradient(0, 0, width, height);
    rainbow.addColorStop(0, "#ff3d93");
    rainbow.addColorStop(0.2, "#ff7a45");
    rainbow.addColorStop(0.4, "#ffd447");
    rainbow.addColorStop(0.6, "#49c99a");
    rainbow.addColorStop(0.8, "#42c7d9");
    rainbow.addColorStop(1, "#7c5ce7");
    context.fillStyle = rainbow;
  } else {
    context.fillStyle = baseColor;
  }
  context.fillRect(0, 0, width, height);
  context.strokeStyle = shiftColor(baseColor, -44);
  context.fillStyle = shiftColor(baseColor, 62);
  context.globalAlpha = 0.52;
  context.lineWidth = Math.max(1.5, unit * 0.18);

  if (settings.pattern === "stripes") {
    for (let offset = -height; offset < width + height; offset += unit * 1.6) {
      context.beginPath();
      context.moveTo(offset, 0);
      context.lineTo(offset + height, height);
      context.stroke();
    }
  } else if (settings.pattern === "polka-dots") {
    for (let y = unit; y < height; y += unit * 1.8) {
      for (let x = unit; x < width; x += unit * 1.8) {
        context.beginPath();
        context.arc(
          x + (Math.round(y / unit) % 2 ? unit * 0.55 : 0),
          y,
          unit * 0.28,
          0,
          Math.PI * 2,
        );
        context.fill();
      }
    }
  } else if (settings.pattern === "hearts") {
    for (let y = unit; y < height; y += unit * 2.1) {
      for (let x = unit; x < width; x += unit * 2.1) {
        const centerX = x + (Math.round(y / unit) % 2 ? unit : 0);
        const size = unit * 0.55;
        context.beginPath();
        context.moveTo(centerX, y + size * 0.75);
        context.bezierCurveTo(
          centerX - size * 1.25,
          y,
          centerX - size * 0.55,
          y - size,
          centerX,
          y - size * 0.35,
        );
        context.bezierCurveTo(
          centerX + size * 0.55,
          y - size,
          centerX + size * 1.25,
          y,
          centerX,
          y + size * 0.75,
        );
        context.fill();
      }
    }
  } else if (settings.pattern === "stars") {
    for (let y = unit; y < height; y += unit * 2.2) {
      for (let x = unit; x < width; x += unit * 2.2) {
        const centerX = x + (Math.round(y / unit) % 2 ? unit : 0);
        const outer = unit * 0.62;
        const inner = outer * 0.45;
        context.beginPath();
        for (let pointIndex = 0; pointIndex < 10; pointIndex += 1) {
          const radius = pointIndex % 2 === 0 ? outer : inner;
          const angle = -Math.PI / 2 + (pointIndex * Math.PI) / 5;
          const pointX = centerX + Math.cos(angle) * radius;
          const pointY = y + Math.sin(angle) * radius;
          if (pointIndex === 0) context.moveTo(pointX, pointY);
          else context.lineTo(pointX, pointY);
        }
        context.closePath();
        context.fill();
      }
    }
  } else if (settings.pattern === "floral") {
    for (let y = unit; y < height; y += unit * 2.3) {
      for (let x = unit; x < width; x += unit * 2.3) {
        const centerX = x + (Math.round(y / unit) % 2 ? unit : 0);
        for (let petal = 0; petal < 5; petal += 1) {
          const angle = (petal / 5) * Math.PI * 2;
          context.beginPath();
          context.arc(
            centerX + Math.cos(angle) * unit * 0.28,
            y + Math.sin(angle) * unit * 0.28,
            unit * 0.22,
            0,
            Math.PI * 2,
          );
          context.fill();
        }
      }
    }
  }

  context.globalAlpha = 0.18;
  if (settings.material === "denim" || settings.material === "cotton") {
    context.strokeStyle = shiftColor(settings.color, 72);
    context.lineWidth = 1;
    for (let offset = -height; offset < width; offset += 4) {
      context.beginPath();
      context.moveTo(offset, 0);
      context.lineTo(offset + height, height);
      context.stroke();
    }
  } else if (settings.material === "cashmere") {
    context.strokeStyle = shiftColor(baseColor, 58);
    context.lineWidth = Math.max(1, unit * 0.08);
    for (let y = 0; y < height + unit; y += unit * 0.55) {
      for (let x = 0; x < width + unit; x += unit * 0.42) {
        context.beginPath();
        context.arc(x, y, unit * 0.2, 0, Math.PI);
        context.stroke();
      }
    }
  } else if (
    settings.material === "silk"
  ) {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "transparent");
    gradient.addColorStop(0.38, "rgba(255,255,255,.75)");
    gradient.addColorStop(0.52, "transparent");
    gradient.addColorStop(0.78, "rgba(255,255,255,.42)");
    gradient.addColorStop(1, "transparent");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  } else if (settings.material === "leather") {
    const leatherLight = context.createRadialGradient(
      width * 0.28,
      height * 0.16,
      0,
      width * 0.4,
      height * 0.35,
      Math.max(width, height) * 0.75,
    );
    leatherLight.addColorStop(0, "rgba(255,255,255,.68)");
    leatherLight.addColorStop(0.38, "rgba(255,255,255,.12)");
    leatherLight.addColorStop(1, "rgba(0,0,0,.24)");
    context.fillStyle = leatherLight;
    context.fillRect(0, 0, width, height);
  } else if (settings.material === "sequins") {
    context.globalAlpha = 0.42;
    context.fillStyle = "#fff7cf";
    for (let y = unit / 2; y < height; y += unit * 0.72) {
      for (let x = unit / 2; x < width; x += unit * 0.72) {
        context.beginPath();
        context.arc(x, y, Math.max(1, unit * 0.09), 0, Math.PI * 2);
        context.fill();
      }
    }
  }
  context.globalAlpha = 1;
}

export function drawFashionRegion(
  target: CanvasRenderingContext2D,
  mask: FashionRegionMask,
  settings: Pick<FashionSettings, "color" | "pattern" | "material">,
  alpha = 0.58,
  reusableCanvas?: HTMLCanvasElement,
) {
  const scratch = reusableCanvas ?? document.createElement("canvas");
  if (scratch.width !== mask.width) scratch.width = mask.width;
  if (scratch.height !== mask.height) scratch.height = mask.height;
  const context = scratch.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, scratch.width, scratch.height);
  context.globalCompositeOperation = "source-over";
  drawPattern(context, settings, scratch.width, scratch.height);
  context.globalCompositeOperation = "destination-in";
  context.drawImage(mask.canvas, 0, 0);
  context.globalCompositeOperation = "source-over";

  target.save();
  target.globalAlpha = alpha;
  target.drawImage(scratch, 0, 0, target.canvas.width, target.canvas.height);
  target.restore();
}
