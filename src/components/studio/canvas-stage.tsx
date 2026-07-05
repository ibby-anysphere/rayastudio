"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ImagePlus,
  Minus,
  Plus,
  RotateCw,
  Scaling,
  Sparkles,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import type { EstimatedProgress } from "@/components/studio/use-estimated-progress";
import {
  buildFashionRegionMask,
  drawFashionRegion,
  drawFashionStroke,
  fashionRegionContains,
  type FashionFill,
  type FashionOperation,
  type FashionPoint,
  type FashionRegionMask,
  type FashionStroke,
} from "@/lib/fashion-drawing";
import { fashionColorHex } from "@/lib/fashion-catalog";
import { canvasToBlob, loadHtmlImage } from "@/lib/image-utils";
import type {
  BrushSettings,
  CanvasTool,
  FashionGuideState,
  FashionRegionSummary,
  FashionSettings,
  MakeupProductId,
  PlacedAsset,
} from "@/lib/studio-types";
import styles from "./studio.module.css";

export interface MakeupGuideLayer {
  product: MakeupProductId;
  colors: string[];
  blob: Blob;
}

export interface MakeupGuideState {
  hasMarks: boolean;
  canUndo: boolean;
  products: MakeupProductId[];
}

export interface FashionGuideLayer {
  id: string;
  kind: "filled-region" | "outline";
  category: FashionSettings["category"];
  material: FashionSettings["material"];
  pattern: FashionSettings["pattern"];
  color: string;
  bounds: FashionRegionSummary["bounds"];
  blob: Blob;
}

export type CanvasInteractionMode = "makeup" | "fashion" | "idle";

export interface CanvasStageHandle {
  createContextualGuideBlob: (maxDimension?: number) => Promise<Blob | null>;
  createMakeupGuideLayers: (maxDimension?: number) => Promise<MakeupGuideLayer[]>;
  createFashionGuideLayers: (maxDimension?: number) => Promise<FashionGuideLayer[]>;
  clearGuide: () => void;
  clearFashionGuide: () => void;
  undoGuide: () => void;
  selectFashionRegion: (regionId: string | null) => void;
  updateFashionRegionStyle: (
    regionId: string,
    patch: Partial<Omit<FashionSettings, "size">>,
  ) => void;
  hasGuide: () => boolean;
}

interface CanvasStageProps {
  image: string | null;
  originalImage: string | null;
  imageName: string;
  interactionMode: CanvasInteractionMode;
  tool: CanvasTool;
  brush: BrushSettings;
  fashion: FashionSettings;
  layers: PlacedAsset[];
  selectedLayerId: string | null;
  showOriginal: boolean;
  generating: boolean;
  generationProgress: EstimatedProgress;
  onUpload: (file: File) => void;
  onDropAsset: (assetId: string, x: number, y: number) => void;
  onSelectLayer: (instanceId: string | null) => void;
  onUpdateLayer: (instanceId: string, patch: Partial<PlacedAsset>) => void;
  onRemoveLayer: (instanceId: string) => void;
  onGuideChange: (state: MakeupGuideState) => void;
  onFashionGuideChange: (state: FashionGuideState) => void;
  onBeforePaint?: (product: MakeupProductId) => boolean;
  onBeforeFashionFill?: () => boolean;
  onFashionFillResult?: (result: "filled" | "repaired" | "selected" | "miss") => void;
}

interface LayerDrag {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

interface LayerTransformDrag {
  mode: "resize" | "rotate" | "stretch-x" | "stretch-y";
  id: string;
  pointerId: number;
  centerX: number;
  centerY: number;
  startDistance: number;
  startAngle: number;
  startScale: number;
  startStretchX: number;
  startStretchY: number;
  startRotation: number;
  minScale: number;
  maxScale: number;
}

interface GuidePoint {
  x: number;
  y: number;
}

interface GuideStroke {
  mode: "paint" | "erase";
  product: MakeupProductId;
  color: string;
  size: number;
  opacity: number;
  points: GuidePoint[];
}

interface FashionPulse {
  id: number;
  x: number;
  y: number;
  tone: "magic" | "miss";
}

interface ViewportCamera {
  zoom: number;
  x: number;
  y: number;
}

interface ViewportPanGesture {
  pointerId: number;
  lastX: number;
  lastY: number;
}

interface ViewportPinchGesture {
  startDistance: number;
  startZoom: number;
  contentX: number;
  contentY: number;
  viewportCenterX: number;
  viewportCenterY: number;
}

const MIN_VIEWPORT_ZOOM = 1;
const MAX_VIEWPORT_ZOOM = 4;
const VIEWPORT_ZOOM_STEP = 0.25;
const INITIAL_VIEWPORT_CAMERA: ViewportCamera = { zoom: 1, x: 0, y: 0 };

function drawGuideStroke(
  context: CanvasRenderingContext2D,
  stroke: GuideStroke,
  width: number,
  height: number,
) {
  if (stroke.points.length === 0) return;

  const lineWidth = Math.max(1, stroke.size * width);
  context.save();
  context.globalCompositeOperation =
    stroke.mode === "erase" ? "destination-out" : "source-over";
  context.globalAlpha = stroke.mode === "erase" ? 1 : stroke.opacity;
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineWidth = lineWidth;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (stroke.mode === "paint" && stroke.product !== "eyeliner") {
    const softness =
      stroke.product === "blush"
        ? 0.28
        : stroke.product === "eyeshadow"
          ? 0.2
          : 0.1;
    context.shadowColor = stroke.color;
    context.shadowBlur = Math.max(1, lineWidth * softness);
  }

  const [first, ...remaining] = stroke.points;
  const firstX = first.x * width;
  const firstY = first.y * height;
  if (remaining.length === 0) {
    context.beginPath();
    context.arc(firstX, firstY, lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
    return;
  }

  context.beginPath();
  context.moveTo(firstX, firstY);
  for (const point of remaining) {
    context.lineTo(point.x * width, point.y * height);
  }
  context.stroke();
  context.restore();
}

function canvasHasVisibleMarks(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) return false;
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index] > 3) return true;
  }
  return false;
}

function displayedBrushSize(tool: CanvasTool, brush: BrushSettings) {
  return tool === "eraser" ? Math.max(18, brush.size * 1.45) : brush.size;
}

function fashionMaskDimensions(width: number, height: number, maxDimension = 768) {
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(2, Math.round(width * scale)),
    height: Math.max(2, Math.round(height * scale)),
  };
}

function PortraitPlaceholder() {
  return (
    <svg
      className={styles.placeholderPortrait}
      viewBox="0 0 360 460"
      role="img"
      aria-label="Abstract portrait placeholder"
    >
      <defs>
        <radialGradient id="portraitGlow" cx="50%" cy="26%" r="70%">
          <stop offset="0" stopColor="#f9d9d1" />
          <stop offset=".48" stopColor="#be8692" />
          <stop offset="1" stopColor="#34263b" />
        </radialGradient>
        <linearGradient id="portraitDress" x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#a6536c" />
          <stop offset=".55" stopColor="#4a294c" />
          <stop offset="1" stopColor="#1e1831" />
        </linearGradient>
        <linearGradient id="idleRevealShimmer" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#fffaf2" stopOpacity="0" />
          <stop offset=".45" stopColor="#fffaf2" stopOpacity=".22" />
          <stop offset=".58" stopColor="#ffd7e9" stopOpacity=".82" />
          <stop offset=".7" stopColor="#ff7a5c" stopOpacity=".24" />
          <stop offset="1" stopColor="#ff7a5c" stopOpacity="0" />
        </linearGradient>
        <pattern
          id="idleHeartsPattern"
          width="30"
          height="27"
          patternUnits="userSpaceOnUse"
        >
          <rect width="30" height="27" fill="#ef86aa" />
          <path
            d="M15 20C7 15 7 8 11 7c3-1 4 2 4 3 1-2 3-4 6-3 5 2 4 8-6 13Z"
            fill="#ffc5d9"
            opacity=".58"
          />
        </pattern>
        <filter id="portraitBlur">
          <feGaussianBlur stdDeviation="18" />
        </filter>
        <clipPath id="idleDressClip">
          <path d="M77 455c8-127 49-188 111-188 67 0 106 61 116 188Z" />
        </clipPath>
      </defs>
      <rect width="360" height="460" rx="32" fill="#e9ded8" />
      <circle cx="185" cy="145" r="126" fill="url(#portraitGlow)" opacity=".32" filter="url(#portraitBlur)" />
      <path
        d="M116 170c3-79 35-124 74-124 50 0 82 50 74 134-7-29-20-53-36-72-21 42-57 63-112 62Z"
        fill="#2a2030"
      />
      <ellipse cx="188" cy="168" rx="65" ry="82" fill="#d6a18f" />
      <path
        d="M129 151c13-71 44-94 77-91 37 4 59 39 58 89-22-16-36-40-42-68-15 37-49 61-93 70Z"
        fill="#302332"
      />
      <path d="M164 188c15 7 31 7 46 0" fill="none" stroke="#754752" strokeWidth="3" strokeLinecap="round" />
      <path d="M173 216c10 6 23 6 33-1" fill="none" stroke="#9a4b60" strokeWidth="5" strokeLinecap="round" />
      <path d="M77 455c8-127 49-188 111-188 67 0 106 61 116 188Z" fill="url(#portraitDress)" />
      <path d="M142 272c6 42 86 42 93-1" fill="none" stroke="#f1c8bb" strokeWidth="8" opacity=".68" />
      <circle cx="163" cy="174" r="4" fill="#382b34" />
      <circle cx="213" cy="174" r="4" fill="#382b34" />
      <path d="M151 162c9-6 18-6 26-1M201 161c9-5 18-4 25 2" fill="none" stroke="#4c3138" strokeWidth="4" strokeLinecap="round" />
      <path d="M92 390c32-24 61-21 86 8 30-37 62-39 98-9" fill="none" stroke="#f2b7c5" strokeOpacity=".34" strokeWidth="18" />
      <path
        className={styles.idleLipFill}
        d="M161 191c8-10 18-12 27-6 9-6 20-4 28 6-8 11-18 15-28 15-10 0-20-4-27-15Z"
        fill="#c64f6a"
      />
      <path
        className={styles.idleLipPaint}
        d="M161 191c8-10 18-12 27-6 9-6 20-4 28 6-8 11-18 15-28 15-10 0-20-4-27-15Z"
        fill="none"
        stroke="#c64f6a"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <image
        className={styles.idleCrown}
        href="/brand/raya-idle-crown.svg"
        x="116"
        y="12"
        width="144"
        height="81"
        preserveAspectRatio="xMidYMid meet"
      />
      <g className={styles.idleDressMagicFill} clipPath="url(#idleDressClip)">
        <rect x="70" y="258" width="245" height="205" fill="url(#idleHeartsPattern)" />
      </g>
      <path
        className={styles.idleDressOutline}
        d="M77 455c8-127 49-188 111-188 67 0 106 61 116 188"
        fill="none"
        stroke="#ff3d93"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <image
        className={styles.idleAfterImage}
        href="/brand/raya-idle-after.jpg"
        x="0"
        y="0"
        width="360"
        height="460"
        preserveAspectRatio="xMidYMid slice"
      />
      <rect
        className={styles.idleAfterSweep}
        x="-20"
        y="-92"
        width="400"
        height="92"
        fill="url(#idleRevealShimmer)"
      />
    </svg>
  );
}

export const CanvasStage = forwardRef<CanvasStageHandle, CanvasStageProps>(
  function CanvasStage(
    {
      image,
      originalImage,
      imageName,
      interactionMode,
      tool,
      brush,
      fashion,
      layers,
      selectedLayerId,
      showOriginal,
      generating,
      generationProgress,
      onUpload,
      onDropAsset,
      onSelectLayer,
      onUpdateLayer,
      onRemoveLayer,
      onGuideChange,
      onFashionGuideChange,
      onBeforePaint,
      onBeforeFashionFill,
      onFashionFillResult,
    },
    forwardedRef,
  ) {
    const stageViewportRef = useRef<HTMLDivElement>(null);
    const stageCameraRef = useRef<HTMLDivElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const fashionBufferRef = useRef<HTMLCanvasElement | null>(null);
    const fashionScratchRef = useRef<HTMLCanvasElement | null>(null);
    const brushCursorRef = useRef<HTMLSpanElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const drawingRef = useRef(false);
    const activeStrokeRef = useRef<GuideStroke | null>(null);
    const makeupStrokesRef = useRef<GuideStroke[]>([]);
    const activeFashionStrokeRef = useRef<FashionStroke | null>(null);
    const fashionOperationsRef = useRef<FashionOperation[]>([]);
    const fashionMasksRef = useRef(new Map<string, FashionRegionMask>());
    const selectedFashionRegionRef = useRef<string | null>(null);
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressStartRef = useRef<{
      point: FashionPoint;
      clientX: number;
      clientY: number;
      strokeId: string;
    } | null>(null);
    const longPressTriggeredRef = useRef(false);
    const hasMarksRef = useRef(false);
    const hasFashionMarksRef = useRef(false);
    const layerDragRef = useRef<LayerDrag | null>(null);
    const layerTransformRef = useRef<LayerTransformDrag | null>(null);
    const viewportCameraRef = useRef<ViewportCamera>(INITIAL_VIEWPORT_CAMERA);
    const viewportPointersRef = useRef(
      new Map<number, { x: number; y: number }>(),
    );
    const viewportPanRef = useRef<ViewportPanGesture | null>(null);
    const viewportPinchRef = useRef<ViewportPinchGesture | null>(null);
    const cameraImageRef = useRef<string | null>(image);
    const [aspectRatio, setAspectRatio] = useState(4 / 5);
    const [layerRatios, setLayerRatios] = useState<Record<string, number>>({});
    const [assetDragActive, setAssetDragActive] = useState(false);
    const [uploadDragActive, setUploadDragActive] = useState(false);
    const [fashionPulse, setFashionPulse] = useState<FashionPulse | null>(null);
    const [viewportCamera, setViewportCamera] = useState<ViewportCamera>(
      INITIAL_VIEWPORT_CAMERA,
    );
    const [viewportPanning, setViewportPanning] = useState(false);

    const renderMakeupStrokes = useCallback(
      (
        context: CanvasRenderingContext2D,
        width: number,
        height: number,
        product?: MakeupProductId,
      ) => {
        for (const stroke of makeupStrokesRef.current) {
          if (stroke.mode === "paint" && product && stroke.product !== product) {
            continue;
          }
          drawGuideStroke(context, stroke, width, height);
        }
      },
      [],
    );

    const fashionStrokes = useCallback(
      () =>
        fashionOperationsRef.current.flatMap((operation) =>
          operation.type === "stroke" ? [operation.stroke] : [],
        ),
      [],
    );

    const fashionFills = useCallback(
      () =>
        fashionOperationsRef.current.flatMap((operation) =>
          operation.type === "fill" ? [operation.fill] : [],
        ),
      [],
    );

    const releaseFashionMasks = useCallback(() => {
      for (const mask of fashionMasksRef.current.values()) {
        mask.canvas.width = 0;
        mask.canvas.height = 0;
      }
      fashionMasksRef.current.clear();
    }, []);

    const rebuildFashionMasks = useCallback(
      (width: number, height: number) => {
        releaseFashionMasks();
        const dimensions = fashionMaskDimensions(width, height);
        const strokes = fashionStrokes();
        for (const fill of fashionFills()) {
          const mask = buildFashionRegionMask(
            strokes,
            dimensions.width,
            dimensions.height,
            fill.seed,
          );
          if (mask) fashionMasksRef.current.set(fill.id, mask);
        }
      },
      [fashionFills, fashionStrokes, releaseFashionMasks],
    );

    const renderFashionLayer = useCallback(
      (
        target: CanvasRenderingContext2D,
        width: number,
        height: number,
        masks = fashionMasksRef.current,
        fills = fashionFills(),
        strokes = fashionStrokes(),
        fillAlpha = 0.58,
      ) => {
        const buffer = fashionBufferRef.current ?? document.createElement("canvas");
        fashionBufferRef.current = buffer;
        if (buffer.width !== width) buffer.width = width;
        if (buffer.height !== height) buffer.height = height;
        const context = buffer.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, width, height);

        const scratch = fashionScratchRef.current ?? document.createElement("canvas");
        fashionScratchRef.current = scratch;
        for (const fill of fills) {
          const mask = masks.get(fill.id);
          if (!mask) continue;
          drawFashionRegion(context, mask, fill, fillAlpha, scratch);
        }
        for (const stroke of strokes) {
          drawFashionStroke(context, stroke, width, height);
        }
        target.drawImage(buffer, 0, 0, width, height);
      },
      [fashionFills, fashionStrokes],
    );

    const renderVisibleGuide = useCallback(() => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      renderMakeupStrokes(context, canvas.width, canvas.height);
      renderFashionLayer(context, canvas.width, canvas.height);
    }, [renderFashionLayer, renderMakeupStrokes]);

    const visibleGuideProducts = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return [];
      const products = Array.from(
        new Set(
          makeupStrokesRef.current
            .filter((stroke) => stroke.mode === "paint")
            .map((stroke) => stroke.product),
        ),
      );
      const layer = document.createElement("canvas");
      layer.width = canvas.width;
      layer.height = canvas.height;
      const context = layer.getContext("2d");
      if (!context) return [];

      return products.filter((product) => {
        context.clearRect(0, 0, layer.width, layer.height);
        renderMakeupStrokes(context, layer.width, layer.height, product);
        return canvasHasVisibleMarks(layer);
      });
    }, [renderMakeupStrokes]);

    const refreshGuideState = useCallback(() => {
      const products = visibleGuideProducts();
      const hasMarks = products.length > 0;
      hasMarksRef.current = hasMarks;
      onGuideChange({
        hasMarks,
        canUndo: makeupStrokesRef.current.length > 0,
        products,
      });
    }, [onGuideChange, visibleGuideProducts]);

    const refreshFashionState = useCallback(() => {
      const fills = fashionFills();
      const regions = fills.flatMap((fill): FashionRegionSummary[] => {
        const mask = fashionMasksRef.current.get(fill.id);
        if (!mask) return [];
        return [
          {
            id: fill.id,
            category: fill.category,
            material: fill.material,
            pattern: fill.pattern,
            color: fill.color,
            bounds: mask.bounds,
          },
        ];
      });
      const hasOutline = fashionStrokes().some((stroke) => stroke.mode === "draw");
      const selectedRegionId = regions.some(
        (region) => region.id === selectedFashionRegionRef.current,
      )
        ? selectedFashionRegionRef.current
        : null;
      selectedFashionRegionRef.current = selectedRegionId;
      hasFashionMarksRef.current = hasOutline || regions.length > 0;
      onFashionGuideChange({
        hasMarks: hasFashionMarksRef.current,
        hasOutline,
        canUndo: fashionOperationsRef.current.length > 0,
        selectedRegionId,
        regions,
      });
    }, [fashionFills, fashionStrokes, onFashionGuideChange]);

    const clampViewportCamera = useCallback(
      (camera: ViewportCamera): ViewportCamera => {
        const viewport = stageViewportRef.current;
        const surface = surfaceRef.current;
        const zoom = Math.min(
          MAX_VIEWPORT_ZOOM,
          Math.max(MIN_VIEWPORT_ZOOM, camera.zoom),
        );
        if (!viewport || !surface || zoom <= MIN_VIEWPORT_ZOOM) {
          return { zoom, x: 0, y: 0 };
        }

        const usableWidth = Math.max(1, viewport.clientWidth - 36);
        const usableHeight = Math.max(1, viewport.clientHeight - 116);
        const maxX = Math.max(
          0,
          (surface.offsetWidth * zoom - usableWidth) / 2 + 12,
        );
        const maxY = Math.max(
          0,
          (surface.offsetHeight * zoom - usableHeight) / 2 + 12,
        );
        return {
          zoom,
          x: Math.min(maxX, Math.max(-maxX, camera.x)),
          y: Math.min(maxY, Math.max(-maxY, camera.y)),
        };
      },
      [],
    );

    const commitViewportCamera = useCallback(
      (next: ViewportCamera) => {
        const clamped = clampViewportCamera(next);
        viewportCameraRef.current = clamped;
        setViewportCamera(clamped);
      },
      [clampViewportCamera],
    );

    const resetViewportCamera = useCallback(() => {
      viewportPointersRef.current.clear();
      viewportPanRef.current = null;
      viewportPinchRef.current = null;
      setViewportPanning(false);
      commitViewportCamera(INITIAL_VIEWPORT_CAMERA);
    }, [commitViewportCamera]);

    const zoomViewportAt = useCallback(
      (requestedZoom: number, clientX?: number, clientY?: number) => {
        const viewport = stageViewportRef.current;
        if (!viewport) return;
        const current = viewportCameraRef.current;
        const nextZoom = Math.min(
          MAX_VIEWPORT_ZOOM,
          Math.max(MIN_VIEWPORT_ZOOM, requestedZoom),
        );
        if (Math.abs(nextZoom - current.zoom) < 0.001) return;
        if (nextZoom <= MIN_VIEWPORT_ZOOM) {
          commitViewportCamera(INITIAL_VIEWPORT_CAMERA);
          return;
        }

        const bounds = viewport.getBoundingClientRect();
        const viewportCenterX = bounds.left + bounds.width / 2;
        const viewportCenterY = bounds.top + bounds.height / 2;
        const focalX = clientX ?? viewportCenterX;
        const focalY = clientY ?? viewportCenterY;
        const contentX =
          (focalX - viewportCenterX - current.x) / current.zoom;
        const contentY =
          (focalY - viewportCenterY - current.y) / current.zoom;
        commitViewportCamera({
          zoom: nextZoom,
          x: focalX - viewportCenterX - contentX * nextZoom,
          y: focalY - viewportCenterY - contentY * nextZoom,
        });
      },
      [commitViewportCamera],
    );

    const panViewportBy = useCallback(
      (deltaX: number, deltaY: number) => {
        const current = viewportCameraRef.current;
        if (current.zoom <= MIN_VIEWPORT_ZOOM) return;
        commitViewportCamera({
          ...current,
          x: current.x + deltaX,
          y: current.y + deltaY,
        });
      },
      [commitViewportCamera],
    );

    const cancelActiveDrawingForViewportGesture = useCallback(() => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
      longPressStartRef.current = null;
      longPressTriggeredRef.current = false;
      if (activeStrokeRef.current) {
        const active = activeStrokeRef.current;
        makeupStrokesRef.current = makeupStrokesRef.current.filter(
          (stroke) => stroke !== active,
        );
      }
      if (activeFashionStrokeRef.current) {
        const activeId = activeFashionStrokeRef.current.id;
        fashionOperationsRef.current = fashionOperationsRef.current.filter(
          (operation) =>
            operation.type !== "stroke" || operation.stroke.id !== activeId,
        );
      }
      drawingRef.current = false;
      activeStrokeRef.current = null;
      activeFashionStrokeRef.current = null;
      renderVisibleGuide();
      refreshGuideState();
      refreshFashionState();
    }, [refreshFashionState, refreshGuideState, renderVisibleGuide]);

    const beginViewportGesture = (
      event: ReactPointerEvent<HTMLDivElement>,
    ) => {
      if (generating) return;
      viewportPointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });

      if (
        event.pointerType === "touch" &&
        viewportPointersRef.current.size >= 2
      ) {
        const points = Array.from(viewportPointersRef.current.values()).slice(
          0,
          2,
        );
        const centerX = (points[0].x + points[1].x) / 2;
        const centerY = (points[0].y + points[1].y) / 2;
        const distance = Math.max(
          1,
          Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
        );
        const viewport = stageViewportRef.current;
        if (!viewport) return;
        const bounds = viewport.getBoundingClientRect();
        const viewportCenterX = bounds.left + bounds.width / 2;
        const viewportCenterY = bounds.top + bounds.height / 2;
        const current = viewportCameraRef.current;
        cancelActiveDrawingForViewportGesture();
        viewportPanRef.current = null;
        viewportPinchRef.current = {
          startDistance: distance,
          startZoom: current.zoom,
          contentX: (centerX - viewportCenterX - current.x) / current.zoom,
          contentY: (centerY - viewportCenterY - current.y) / current.zoom,
          viewportCenterX,
          viewportCenterY,
        };
        setViewportPanning(true);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const target = event.target as HTMLElement;
      const interactiveTarget = target.closest(
        `.${styles.placedAsset}, .${styles.layerHandle}, .${styles.layerAxisHandle}`,
      );
      if (
        viewportCameraRef.current.zoom > MIN_VIEWPORT_ZOOM &&
        interactionMode === "idle" &&
        event.button === 0 &&
        !interactiveTarget
      ) {
        viewportPanRef.current = {
          pointerId: event.pointerId,
          lastX: event.clientX,
          lastY: event.clientY,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        setViewportPanning(true);
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const moveViewportGesture = (
      event: ReactPointerEvent<HTMLDivElement>,
    ) => {
      if (!viewportPointersRef.current.has(event.pointerId)) return;
      viewportPointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });

      const pinch = viewportPinchRef.current;
      if (pinch && viewportPointersRef.current.size >= 2) {
        const points = Array.from(viewportPointersRef.current.values()).slice(
          0,
          2,
        );
        const centerX = (points[0].x + points[1].x) / 2;
        const centerY = (points[0].y + points[1].y) / 2;
        const distance = Math.max(
          1,
          Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
        );
        const nextZoom = Math.min(
          MAX_VIEWPORT_ZOOM,
          Math.max(
            MIN_VIEWPORT_ZOOM,
            pinch.startZoom * (distance / pinch.startDistance),
          ),
        );
        commitViewportCamera({
          zoom: nextZoom,
          x:
            centerX -
            pinch.viewportCenterX -
            pinch.contentX * nextZoom,
          y:
            centerY -
            pinch.viewportCenterY -
            pinch.contentY * nextZoom,
        });
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const pan = viewportPanRef.current;
      if (pan?.pointerId === event.pointerId) {
        panViewportBy(event.clientX - pan.lastX, event.clientY - pan.lastY);
        pan.lastX = event.clientX;
        pan.lastY = event.clientY;
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const finishViewportGesture = (
      event: ReactPointerEvent<HTMLDivElement>,
    ) => {
      viewportPointersRef.current.delete(event.pointerId);
      if (viewportPinchRef.current) {
        event.preventDefault();
        event.stopPropagation();
        if (viewportPointersRef.current.size < 2) {
          viewportPinchRef.current = null;
          setViewportPanning(false);
        }
      }
      if (viewportPanRef.current?.pointerId === event.pointerId) {
        viewportPanRef.current = null;
        setViewportPanning(false);
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    };

    const resizeDrawingCanvas = useCallback((aspectOverride?: number) => {
      const canvas = canvasRef.current;
      const surface = surfaceRef.current;
      const viewport = stageViewportRef.current;
      if (!canvas || !surface || !viewport) return;

      const viewportBounds = viewport.getBoundingClientRect();
      const mobile = window.matchMedia("(max-width: 680px)").matches;
      const ratio =
        typeof aspectOverride === "number" && Number.isFinite(aspectOverride)
          ? aspectOverride
          : aspectRatio;
      const availableWidth = Math.max(
        120,
        viewportBounds.width - (mobile ? 96 : 148),
      );
      const availableHeight = Math.max(
        150,
        viewportBounds.height - (mobile ? 200 : 188),
      );
      let displayWidth = Math.min(
        mobile ? 480 : 670,
        availableWidth,
        viewportBounds.width * (mobile ? 0.82 : 0.64),
      );
      let displayHeight = displayWidth / Math.max(0.1, ratio);
      if (displayHeight > availableHeight) {
        displayHeight = availableHeight;
        displayWidth = displayHeight * ratio;
      }
      surface.style.width = `${Math.max(80, displayWidth)}px`;
      surface.style.height = `${Math.max(80, displayHeight)}px`;

      const layoutWidth = surface.offsetWidth;
      const layoutHeight = surface.offsetHeight;
      if (!layoutWidth || !layoutHeight) return;

      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const nextWidth = Math.max(1, Math.round(layoutWidth * pixelRatio));
      const nextHeight = Math.max(1, Math.round(layoutHeight * pixelRatio));
      if (canvas.width === nextWidth && canvas.height === nextHeight) return;

      canvas.width = nextWidth;
      canvas.height = nextHeight;
      rebuildFashionMasks(nextWidth, nextHeight);
      renderVisibleGuide();
      refreshFashionState();
    }, [
      aspectRatio,
      rebuildFashionMasks,
      refreshFashionState,
      renderVisibleGuide,
    ]);

    useEffect(() => {
      const surface = surfaceRef.current;
      const viewport = stageViewportRef.current;
      if (!surface || !viewport) return;

      const observer = new ResizeObserver(() => resizeDrawingCanvas());
      observer.observe(surface);
      observer.observe(viewport);
      resizeDrawingCanvas();
      return () => observer.disconnect();
    }, [image, resizeDrawingCanvas]);

    useEffect(() => {
      const viewport = stageViewportRef.current;
      if (!viewport) return;
      const handleWheel = (event: WheelEvent) => {
        if (generating) return;
        const current = viewportCameraRef.current;
        const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          const factor = Math.exp(-event.deltaY * scale * 0.002);
          zoomViewportAt(
            current.zoom * factor,
            event.clientX,
            event.clientY,
          );
          return;
        }
        if (current.zoom <= MIN_VIEWPORT_ZOOM) return;
        event.preventDefault();
        const deltaX =
          (event.shiftKey && Math.abs(event.deltaX) < Math.abs(event.deltaY)
            ? event.deltaY
            : event.deltaX) * scale;
        const deltaY = (event.shiftKey ? 0 : event.deltaY) * scale;
        panViewportBy(-deltaX, -deltaY);
      };
      viewport.addEventListener("wheel", handleWheel, { passive: false });
      return () => viewport.removeEventListener("wheel", handleWheel);
    }, [generating, panViewportBy, zoomViewportAt]);

    useEffect(
      () => () => {
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        releaseFashionMasks();
        if (fashionBufferRef.current) {
          fashionBufferRef.current.width = 0;
          fashionBufferRef.current.height = 0;
        }
        if (fashionScratchRef.current) {
          fashionScratchRef.current.width = 0;
          fashionScratchRef.current.height = 0;
        }
      },
      [releaseFashionMasks],
    );

    const clearFashionGuide = () => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
      longPressStartRef.current = null;
      activeFashionStrokeRef.current = null;
      fashionOperationsRef.current = [];
      selectedFashionRegionRef.current = null;
      drawingRef.current = false;
      hasFashionMarksRef.current = false;
      releaseFashionMasks();
      onFashionGuideChange({
        hasMarks: false,
        hasOutline: false,
        canUndo: false,
        selectedRegionId: null,
        regions: [],
      });
      renderVisibleGuide();
    };

    const clearGuide = () => {
      makeupStrokesRef.current = [];
      activeStrokeRef.current = null;
      drawingRef.current = false;
      hasMarksRef.current = false;
      onGuideChange({ hasMarks: false, canUndo: false, products: [] });
      clearFashionGuide();
    };

    const undoMakeupGuide = () => {
      if (makeupStrokesRef.current.length === 0) return;
      makeupStrokesRef.current.pop();
      activeStrokeRef.current = null;
      drawingRef.current = false;
      renderVisibleGuide();
      refreshGuideState();
    };

    const undoFashionGuide = () => {
      if (fashionOperationsRef.current.length === 0) return;
      fashionOperationsRef.current.pop();
      activeFashionStrokeRef.current = null;
      drawingRef.current = false;
      const canvas = canvasRef.current;
      if (canvas) rebuildFashionMasks(canvas.width, canvas.height);
      renderVisibleGuide();
      refreshFashionState();
    };

    const undoGuide = () => {
      if (interactionMode === "fashion") {
        undoFashionGuide();
      } else {
        undoMakeupGuide();
      }
    };

    const createInstructionCanvas = async (
      background: "source" | "white",
      maxDimension = 1024,
    ) => {
      if (!image) return null;

      const source = await loadHtmlImage(image);
      const outputScale = Math.min(
        1,
        maxDimension / Math.max(source.naturalWidth, source.naturalHeight),
      );
      const output = document.createElement("canvas");
      output.width = Math.max(1, Math.round(source.naturalWidth * outputScale));
      output.height = Math.max(1, Math.round(source.naturalHeight * outputScale));
      const context = output.getContext("2d");
      if (!context) return null;

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      if (background === "source") {
        context.drawImage(source, 0, 0, output.width, output.height);
      } else {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, output.width, output.height);
      }

      return { output, context };
    };

    const createContextualGuideBlob = async (maxDimension = 1024) => {
      if (
        !image ||
        (!hasMarksRef.current && !hasFashionMarksRef.current && layers.length === 0)
      ) {
        return null;
      }

      const instructionCanvas = await createInstructionCanvas("source", maxDimension);
      if (!instructionCanvas) return null;
      const { output, context } = instructionCanvas;
      renderMakeupStrokes(context, output.width, output.height);

      const fills = fashionFills();
      const strokes = fashionStrokes();
      const exportMasks = new Map<string, FashionRegionMask>();
      for (const fill of fills) {
        const mask = buildFashionRegionMask(
          strokes,
          output.width,
          output.height,
          fill.seed,
        );
        if (mask) exportMasks.set(fill.id, mask);
      }
      if (strokes.length > 0 || exportMasks.size > 0) {
        renderFashionLayer(
          context,
          output.width,
          output.height,
          exportMasks,
          fills,
          strokes,
          0.48,
        );
      }
      for (const mask of exportMasks.values()) {
        mask.canvas.width = 0;
        mask.canvas.height = 0;
      }

      for (const layer of layers) {
        try {
          const assetImage = await loadHtmlImage(layer.asset.src);
          const baseWidth = output.width * (layer.scale / 100);
          const width = baseWidth * (layer.stretchX ?? 1);
          const height =
            baseWidth *
            (assetImage.naturalHeight / Math.max(1, assetImage.naturalWidth)) *
            (layer.stretchY ?? 1);
          context.save();
          // Keep the face and body visible beneath the placement proxy. The
          // isolated full-opacity piece is sent separately to the model.
          context.globalAlpha =
            layer.asset.category === "hair"
              ? 0.46
              : layer.asset.category === "garment"
                ? 0.52
                : 0.62;
          context.translate(layer.x * output.width, layer.y * output.height);
          context.rotate((layer.rotation * Math.PI) / 180);
          context.drawImage(assetImage, -width / 2, -height / 2, width, height);
          context.restore();
        } catch {
          // The written placement data still gives the image model a precise fallback.
        }
      }

      try {
        return await canvasToBlob(output, "image/jpeg", 0.9);
      } finally {
        output.width = 0;
        output.height = 0;
      }
    };

    const createMakeupGuideLayers = async (
      maxDimension = 1024,
    ): Promise<MakeupGuideLayer[]> => {
      if (!image || !hasMarksRef.current) return [];

      const instructionCanvas = await createInstructionCanvas("white", maxDimension);
      if (!instructionCanvas) return [];
      const products = Array.from(
        new Set(
          makeupStrokesRef.current
            .filter((stroke) => stroke.mode === "paint")
            .map((stroke) => stroke.product),
        ),
      );
      const guides: MakeupGuideLayer[] = [];

      try {
        for (const product of products) {
          const transparentLayer = document.createElement("canvas");
          transparentLayer.width = instructionCanvas.output.width;
          transparentLayer.height = instructionCanvas.output.height;
          const layerContext = transparentLayer.getContext("2d");
          if (!layerContext) continue;
          renderMakeupStrokes(
            layerContext,
            transparentLayer.width,
            transparentLayer.height,
            product,
          );
          if (!canvasHasVisibleMarks(transparentLayer)) {
            transparentLayer.width = 0;
            transparentLayer.height = 0;
            continue;
          }

          const output = document.createElement("canvas");
          output.width = transparentLayer.width;
          output.height = transparentLayer.height;
          const context = output.getContext("2d");
          if (!context) {
            transparentLayer.width = 0;
            transparentLayer.height = 0;
            continue;
          }
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, output.width, output.height);
          context.drawImage(transparentLayer, 0, 0);

          const colors = Array.from(
            new Set(
              makeupStrokesRef.current
                .filter(
                  (stroke) => stroke.mode === "paint" && stroke.product === product,
                )
                .map((stroke) => stroke.color.toLowerCase()),
            ),
          );
          try {
            guides.push({
              product,
              colors,
              blob: await canvasToBlob(output, "image/png"),
            });
          } finally {
            transparentLayer.width = 0;
            transparentLayer.height = 0;
            output.width = 0;
            output.height = 0;
          }
        }

        return guides;
      } finally {
        instructionCanvas.output.width = 0;
        instructionCanvas.output.height = 0;
      }
    };

    const createFashionGuideLayers = async (
      maxDimension = 1024,
    ): Promise<FashionGuideLayer[]> => {
      if (!image || !hasFashionMarksRef.current) return [];
      const instructionCanvas = await createInstructionCanvas("white", maxDimension);
      if (!instructionCanvas) return [];
      const { output } = instructionCanvas;
      const strokes = fashionStrokes();
      const fills = fashionFills();
      const guides: FashionGuideLayer[] = [];

      try {
        for (const fill of fills) {
          const mask = buildFashionRegionMask(
            strokes,
            output.width,
            output.height,
            fill.seed,
          );
          if (!mask) continue;
          const layer = document.createElement("canvas");
          layer.width = output.width;
          layer.height = output.height;
          const context = layer.getContext("2d");
          if (!context) {
            mask.canvas.width = 0;
            mask.canvas.height = 0;
            continue;
          }
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, layer.width, layer.height);
          drawFashionRegion(context, mask, fill, 0.98);
          try {
            guides.push({
              id: fill.id,
              kind: "filled-region",
              category: fill.category,
              material: fill.material,
              pattern: fill.pattern,
              color: fill.color.toLowerCase(),
              bounds: mask.bounds,
              blob: await canvasToBlob(layer, "image/png"),
            });
          } finally {
            mask.canvas.width = 0;
            mask.canvas.height = 0;
            layer.width = 0;
            layer.height = 0;
          }
        }

        if (guides.length === 0) {
          const drawStrokes = strokes.filter((stroke) => stroke.mode === "draw");
          const latest = drawStrokes[drawStrokes.length - 1];
          if (!latest) return [];
          const transparent = document.createElement("canvas");
          transparent.width = output.width;
          transparent.height = output.height;
          const transparentContext = transparent.getContext("2d");
          if (!transparentContext) return [];
          for (const stroke of strokes) {
            drawFashionStroke(
              transparentContext,
              stroke,
              transparent.width,
              transparent.height,
            );
          }
          if (!canvasHasVisibleMarks(transparent)) {
            transparent.width = 0;
            transparent.height = 0;
            return [];
          }

          const context = output.getContext("2d");
          if (!context) return [];
          context.drawImage(transparent, 0, 0);
          const points = drawStrokes.flatMap((stroke) => stroke.points);
          const minX = Math.min(...points.map((point) => point.x));
          const minY = Math.min(...points.map((point) => point.y));
          const maxX = Math.max(...points.map((point) => point.x));
          const maxY = Math.max(...points.map((point) => point.y));
          transparent.width = 0;
          transparent.height = 0;
          guides.push({
            id: "fashion-outline",
            kind: "outline",
            category: latest.category,
            material: latest.material,
            pattern: latest.pattern,
            color: latest.color.toLowerCase(),
            bounds: {
              x: minX,
              y: minY,
              width: Math.max(0.01, maxX - minX),
              height: Math.max(0.01, maxY - minY),
            },
            blob: await canvasToBlob(output, "image/png"),
          });
        }
        return guides;
      } finally {
        output.width = 0;
        output.height = 0;
      }
    };

    const selectFashionRegion = (regionId: string | null) => {
      selectedFashionRegionRef.current = regionId;
      refreshFashionState();
    };

    const updateFashionRegionStyle = (
      regionId: string,
      patch: Partial<Omit<FashionSettings, "size">>,
    ) => {
      const operation = fashionOperationsRef.current.find(
        (candidate) =>
          candidate.type === "fill" && candidate.fill.id === regionId,
      );
      if (!operation || operation.type !== "fill") return;
      Object.assign(operation.fill, patch);
      renderVisibleGuide();
      refreshFashionState();
    };

    useImperativeHandle(forwardedRef, () => ({
      createContextualGuideBlob,
      createMakeupGuideLayers,
      createFashionGuideLayers,
      clearGuide,
      clearFashionGuide,
      undoGuide,
      selectFashionRegion,
      updateFashionRegionStyle,
      hasGuide: () => hasMarksRef.current || hasFashionMarksRef.current,
    }));

    const pointForEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const canvas = event.currentTarget;
      const bounds = canvas.getBoundingClientRect();
      return {
        x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
        y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
      };
    };

    const updateBrushCursor = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const cursor = brushCursorRef.current;
      if (!cursor) return;
      if (interactionMode === "idle") {
        cursor.style.opacity = "0";
        return;
      }
      const bounds = event.currentTarget.getBoundingClientRect();
      const localSize =
        interactionMode === "fashion"
          ? tool === "fill"
            ? 30
            : tool === "eraser"
              ? Math.max(22, fashion.size * 2.1)
              : fashion.size
          : displayedBrushSize(tool, brush);
      cursor.style.left = `${((event.clientX - bounds.left) / bounds.width) * 100}%`;
      cursor.style.top = `${((event.clientY - bounds.top) / bounds.height) * 100}%`;
      const cameraScale = Math.max(
        MIN_VIEWPORT_ZOOM,
        viewportCameraRef.current.zoom,
      );
      cursor.style.width = `${localSize / cameraScale}px`;
      cursor.style.height = `${localSize / cameraScale}px`;
      cursor.style.opacity = "1";
    };

    const hideBrushCursor = () => {
      if (brushCursorRef.current) brushCursorRef.current.style.opacity = "0";
    };

    const flashFashionPulse = (point: FashionPoint, tone: FashionPulse["tone"]) => {
      const pulse = { id: Date.now(), ...point, tone };
      setFashionPulse(pulse);
      window.setTimeout(
        () => setFashionPulse((current) => (current?.id === pulse.id ? null : current)),
        720,
      );
    };

    const fillFashionAt = (point: FashionPoint) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const fills = fashionFills();
      const existing = [...fills]
        .reverse()
        .find((fill) => {
          const mask = fashionMasksRef.current.get(fill.id);
          return mask ? fashionRegionContains(mask, point) : false;
        });

      if (existing) {
        existing.category = fashion.category;
        existing.material = fashion.material;
        existing.pattern = fashion.pattern;
        existing.color = fashion.color;
        selectedFashionRegionRef.current = existing.id;
        renderVisibleGuide();
        refreshFashionState();
        onFashionFillResult?.("selected");
        flashFashionPulse(point, "magic");
        return;
      }
      if (onBeforeFashionFill && !onBeforeFashionFill()) return;

      const dimensions = fashionMaskDimensions(canvas.width, canvas.height);
      const mask = buildFashionRegionMask(
        fashionStrokes(),
        dimensions.width,
        dimensions.height,
        point,
      );
      if (!mask) {
        onFashionFillResult?.("miss");
        flashFashionPulse(point, "miss");
        return;
      }

      const fill: FashionFill = {
        id: `fashion-${crypto.randomUUID()}`,
        seed: point,
        category: fashion.category,
        material: fashion.material,
        pattern: fashion.pattern,
        color: fashion.color,
      };
      fashionOperationsRef.current.push({ type: "fill", fill });
      fashionMasksRef.current.set(fill.id, mask);
      selectedFashionRegionRef.current = fill.id;
      hasFashionMarksRef.current = true;
      renderVisibleGuide();
      refreshFashionState();
      onFashionFillResult?.(mask.repaired ? "repaired" : "filled");
      flashFashionPulse(point, "magic");
      if ("vibrate" in navigator) navigator.vibrate(18);
    };

    const beginDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (generating || interactionMode === "idle") return;
      const canvas = event.currentTarget;
      const bounds = canvas.getBoundingClientRect();
      const point = pointForEvent(event);

      if (interactionMode === "fashion") {
        longPressTriggeredRef.current = false;
        if (tool === "fill") {
          fillFashionAt(point);
          updateBrushCursor(event);
          event.preventDefault();
          return;
        }

        const displaySize =
          tool === "eraser" ? Math.max(22, fashion.size * 2.1) : fashion.size;
        const stroke: FashionStroke = {
          id: `stroke-${crypto.randomUUID()}`,
          mode: tool === "eraser" ? "erase" : "draw",
          color: fashion.color,
          size: displaySize / Math.max(1, bounds.width),
          category: fashion.category,
          material: fashion.material,
          pattern: fashion.pattern,
          points: [point],
        };
        fashionOperationsRef.current.push({ type: "stroke", stroke });
        activeFashionStrokeRef.current = stroke;
        drawingRef.current = true;
        canvas.setPointerCapture(event.pointerId);
        renderVisibleGuide();
        refreshFashionState();
        updateBrushCursor(event);

        if (tool !== "eraser") {
          longPressStartRef.current = {
            point,
            clientX: event.clientX,
            clientY: event.clientY,
            strokeId: stroke.id,
          };
          if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = setTimeout(() => {
            const start = longPressStartRef.current;
            if (!start || start.strokeId !== stroke.id || !drawingRef.current) return;
            fashionOperationsRef.current = fashionOperationsRef.current.filter(
              (operation) =>
                operation.type !== "stroke" || operation.stroke.id !== stroke.id,
            );
            activeFashionStrokeRef.current = null;
            drawingRef.current = false;
            longPressTriggeredRef.current = true;
            longPressStartRef.current = null;
            fillFashionAt(start.point);
          }, 520);
        }
        event.preventDefault();
        return;
      }

      if (tool === "brush" && onBeforePaint && !onBeforePaint(brush.product)) return;
      const displaySize = displayedBrushSize(tool, brush);
      const stroke: GuideStroke = {
        mode: tool === "eraser" ? "erase" : "paint",
        product: brush.product,
        color: brush.color,
        size: displaySize / Math.max(1, bounds.width),
        opacity: brush.opacity,
        points: [point],
      };
      makeupStrokesRef.current.push(stroke);
      activeStrokeRef.current = stroke;
      drawingRef.current = true;
      canvas.setPointerCapture(event.pointerId);
      renderVisibleGuide();
      refreshGuideState();
      updateBrushCursor(event);
      event.preventDefault();
    };

    const continueDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      updateBrushCursor(event);
      if (generating) return;
      const stroke =
        interactionMode === "fashion"
          ? activeFashionStrokeRef.current
          : activeStrokeRef.current;
      if (!drawingRef.current || !stroke) return;
      const canvas = event.currentTarget;
      const bounds = canvas.getBoundingClientRect();
      const point = pointForEvent(event);
      const previous = stroke.points[stroke.points.length - 1];

      if (interactionMode === "fashion" && longPressStartRef.current) {
        const moved = Math.hypot(
          event.clientX - longPressStartRef.current.clientX,
          event.clientY - longPressStartRef.current.clientY,
        );
        if (moved > 7) {
          if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
          longPressStartRef.current = null;
        }
      }
      if (
        previous &&
        Math.hypot(
          (point.x - previous.x) * bounds.width,
          (point.y - previous.y) * bounds.height,
        ) < 1.25
      ) {
        return;
      }
      stroke.points.push(point);
      renderVisibleGuide();
    };

    const finishDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
      longPressStartRef.current = null;
      drawingRef.current = false;
      activeStrokeRef.current = null;
      activeFashionStrokeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (interactionMode === "fashion") {
        if (!longPressTriggeredRef.current) {
          rebuildFashionMasks(event.currentTarget.width, event.currentTarget.height);
        }
        longPressTriggeredRef.current = false;
        renderVisibleGuide();
        refreshFashionState();
        return;
      }
      renderVisibleGuide();
      refreshGuideState();
    };

    const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
      if (generating) {
        event.target.value = "";
        return;
      }
      const file = event.target.files?.[0];
      if (file) onUpload(file);
      event.target.value = "";
    };

    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setAssetDragActive(false);
      setUploadDragActive(false);
      if (generating) return;

      const assetId = event.dataTransfer.getData("application/riya-asset");
      if (assetId && surfaceRef.current) {
        const bounds = surfaceRef.current.getBoundingClientRect();
        onDropAsset(
          assetId,
          Math.min(0.97, Math.max(0.03, (event.clientX - bounds.left) / bounds.width)),
          Math.min(0.97, Math.max(0.03, (event.clientY - bounds.top) / bounds.height)),
        );
        return;
      }

      const file = Array.from(event.dataTransfer.files).find((candidate) =>
        candidate.type.startsWith("image/"),
      );
      if (file) onUpload(file);
    };

    const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (generating) {
        event.dataTransfer.dropEffect = "none";
        return;
      }
      const isAsset = event.dataTransfer.types.includes("application/riya-asset");
      setAssetDragActive(isAsset);
      setUploadDragActive(!isAsset);
      event.dataTransfer.dropEffect = isAsset ? "copy" : "copy";
    };

    const beginLayerDrag = (
      event: ReactPointerEvent<HTMLDivElement>,
      layer: PlacedAsset,
    ) => {
      if (generating) return;
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      layerDragRef.current = {
        id: layer.instanceId,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: layer.x,
        originY: layer.y,
      };
      onSelectLayer(layer.instanceId);
    };

    const moveLayer = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (generating) return;
      const drag = layerDragRef.current;
      const surface = surfaceRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !surface) return;
      const bounds = surface.getBoundingClientRect();
      onUpdateLayer(drag.id, {
        x: Math.min(0.98, Math.max(0.02, drag.originX + (event.clientX - drag.startX) / bounds.width)),
        y: Math.min(0.98, Math.max(0.02, drag.originY + (event.clientY - drag.startY) / bounds.height)),
      });
    };

    const finishLayerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      layerDragRef.current = null;
    };

    const beginLayerTransform = (
      event: ReactPointerEvent<HTMLButtonElement>,
      layer: PlacedAsset,
      mode: LayerTransformDrag["mode"],
    ) => {
      if (generating) return;
      const surface = surfaceRef.current;
      if (!surface) return;
      event.stopPropagation();
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);

      const bounds = surface.getBoundingClientRect();
      const centerX = bounds.left + layer.x * bounds.width;
      const centerY = bounds.top + layer.y * bounds.height;
      const deltaX = event.clientX - centerX;
      const deltaY = event.clientY - centerY;
      const startDistance =
        mode === "stretch-x"
          ? Math.abs(deltaX)
          : mode === "stretch-y"
            ? Math.abs(deltaY)
            : Math.hypot(deltaX, deltaY);
      layerTransformRef.current = {
        mode,
        id: layer.instanceId,
        pointerId: event.pointerId,
        centerX,
        centerY,
        startDistance: Math.max(1, startDistance),
        startAngle: Math.atan2(deltaY, deltaX),
        startScale: layer.scale,
        startStretchX: layer.stretchX ?? 1,
        startStretchY: layer.stretchY ?? 1,
        startRotation: layer.rotation,
        minScale: layer.asset.category === "garment" ? 25 : 7,
        maxScale: layer.asset.category === "garment" ? 92 : 70,
      };
      onSelectLayer(layer.instanceId);
    };

    const transformLayer = (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (generating) return;
      const drag = layerTransformRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.stopPropagation();

      const deltaX = event.clientX - drag.centerX;
      const deltaY = event.clientY - drag.centerY;
      if (drag.mode === "resize") {
        const nextDistance = Math.max(1, Math.hypot(deltaX, deltaY));
        const nextScale = drag.startScale * (nextDistance / drag.startDistance);
        onUpdateLayer(drag.id, {
          scale:
            Math.round(
              Math.min(drag.maxScale, Math.max(drag.minScale, nextScale)) * 10,
            ) / 10,
        });
        return;
      }
      if (drag.mode === "stretch-x") {
        const nextDistance = Math.max(1, Math.abs(deltaX));
        const nextStretch = drag.startStretchX * (nextDistance / drag.startDistance);
        onUpdateLayer(drag.id, {
          stretchX:
            Math.round(Math.min(3, Math.max(0.3, nextStretch)) * 100) / 100,
        });
        return;
      }
      if (drag.mode === "stretch-y") {
        const nextDistance = Math.max(1, Math.abs(deltaY));
        const nextStretch = drag.startStretchY * (nextDistance / drag.startDistance);
        onUpdateLayer(drag.id, {
          stretchY:
            Math.round(Math.min(3, Math.max(0.3, nextStretch)) * 100) / 100,
        });
        return;
      }

      const nextAngle = Math.atan2(deltaY, deltaX);
      const angleDelta = ((nextAngle - drag.startAngle) * 180) / Math.PI;
      const rawRotation = drag.startRotation + angleDelta;
      onUpdateLayer(drag.id, {
        rotation: Math.round(((rawRotation + 180) % 360 + 360) % 360 - 180),
      });
    };

    const finishLayerTransform = (event: ReactPointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      layerTransformRef.current = null;
    };

    if (!image) {
      return (
        <div
          className={`${styles.emptyStage} ${uploadDragActive ? styles.emptyStageDragging : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={() => setUploadDragActive(false)}
          onDrop={handleDrop}
        >
          <input
            ref={inputRef}
            className={styles.visuallyHidden}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={handleInput}
          />
          <div className={styles.emptyArt}>
            <div className={styles.emptyArtGlow} />
            <PortraitPlaceholder />
            <span className={styles.idleLipWand} aria-hidden="true">
              <WandSparkles size={14} />
            </span>
            <span className={`${styles.floatingTag} ${styles.floatingTagOne}`}>
              <WandSparkles size={13} /> Makeup
            </span>
            <span className={`${styles.floatingTag} ${styles.floatingTagTwo}`}>
              <ImagePlus size={13} /> Accessories
            </span>
            <span className={`${styles.floatingTag} ${styles.floatingTagThree}`}>
              <WandSparkles size={13} /> Clothes
            </span>
          </div>
          <div className={styles.emptyCopy}>
            <h2>Begin with a portrait</h2>
            <button className={styles.primaryUpload} onClick={() => inputRef.current?.click()}>
              <Upload size={17} />
              Choose a portrait
            </button>
          </div>
        </div>
      );
    }

    const visibleImage = showOriginal && originalImage ? originalImage : image;

    return (
      <div
        ref={stageViewportRef}
        className={`${styles.stageViewport} ${
          assetDragActive ? styles.stageAssetDragging : ""
        } ${
          viewportCamera.zoom > MIN_VIEWPORT_ZOOM
            ? styles.stageViewportZoomed
            : ""
        } ${viewportPanning ? styles.stageViewportPanning : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={() => {
          setAssetDragActive(false);
          setUploadDragActive(false);
        }}
        onDrop={handleDrop}
        onClick={() => {
          if (!generating) onSelectLayer(null);
        }}
      >
        <input
          ref={inputRef}
          className={styles.visuallyHidden}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleInput}
        />
        <div
          className={styles.stageTopActions}
          onClick={(event) => event.stopPropagation()}
        >
          <div
            className={styles.zoomControls}
            role="group"
            aria-label="Canvas zoom"
          >
            <button
              type="button"
              aria-label="Zoom out"
              title="Zoom out"
              disabled={
                generating ||
                viewportCamera.zoom <= MIN_VIEWPORT_ZOOM
              }
              onClick={() =>
                zoomViewportAt(
                  viewportCameraRef.current.zoom - VIEWPORT_ZOOM_STEP,
                )
              }
            >
              <Minus size={13} />
            </button>
            <output aria-live="polite">
              {Math.round(viewportCamera.zoom * 100)}%
            </output>
            <button
              type="button"
              aria-label="Zoom in"
              title="Zoom in"
              disabled={
                generating ||
                viewportCamera.zoom >= MAX_VIEWPORT_ZOOM
              }
              onClick={() =>
                zoomViewportAt(
                  viewportCameraRef.current.zoom + VIEWPORT_ZOOM_STEP,
                )
              }
            >
              <Plus size={13} />
            </button>
          </div>
          <button
            className={styles.replacePhoto}
            disabled={generating}
            onClick={() => inputRef.current?.click()}
            aria-label="Replace portrait"
            title="Replace portrait"
          >
            <ImagePlus size={14} />
          </button>
        </div>

        <div
          ref={stageCameraRef}
          className={styles.stageCamera}
          style={{
            transform: `translate3d(${viewportCamera.x}px, ${viewportCamera.y}px, 0) scale(${viewportCamera.zoom})`,
          }}
          onPointerDownCapture={beginViewportGesture}
          onPointerMoveCapture={moveViewportGesture}
          onPointerUpCapture={finishViewportGesture}
          onPointerCancelCapture={finishViewportGesture}
        >
          <div
            ref={surfaceRef}
            className={styles.imageSurface}
            style={{
              aspectRatio,
              cursor:
                interactionMode === "idle"
                  ? viewportCamera.zoom > MIN_VIEWPORT_ZOOM
                    ? viewportPanning
                      ? "grabbing"
                      : "grab"
                    : "default"
                  : "none",
              maxWidth: "none",
              maxHeight: "none",
            }}
          >
          {/* Canvas composition intentionally uses a native image for predictable export geometry. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className={styles.canvasImage}
            src={visibleImage}
            alt={imageName}
            draggable={false}
            onLoad={(event) => {
              if (cameraImageRef.current !== image) {
                cameraImageRef.current = image;
                resetViewportCamera();
              }
              const target = event.currentTarget;
              const nextAspect =
                target.naturalWidth / Math.max(1, target.naturalHeight);
              setAspectRatio(nextAspect);
              requestAnimationFrame(() => resizeDrawingCanvas(nextAspect));
            }}
          />

          {!showOriginal &&
            layers.map((layer) => {
              const stretchX = layer.stretchX ?? 1;
              const stretchY = layer.stretchY ?? 1;
              const assetRatio = layerRatios[layer.instanceId] ?? 1;
              return (
              <div
                key={layer.instanceId}
                className={`${styles.placedAsset} ${
                  selectedLayerId === layer.instanceId ? styles.placedAssetSelected : ""
                } ${interactionMode === "fashion" ? styles.placedAssetBlocked : ""}`}
                role="button"
                tabIndex={interactionMode === "fashion" ? -1 : 0}
                aria-label={`${layer.asset.name} — drag to reposition`}
                style={{
                  left: `${layer.x * 100}%`,
                  top: `${layer.y * 100}%`,
                  width: `${layer.scale * stretchX}%`,
                  aspectRatio: (assetRatio * stretchX) / stretchY,
                  transform: `translate(-50%, -50%) rotate(${layer.rotation}deg)`,
                }}
                title={`${layer.asset.name} — drag to reposition`}
                onPointerDown={(event) => beginLayerDrag(event, layer)}
                onPointerMove={moveLayer}
                onPointerUp={finishLayerDrag}
                onPointerCancel={finishLayerDrag}
                onClick={(event) => {
                  event.stopPropagation();
                  if (generating) return;
                  onSelectLayer(layer.instanceId);
                }}
                onKeyDown={(event) => {
                  if (generating) return;
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectLayer(layer.instanceId);
                  }
                  if (event.key === "Delete" || event.key === "Backspace") {
                    event.preventDefault();
                    onRemoveLayer(layer.instanceId);
                  }
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={layer.asset.src}
                  alt=""
                  draggable={false}
                  onLoad={(event) => {
                    const imageElement = event.currentTarget;
                    const ratio =
                      imageElement.naturalWidth /
                      Math.max(1, imageElement.naturalHeight);
                    setLayerRatios((current) =>
                      current[layer.instanceId] === ratio
                        ? current
                        : { ...current, [layer.instanceId]: ratio },
                    );
                  }}
                />
                {selectedLayerId === layer.instanceId && (
                  <>
                    <button
                      type="button"
                      className={`${styles.layerHandle} ${styles.layerDeleteHandle}`}
                      aria-label={`Delete ${layer.asset.name}`}
                      title="Delete artifact"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemoveLayer(layer.instanceId);
                      }}
                    >
                      <X size={13} strokeWidth={2.4} />
                    </button>
                    <button
                      type="button"
                      className={`${styles.layerHandle} ${styles.layerRotateHandle}`}
                      aria-label={`Rotate ${layer.asset.name}`}
                      title="Drag to rotate"
                      onPointerDown={(event) =>
                        beginLayerTransform(event, layer, "rotate")
                      }
                      onPointerMove={transformLayer}
                      onPointerUp={finishLayerTransform}
                      onPointerCancel={finishLayerTransform}
                    >
                      <RotateCw size={12} />
                    </button>
                    <button
                      type="button"
                      className={`${styles.layerHandle} ${styles.layerResizeHandle}`}
                      aria-label={`Resize ${layer.asset.name}`}
                      title="Drag to resize"
                      onPointerDown={(event) =>
                        beginLayerTransform(event, layer, "resize")
                      }
                      onPointerMove={transformLayer}
                      onPointerUp={finishLayerTransform}
                      onPointerCancel={finishLayerTransform}
                    >
                      <Scaling size={12} />
                    </button>
                    <button
                      type="button"
                      className={`${styles.layerAxisHandle} ${styles.layerStretchXHandle}`}
                      aria-label={`Stretch ${layer.asset.name} horizontally`}
                      title="Drag to stretch width"
                      onPointerDown={(event) =>
                        beginLayerTransform(event, layer, "stretch-x")
                      }
                      onPointerMove={transformLayer}
                      onPointerUp={finishLayerTransform}
                      onPointerCancel={finishLayerTransform}
                    >
                      <span />
                    </button>
                    <button
                      type="button"
                      className={`${styles.layerAxisHandle} ${styles.layerStretchXHandleLeft}`}
                      aria-label={`Stretch ${layer.asset.name} horizontally from the left`}
                      title="Drag to stretch width from the left"
                      onPointerDown={(event) =>
                        beginLayerTransform(event, layer, "stretch-x")
                      }
                      onPointerMove={transformLayer}
                      onPointerUp={finishLayerTransform}
                      onPointerCancel={finishLayerTransform}
                    >
                      <span />
                    </button>
                    <button
                      type="button"
                      className={`${styles.layerAxisHandle} ${styles.layerStretchYHandle}`}
                      aria-label={`Stretch ${layer.asset.name} vertically`}
                      title="Drag to stretch height"
                      onPointerDown={(event) =>
                        beginLayerTransform(event, layer, "stretch-y")
                      }
                      onPointerMove={transformLayer}
                      onPointerUp={finishLayerTransform}
                      onPointerCancel={finishLayerTransform}
                    >
                      <span />
                    </button>
                    <button
                      type="button"
                      className={`${styles.layerAxisHandle} ${styles.layerStretchYHandleTop}`}
                      aria-label={`Stretch ${layer.asset.name} vertically from the top`}
                      title="Drag to stretch height from the top"
                      onPointerDown={(event) =>
                        beginLayerTransform(event, layer, "stretch-y")
                      }
                      onPointerMove={transformLayer}
                      onPointerUp={finishLayerTransform}
                      onPointerCancel={finishLayerTransform}
                    >
                      <span />
                    </button>
                  </>
                )}
              </div>
              );
            })}

          {!showOriginal && (
            <canvas
              ref={canvasRef}
              role="application"
              aria-label={
                interactionMode === "fashion"
                  ? "Fashion drawing canvas. Draw an outline, then fill inside it."
                  : "Makeup painting canvas"
              }
              className={`${styles.makeupCanvas} ${
                !generating && interactionMode !== "idle"
                  ? styles.makeupCanvasActive
                  : ""
              } ${interactionMode === "fashion" ? styles.fashionCanvasActive : ""}`}
              onPointerDown={beginDrawing}
              onPointerMove={continueDrawing}
              onPointerEnter={updateBrushCursor}
              onPointerLeave={hideBrushCursor}
              onPointerUp={finishDrawing}
              onPointerCancel={(event) => {
                finishDrawing(event);
                hideBrushCursor();
              }}
            />
          )}

          {!showOriginal && !generating && interactionMode !== "idle" && (
            <span
              ref={brushCursorRef}
              className={`${styles.brushCursor} ${
                tool === "eraser" ? styles.brushCursorEraser : ""
              } ${tool === "fill" ? styles.brushCursorFill : ""}`}
              style={{
                borderColor:
                  tool === "eraser"
                    ? "rgba(255, 255, 255, 0.92)"
                    : interactionMode === "fashion"
                      ? fashionColorHex(fashion.color)
                      : brush.color,
                background:
                  tool === "eraser"
                    ? "rgba(42, 32, 39, 0.14)"
                    : `${
                        interactionMode === "fashion"
                          ? fashionColorHex(fashion.color)
                          : brush.color
                      }20`,
              }}
              aria-hidden="true"
            />
          )}

          {fashionPulse && (
            <span
              className={`${styles.fashionPulse} ${
                fashionPulse.tone === "miss" ? styles.fashionPulseMiss : ""
              }`}
              style={{
                left: `${fashionPulse.x * 100}%`,
                top: `${fashionPulse.y * 100}%`,
              }}
              aria-hidden="true"
            >
              {fashionPulse.tone === "magic" ? (
                <>
                  <b>
                    <WandSparkles size={18} />
                  </b>
                  {Array.from({ length: 20 }, (_, index) => (
                    <i
                      key={index}
                      style={
                        {
                          "--burst-angle": `${index * 18 + (index % 2) * 6}deg`,
                          "--burst-distance": `${30 + (index % 5) * 6}px`,
                          "--burst-delay": `${(index % 4) * 12}ms`,
                        } as CSSProperties
                      }
                    >
                      <WandSparkles size={9 + (index % 3) * 2} />
                    </i>
                  ))}
                </>
              ) : (
                <Sparkles size={13} />
              )}
            </span>
          )}

          {generating && (
            <div
              className={styles.generatingOverlay}
              role="status"
              aria-live="polite"
            >
              <div className={styles.generationSimple}>
                <span className={styles.generationSimpleIcon} aria-hidden="true">
                  <WandSparkles size={17} />
                </span>
                <div className={styles.generationSimpleMeter}>
                  <strong>{generationProgress.percent}%</strong>
                  <div
                    className={styles.generationSimpleTrack}
                    role="progressbar"
                    aria-label="Estimated image generation progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={generationProgress.percent}
                  >
                    <span style={{ width: `${generationProgress.percent}%` }} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        </div>

        {assetDragActive && (
          <div className={styles.dropTarget}>
            <span>
              <Sparkles size={17} /> Place it here
            </span>
          </div>
        )}
      </div>
    );
  },
);
