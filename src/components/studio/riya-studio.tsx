"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Brush,
  Check,
  Clock3,
  Eraser,
  Eye,
  HelpCircle,
  ImagePlus,
  PaintBucket,
  PenLine,
  RotateCcw,
  Sparkles,
  Undo2,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { RayaLoadingScreen } from "@/components/brand/raya-loading-screen";
import { RayaLogo } from "@/components/brand/raya-logo";
import {
  CanvasStage,
  type CanvasStageHandle,
  type FashionGuideLayer,
  type MakeupGuideState,
} from "@/components/studio/canvas-stage";
import { Inspector } from "@/components/studio/inspector";
import { useEstimatedProgress } from "@/components/studio/use-estimated-progress";
import { catalogAssets } from "@/lib/studio-catalog";
import {
  clearHistoryImages,
  loadHistoryImage,
  removeHistoryImage,
  saveHistoryImage,
} from "@/lib/history-db";
import {
  assetSourceToPngFile,
  createImageThumbnail,
  dataUrlToFile,
  prepareArtifactUpload,
  prepareUpload,
  recommendedAspectRatio,
  saveImageToDevice,
} from "@/lib/image-utils";
import {
  MAX_FASHION_LAYERS,
  MAX_INPUT_IMAGES,
  MAX_MAKEUP_LAYERS,
  MAX_WARDROBE_REFERENCES,
  type ArtifactExtractionSlot,
  type ArtifactExtractionStreamEvent,
  type AssetCategory,
  type BrushSettings,
  type CanvasTool,
  type FashionArtifactJob,
  type FashionGuideState,
  type FashionSettings,
  type GeneratedArtifactResult,
  type GenerationIntent,
  type HistoryItem,
  type MakeupProductId,
  type PlacedAsset,
  type RenderMode,
  type StudioAsset,
  type StudioTab,
} from "@/lib/studio-types";
import {
  loadWardrobeAssets,
  removeWardrobeAsset,
  saveWardrobeAsset,
} from "@/lib/wardrobe-db";
import styles from "./studio.module.css";

interface ToastMessage {
  id: number;
  tone: "success" | "error" | "info";
  title: string;
  detail?: string;
}

const categoryAccent: Record<AssetCategory, string> = {
  jewelry: "#d6b76d",
  eyewear: "#64545c",
  hair: "#b56d76",
  garment: "#6870a3",
  accessory: "#a07da7",
};

function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function timestamp() {
  return Date.now();
}

function holdForReveal(milliseconds = 620) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fashionJobPercent(elapsedMs: number, estimateMs: number) {
  const ratio = elapsedMs / Math.max(1, estimateMs);
  if (ratio <= 0.1) return 4 + (ratio / 0.1) * 12;
  if (ratio <= 0.45) return 16 + ((ratio - 0.1) / 0.35) * 38;
  if (ratio <= 0.8) return 54 + ((ratio - 0.45) / 0.35) * 28;
  if (ratio <= 1) return 82 + ((ratio - 0.8) / 0.2) * 10;
  return Math.min(98, 92 + 6 * (1 - Math.exp(-(ratio - 1))));
}

function emptyFashionGuideState(): FashionGuideState {
  return {
    hasMarks: false,
    hasOutline: false,
    canUndo: false,
    selectedRegionId: null,
    regions: [],
  };
}

function pieceNameFromPrompt(prompt: string) {
  const clean = prompt
    .replace(/^(a|an|the)\s+/i, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = clean.split(" ").slice(0, 4).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Untitled piece";
}

function isAssetCategory(value: unknown): value is AssetCategory {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(categoryAccent, value)
  );
}

function studioAssetFromArtifact(
  artifact: Partial<GeneratedArtifactResult>,
  index: number,
  createdAt: number,
  fallbackPrompt: string,
): StudioAsset | null {
  if (
    typeof artifact.image !== "string" ||
    !artifact.image.startsWith("data:image/") ||
    !isAssetCategory(artifact.category)
  ) {
    return null;
  }
  const prompt =
    typeof artifact.prompt === "string" && artifact.prompt.trim()
      ? artifact.prompt.trim()
      : fallbackPrompt;
  const name =
    typeof artifact.name === "string" && artifact.name.trim()
      ? artifact.name.trim().slice(0, 80)
      : pieceNameFromPrompt(prompt);
  return {
    id: makeId("custom"),
    name,
    category: artifact.category,
    prompt,
    src: artifact.image,
    accent: categoryAccent[artifact.category],
    custom: true,
    createdAt: createdAt - index,
  };
}

function fashionAssetsFromArtifacts(
  artifacts: Array<Partial<GeneratedArtifactResult>>,
  fallbackPrompt: string,
) {
  const createdAt = timestamp();
  return artifacts.flatMap((artifact, index) => {
    const asset = studioAssetFromArtifact(
      artifact,
      index,
      createdAt,
      fallbackPrompt,
    );
    return asset ? [asset] : [];
  });
}

async function readArtifactExtractionStream(
  response: Response,
  onEvent: (event: ArtifactExtractionStreamEvent) => void,
) {
  if (!response.body) {
    throw new Error("The browser could not read the extraction stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitLine = (line: string) => {
    if (!line.trim()) return;
    let event: ArtifactExtractionStreamEvent;
    try {
      event = JSON.parse(line) as ArtifactExtractionStreamEvent;
    } catch {
      throw new Error("The extraction stream returned an invalid update");
    }
    if (!event || typeof event !== "object" || !("type" in event)) {
      throw new Error("The extraction stream returned an invalid update");
    }
    onEvent(event);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        emitLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    emitLine(buffer);
  } finally {
    reader.releaseLock();
  }
}

function defaultPlacement(asset: StudioAsset) {
  const placements: Record<string, Pick<PlacedAsset, "x" | "y" | "scale" | "rotation">> = {
    "aurelia-tiara": { x: 0.5, y: 0.17, scale: 44, rotation: 0 },
    "lumiere-pearls": { x: 0.5, y: 0.42, scale: 48, rotation: 0 },
    "noir-frames": { x: 0.5, y: 0.34, scale: 43, rotation: 0 },
    "rose-ribbon": { x: 0.76, y: 0.2, scale: 31, rotation: 8 },
    "celeste-necklace": { x: 0.5, y: 0.68, scale: 39, rotation: 0 },
    "silk-scarf": { x: 0.5, y: 0.64, scale: 55, rotation: -4 },
    "midnight-dress": { x: 0.5, y: 0.7, scale: 72, rotation: 0 },
    "petal-clutch": { x: 0.73, y: 0.72, scale: 31, rotation: -5 },
  };

  if (placements[asset.id]) return placements[asset.id];
  if (asset.category === "garment") return { x: 0.5, y: 0.7, scale: 68, rotation: 0 };
  if (asset.category === "hair") return { x: 0.5, y: 0.2, scale: 48, rotation: 0 };
  if (asset.category === "eyewear") return { x: 0.5, y: 0.34, scale: 42, rotation: 0 };
  if (asset.category === "jewelry") return { x: 0.5, y: 0.47, scale: 35, rotation: 0 };
  return { x: 0.62, y: 0.58, scale: 36, rotation: 0 };
}

export function RiyaStudio() {
  const canvasRef = useRef<CanvasStageHandle>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const imageUrlsRef = useRef(new Set<string>());
  const currentImageRef = useRef<string | null>(null);
  const originalImageRef = useRef<string | null>(null);
  const originalHistoryIdRef = useRef<string | null>(null);
  const createdSourceImageRef = useRef<string | null>(null);
  const historyFallbackRef = useRef(new Map<string, Blob>());
  const historySelectionRef = useRef(0);
  const revisionCountRef = useRef(0);
  const artifactExtractionAbortRef = useRef<AbortController | null>(null);
  const artifactExtractionSlotsRef = useRef<ArtifactExtractionSlot[]>([]);
  const portraitGeneration = useEstimatedProgress();
  const assetGeneration = useEstimatedProgress();

  const [brandIntroState, setBrandIntroState] = useState<
    "visible" | "leaving" | "hidden"
  >("visible");
  const [tab, setTab] = useState<StudioTab>("makeup");
  const [tool, setTool] = useState<CanvasTool>("brush");
  const [brush, setBrush] = useState<BrushSettings>({
    product: "lipstick",
    color: "#c64f6a",
    size: 18,
    opacity: 0.68,
  });
  const [fashion, setFashion] = useState<FashionSettings>({
    category: "auto",
    material: "cashmere",
    pattern: "solid",
    color: "#d83f5f",
    size: 8,
  });
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [currentImage, setCurrentImage] = useState<string | null>(null);
  const [imageName, setImageName] = useState("Untitled portrait");
  const [layers, setLayers] = useState<PlacedAsset[]>([]);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [guideState, setGuideState] = useState<MakeupGuideState>({
    hasMarks: false,
    canUndo: false,
    products: [],
  });
  const [fashionState, setFashionState] = useState<FashionGuideState>({
    hasMarks: false,
    hasOutline: false,
    canUndo: false,
    selectedRegionId: null,
    regions: [],
  });
  const [showOriginal, setShowOriginal] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [currentHistoryId, setCurrentHistoryId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [customAssets, setCustomAssets] = useState<StudioAsset[]>([]);
  const [createdAssets, setCreatedAssets] = useState<StudioAsset[]>([]);
  const [artifactExtractionSlots, setArtifactExtractionSlots] = useState<
    ArtifactExtractionSlot[]
  >([]);
  const [createdSourceImage, setCreatedSourceImage] = useState<string | null>(null);
  const [createdSourceName, setCreatedSourceName] = useState("");
  const [fashionArtifactJobs, setFashionArtifactJobs] = useState<
    FashionArtifactJob[]
  >([]);
  const [generating, setGenerating] = useState(false);
  const [creatingAsset, setCreatingAsset] = useState(false);
  const [renderMode, setRenderMode] = useState<RenderMode>("fast");
  const [editApiConfigured, setEditApiConfigured] = useState<boolean | null>(null);
  const [assetApiConfigured, setAssetApiConfigured] = useState<boolean | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const allAssets = useMemo(
    () => [...customAssets, ...catalogAssets],
    [customAssets],
  );
  const hasGuide = guideState.hasMarks;
  const hasFashionGuide = fashionState.hasMarks;
  const hasPendingEdits = hasGuide || hasFashionGuide || layers.length > 0;
  const interactionMode =
    tab === "makeup"
      ? "makeup"
      : tab === "create"
        ? "fashion"
        : "idle";

  // Mirror the server's per-request image budget. Every look sends the source
  // photo plus a contextual guide (present as soon as anything is added), one
  // image per painted makeup product, and one per unique wardrobe reference.
  // Duplicated artifacts reuse a single reference, so they never grow the count.
  const uniqueAssetCount = useMemo(
    () => new Set(layers.map((layer) => layer.asset.id)).size,
    [layers],
  );
  const makeupProductCount = guideState.products.length;
  // Filled fashion shapes are sent independently so their material and print
  // meaning cannot bleed together. Before the first fill, the outline itself
  // occupies one guide slot.
  const fashionLayerCount =
    fashionState.regions.length > 0
      ? fashionState.regions.length
      : Number(fashionState.hasOutline);

  // Slots for wardrobe references once the source photo, contextual guide, and
  // authored guide layers are accounted for — capped by the reference ceiling.
  const referenceBudget = Math.max(
    0,
    Math.min(
      MAX_WARDROBE_REFERENCES,
      MAX_INPUT_IMAGES - 2 - makeupProductCount - fashionLayerCount,
    ),
  );
  const canAddNewArtifact = uniqueAssetCount < referenceBudget;

  // A new makeup product adds one layer; block it only if the combined image
  // budget (or the makeup layer ceiling) would be exceeded.
  const canAddNewMakeupProduct =
    makeupProductCount < MAX_MAKEUP_LAYERS &&
    2 +
      (makeupProductCount + 1) +
      fashionLayerCount +
      uniqueAssetCount <=
      MAX_INPUT_IMAGES;

  const showToast = (
    tone: ToastMessage["tone"],
    title: string,
    detail?: string,
  ) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: timestamp(), tone, title, detail });
    toastTimerRef.current = setTimeout(() => setToast(null), 5200);
  };

  const createManagedImageUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    imageUrlsRef.current.add(url);
    return url;
  };

  const releaseImageUrl = (url: string | null) => {
    if (!url || !imageUrlsRef.current.has(url)) return;
    URL.revokeObjectURL(url);
    imageUrlsRef.current.delete(url);
  };

  const replaceCreatedSourceImage = (
    nextImage: string | null,
    nextName = "",
  ) => {
    const previousImage = createdSourceImageRef.current;
    createdSourceImageRef.current = nextImage;
    setCreatedSourceImage(nextImage);
    setCreatedSourceName(nextName);
    if (previousImage && previousImage !== nextImage) {
      releaseImageUrl(previousImage);
    }
  };

  const replaceArtifactExtractionSlots = (
    nextSlots: ArtifactExtractionSlot[],
  ) => {
    artifactExtractionSlotsRef.current = nextSlots;
    setArtifactExtractionSlots(nextSlots);
  };

  const updateArtifactExtractionSlots = (
    update: (current: ArtifactExtractionSlot[]) => ArtifactExtractionSlot[],
  ) => {
    setArtifactExtractionSlots((current) => {
      const next = update(current);
      artifactExtractionSlotsRef.current = next;
      return next;
    });
  };

  const replaceCurrentImage = (nextImage: string) => {
    const previousImage = currentImageRef.current;
    currentImageRef.current = nextImage;
    setCurrentImage(nextImage);
    if (
      previousImage &&
      previousImage !== nextImage &&
      previousImage !== originalImageRef.current
    ) {
      releaseImageUrl(previousImage);
    }
  };

  const persistHistoryBlob = async (id: string, blob: Blob) => {
    try {
      await saveHistoryImage(id, blob);
      historyFallbackRef.current.delete(id);
    } catch {
      // Compressed blobs are a much smaller fallback than base64 images if
      // IndexedDB is unavailable (for example, in private browsing).
      historyFallbackRef.current.set(id, blob);
    }
  };

  const readHistoryBlob = async (id: string) => {
    const fallback = historyFallbackRef.current.get(id);
    if (fallback) return fallback;
    try {
      return await loadHistoryImage(id);
    } catch {
      return null;
    }
  };

  const discardHistoryBlob = (id: string) => {
    historyFallbackRef.current.delete(id);
    void removeHistoryImage(id).catch(() => undefined);
  };

  useEffect(() => {
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const leaveTimer = window.setTimeout(
      () => setBrandIntroState("leaving"),
      2200,
    );
    const hideTimer = window.setTimeout(
      () => setBrandIntroState("hidden"),
      reducedMotion ? 2220 : 2480,
    );

    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(hideTimer);
    };
  }, []);

  useEffect(() => {
    const imageUrls = imageUrlsRef.current;
    const historyFallback = historyFallbackRef.current;

    fetch("/api/status", { cache: "no-store" })
      .then((response) => response.json())
      .then(
        (data: {
          editConfigured?: boolean;
          assetConfigured?: boolean;
        }) => {
          setEditApiConfigured(Boolean(data.editConfigured));
          setAssetApiConfigured(Boolean(data.assetConfigured));
        },
      )
      .catch(() => {
        setEditApiConfigured(false);
        setAssetApiConfigured(false);
      });

    loadWardrobeAssets()
      .then(setCustomAssets)
      .catch(() => {
        // The studio remains fully usable if private browser storage is unavailable.
      });

    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      artifactExtractionAbortRef.current?.abort();
      for (const url of imageUrls) URL.revokeObjectURL(url);
      imageUrls.clear();
      historyFallback.clear();
      void clearHistoryImages().catch(() => undefined);
    };
  }, []);

  const handleUpload = async (file: File) => {
    try {
      const prepared = await prepareUpload(file);
      const thumbnail = await createImageThumbnail(prepared.blob);
      const historyId = makeId("history");

      historySelectionRef.current += 1;
      for (const url of imageUrlsRef.current) URL.revokeObjectURL(url);
      imageUrlsRef.current.clear();
      historyFallbackRef.current.clear();
      revisionCountRef.current = 0;
      await clearHistoryImages().catch(() => undefined);

      const imageUrl = createManagedImageUrl(prepared.blob);
      originalImageRef.current = imageUrl;
      currentImageRef.current = imageUrl;
      originalHistoryIdRef.current = historyId;
      setOriginalImage(imageUrl);
      setCurrentImage(imageUrl);
      setImageName(prepared.name);
      setLayers([]);
      setSelectedLayerId(null);
      setHistory([
        {
          id: historyId,
          thumbnail,
          label: "Original",
          createdAt: timestamp(),
        },
      ]);
      setCurrentHistoryId(historyId);
      setTool(tab === "create" ? "pencil" : "brush");
      setGuideState({ hasMarks: false, canUndo: false, products: [] });
      setFashionState(emptyFashionGuideState());
      setHistoryOpen(false);
      requestAnimationFrame(() => canvasRef.current?.clearGuide());
      showToast("success", "Portrait ready", "Now paint, style, or drag a piece onto the canvas.");
    } catch (error) {
      showToast(
        "error",
        "That photo could not be opened",
        error instanceof Error ? error.message : "Try another image.",
      );
    }
  };

  const placeAsset = (
    asset: StudioAsset,
    position?: { x: number; y: number },
  ) => {
    if (generating) return;
    if (!currentImage) {
      showToast("info", "Start with a portrait", "Upload a photo before placing a piece.");
      return;
    }

    const isNewReference = !layers.some((layer) => layer.asset.id === asset.id);
    if (isNewReference && !canAddNewArtifact) {
      showToast(
        "info",
        "Image limit reached",
        `A look can include up to ${MAX_INPUT_IMAGES} images. Remove an artifact or a makeup product before adding another piece.`,
      );
      return;
    }

    const placement = defaultPlacement(asset);
    const instanceId = makeId("piece");
    setLayers((existing) => [
      ...existing,
      {
        instanceId,
        asset,
        ...placement,
        stretchX: 1,
        stretchY: 1,
        ...(position ?? {}),
      },
    ]);
    setSelectedLayerId(instanceId);
  };

  const handleDropAsset = (assetId: string, x: number, y: number) => {
    const asset = allAssets.find((candidate) => candidate.id === assetId);
    if (asset) placeAsset(asset, { x, y });
  };

  // Gate the first stroke of a not-yet-painted makeup product when the image
  // budget is full. Repainting or erasing an existing product never adds an
  // image, so it stays available.
  const canPaintProduct = (product: MakeupProductId) => {
    const alreadyPainted = guideState.products.includes(product);
    if (!alreadyPainted && !canAddNewMakeupProduct) {
      showToast(
        "info",
        "Image limit reached",
        `A look can include up to ${MAX_INPUT_IMAGES} images. Remove an artifact or a makeup product before adding a new one.`,
      );
      return false;
    }
    return true;
  };

  const canFillFashionRegion = () => {
    const nextFashionLayerCount =
      fashionState.regions.length === 0 ? 1 : fashionState.regions.length + 1;
    if (
      nextFashionLayerCount > MAX_FASHION_LAYERS ||
      2 +
        makeupProductCount +
        nextFashionLayerCount +
        uniqueAssetCount >
        MAX_INPUT_IMAGES
    ) {
      showToast(
        "info",
        "Your magic layers are full",
        `Use up to ${MAX_FASHION_LAYERS} filled shapes in one look, or remove another visual layer first.`,
      );
      return false;
    }
    return true;
  };

  const handleFashionGuideChange = useCallback((next: FashionGuideState) => {
    setFashionState(next);
    const selected = next.regions.find(
      (region) => region.id === next.selectedRegionId,
    );
    if (!selected) return;
    setFashion((current) => ({
      ...current,
      category: selected.category,
      material: selected.material,
      pattern: selected.pattern,
      color: selected.color,
    }));
  }, []);

  const updateFashionSettings = (patch: Partial<FashionSettings>) => {
    canvasRef.current?.selectFashionRegion(null);
    setFashion((current) => ({ ...current, ...patch }));
  };

  const changeTab = (nextTab: StudioTab) => {
    setTab(nextTab);
    if (nextTab === "makeup") {
      setTool((current) => (current === "eraser" ? current : "brush"));
    } else if (nextTab === "create") {
      setSelectedLayerId(null);
      setTool((current) =>
        current === "fill" || current === "eraser" ? current : "pencil",
      );
    }
  };

  const handleFashionFillResult = (
    result: "filled" | "repaired" | "selected" | "miss",
  ) => {
    if (result === "repaired") {
      showToast(
        "success",
        "Tiny gaps fixed",
        "RIYA joined the nearby lines and filled your shape.",
      );
    } else if (result === "miss") {
      showToast(
        "info",
        "Give the shape one more line",
        "Draw a little more around the open side, then tap or hold inside again.",
      );
    }
  };

  const updateLayer = (instanceId: string, patch: Partial<PlacedAsset>) => {
    setLayers((existing) =>
      existing.map((layer) =>
        layer.instanceId === instanceId ? { ...layer, ...patch } : layer,
      ),
    );
  };

  const removeLayer = (instanceId: string) => {
    setLayers((existing) => existing.filter((layer) => layer.instanceId !== instanceId));
    setSelectedLayerId((selected) => (selected === instanceId ? null : selected));
  };

  const startFashionMaterialization = ({
    finalBlob,
    fashionGuides,
    intent,
  }: {
    finalBlob: Blob;
    fashionGuides: FashionGuideLayer[];
    intent: GenerationIntent;
  }) => {
    if (fashionGuides.length === 0) return;
    if (assetApiConfigured === false) {
      showToast(
        "info",
        "Your look is ready",
        "Connect the closet model later to save this drawing as a reusable piece.",
      );
      return;
    }

    const jobId = makeId("fashion-job");
    setFashionArtifactJobs((current) => [
      {
        id: jobId,
        status: "processing",
        progress: 4,
        artifacts: [],
        createdAt: timestamp(),
      },
      ...current,
    ]);
    setTab("create");
    const runJob = async () => {
      const startedAt = performance.now();
      const estimateMs = 62_000 + Math.max(0, fashionGuides.length - 1) * 7_000;
      const progressTimer = window.setInterval(() => {
        const progress = Math.floor(
          fashionJobPercent(performance.now() - startedAt, estimateMs),
        );
        setFashionArtifactJobs((current) =>
          current.map((job) =>
            job.id === jobId && job.status === "processing"
              ? { ...job, progress }
              : job,
          ),
        );
      }, 250);

      try {
        const sourceFile = new File([finalBlob], "finished-look.jpg", {
          type: finalBlob.type || "image/jpeg",
        });
        const sourceBlob =
          finalBlob.size <= 3.8 * 1024 * 1024
            ? finalBlob
            : (await prepareArtifactUpload(sourceFile)).blob;
        const sourceType = sourceBlob.type || "image/jpeg";
        const form = new FormData();
        form.append("mode", "fashion-artifactize");
        form.append(
          "source",
          new File([sourceBlob], "finished-look.jpg", {
            type: sourceType,
          }),
        );
        for (const guide of fashionGuides) {
          form.append(
            "fashionLayers",
            new File([guide.blob], `drawn-piece-${guide.id}.png`, {
              type: "image/png",
            }),
          );
        }
        form.append("intent", JSON.stringify(intent));

        const response = await fetch("/api/image", {
          method: "POST",
          body: form,
        });
        const data = (await response.json().catch(() => null)) as {
          artifacts?: Array<Partial<GeneratedArtifactResult>>;
          detectedCount?: number;
          failedCount?: number;
          error?: string;
          detail?: string;
        } | null;
        if (!response.ok) {
          throw new Error(
            data?.detail ||
              data?.error ||
              "The drawing could not be turned into a closet piece",
          );
        }

        const assets = fashionAssetsFromArtifacts(
          data?.artifacts ?? [],
          "Materialized from a hand-drawn fashion design",
        );
        if (assets.length === 0) {
          throw new Error("The closet model did not return a usable piece");
        }

        setFashionArtifactJobs((current) =>
          current.map((job) =>
            job.id === jobId
              ? {
                  ...job,
                  status: "complete",
                  progress: 100,
                  artifacts: assets,
                }
              : job,
          ),
        );
        const failedCount =
          typeof data?.failedCount === "number" ? data.failedCount : 0;
        showToast(
          failedCount > 0 ? "info" : "success",
          `${assets.length} closet ${assets.length === 1 ? "piece is" : "pieces are"} ready`,
          failedCount > 0
            ? "Keep the pieces you love. One drawing could not be isolated."
            : "Keep what you love—nothing is added until you choose it.",
        );
      } catch (error) {
        const detail =
          error instanceof Error
            ? error.message
            : "The reusable closet piece can be tried again later.";
        setFashionArtifactJobs((current) =>
          current.map((job) =>
            job.id === jobId
              ? {
                  ...job,
                  status: "error",
                  progress: 100,
                  error: detail,
                }
              : job,
          ),
        );
        showToast(
          "info",
          "Your finished look is safe",
          `The reusable closet piece paused: ${detail}`,
        );
      } finally {
        window.clearInterval(progressTimer);
      }
    };

    void runJob();
  };

  const applyEdits = async () => {
    if (!currentImage) {
      showToast("info", "Start with a portrait", "Choose a photo to begin your look.");
      return;
    }
    if (editApiConfigured === false) {
      showToast(
        "error",
        "Connect the image model",
        "Add a fresh GEMINI_API_KEY to .env.local and restart the studio.",
      );
      return;
    }

    setGenerating(true);
    setSelectedLayerId(null);
    let completed = false;
    let progressStarted = false;

    try {
      // 1K instruction guides are sufficient for placement even when Gemini's
      // final output is 2K. Build them sequentially to bound peak iPad memory.
      const guideMaxDimension = 1024;
      const contextualGuide =
        await canvasRef.current?.createContextualGuideBlob(guideMaxDimension);
      const makeupGuides =
        await canvasRef.current?.createMakeupGuideLayers(guideMaxDimension);
      const makeupLayers = makeupGuides ?? [];
      const fashionGuides =
        await canvasRef.current?.createFashionGuideLayers(guideMaxDimension);
      const fashionLayers = fashionGuides ?? [];
      const maxReferenceCount = Math.max(
        0,
        Math.min(
          MAX_WARDROBE_REFERENCES,
          MAX_INPUT_IMAGES -
            1 -
            Number(Boolean(contextualGuide)) -
            makeupLayers.length -
            fashionLayers.length,
        ),
      );
      const expectedReferenceCount = Math.min(
        maxReferenceCount,
        new Set(layers.map((layer) => layer.asset.id)).size,
      );
      portraitGeneration.start(
        renderMode === "max" ? "portrait-max" : "portrait-fast",
        1 +
          Number(Boolean(contextualGuide)) +
          makeupLayers.length +
          fashionLayers.length +
          expectedReferenceCount,
      );
      progressStarted = true;

      const source = await dataUrlToFile(currentImage, "portrait.jpg");
      const form = new FormData();
      form.append("mode", "edit");
      form.append("source", source);
      form.append("renderMode", renderMode);
      form.append("aspectRatio", await recommendedAspectRatio(currentImage));

      if (contextualGuide) {
        form.append(
          "contextualGuide",
          new File([contextualGuide], "contextual-guide.jpg", { type: "image/jpeg" }),
        );
      }
      for (const guide of makeupLayers) {
        form.append(
          "makeupLayers",
          new File([guide.blob], `makeup-${guide.product}.png`, {
            type: "image/png",
          }),
        );
      }
      for (const guide of fashionLayers) {
        form.append(
          "fashionLayers",
          new File([guide.blob], `fashion-${guide.id}.png`, {
            type: "image/png",
          }),
        );
      }
      let nextReferenceIndex =
        2 +
        Number(Boolean(contextualGuide)) +
        makeupLayers.length +
        fashionLayers.length;
      const referenceIndexes = new Map<string, number>();
      const intentLayers: GenerationIntent["placedAssets"] = [];

      for (const layer of layers) {
        const layerIntent: GenerationIntent["placedAssets"][number] = {
          name: layer.asset.name,
          category: layer.asset.category,
          prompt: layer.asset.prompt,
          x: layer.x,
          y: layer.y,
          scale: layer.scale,
          stretchX: layer.stretchX,
          stretchY: layer.stretchY,
          rotation: layer.rotation,
        };

        let referenceIndex = referenceIndexes.get(layer.asset.id);
        if (
          referenceIndex === undefined &&
          referenceIndexes.size < maxReferenceCount
        ) {
          const safeName = layer.asset.id.replace(/[^a-z0-9-]/gi, "-");
          const file = await assetSourceToPngFile(
            layer.asset.src,
            `${safeName}.png`,
          );
          referenceIndex = nextReferenceIndex;
          referenceIndexes.set(layer.asset.id, referenceIndex);
          form.append("references", file);
          nextReferenceIndex += 1;
        }
        layerIntent.referenceIndex = referenceIndex;
        intentLayers.push(layerIntent);
      }

      const intent: GenerationIntent = {
        makeupLayers: makeupLayers.map((guide) => ({
          product: guide.product,
          colors: guide.colors,
        })),
        fashionLayers: fashionLayers.map((guide) => ({
          kind: guide.kind,
          category: guide.category,
          material: guide.material,
          pattern: guide.pattern,
          color: guide.color,
          bounds: guide.bounds,
        })),
        placedAssets: intentLayers,
      };
      form.append("intent", JSON.stringify(intent));

      const response = await fetch("/api/image", {
        method: "POST",
        body: form,
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
          detail?: string;
        } | null;
        throw new Error(
          data?.detail || data?.error || "The image could not be generated",
        );
      }
      const finalBlob = await response.blob();
      if (!finalBlob.size || !finalBlob.type.startsWith("image/")) {
        throw new Error("The image model returned an invalid result");
      }

      revisionCountRef.current += 1;
      const historyId = makeId("history");
      const thumbnail = await createImageThumbnail(finalBlob);
      await persistHistoryBlob(historyId, finalBlob);
      const finalImage = createManagedImageUrl(finalBlob);
      const historyItem: HistoryItem = {
        id: historyId,
        thumbnail,
        label: `Look ${String(revisionCountRef.current).padStart(2, "0")}`,
        createdAt: timestamp(),
      };
      replaceCurrentImage(finalImage);
      setCurrentHistoryId(historyId);
      setHistory((existing) => {
        const next = [...existing, historyItem];
        const removed = next.slice(0, Math.max(0, next.length - 9));
        for (const item of removed) discardHistoryBlob(item.id);
        return next.slice(-9);
      });
      setLayers([]);
      setSelectedLayerId(null);
      setGuideState({ hasMarks: false, canUndo: false, products: [] });
      setFashionState(emptyFashionGuideState());
      setTool(interactionMode === "fashion" ? "pencil" : "brush");
      canvasRef.current?.clearGuide();
      portraitGeneration.complete();
      completed = true;
      await holdForReveal();
      showToast(
        "success",
        "Your new look is ready",
        fashionLayers.length > 0
          ? "Now matching your finished drawing into reusable closet pieces."
          : "The original is untouched — hold Before to compare.",
      );
      if (fashionLayers.length > 0) {
        // Reveal the finished portrait immediately. Closet materialization is a
        // second, non-blocking-feeling step that uses this final render as the
        // visual authority and the raw maps only to locate each drawn piece.
        setGenerating(false);
        startFashionMaterialization({
          finalBlob,
          fashionGuides: fashionLayers,
          intent,
        });
      }
    } catch (error) {
      showToast(
        "error",
        "The atelier paused",
        error instanceof Error ? error.message : "Please try the generation again.",
      );
    } finally {
      if (!completed && progressStarted) portraitGeneration.cancel();
      setGenerating(false);
    }
  };

  const createAsset = async (prompt: string) => {
    if (prompt.trim().length < 3) {
      showToast(
        "info",
        "Describe your piece",
        "Enter at least 3 characters before creating.",
      );
      return;
    }
    if (assetApiConfigured === false) {
      showToast(
        "error",
        "Connect the image model",
        "Add a fresh OPENAI_API_KEY to .env.local and restart the studio.",
      );
      return;
    }

    replaceCreatedSourceImage(null);
    replaceArtifactExtractionSlots([]);
    setCreatedAssets([]);
    setCreatingAsset(true);
    assetGeneration.start("asset");
    let completed = false;
    try {
      const form = new FormData();
      form.append("mode", "asset");
      form.append("prompt", prompt);
      form.append("renderMode", renderMode);

      const response = await fetch("/api/image", { method: "POST", body: form });
      const data = (await response.json()) as {
        image?: string;
        category?: AssetCategory;
        error?: string;
        detail?: string;
      };
      if (!response.ok || !data.image) {
        throw new Error(data.detail || data.error || "The piece could not be created");
      }

      const category = data.category ?? "accessory";
      const asset: StudioAsset = {
        id: makeId("custom"),
        name: pieceNameFromPrompt(prompt),
        category,
        prompt,
        src: data.image,
        accent: categoryAccent[category],
        custom: true,
        createdAt: timestamp(),
      };
      replaceCreatedSourceImage(null);
      setCreatedAssets([asset]);
      assetGeneration.complete();
      completed = true;
      await holdForReveal();
      showToast(
        "success",
        "Your piece is ready",
        "Add it to your closet or place it on a portrait.",
      );
    } catch (error) {
      showToast(
        "error",
        "The piece was not created",
        error instanceof Error ? error.message : "Try a different description.",
      );
    } finally {
      if (!completed) assetGeneration.cancel();
      setCreatingAsset(false);
    }
  };

  const createAssetsFromImage = async (file: File) => {
    if (assetApiConfigured === false) {
      showToast(
        "error",
        "Connect the image model",
        "Add a fresh OPENAI_API_KEY to .env.local and restart the studio.",
      );
      return;
    }

    artifactExtractionAbortRef.current?.abort();
    const abortController = new AbortController();
    artifactExtractionAbortRef.current = abortController;
    setCreatingAsset(true);
    assetGeneration.start("asset-upload");
    let completed = false;
    let sourceStaged = false;
    let inventoryReceived = false;
    let streamCompleted = false;
    let completedCount = 0;
    let detectedCount = 0;
    let failedCount = 0;
    try {
      const prepared = await prepareArtifactUpload(file);
      replaceCreatedSourceImage(
        createManagedImageUrl(prepared.blob),
        prepared.name,
      );
      setCreatedAssets([]);
      replaceArtifactExtractionSlots([]);
      sourceStaged = true;

      const safeName =
        prepared.name.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80) ||
        "artifact-reference";
      const form = new FormData();
      form.append("mode", "artifactize");
      form.append("stream", "1");
      form.append(
        "source",
        new File([prepared.blob], `${safeName}.jpg`, { type: "image/jpeg" }),
      );

      const response = await fetch("/api/image", {
        method: "POST",
        body: form,
        headers: { Accept: "application/x-ndjson" },
        signal: abortController.signal,
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
          detail?: string;
        } | null;
        throw new Error(
          data?.detail || data?.error || "The image could not be turned into artifacts",
        );
      }

      const createdAt = timestamp();
      await readArtifactExtractionStream(response, (event) => {
        if (event.type === "started") return;

        if (event.type === "inventory") {
          const slots = event.items
            .filter(
              (item) =>
                typeof item.id === "string" &&
                typeof item.index === "number" &&
                typeof item.name === "string" &&
                typeof item.prompt === "string" &&
                isAssetCategory(item.category),
            )
            .map(
              (item) =>
                ({
                  ...item,
                  status: "extracting",
                }) satisfies ArtifactExtractionSlot,
            );
          if (slots.length === 0) {
            throw new Error("The image model did not identify any usable pieces");
          }
          inventoryReceived = true;
          detectedCount = event.detectedCount;
          replaceArtifactExtractionSlots(slots);
          return;
        }

        if (event.type === "artifact") {
          const asset = studioAssetFromArtifact(
            event.artifact,
            event.index,
            createdAt,
            "Digitized from an uploaded reference image",
          );
          if (!asset) {
            failedCount += 1;
            updateArtifactExtractionSlots((current) =>
              current.map((slot) =>
                slot.id === event.id
                  ? {
                      ...slot,
                      status: "error",
                      error: "The returned image could not be displayed.",
                    }
                  : slot,
              ),
            );
            return;
          }

          completedCount += 1;
          updateArtifactExtractionSlots((current) =>
            current.map((slot) =>
              slot.id === event.id
                ? { ...slot, status: "complete", asset, error: undefined }
                : slot,
            ),
          );
          setCreatedAssets((current) =>
            [...current, asset].sort(
              (left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0),
            ),
          );
          return;
        }

        if (event.type === "artifact-error") {
          failedCount += 1;
          updateArtifactExtractionSlots((current) =>
            current.map((slot) =>
              slot.id === event.id
                ? { ...slot, status: "error", error: event.detail }
                : slot,
            ),
          );
          return;
        }

        if (event.type === "complete") {
          streamCompleted = true;
          completedCount = event.completedCount;
          detectedCount = event.detectedCount;
          failedCount = event.failedCount;
          return;
        }

        throw new Error(event.detail || event.error);
      });
      if (!streamCompleted) {
        throw new Error("The extraction stream ended before it completed");
      }
      if (completedCount === 0) {
        throw new Error("The image model did not return any usable artifacts");
      }

      assetGeneration.complete();
      completed = true;
      const details = [
        failedCount > 0
          ? `Created ${completedCount} of ${detectedCount} detected products.`
          : completedCount > 1
            ? "Each detected product is ready as its own piece."
            : "Your new piece is ready.",
        "Choose what to add to your closet or place on a portrait.",
      ]
        .filter(Boolean)
        .join(" ");
      showToast(
        "success",
        `${completedCount} ${completedCount === 1 ? "piece" : "pieces"} ready`,
        details,
      );
    } catch (error) {
      abortController.abort();
      if (inventoryReceived) {
        const detail =
          error instanceof Error ? error.message : "The extraction was interrupted.";
        updateArtifactExtractionSlots((current) =>
          current.map((slot) =>
            slot.status === "extracting"
              ? { ...slot, status: "error", error: detail }
              : slot,
          ),
        );
      } else if (sourceStaged) {
        replaceArtifactExtractionSlots([]);
        replaceCreatedSourceImage(null);
      }
      showToast(
        "error",
        completedCount > 0 ? "Some pieces are ready" : "The image was not digitized",
        error instanceof Error ? error.message : "Try another product image.",
      );
    } finally {
      if (!completed) assetGeneration.cancel();
      if (artifactExtractionAbortRef.current === abortController) {
        artifactExtractionAbortRef.current = null;
      }
      setCreatingAsset(false);
    }
  };

  const removeCreatedAssetResult = (assetId: string) => {
    setCreatedAssets((current) =>
      current.filter((candidate) => candidate.id !== assetId),
    );
    const remainingSlots = artifactExtractionSlotsRef.current.filter(
      (slot) => slot.asset?.id !== assetId,
    );
    replaceArtifactExtractionSlots(remainingSlots);
    if (!creatingAsset && remainingSlots.length === 0) {
      replaceCreatedSourceImage(null);
    }
  };

  const addCreatedAssetToCloset = async (asset: StudioAsset) => {
    if (customAssets.some((candidate) => candidate.id === asset.id)) {
      removeCreatedAssetResult(asset.id);
      return;
    }

    try {
      await saveWardrobeAsset(asset);
      setCustomAssets((existing) => [asset, ...existing]);
      removeCreatedAssetResult(asset.id);
      showToast("success", "Added to your closet", asset.name);
    } catch {
      showToast(
        "error",
        "Could not add the piece",
        "Private browser storage did not respond.",
      );
    }
  };

  const addFashionArtifactToCloset = async (asset: StudioAsset) => {
    try {
      await saveWardrobeAsset(asset);
      setCustomAssets((existing) =>
        existing.some((candidate) => candidate.id === asset.id)
          ? existing
          : [asset, ...existing],
      );
      setFashionArtifactJobs((current) =>
        current.flatMap((job) => {
          const artifacts = job.artifacts.filter(
            (candidate) => candidate.id !== asset.id,
          );
          return job.status === "complete" && artifacts.length === 0
            ? []
            : [{ ...job, artifacts }];
        }),
      );
      showToast("success", "Added to your closet", asset.name);
    } catch {
      showToast(
        "error",
        "Could not add the piece",
        "Private browser storage did not respond.",
      );
    }
  };

  const dismissFashionArtifact = (asset: StudioAsset) => {
    setFashionArtifactJobs((current) =>
      current.flatMap((job) => {
        const artifacts = job.artifacts.filter(
          (candidate) => candidate.id !== asset.id,
        );
        return job.status === "complete" && artifacts.length === 0
          ? []
          : [{ ...job, artifacts }];
      }),
    );
  };

  const dismissFashionArtifactJob = (jobId: string) => {
    setFashionArtifactJobs((current) =>
      current.filter((job) => job.id !== jobId),
    );
  };

  const dismissCreatedAsset = (asset: StudioAsset) => {
    removeCreatedAssetResult(asset.id);
    setLayers((existing) =>
      existing.filter((layer) => layer.asset.id !== asset.id),
    );
  };

  const deleteCustomAsset = async (asset: StudioAsset) => {
    try {
      await removeWardrobeAsset(asset.id);
      setCustomAssets((existing) => existing.filter((candidate) => candidate.id !== asset.id));
      setLayers((existing) => existing.filter((layer) => layer.asset.id !== asset.id));
      setCreatedAssets((current) =>
        current.filter((candidate) => candidate.id !== asset.id),
      );
      updateArtifactExtractionSlots((current) =>
        current.filter((slot) => slot.asset?.id !== asset.id),
      );
      showToast("info", "Piece removed", `${asset.name} was removed from your atelier.`);
    } catch {
      showToast("error", "Could not remove the piece", "Private browser storage did not respond.");
    }
  };

  const selectHistoryItem = async (item: HistoryItem) => {
    if (item.id === currentHistoryId) return;
    const selection = ++historySelectionRef.current;
    let nextImage: string | null = null;

    if (item.id === originalHistoryIdRef.current) {
      nextImage = originalImageRef.current;
    } else {
      const blob = await readHistoryBlob(item.id);
      if (selection !== historySelectionRef.current) return;
      if (blob) nextImage = createManagedImageUrl(blob);
    }

    if (!nextImage) {
      showToast(
        "error",
        "That revision is unavailable",
        "The device could not reload the full-resolution image.",
      );
      return;
    }

    replaceCurrentImage(nextImage);
    setCurrentHistoryId(item.id);
    setLayers([]);
    setSelectedLayerId(null);
    setGuideState({ hasMarks: false, canUndo: false, products: [] });
    setFashionState(emptyFashionGuideState());
    setTool(interactionMode === "fashion" ? "pencil" : "brush");
    canvasRef.current?.clearGuide();
  };

  const downloadImage = async () => {
    if (!currentImage) {
      showToast("info", "Nothing to download yet", "Upload and style a portrait first.");
      return;
    }

    const filename = `${imageName.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "riya-look"}-riya`;
    try {
      const result = await saveImageToDevice(currentImage, filename);
      if (result === "shared") {
        showToast("success", "Photo saved or shared");
      } else if (result === "downloaded") {
        showToast("success", "Photo downloaded");
      }
    } catch (error) {
      showToast(
        "error",
        "The photo could not be downloaded",
        error instanceof Error ? error.message : "Please try again.",
      );
    }
  };

  return (
    <div className={styles.appShell}>
      {brandIntroState !== "hidden" && (
        <RayaLoadingScreen exiting={brandIntroState === "leaving"} />
      )}
      <main className={styles.studio}>
        <header className={styles.topbar} inert={generating ? true : undefined}>
          <button
            className={styles.headerBrand}
            onClick={() => changeTab("makeup")}
            aria-label="Raya Studio home"
          >
            <RayaLogo layout="horizontal" className={styles.headerBrandLogo} />
          </button>

          <div className={styles.topbarActions}>
            <button
              className={`${styles.historyButton} ${
                historyOpen ? styles.historyButtonActive : ""
              }`}
              onClick={() => setHistoryOpen((open) => !open)}
              aria-expanded={historyOpen}
              aria-label="Look history"
            >
              <Clock3 size={15} />
              <span>History</span>
              {history.length > 1 && (
                <i className={styles.historyButtonBadge}>{history.length}</i>
              )}
            </button>
            <button
              className={styles.beforeButton}
              disabled={!originalImage || originalImage === currentImage}
              onPointerDown={() => setShowOriginal(true)}
              onPointerUp={() => setShowOriginal(false)}
              onPointerLeave={() => setShowOriginal(false)}
              onPointerCancel={() => setShowOriginal(false)}
            >
              <Eye size={15} />
              Hold for before
            </button>
            <button className={styles.exportButton} onClick={() => void downloadImage()}>
              <ArrowDownToLine size={15} />
              <span>Download</span>
            </button>
          </div>
        </header>

        <div className={styles.workbench}>
          <section className={styles.canvasColumn}>
            {currentImage && (
              <div
                className={`${styles.canvasTools} ${
                  interactionMode === "fashion" ? styles.canvasToolsFashion : ""
                }`}
                inert={generating ? true : undefined}
              >
                {interactionMode === "fashion" ? (
                  <>
                    <button
                      className={
                        tool === "pencil" ? styles.canvasToolActive : styles.canvasTool
                      }
                      onClick={() => setTool("pencil")}
                      title="Draw a smooth fashion outline"
                    >
                      <PenLine size={16} />
                    </button>
                    <button
                      className={
                        tool === "fill" ? styles.canvasToolActive : styles.canvasTool
                      }
                      onClick={() => setTool("fill")}
                      title="Fill inside a shape"
                    >
                      <PaintBucket size={16} />
                    </button>
                    <button
                      className={
                        tool === "eraser" ? styles.canvasToolActive : styles.canvasTool
                      }
                      onClick={() => setTool("eraser")}
                      title="Erase part of the fashion sketch"
                    >
                      <Eraser size={16} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className={
                        tool === "brush" ? styles.canvasToolActive : styles.canvasTool
                      }
                      onClick={() => {
                        setTool("brush");
                        setTab("makeup");
                      }}
                      title="Paint makeup guide"
                    >
                      <Brush size={16} />
                    </button>
                    <button
                      className={
                        tool === "eraser" && interactionMode === "makeup"
                          ? styles.canvasToolActive
                          : styles.canvasTool
                      }
                      onClick={() => {
                        setTool("eraser");
                        setTab("makeup");
                      }}
                      title="Erase makeup guide"
                    >
                      <Eraser size={16} />
                    </button>
                  </>
                )}
                <span />
                <button
                  className={styles.canvasTool}
                  onClick={() => canvasRef.current?.undoGuide()}
                  disabled={
                    interactionMode === "fashion"
                      ? !fashionState.canUndo
                      : !guideState.canUndo
                  }
                  title="Undo last mark"
                >
                  <Undo2 size={16} />
                </button>
              </div>
            )}

            <CanvasStage
              ref={canvasRef}
              image={currentImage}
              originalImage={originalImage}
              imageName={imageName}
              interactionMode={interactionMode}
              tool={tool}
              brush={brush}
              fashion={fashion}
              layers={layers}
              selectedLayerId={selectedLayerId}
              showOriginal={showOriginal}
              generating={generating}
              generationProgress={portraitGeneration.progress}
              idleAnimationActive={brandIntroState === "hidden"}
              onUpload={handleUpload}
              onDropAsset={handleDropAsset}
              onSelectLayer={setSelectedLayerId}
              onUpdateLayer={updateLayer}
              onRemoveLayer={removeLayer}
              onGuideChange={setGuideState}
              onFashionGuideChange={handleFashionGuideChange}
              onBeforePaint={canPaintProduct}
              onBeforeFashionFill={canFillFashionRegion}
              onFashionFillResult={handleFashionFillResult}
            />

            {historyOpen && (
              <div
                className={styles.historyPanel}
                inert={generating ? true : undefined}
              >
                <div className={styles.historyHead}>
                  <div>
                    <span className={styles.eyebrow}>Revision history</span>
                    <strong>Your looks</strong>
                  </div>
                  <button onClick={() => setHistoryOpen(false)}>
                    <X size={15} />
                  </button>
                </div>
                {history.length === 0 ? (
                  <div className={styles.historyEmpty}>
                    <ImagePlus size={18} />
                    <p>Your original and every generated look will appear here.</p>
                  </div>
                ) : (
                  <div className={styles.historyGrid}>
                    {[...history].reverse().map((item) => (
                      <button
                        key={item.id}
                        className={
                          currentHistoryId === item.id
                            ? styles.historyItemActive
                            : styles.historyItem
                        }
                        onClick={() => void selectHistoryItem(item)}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={item.thumbnail} alt={item.label} />
                        <span>
                          <strong>{item.label}</strong>
                          <small>
                            {new Intl.DateTimeFormat(undefined, {
                              hour: "numeric",
                              minute: "2-digit",
                            }).format(item.createdAt)}
                          </small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div
              className={styles.promptDock}
              inert={generating ? true : undefined}
            >
              <div className={styles.renderModePanel}>
                <div
                  className={styles.renderModeOptions}
                  role="group"
                  aria-label="Generation mode"
                >
                  <button
                    type="button"
                    className={renderMode === "fast" ? styles.renderModeActive : styles.renderMode}
                    aria-pressed={renderMode === "fast"}
                    onClick={() => setRenderMode("fast")}
                    disabled={generating}
                  >
                    <Zap size={14} />
                    <strong>Fast</strong>
                    {renderMode === "fast" && <Check size={12} />}
                  </button>
                  <button
                    type="button"
                    className={renderMode === "max" ? styles.renderModeActive : styles.renderMode}
                    aria-pressed={renderMode === "max"}
                    onClick={() => setRenderMode("max")}
                    disabled={generating}
                  >
                    <Sparkles size={14} />
                    <strong>Quality</strong>
                    {renderMode === "max" && <Check size={12} />}
                  </button>
                </div>
              </div>
              <button
                className={styles.applyButton}
                onClick={applyEdits}
                disabled={
                  !currentImage ||
                  generating ||
                  !hasPendingEdits
                }
              >
                {generating ? (
                  "Creating…"
                ) : (
                  <>
                    <WandSparkles size={17} />
                    Imagine
                  </>
                )}
              </button>
            </div>
          </section>

          <Inspector
            tab={tab}
            onTabChange={changeTab}
            tool={tool}
            brush={brush}
            onBrushChange={(patch) => setBrush((current) => ({ ...current, ...patch }))}
            onToolChange={setTool}
            fashion={fashion}
            fashionState={fashionState}
            onFashionChange={updateFashionSettings}
            onSelectFashionRegion={(regionId) =>
              canvasRef.current?.selectFashionRegion(regionId)
            }
            assets={catalogAssets}
            customAssets={customAssets}
            onPlaceAsset={placeAsset}
            onDeleteCustomAsset={deleteCustomAsset}
            onCreateAsset={createAsset}
            onCreateAssetsFromImage={createAssetsFromImage}
            onAddCreatedAsset={addCreatedAssetToCloset}
            onDismissCreatedAsset={dismissCreatedAsset}
            creatingAsset={creatingAsset}
            assetProgress={assetGeneration.progress}
            createdAssets={createdAssets}
            artifactExtractionSlots={artifactExtractionSlots}
            createdSourceImage={createdSourceImage}
            createdSourceName={createdSourceName}
            fashionArtifactJobs={fashionArtifactJobs}
            onAddFashionArtifact={addFashionArtifactToCloset}
            onDismissFashionArtifact={dismissFashionArtifact}
            onDismissFashionArtifactJob={dismissFashionArtifactJob}
            apiConfigured={assetApiConfigured}
            hasPortrait={Boolean(currentImage)}
            disabled={generating}
          />
        </div>
      </main>

      {generating && (
        <div
          className={styles.generationInteractionLock}
          aria-hidden="true"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => event.preventDefault()}
        />
      )}

      {toast && (
        <div className={`${styles.toast} ${styles[`toast${toast.tone}`]}`} key={toast.id}>
          <span className={styles.toastIcon}>
            {toast.tone === "success" ? (
              <Sparkles size={16} />
            ) : toast.tone === "error" ? (
              <RotateCcw size={16} />
            ) : (
              <HelpCircle size={16} />
            )}
          </span>
          <div>
            <strong>{toast.title}</strong>
            {toast.detail && <p>{toast.detail}</p>}
          </div>
          <button onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
