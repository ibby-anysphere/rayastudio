"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ImagePlus,
  RotateCw,
  Scaling,
  Sparkles,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import type { EstimatedProgress } from "@/components/studio/use-estimated-progress";
import { canvasToBlob, loadHtmlImage } from "@/lib/image-utils";
import type {
  BrushSettings,
  CanvasTool,
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

export interface CanvasStageHandle {
  createContextualGuideBlob: (maxDimension?: number) => Promise<Blob | null>;
  createMakeupGuideLayers: (maxDimension?: number) => Promise<MakeupGuideLayer[]>;
  clearGuide: () => void;
  undoGuide: () => void;
  hasGuide: () => boolean;
}

interface CanvasStageProps {
  image: string | null;
  originalImage: string | null;
  imageName: string;
  tool: CanvasTool;
  brush: BrushSettings;
  layers: PlacedAsset[];
  selectedLayerId: string | null;
  showOriginal: boolean;
  zoom: number;
  generating: boolean;
  generationProgress: EstimatedProgress;
  onUpload: (file: File) => void;
  onDropAsset: (assetId: string, x: number, y: number) => void;
  onSelectLayer: (instanceId: string | null) => void;
  onUpdateLayer: (instanceId: string, patch: Partial<PlacedAsset>) => void;
  onRemoveLayer: (instanceId: string) => void;
  onGuideChange: (state: MakeupGuideState) => void;
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
        <filter id="portraitBlur">
          <feGaussianBlur stdDeviation="18" />
        </filter>
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
    </svg>
  );
}

export const CanvasStage = forwardRef<CanvasStageHandle, CanvasStageProps>(
  function CanvasStage(
    {
      image,
      originalImage,
      imageName,
      tool,
      brush,
      layers,
      selectedLayerId,
      showOriginal,
      zoom,
      generating,
      generationProgress,
      onUpload,
      onDropAsset,
      onSelectLayer,
      onUpdateLayer,
      onRemoveLayer,
      onGuideChange,
    },
    forwardedRef,
  ) {
    const surfaceRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const brushCursorRef = useRef<HTMLSpanElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const drawingRef = useRef(false);
    const activeStrokeRef = useRef<GuideStroke | null>(null);
    const strokesRef = useRef<GuideStroke[]>([]);
    const hasMarksRef = useRef(false);
    const layerDragRef = useRef<LayerDrag | null>(null);
    const layerTransformRef = useRef<LayerTransformDrag | null>(null);
    const [aspectRatio, setAspectRatio] = useState(4 / 5);
    const [layerRatios, setLayerRatios] = useState<Record<string, number>>({});
    const [assetDragActive, setAssetDragActive] = useState(false);
    const [uploadDragActive, setUploadDragActive] = useState(false);

    const renderGuideStrokes = useCallback(
      (
        context: CanvasRenderingContext2D,
        width: number,
        height: number,
        product?: MakeupProductId,
      ) => {
        for (const stroke of strokesRef.current) {
          if (stroke.mode === "paint" && product && stroke.product !== product) {
            continue;
          }
          drawGuideStroke(context, stroke, width, height);
        }
      },
      [],
    );

    const renderVisibleGuide = useCallback(() => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      context.clearRect(0, 0, canvas.width, canvas.height);
      renderGuideStrokes(context, canvas.width, canvas.height);
    }, [renderGuideStrokes]);

    const visibleGuideProducts = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return [];
      const products = Array.from(
        new Set(
          strokesRef.current
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
        renderGuideStrokes(context, layer.width, layer.height, product);
        return canvasHasVisibleMarks(layer);
      });
    }, [renderGuideStrokes]);

    const refreshGuideState = useCallback(() => {
      const canvas = canvasRef.current;
      const hasMarks = Boolean(canvas && canvasHasVisibleMarks(canvas));
      hasMarksRef.current = hasMarks;
      onGuideChange({
        hasMarks,
        canUndo: strokesRef.current.length > 0,
        products: hasMarks ? visibleGuideProducts() : [],
      });
    }, [onGuideChange, visibleGuideProducts]);

    const resizeDrawingCanvas = useCallback(() => {
      const canvas = canvasRef.current;
      const surface = surfaceRef.current;
      if (!canvas || !surface) return;

      const bounds = surface.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;

      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const nextWidth = Math.max(1, Math.round(bounds.width * pixelRatio));
      const nextHeight = Math.max(1, Math.round(bounds.height * pixelRatio));
      if (canvas.width === nextWidth && canvas.height === nextHeight) return;

      canvas.width = nextWidth;
      canvas.height = nextHeight;
      renderVisibleGuide();
    }, [renderVisibleGuide]);

    useEffect(() => {
      const surface = surfaceRef.current;
      if (!surface) return;

      const observer = new ResizeObserver(resizeDrawingCanvas);
      observer.observe(surface);
      resizeDrawingCanvas();
      return () => observer.disconnect();
    }, [image, resizeDrawingCanvas]);

    const clearGuide = () => {
      const canvas = canvasRef.current;
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      strokesRef.current = [];
      activeStrokeRef.current = null;
      drawingRef.current = false;
      hasMarksRef.current = false;
      onGuideChange({ hasMarks: false, canUndo: false, products: [] });
    };

    const undoGuide = () => {
      if (strokesRef.current.length === 0) return;
      strokesRef.current.pop();
      activeStrokeRef.current = null;
      drawingRef.current = false;
      renderVisibleGuide();
      refreshGuideState();
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
      if (!image || (!hasMarksRef.current && layers.length === 0)) return null;

      const instructionCanvas = await createInstructionCanvas("source", maxDimension);
      if (!instructionCanvas) return null;
      const { output, context } = instructionCanvas;
      renderGuideStrokes(context, output.width, output.height);

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

      return canvasToBlob(output, "image/jpeg", 0.9);
    };

    const createMakeupGuideLayers = async (
      maxDimension = 1024,
    ): Promise<MakeupGuideLayer[]> => {
      if (!image || !hasMarksRef.current) return [];

      const instructionCanvas = await createInstructionCanvas("white", maxDimension);
      if (!instructionCanvas) return [];
      const products = Array.from(
        new Set(
          strokesRef.current
            .filter((stroke) => stroke.mode === "paint")
            .map((stroke) => stroke.product),
        ),
      );
      const guides: MakeupGuideLayer[] = [];

      for (const product of products) {
        const transparentLayer = document.createElement("canvas");
        transparentLayer.width = instructionCanvas.output.width;
        transparentLayer.height = instructionCanvas.output.height;
        const layerContext = transparentLayer.getContext("2d");
        if (!layerContext) continue;
        renderGuideStrokes(
          layerContext,
          transparentLayer.width,
          transparentLayer.height,
          product,
        );
        if (!canvasHasVisibleMarks(transparentLayer)) continue;

        const output = document.createElement("canvas");
        output.width = transparentLayer.width;
        output.height = transparentLayer.height;
        const context = output.getContext("2d");
        if (!context) continue;
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, output.width, output.height);
        context.drawImage(transparentLayer, 0, 0);

        const colors = Array.from(
          new Set(
            strokesRef.current
              .filter(
                (stroke) => stroke.mode === "paint" && stroke.product === product,
              )
              .map((stroke) => stroke.color.toLowerCase()),
          ),
        );
        guides.push({
          product,
          colors,
          blob: await canvasToBlob(output, "image/png"),
        });
      }

      return guides;
    };

    useImperativeHandle(forwardedRef, () => ({
      createContextualGuideBlob,
      createMakeupGuideLayers,
      clearGuide,
      undoGuide,
      hasGuide: () => hasMarksRef.current,
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
      const bounds = event.currentTarget.getBoundingClientRect();
      const localSize =
        displayedBrushSize(tool, brush) / Math.max(0.01, zoom / 100);
      cursor.style.left = `${((event.clientX - bounds.left) / bounds.width) * 100}%`;
      cursor.style.top = `${((event.clientY - bounds.top) / bounds.height) * 100}%`;
      cursor.style.width = `${localSize}px`;
      cursor.style.height = `${localSize}px`;
      cursor.style.opacity = "1";
    };

    const hideBrushCursor = () => {
      if (brushCursorRef.current) brushCursorRef.current.style.opacity = "0";
    };

    const beginDrawing = (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (tool !== "brush" && tool !== "eraser") return;
      const canvas = event.currentTarget;
      const bounds = canvas.getBoundingClientRect();
      const displaySize = displayedBrushSize(tool, brush);
      const stroke: GuideStroke = {
        mode: tool === "eraser" ? "erase" : "paint",
        product: brush.product,
        color: brush.color,
        size: displaySize / Math.max(1, bounds.width),
        opacity: brush.opacity,
        points: [pointForEvent(event)],
      };
      strokesRef.current.push(stroke);
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
      const stroke = activeStrokeRef.current;
      if (!drawingRef.current || !stroke) return;
      const canvas = event.currentTarget;
      const bounds = canvas.getBoundingClientRect();
      const point = pointForEvent(event);
      const previous = stroke.points[stroke.points.length - 1];
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
      drawingRef.current = false;
      activeStrokeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      renderVisibleGuide();
      refreshGuideState();
    };

    const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) onUpload(file);
      event.target.value = "";
    };

    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setAssetDragActive(false);
      setUploadDragActive(false);

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
      const isAsset = event.dataTransfer.types.includes("application/riya-asset");
      setAssetDragActive(isAsset);
      setUploadDragActive(!isAsset);
      event.dataTransfer.dropEffect = isAsset ? "copy" : "copy";
    };

    const beginLayerDrag = (
      event: ReactPointerEvent<HTMLDivElement>,
      layer: PlacedAsset,
    ) => {
      if (tool !== "select") return;
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
            <span className={`${styles.floatingTag} ${styles.floatingTagOne}`}>
              <Sparkles size={13} /> Makeup
            </span>
            <span className={`${styles.floatingTag} ${styles.floatingTagTwo}`}>
              <WandSparkles size={13} /> Couture
            </span>
            <span className={`${styles.floatingTag} ${styles.floatingTagThree}`}>
              <ImagePlus size={13} /> Accessories
            </span>
          </div>
          <div className={styles.emptyCopy}>
            <span className={styles.eyebrow}>Your private styling room</span>
            <h2>Begin with a portrait</h2>
            <p>
              Upload a clear photo, then paint makeup, drape couture, and place
              accessories exactly where you imagine them.
            </p>
            <button className={styles.primaryUpload} onClick={() => inputRef.current?.click()}>
              <Upload size={17} />
              Choose a portrait
            </button>
            <span className={styles.uploadHint}>JPG, PNG or WebP · up to 24 MB</span>
          </div>
        </div>
      );
    }

    const visibleImage = showOriginal && originalImage ? originalImage : image;

    return (
      <div
        className={`${styles.stageViewport} ${assetDragActive ? styles.stageAssetDragging : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={() => {
          setAssetDragActive(false);
          setUploadDragActive(false);
        }}
        onDrop={handleDrop}
        onClick={() => onSelectLayer(null)}
      >
        <input
          ref={inputRef}
          className={styles.visuallyHidden}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={handleInput}
        />
        <div className={styles.stageMeta}>
          <span>{showOriginal ? "Original" : "Working canvas"}</span>
          <span className={styles.stageMetaDot} />
          <span>{imageName}</span>
        </div>
        <button className={styles.replacePhoto} onClick={() => inputRef.current?.click()}>
          <ImagePlus size={14} />
          Replace
        </button>

        <div
          ref={surfaceRef}
          className={styles.imageSurface}
          style={{
            aspectRatio,
            transform: `scale(${zoom / 100})`,
            cursor:
              tool === "brush" || tool === "eraser" ? "none" : "default",
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
              const target = event.currentTarget;
              setAspectRatio(target.naturalWidth / Math.max(1, target.naturalHeight));
              requestAnimationFrame(resizeDrawingCanvas);
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
                }`}
                role="button"
                tabIndex={0}
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
                  onSelectLayer(layer.instanceId);
                }}
                onKeyDown={(event) => {
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
                  </>
                )}
              </div>
              );
            })}

          {!showOriginal && (
            <canvas
              ref={canvasRef}
              className={`${styles.makeupCanvas} ${
                tool === "brush" || tool === "eraser" ? styles.makeupCanvasActive : ""
              }`}
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

          {!showOriginal && (tool === "brush" || tool === "eraser") && (
            <span
              ref={brushCursorRef}
              className={`${styles.brushCursor} ${
                tool === "eraser" ? styles.brushCursorEraser : ""
              }`}
              style={{
                borderColor: tool === "eraser" ? "rgba(255, 255, 255, 0.92)" : brush.color,
                background:
                  tool === "eraser" ? "rgba(42, 32, 39, 0.14)" : `${brush.color}20`,
              }}
              aria-hidden="true"
            />
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
