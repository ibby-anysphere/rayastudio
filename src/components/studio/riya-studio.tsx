"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Brush,
  Check,
  Clock3,
  Eraser,
  Eye,
  FolderPlus,
  Gauge,
  Gem,
  HelpCircle,
  ImagePlus,
  Layers3,
  Minus,
  MousePointer2,
  Plus,
  RotateCcw,
  Sparkles,
  Undo2,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import {
  CanvasStage,
  type CanvasStageHandle,
  type MakeupGuideState,
} from "@/components/studio/canvas-stage";
import { Inspector } from "@/components/studio/inspector";
import { useEstimatedProgress } from "@/components/studio/use-estimated-progress";
import { catalogAssets } from "@/lib/studio-catalog";
import {
  assetSourceToPngFile,
  dataUrlToFile,
  downloadDataUrl,
  prepareUpload,
  recommendedAspectRatio,
} from "@/lib/image-utils";
import {
  MAX_INPUT_IMAGES,
  MAX_MAKEUP_LAYERS,
  MAX_WARDROBE_REFERENCES,
  type AssetCategory,
  type BrushSettings,
  type CanvasTool,
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

function holdForReveal(milliseconds = 620) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  const portraitGeneration = useEstimatedProgress();
  const assetGeneration = useEstimatedProgress();

  const [tab, setTab] = useState<StudioTab>("makeup");
  const [tool, setTool] = useState<CanvasTool>("select");
  const [brush, setBrush] = useState<BrushSettings>({
    product: "lipstick",
    color: "#c64f6a",
    size: 18,
    opacity: 0.68,
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
  const [showOriginal, setShowOriginal] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [customAssets, setCustomAssets] = useState<StudioAsset[]>([]);
  const [createdAsset, setCreatedAsset] = useState<StudioAsset | null>(null);
  const [generating, setGenerating] = useState(false);
  const [creatingAsset, setCreatingAsset] = useState(false);
  const [renderMode, setRenderMode] = useState<RenderMode>("fast");
  const [apiConfigured, setApiConfigured] = useState<boolean | null>(null);
  const [editApiConfigured, setEditApiConfigured] = useState<boolean | null>(null);
  const [assetApiConfigured, setAssetApiConfigured] = useState<boolean | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const allAssets = useMemo(
    () => [...customAssets, ...catalogAssets],
    [customAssets],
  );
  const hasGuide = guideState.hasMarks;
  const hasPendingEdits = hasGuide || layers.length > 0;

  // Mirror the server's per-request image budget. Every look sends the source
  // photo plus a contextual guide (present as soon as anything is added), one
  // image per painted makeup product, and one per unique wardrobe reference.
  // Duplicated artifacts reuse a single reference, so they never grow the count.
  const uniqueAssetCount = useMemo(
    () => new Set(layers.map((layer) => layer.asset.id)).size,
    [layers],
  );
  const makeupProductCount = guideState.products.length;

  // Slots for wardrobe references once the source photo, contextual guide, and
  // makeup layers are accounted for — capped by the dedicated reference ceiling.
  const referenceBudget = Math.max(
    0,
    Math.min(MAX_WARDROBE_REFERENCES, MAX_INPUT_IMAGES - 2 - makeupProductCount),
  );
  const canAddNewArtifact = uniqueAssetCount < referenceBudget;

  // A new makeup product adds one layer; block it only if the combined image
  // budget (or the makeup layer ceiling) would be exceeded.
  const canAddNewMakeupProduct =
    makeupProductCount < MAX_MAKEUP_LAYERS &&
    2 + (makeupProductCount + 1) + uniqueAssetCount <= MAX_INPUT_IMAGES;

  const showToast = (
    tone: ToastMessage["tone"],
    title: string,
    detail?: string,
  ) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ id: Date.now(), tone, title, detail });
    toastTimerRef.current = setTimeout(() => setToast(null), 5200);
  };

  useEffect(() => {
    fetch("/api/status", { cache: "no-store" })
      .then((response) => response.json())
      .then(
        (data: {
          configured?: boolean;
          editConfigured?: boolean;
          assetConfigured?: boolean;
        }) => {
          setApiConfigured(Boolean(data.configured));
          setEditApiConfigured(Boolean(data.editConfigured));
          setAssetApiConfigured(Boolean(data.assetConfigured));
        },
      )
      .catch(() => {
        setApiConfigured(false);
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
    };
  }, []);

  const resetProject = () => {
    setOriginalImage(null);
    setCurrentImage(null);
    setImageName("Untitled portrait");
    setLayers([]);
    setSelectedLayerId(null);
    setHistory([]);
    setGuideState({ hasMarks: false, canUndo: false, products: [] });
    setShowOriginal(false);
    setZoom(100);
    setTool("select");
    setHistoryOpen(false);
    canvasRef.current?.clearGuide();
  };

  const handleUpload = async (file: File) => {
    try {
      const prepared = await prepareUpload(file);
      setOriginalImage(prepared.dataUrl);
      setCurrentImage(prepared.dataUrl);
      setImageName(prepared.name);
      setLayers([]);
      setSelectedLayerId(null);
      setHistory([
        {
          id: makeId("history"),
          image: prepared.dataUrl,
          label: "Original",
          createdAt: Date.now(),
        },
      ]);
      setTool("select");
      setGuideState({ hasMarks: false, canUndo: false, products: [] });
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
    setTool("select");
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
      const guideMaxDimension = renderMode === "max" ? 2048 : 1024;
      const [contextualGuide, makeupGuides] = await Promise.all([
        canvasRef.current?.createContextualGuideBlob(guideMaxDimension),
        canvasRef.current?.createMakeupGuideLayers(guideMaxDimension),
      ]);
      const guideLayers = makeupGuides ?? [];
      const maxReferenceCount = Math.max(
        0,
        Math.min(
          MAX_WARDROBE_REFERENCES,
          MAX_INPUT_IMAGES -
            1 -
            Number(Boolean(contextualGuide)) -
            guideLayers.length,
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
          guideLayers.length +
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
      for (const guide of guideLayers) {
        form.append(
          "makeupLayers",
          new File([guide.blob], `makeup-${guide.product}.png`, {
            type: "image/png",
          }),
        );
      }
      let nextReferenceIndex =
        2 + Number(Boolean(contextualGuide)) + guideLayers.length;
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
        makeupLayers: guideLayers.map((guide) => ({
          product: guide.product,
          colors: guide.colors,
        })),
        placedAssets: intentLayers,
      };
      form.append("intent", JSON.stringify(intent));

      const response = await fetch("/api/image", {
        method: "POST",
        body: form,
      });
      const data = (await response.json()) as {
        image?: string;
        error?: string;
        detail?: string;
      };

      if (!response.ok || !data.image) {
        throw new Error(data.detail || data.error || "The image could not be generated");
      }
      const finalImage = data.image;

      const revisionNumber = history.filter((item) => item.label !== "Original").length + 1;
      const historyItem: HistoryItem = {
        id: makeId("history"),
        image: finalImage,
        label: `Look ${String(revisionNumber).padStart(2, "0")}`,
        createdAt: Date.now(),
      };
      setCurrentImage(finalImage);
      setHistory((existing) => [...existing, historyItem].slice(-9));
      setLayers([]);
      setSelectedLayerId(null);
      setGuideState({ hasMarks: false, canUndo: false, products: [] });
      setTool("select");
      canvasRef.current?.clearGuide();
      portraitGeneration.complete();
      completed = true;
      await holdForReveal();
      showToast(
        "success",
        "Your new look is ready",
        "The original is untouched — hold Before to compare.",
      );
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

  const createAsset = async (prompt: string, category: AssetCategory) => {
    if (assetApiConfigured === false) {
      showToast(
        "error",
        "Connect the image model",
        "Add a fresh OPENAI_API_KEY to .env.local and restart the studio.",
      );
      return;
    }

    setCreatingAsset(true);
    assetGeneration.start("asset");
    let completed = false;
    try {
      const form = new FormData();
      form.append("mode", "asset");
      form.append("prompt", prompt);
      form.append("category", category);
      form.append("renderMode", renderMode);

      const response = await fetch("/api/image", { method: "POST", body: form });
      const data = (await response.json()) as {
        image?: string;
        error?: string;
        detail?: string;
      };
      if (!response.ok || !data.image) {
        throw new Error(data.detail || data.error || "The piece could not be created");
      }

      const asset: StudioAsset = {
        id: makeId("custom"),
        name: pieceNameFromPrompt(prompt),
        category,
        prompt,
        src: data.image,
        accent: categoryAccent[category],
        custom: true,
        createdAt: Date.now(),
      };
      await saveWardrobeAsset(asset);
      setCustomAssets((existing) => [asset, ...existing]);
      setCreatedAsset(asset);
      assetGeneration.complete();
      completed = true;
      await holdForReveal();
      showToast("success", "Saved to your atelier", "This piece will be here when you return.");
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

  const deleteCustomAsset = async (asset: StudioAsset) => {
    try {
      await removeWardrobeAsset(asset.id);
      setCustomAssets((existing) => existing.filter((candidate) => candidate.id !== asset.id));
      setLayers((existing) => existing.filter((layer) => layer.asset.id !== asset.id));
      setCreatedAsset((current) => (current?.id === asset.id ? null : current));
      showToast("info", "Piece removed", `${asset.name} was removed from your atelier.`);
    } catch {
      showToast("error", "Could not remove the piece", "Private browser storage did not respond.");
    }
  };

  const selectHistoryItem = (item: HistoryItem) => {
    setCurrentImage(item.image);
    setLayers([]);
    setSelectedLayerId(null);
    setGuideState({ hasMarks: false, canUndo: false, products: [] });
    setTool("select");
    canvasRef.current?.clearGuide();
  };

  const exportImage = () => {
    if (!currentImage) {
      showToast("info", "Nothing to export yet", "Upload and style a portrait first.");
      return;
    }
    const extension = currentImage.startsWith("data:image/jpeg") ? "jpg" : "png";
    const filename = `${imageName.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "riya-look"}-riya.${extension}`;
    downloadDataUrl(currentImage, filename);
    showToast("success", "High-resolution look exported");
  };

  return (
    <div className={styles.appShell}>
      <nav className={styles.rail} aria-label="Studio navigation">
        <button className={styles.wordmark} onClick={() => setTab("makeup")} aria-label="RIYA home">
          <span>R</span>
        </button>
        <div className={styles.railPrimary}>
          <button
            className={styles.railAction}
            onClick={resetProject}
            data-tooltip="New canvas"
          >
            <FolderPlus size={19} />
          </button>
          <span className={styles.railDivider} />
          <button
            className={`${styles.railAction} ${tab === "wardrobe" ? styles.railActionActive : ""}`}
            onClick={() => setTab("wardrobe")}
            data-tooltip="Wardrobe"
          >
            <Gem size={19} />
          </button>
          <button
            className={`${styles.railAction} ${historyOpen ? styles.railActionActive : ""}`}
            onClick={() => setHistoryOpen((open) => !open)}
            data-tooltip="Look history"
          >
            <Clock3 size={19} />
            {history.length > 1 && <i>{history.length}</i>}
          </button>
        </div>
        <div className={styles.railBottom}>
          <button className={styles.railAction} data-tooltip="Studio tips">
            <HelpCircle size={18} />
          </button>
          <button className={styles.avatar} aria-label="Your profile">
            IB
          </button>
        </div>
      </nav>

      <main className={styles.studio}>
        <header className={styles.topbar}>
          <div className={styles.projectIdentity}>
            <div className={styles.projectIcon}>
              <Layers3 size={16} />
            </div>
            <div>
              <span>RIYA / PRIVATE ATELIER</span>
              <strong>{currentImage ? imageName : "New styling session"}</strong>
            </div>
          </div>

          <div className={styles.topbarCenter}>
            <span className={styles.saveState}>
              <i />
              Saved locally
            </span>
            <span
              className={`${styles.apiState} ${
                apiConfigured ? styles.apiStateReady : styles.apiStateMissing
              }`}
              title={
                apiConfigured
                  ? "Gemini editing and OpenAI artifact models are connected"
                  : "Add GEMINI_API_KEY and OPENAI_API_KEY to .env.local"
              }
            >
              <i />
              {apiConfigured === null
                ? "Checking model"
                : apiConfigured
                  ? "Image model ready"
                  : "Model not connected"}
            </span>
          </div>

          <div className={styles.topbarActions}>
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
            <button className={styles.exportButton} onClick={exportImage}>
              <ArrowDownToLine size={15} />
              Export
            </button>
          </div>
        </header>

        <div className={styles.workbench}>
          <section className={styles.canvasColumn}>
            <div className={styles.canvasTools}>
              <button
                className={tool === "select" ? styles.canvasToolActive : styles.canvasTool}
                onClick={() => setTool("select")}
                title="Select and move pieces"
              >
                <MousePointer2 size={16} />
              </button>
              <button
                className={tool === "brush" ? styles.canvasToolActive : styles.canvasTool}
                onClick={() => {
                  setTool("brush");
                  setTab("makeup");
                }}
                title="Paint makeup guide"
              >
                <Brush size={16} />
              </button>
              <button
                className={tool === "eraser" ? styles.canvasToolActive : styles.canvasTool}
                onClick={() => {
                  setTool("eraser");
                  setTab("makeup");
                }}
                title="Erase makeup guide"
              >
                <Eraser size={16} />
              </button>
              <span />
              <button
                className={styles.canvasTool}
                onClick={() => canvasRef.current?.undoGuide()}
                disabled={!guideState.canUndo}
                title="Undo brush stroke"
              >
                <Undo2 size={16} />
              </button>
            </div>

            <CanvasStage
              ref={canvasRef}
              image={currentImage}
              originalImage={originalImage}
              imageName={imageName}
              tool={tool}
              brush={brush}
              layers={layers}
              selectedLayerId={selectedLayerId}
              showOriginal={showOriginal}
              zoom={zoom}
              generating={generating}
              generationProgress={portraitGeneration.progress}
              onUpload={handleUpload}
              onDropAsset={handleDropAsset}
              onSelectLayer={setSelectedLayerId}
              onUpdateLayer={updateLayer}
              onRemoveLayer={removeLayer}
              onGuideChange={setGuideState}
              onBeforePaint={canPaintProduct}
            />

            {currentImage && (
              <div className={styles.zoomControls}>
                <button
                  onClick={() => setZoom((value) => Math.max(70, value - 10))}
                  disabled={zoom <= 70}
                >
                  <Minus size={13} />
                </button>
                <button className={styles.zoomValue} onClick={() => setZoom(100)}>
                  {zoom}%
                </button>
                <button
                  onClick={() => setZoom((value) => Math.min(140, value + 10))}
                  disabled={zoom >= 140}
                >
                  <Plus size={13} />
                </button>
              </div>
            )}

            {historyOpen && (
              <div className={styles.historyPanel}>
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
                        className={currentImage === item.image ? styles.historyItemActive : styles.historyItem}
                        onClick={() => selectHistoryItem(item)}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={item.image} alt={item.label} />
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

            <div className={styles.promptDock}>
              <div className={styles.renderModePanel}>
                <div className={styles.renderModeHeading}>
                  <div>
                    <span>Image model</span>
                    <small>Choose speed or maximum generation quality</small>
                  </div>
                  <Gauge size={16} />
                </div>
                <div
                  className={styles.renderModeOptions}
                  role="group"
                  aria-label="Image model"
                >
                  <button
                    type="button"
                    className={renderMode === "fast" ? styles.renderModeActive : styles.renderMode}
                    aria-pressed={renderMode === "fast"}
                    onClick={() => setRenderMode("fast")}
                  >
                    <Zap size={14} />
                    <span>
                      <strong>Fast</strong>
                      <small>Nano Banana Lite · 1K</small>
                    </span>
                    {renderMode === "fast" && <Check size={12} />}
                  </button>
                  <button
                    type="button"
                    className={renderMode === "max" ? styles.renderModeActive : styles.renderMode}
                    aria-pressed={renderMode === "max"}
                    onClick={() => setRenderMode("max")}
                  >
                    <Sparkles size={14} />
                    <span>
                      <strong>Pro</strong>
                      <small>Nano Banana Pro · 2K</small>
                    </span>
                    {renderMode === "max" && <Check size={12} />}
                  </button>
                </div>
              </div>
              <button
                className={styles.applyButton}
                onClick={applyEdits}
                disabled={!currentImage || generating || !hasPendingEdits}
              >
                {generating ? (
                  "Creating…"
                ) : (
                  <>
                    <WandSparkles size={17} />
                    Apply edits
                  </>
                )}
              </button>
            </div>
          </section>

          <Inspector
            tab={tab}
            onTabChange={setTab}
            brush={brush}
            onBrushChange={(patch) => setBrush((current) => ({ ...current, ...patch }))}
            tool={tool}
            onToolChange={setTool}
            hasGuide={hasGuide}
            canUndoGuide={guideState.canUndo}
            guideProducts={guideState.products}
            onUndoGuide={() => canvasRef.current?.undoGuide()}
            onClearGuide={() => canvasRef.current?.clearGuide()}
            assets={catalogAssets}
            customAssets={customAssets}
            onPlaceAsset={placeAsset}
            onDeleteCustomAsset={deleteCustomAsset}
            onCreateAsset={createAsset}
            creatingAsset={creatingAsset}
            assetProgress={assetGeneration.progress}
            createdAsset={createdAsset}
            apiConfigured={assetApiConfigured}
            hasPortrait={Boolean(currentImage)}
          />
        </div>
      </main>

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
