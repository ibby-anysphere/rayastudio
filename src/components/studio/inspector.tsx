"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  Check,
  ChevronRight,
  Gem,
  Maximize2,
  Minimize2,
  Palette,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import type { EstimatedProgress } from "@/components/studio/use-estimated-progress";
import {
  fashionColorHex,
  fashionColorPreview,
  fashionColors,
  fashionMaterial,
  fashionMaterials,
  fashionPattern,
  fashionPatterns,
} from "@/lib/fashion-catalog";
import { makeupProducts } from "@/lib/studio-catalog";
import type {
  ArtifactExtractionSlot,
  AssetCategory,
  BrushSettings,
  CanvasTool,
  FashionArtifactJob,
  FashionGuideState,
  FashionSettings,
  MakeupProduct,
  MakeupProductId,
  StudioAsset,
  StudioTab,
} from "@/lib/studio-types";
import styles from "./studio.module.css";

interface InspectorProps {
  tab: StudioTab;
  onTabChange: (tab: StudioTab) => void;
  tool: CanvasTool;
  brush: BrushSettings;
  onBrushChange: (patch: Partial<BrushSettings>) => void;
  onToolChange: (tool: CanvasTool) => void;
  fashion: FashionSettings;
  fashionState: FashionGuideState;
  onFashionChange: (patch: Partial<FashionSettings>) => void;
  onSelectFashionRegion: (regionId: string) => void;
  assets: StudioAsset[];
  customAssets: StudioAsset[];
  onPlaceAsset: (asset: StudioAsset) => void;
  onDeleteCustomAsset: (asset: StudioAsset) => void;
  onCreateAsset: (prompt: string) => void;
  onCreateAssetsFromImage: (file: File) => void;
  onAddCreatedAsset: (asset: StudioAsset) => void;
  onDismissCreatedAsset: (asset: StudioAsset) => void;
  creatingAsset: boolean;
  assetProgress: EstimatedProgress;
  createdAssets: StudioAsset[];
  artifactExtractionSlots: ArtifactExtractionSlot[];
  createdSourceImage: string | null;
  createdSourceName: string;
  fashionArtifactJobs: FashionArtifactJob[];
  onAddFashionArtifact: (asset: StudioAsset) => void;
  onDismissFashionArtifact: (asset: StudioAsset) => void;
  onDismissFashionArtifactJob: (jobId: string) => void;
  apiConfigured: boolean | null;
  hasPortrait: boolean;
  disabled: boolean;
}

const tabItems: Array<{ id: StudioTab; label: string; icon: typeof Palette }> = [
  { id: "makeup", label: "Beauty", icon: Palette },
  { id: "create", label: "Create", icon: WandSparkles },
  { id: "wardrobe", label: "Closet", icon: Gem },
];

const categoryItems: Array<{ id: "all" | AssetCategory; label: string }> = [
  { id: "all", label: "All" },
  { id: "jewelry", label: "Jewelry" },
  { id: "eyewear", label: "Eyewear" },
  { id: "hair", label: "Hair" },
  { id: "garment", label: "Garments" },
  { id: "accessory", label: "Extras" },
];

function hexHue(color: string) {
  const value = color.replace("#", "");
  const red = Number.parseInt(value.slice(0, 2), 16) / 255;
  const green = Number.parseInt(value.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  if (max === min) return 0;

  const delta = max - min;
  const channel =
    max === red
      ? ((green - blue) / delta) % 6
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  return Math.round((channel * 60 + 360) % 360);
}

function productArtStyle(product: MakeupProduct, color: string): CSSProperties {
  const hueRotation = hexHue(color) - product.baseHue;
  return {
    filter: `hue-rotate(${hueRotation}deg) saturate(1.08) drop-shadow(0 8px 10px ${color}24)`,
  };
}

function AssetCard({
  asset,
  onPlace,
  onDelete,
  disabled,
}: {
  asset: StudioAsset;
  onPlace: () => void;
  onDelete?: () => void;
  disabled: boolean;
}) {
  const startDrag = (event: DragEvent<HTMLDivElement>) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData("application/riya-asset", asset.id);
    event.dataTransfer.effectAllowed = "copy";
  };

  const handleKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onPlace();
    }
  };

  return (
    <div
      className={styles.assetCard}
      role="button"
      tabIndex={disabled ? -1 : 0}
      draggable={!disabled}
      aria-disabled={disabled}
      aria-label={`Place ${asset.name}`}
      onDragStart={startDrag}
      onClick={disabled ? undefined : onPlace}
      onKeyDown={handleKeyboard}
    >
      <div
        className={styles.assetThumb}
        style={{ background: `linear-gradient(145deg, ${asset.accent}24, ${asset.accent}08)` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={asset.src} alt="" draggable={false} />
        {asset.custom && <span className={styles.customBadge}>Yours</span>}
      </div>
      <div className={styles.assetCardCopy}>
        <strong>{asset.name}</strong>
        <span>{asset.category}</span>
      </div>
      <span className={styles.assetAdd}>
        <Plus size={13} />
      </span>
      {onDelete && (
        <button
          type="button"
          className={styles.assetDelete}
          aria-label={`Delete ${asset.name}`}
          title={`Delete ${asset.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}

export function Inspector({
  tab,
  onTabChange,
  tool,
  brush,
  onBrushChange,
  onToolChange,
  fashion,
  fashionState,
  onFashionChange,
  onSelectFashionRegion,
  assets,
  customAssets,
  onPlaceAsset,
  onDeleteCustomAsset,
  onCreateAsset,
  onCreateAssetsFromImage,
  onAddCreatedAsset,
  onDismissCreatedAsset,
  creatingAsset,
  assetProgress,
  createdAssets,
  artifactExtractionSlots,
  createdSourceImage,
  createdSourceName,
  fashionArtifactJobs,
  onAddFashionArtifact,
  onDismissFashionArtifact,
  onDismissFashionArtifactJob,
  apiConfigured,
  hasPortrait,
  disabled,
}: InspectorProps) {
  const [category, setCategory] = useState<"all" | AssetCategory>("all");
  const [query, setQuery] = useState("");
  const [createPrompt, setCreatePrompt] = useState("");
  const [artifactUploadDragging, setArtifactUploadDragging] = useState(false);
  const [expandedCreation, setExpandedCreation] = useState<
    | { kind: "source"; src: string; name: string }
    | { kind: "asset"; asset: StudioAsset }
    | { kind: "fashion"; asset: StudioAsset }
    | null
  >(null);
  const artifactUploadRef = useRef<HTMLInputElement>(null);
  const autoPreviewedFashionJobsRef = useRef(new Set<string>());
  const [productMemory, setProductMemory] = useState(
    () =>
      Object.fromEntries(
        makeupProducts.map((product) => [
          product.id,
          { color: product.shades[0].color, size: product.defaultSize },
        ]),
      ) as Record<MakeupProductId, Pick<BrushSettings, "color" | "size">>,
  );

  useEffect(() => {
    if (!expandedCreation) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setExpandedCreation(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [expandedCreation]);

  useEffect(() => {
    const completed = fashionArtifactJobs.find(
      (job) =>
        job.status === "complete" &&
        job.artifacts.length > 0 &&
        !autoPreviewedFashionJobsRef.current.has(job.id),
    );
    if (completed) {
      autoPreviewedFashionJobsRef.current.add(completed.id);
      setExpandedCreation({
        kind: "fashion",
        asset: completed.artifacts[0],
      });
    }
  }, [fashionArtifactJobs]);

  const selectedProduct =
    makeupProducts.find((product) => product.id === brush.product) ?? makeupProducts[0];
  const selectedShade =
    selectedProduct.shades.find((shade) => shade.color === brush.color) ??
    selectedProduct.shades[0];
  const makeupSizeOptions = [
    { label: "Small", size: selectedProduct.minSize, previewSize: 14 },
    { label: "Medium", size: selectedProduct.defaultSize, previewSize: 21 },
    { label: "Large", size: selectedProduct.maxSize, previewSize: 28 },
  ];
  const selectedMakeupSize = makeupSizeOptions.reduce((closest, option) =>
    Math.abs(option.size - brush.size) < Math.abs(closest.size - brush.size)
      ? option
      : closest,
  );

  const selectMakeupProduct = (product: MakeupProduct) => {
    const remembered = productMemory[product.id];
    onToolChange("brush");
    onBrushChange({
      product: product.id,
      color: remembered.color,
      size: remembered.size,
      opacity: product.opacity,
    });
  };

  const updateMakeupBrush = (patch: Partial<Pick<BrushSettings, "color" | "size">>) => {
    setProductMemory((current) => ({
      ...current,
      [brush.product]: {
        ...current[brush.product],
        ...patch,
      },
    }));
    onToolChange("brush");
    onBrushChange(patch);
  };

  const updateFashion = (patch: Partial<FashionSettings>) => {
    onFashionChange(patch);
    if (tool === "fill" || tool === "pencil") return;
    onToolChange("pencil");
  };

  const visibleAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return [...customAssets, ...assets].filter((asset) => {
      const categoryMatches = category === "all" || asset.category === category;
      const queryMatches =
        !normalized ||
        asset.name.toLowerCase().includes(normalized) ||
        asset.prompt.toLowerCase().includes(normalized);
      return categoryMatches && queryMatches;
    });
  }, [assets, category, customAssets, query]);
  const readyExtractionCount = artifactExtractionSlots.filter(
    (slot) => slot.status === "complete",
  ).length;

  const digitizeImage = (file: File | undefined) => {
    if (!file || creatingAsset || apiConfigured === false) return;
    onCreateAssetsFromImage(file);
  };

  const renderCreatedAssetCard = (
    createdAsset: StudioAsset,
    compact = false,
  ) => (
    <div
      className={`${styles.createdPiece} ${
        compact ? styles.createdPieceCompact : ""
      }`}
      key={createdAsset.id}
    >
      <button
        type="button"
        className={styles.createdPieceDismiss}
        aria-label={`Discard ${createdAsset.name}`}
        title="Discard piece"
        onClick={() => onDismissCreatedAsset(createdAsset)}
      >
        <X size={12} />
      </button>
      <button
        type="button"
        className={styles.createdPieceArt}
        aria-label={`Preview ${createdAsset.name}`}
        onClick={() =>
          setExpandedCreation({ kind: "asset", asset: createdAsset })
        }
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={createdAsset.src} alt="" />
        <span>
          <Check size={12} /> Ready
        </span>
        <i className={styles.createdPieceExpand}>
          <Maximize2 size={11} />
        </i>
      </button>
      <div>
        <span className={styles.createdPieceCategory}>
          {createdAsset.category}
        </span>
        <strong>{createdAsset.name}</strong>
        <div className={styles.createdPieceActions}>
          <button
            type="button"
            className={styles.createdPieceAdd}
            onClick={() => onAddCreatedAsset(createdAsset)}
          >
            <Plus size={12} /> Add to closet
          </button>
          <button type="button" onClick={() => onPlaceAsset(createdAsset)}>
            Place on portrait <ChevronRight size={13} />
          </button>
        </div>
      </div>
    </div>
  );

  const renderExtractionSlot = (slot: ArtifactExtractionSlot) => {
    if (slot.status === "complete" && slot.asset) {
      return renderCreatedAssetCard(
        slot.asset,
        artifactExtractionSlots.length >= 4,
      );
    }

    const failed = slot.status === "error";
    return (
      <div
        className={`${styles.assetGenerationCard} ${
          failed ? styles.assetGenerationCardError : ""
        }`}
        key={slot.id}
      >
        <div className={styles.assetGenerationPreview} aria-hidden="true">
          {failed ? (
            <X size={21} />
          ) : (
            <>
              <span className={styles.assetGenerationGlow} />
              <WandSparkles size={22} />
              <i />
              <i />
              <i />
            </>
          )}
        </div>
        <div className={styles.assetGenerationBody}>
          <div className={styles.assetGenerationHead}>
            <span>{slot.category}</span>
            <small>{failed ? "Paused" : "Extracting"}</small>
          </div>
          <strong>{slot.name}</strong>
          {failed ? (
            <p className={styles.assetGenerationError}>
              {slot.error || "This piece could not be isolated."}
            </p>
          ) : (
            <>
              <div
                className={`${styles.assetGenerationTrack} ${styles.artifactExtractionTrack}`}
                role="progressbar"
                aria-label={`Extracting ${slot.name}`}
              >
                <span />
              </div>
              <div className={styles.assetGenerationMeta}>
                <b>Working</b>
                <span>Appears here when ready</span>
              </div>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <aside
      className={`${styles.inspector} ${disabled ? styles.inspectorDisabled : ""}`}
      inert={disabled ? true : undefined}
    >
      <div className={styles.inspectorTabs} role="tablist" aria-label="Styling controls">
        {tabItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={tab === item.id ? styles.inspectorTabActive : styles.inspectorTab}
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => onTabChange(item.id)}
            >
              <Icon size={15} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      <div className={styles.inspectorScroll}>
        {tab === "makeup" && (
          <div className={`${styles.panelStack} ${styles.beautyPanel}`}>
            <div
              className={styles.makeupShelf}
              role="radiogroup"
              aria-label="Makeup product"
            >
              {makeupProducts.map((product) => {
                const selected = brush.product === product.id;
                const previewColor = selected
                  ? brush.color
                  : productMemory[product.id].color;
                return (
                  <button
                    type="button"
                    key={product.id}
                    role="radio"
                    aria-checked={selected}
                    className={`${styles.makeupProduct} ${
                      selected ? styles.makeupProductActive : ""
                    }`}
                    onClick={() => selectMakeupProduct(product)}
                  >
                    <span
                      className={styles.makeupProductArt}
                      style={{
                        background: `radial-gradient(circle at 50% 55%, ${previewColor}20, transparent 68%)`,
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        className={styles.makeupProductImage}
                        src={product.src}
                        alt=""
                        draggable={false}
                        style={productArtStyle(product, previewColor)}
                      />
                      {selected && (
                        <i className={styles.makeupProductCheck}>
                          <Check size={9} strokeWidth={3} />
                        </i>
                      )}
                    </span>
                    <span className={styles.makeupProductCopy}>
                      <strong>{product.shortName}</strong>
                    </span>
                  </button>
                );
              })}
            </div>

            <section className={styles.makeupWorkbench} aria-label={selectedProduct.name}>
              <div className={styles.makeupSelection}>
                <div
                  className={styles.makeupHero}
                  style={{
                    background: `radial-gradient(circle at 50% 58%, ${brush.color}25, ${brush.color}08 48%, transparent 72%)`,
                  }}
                >
                  <span
                    className={styles.makeupHeroGlow}
                    style={{ background: brush.color }}
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className={styles.makeupHeroImage}
                    src={selectedProduct.src}
                    alt={selectedProduct.name}
                    draggable={false}
                    style={productArtStyle(selectedProduct, brush.color)}
                  />
                </div>
                <div className={styles.makeupSelectionCopy}>
                  <span>{selectedProduct.name}</span>
                  <strong>{selectedShade.name}</strong>
                </div>
              </div>

              <div className={styles.shadePanel}>
                <div className={styles.shadePanelHead}>
                  <span>Choose a shade</span>
                </div>
                <div
                  className={styles.shadePalette}
                  role="radiogroup"
                  aria-label={`${selectedProduct.name} shade`}
                >
                  {selectedProduct.shades.map((shade) => {
                    const selected = brush.color === shade.color;
                    return (
                      <button
                        type="button"
                        key={shade.color}
                        role="radio"
                        aria-checked={selected}
                        aria-label={shade.name}
                        title={shade.name}
                        className={`${styles.makeupShade} ${
                          selected ? styles.makeupShadeActive : ""
                        }`}
                        style={{ background: shade.color }}
                        onClick={() => updateMakeupBrush({ color: shade.color })}
                      >
                        {selected && <Check size={13} strokeWidth={2.7} />}
                      </button>
                    );
                  })}
                </div>
              </div>

            </section>

            <section className={styles.fashionControlSection}>
              <div className={styles.fashionControlHead}>
                <span>Brush size</span>
              </div>
              <div
                className={styles.fashionPenSizes}
                role="radiogroup"
                aria-label={`${selectedProduct.name} brush size`}
              >
                {makeupSizeOptions.map((option) => {
                  const selected = selectedMakeupSize.size === option.size;
                  return (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={`${option.label} ${selectedProduct.shortName} brush, ${option.size} pixels`}
                      className={
                        selected
                          ? styles.fashionPenSizeActive
                          : styles.fashionPenSize
                      }
                      key={option.label}
                      onClick={() => updateMakeupBrush({ size: option.size })}
                    >
                      <i
                        style={{
                          width: `${option.previewSize}px`,
                          height: `${option.previewSize}px`,
                          background: brush.color,
                          opacity: Math.max(0.58, selectedProduct.opacity),
                        }}
                      />
                      <span>{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          </div>
        )}

        {(tab === "wardrobe" || tab === "create") && (
          <div className={`${styles.panelStack} ${styles.closetPanel}`}>
            {tab === "wardrobe" ? (
              <>
                <p
                  className={`${styles.createMethodDescription} ${styles.studioSectionHeading}`}
                >
                  Turn any image into new pieces for your closet
                </p>

                <input
                  ref={artifactUploadRef}
                  className={styles.visuallyHidden}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  aria-label="Choose an image to turn into artifacts"
                  disabled={creatingAsset || apiConfigured === false}
                  onChange={(event) => {
                    digitizeImage(event.currentTarget.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
                <button
                  type="button"
                  className={`${styles.artifactUpload} ${
                    artifactUploadDragging ? styles.artifactUploadDragging : ""
                  }`}
                  disabled={creatingAsset || apiConfigured === false}
                  onClick={() => artifactUploadRef.current?.click()}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setArtifactUploadDragging(true);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                  }}
                  onDragLeave={(event) => {
                    if (
                      !event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                      )
                    ) {
                      setArtifactUploadDragging(false);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setArtifactUploadDragging(false);
                    digitizeImage(event.dataTransfer.files?.[0]);
                  }}
                >
                  <span className={styles.artifactUploadIcon}>
                    <Upload size={18} />
                  </span>
                  <span className={styles.artifactUploadCopy}>
                    <strong>Upload an image</strong>
                  </span>
                  <ChevronRight
                    className={styles.artifactUploadArrow}
                    size={16}
                  />
                </button>

                {createdSourceImage &&
                (creatingAsset || artifactExtractionSlots.length > 0) ? (
                  <section
                    className={`${styles.extractionSet} ${
                      creatingAsset ? styles.extractionSetLoading : ""
                    }`}
                    role="status"
                    aria-live="polite"
                  >
                    <header className={styles.extractionSetHeader}>
                      <span>
                        <Sparkles size={12} />
                        {artifactExtractionSlots.length === 0
                          ? "Finding distinct pieces"
                          : creatingAsset
                            ? "Creating from your image"
                            : "Created from your image"}
                      </span>
                      <b>
                        {artifactExtractionSlots.length === 0
                          ? `${assetProgress.percent}%`
                          : `${readyExtractionCount} of ${artifactExtractionSlots.length} ready`}
                      </b>
                    </header>
                    <div className={styles.extractionFlow}>
                      <button
                        type="button"
                        className={styles.extractionSource}
                        aria-label={
                          createdSourceName
                            ? `Preview original image ${createdSourceName}`
                            : "Preview original image"
                        }
                        onClick={() =>
                          setExpandedCreation({
                            kind: "source",
                            src: createdSourceImage,
                            name: createdSourceName || "Original image",
                          })
                        }
                      >
                        <span className={styles.extractionSourceImage}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={createdSourceImage} alt="" />
                          <i>
                            <Maximize2 size={11} />
                          </i>
                        </span>
                        <small>Original</small>
                      </button>
                      <div
                        className={styles.extractionBranch}
                        aria-hidden="true"
                      >
                        <i />
                        <Sparkles size={11} />
                        <i />
                      </div>
                      {artifactExtractionSlots.length === 0 ? (
                        <div className={styles.extractionLoading}>
                          <span
                            className={styles.generationSimpleIcon}
                            aria-hidden="true"
                          >
                            <WandSparkles size={16} />
                          </span>
                          <strong className={styles.extractionLoadingPercent}>
                            {assetProgress.percent}%
                          </strong>
                          <div
                            className={styles.generationSimpleTrack}
                            role="progressbar"
                            aria-label="Estimated image analysis progress"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={assetProgress.percent}
                          >
                            <span
                              style={{ width: `${assetProgress.percent}%` }}
                            />
                          </div>
                        </div>
                      ) : (
                        <div className={styles.extractionArtifacts}>
                          {artifactExtractionSlots.map(renderExtractionSlot)}
                        </div>
                      )}
                    </div>
                  </section>
                ) : null}

                {apiConfigured === false && (
                  <div className={styles.apiNotice}>
                    <span>API key needed</span>
                    Add a fresh <code>OPENAI_API_KEY</code> to{" "}
                    <code>.env.local</code>, then restart.
                  </div>
                )}

                <label className={styles.searchField}>
                  <Search size={15} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search the closet"
                  />
                </label>

                <div className={styles.categoryScroller}>
                  {categoryItems.map((item) => (
                    <button
                      key={item.id}
                      className={
                        category === item.id ? styles.categoryActive : styles.category
                      }
                      onClick={() => setCategory(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                  <span
                    className={`${styles.itemCount} ${styles.categoryItemCount}`}
                    aria-label={`${visibleAssets.length} visible pieces`}
                  >
                    {visibleAssets.length}
                  </span>
                </div>

                {customAssets.length > 0 && !query && category === "all" && (
                  <div className={styles.collectionDivider}>
                    <span>Your atelier</span>
                    <i />
                  </div>
                )}

                <div className={styles.assetGrid}>
                  {visibleAssets.map((asset) => (
                    <AssetCard
                      key={asset.id}
                      asset={asset}
                      onPlace={() => onPlaceAsset(asset)}
                      onDelete={
                        asset.custom ? () => onDeleteCustomAsset(asset) : undefined
                      }
                      disabled={disabled}
                    />
                  ))}
                </div>

                {visibleAssets.length === 0 && (
                  <div className={styles.emptyResults}>
                    <Gem size={19} />
                    <strong>No pieces found</strong>
                    <span>Try another category or create your own.</span>
                  </div>
                )}

                <button
                  className={styles.createShortcut}
                  onClick={() => onTabChange("create")}
                >
                  <span>
                    <WandSparkles size={16} />
                  </span>
                  <div>
                    <strong>Can’t find it?</strong>
                    <small>Design a one of one piece with AI</small>
                  </div>
                  <ChevronRight size={16} />
                </button>
              </>
            ) : (
              <div className={styles.fashionStudio}>
                <section className={styles.fashionControlSection}>
                  <div className={styles.fashionControlHead}>
                    <span>Step 1: Fabric</span>
                  </div>
                  <div className={styles.fashionMaterialGrid} role="radiogroup">
                    {fashionMaterials.map((material) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={fashion.material === material.id}
                        key={material.id}
                        className={
                          fashion.material === material.id
                            ? styles.fashionMaterialActive
                            : styles.fashionMaterial
                        }
                        onClick={() => updateFashion({ material: material.id })}
                      >
                        <span className={styles.fashionChoiceArt}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={material.image} alt="" draggable={false} />
                        </span>
                        <strong>{material.label}</strong>
                      </button>
                    ))}
                  </div>
                </section>

                <section className={styles.fashionControlSection}>
                  <div className={styles.fashionControlHead}>
                    <span>Step 2: Print</span>
                  </div>
                  <div className={styles.fashionPatternGrid} role="radiogroup">
                    {fashionPatterns.map((pattern) => (
                      <button
                        type="button"
                        role="radio"
                        aria-label={pattern.label}
                        aria-checked={fashion.pattern === pattern.id}
                        title={pattern.label}
                        key={pattern.id}
                        className={
                          fashion.pattern === pattern.id
                            ? styles.fashionPatternActive
                            : styles.fashionPattern
                        }
                        onClick={() => updateFashion({ pattern: pattern.id })}
                      >
                        <span className={styles.fashionChoiceArt}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={pattern.image}
                            alt=""
                            draggable={false}
                            style={{
                              filter:
                                fashion.color === "rainbow"
                                  ? "saturate(1.15)"
                                  : `hue-rotate(${
                                      hexHue(fashionColorHex(fashion.color)) - 335
                                    }deg) saturate(1.08)`,
                            }}
                          />
                        </span>
                        <span>{pattern.label}</span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className={styles.fashionControlSection}>
                  <div className={styles.fashionControlHead}>
                    <span>Step 3: Color</span>
                  </div>
                  <div className={styles.fashionColorGrid} role="radiogroup">
                    {fashionColors.map((swatch) => (
                      <button
                        type="button"
                        role="radio"
                        aria-label={swatch.name}
                        aria-checked={fashion.color === swatch.color}
                        title={swatch.name}
                        key={swatch.color}
                        className={
                          fashion.color === swatch.color
                            ? styles.fashionColorActive
                            : styles.fashionColor
                        }
                        style={{
                          background: fashionColorPreview(swatch.color),
                        }}
                        onClick={() => updateFashion({ color: swatch.color })}
                      >
                        {fashion.color === swatch.color && (
                          <Check size={13} strokeWidth={2.8} />
                        )}
                      </button>
                    ))}
                    <label className={styles.fashionCustomColor} title="Choose any color">
                      <input
                        type="color"
                        value={fashionColorHex(fashion.color)}
                        onChange={(event) =>
                          updateFashion({ color: event.target.value })
                        }
                      />
                      <span />
                      <small>Any</small>
                    </label>
                  </div>
                </section>

                <section className={styles.fashionControlSection}>
                  <div className={styles.fashionControlHead}>
                    <span>Pencil</span>
                  </div>
                  <div
                    className={styles.fashionPenSizes}
                    role="radiogroup"
                    aria-label="Pencil size"
                  >
                    {[
                      { label: "Thin", size: 4 },
                      { label: "Medium", size: 8 },
                      { label: "Thick", size: 14 },
                    ].map((option) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={fashion.size === option.size}
                        className={
                          fashion.size === option.size
                            ? styles.fashionPenSizeActive
                            : styles.fashionPenSize
                        }
                        key={option.label}
                        onClick={() => updateFashion({ size: option.size })}
                      >
                        <i
                          style={{
                            width: `${option.size + 7}px`,
                            height: `${option.size + 7}px`,
                            background: fashionColorPreview(fashion.color),
                          }}
                        />
                        <span>{option.label}</span>
                      </button>
                    ))}
                  </div>
                </section>

                {fashionArtifactJobs.length > 0 && (
                  <div className={styles.fashionArtifactJobStack}>
                    {fashionArtifactJobs.map((job) =>
                      job.status === "processing" ? (
                        <div
                          className={styles.fashionArtifactBubble}
                          role="status"
                          aria-live="polite"
                          key={job.id}
                        >
                          <span>
                            <WandSparkles size={15} />
                          </span>
                          <div>
                            <strong>Making your closet pieces</strong>
                            <div
                              className={styles.fashionArtifactBubbleTrack}
                              role="progressbar"
                              aria-label="Estimated drawn closet piece progress"
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={job.progress}
                            >
                              <i style={{ width: `${job.progress}%` }} />
                            </div>
                          </div>
                          <b>{job.progress}%</b>
                        </div>
                      ) : job.status === "error" ? (
                        <div
                          className={styles.fashionArtifactError}
                          key={job.id}
                        >
                          <span>
                            <X size={13} />
                          </span>
                          <div>
                            <strong>Closet piece paused</strong>
                            <small>{job.error || "Try this drawing again."}</small>
                          </div>
                          <button
                            type="button"
                            aria-label="Dismiss failed closet piece"
                            onClick={() =>
                              onDismissFashionArtifactJob(job.id)
                            }
                          >
                            <X size={12} />
                          </button>
                        </div>
                      ) : job.artifacts.length > 0 ? (
                        <section
                          className={styles.fashionArtifactResults}
                          key={job.id}
                        >
                          <header>
                            <span>
                              <Sparkles size={13} />
                              Ready for your closet
                            </span>
                            <small>{job.artifacts.length}</small>
                          </header>
                          <div>
                            {job.artifacts.map((asset) => (
                              <article key={asset.id}>
                                <button
                                  type="button"
                                  className={styles.fashionArtifactDismiss}
                                  aria-label={`Discard ${asset.name}`}
                                  title="Discard piece"
                                  onClick={() =>
                                    onDismissFashionArtifact(asset)
                                  }
                                >
                                  <X size={11} />
                                </button>
                                <button
                                  type="button"
                                  className={styles.fashionArtifactResultArt}
                                  aria-label={`Preview ${asset.name}`}
                                  onClick={() =>
                                    setExpandedCreation({
                                      kind: "fashion",
                                      asset,
                                    })
                                  }
                                >
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={asset.src} alt="" />
                                  <i>
                                    <Maximize2 size={10} />
                                  </i>
                                </button>
                                <div>
                                  <small>{asset.category}</small>
                                  <strong>{asset.name}</strong>
                                  <button
                                    type="button"
                                    className={styles.fashionArtifactAdd}
                                    onClick={() =>
                                      onAddFashionArtifact(asset)
                                    }
                                  >
                                    <Plus size={12} />
                                    Add to closet
                                  </button>
                                </div>
                              </article>
                            ))}
                          </div>
                        </section>
                      ) : null,
                    )}
                  </div>
                )}

                {fashionState.regions.length > 0 && (
                  <section className={styles.fashionLayers}>
                    <div className={styles.fashionControlHead}>
                      <span>Filled shapes</span>
                      <small>{fashionState.regions.length}</small>
                    </div>
                    <div>
                      {fashionState.regions.map((region, index) => {
                        const material = fashionMaterial(region.material);
                        const pattern = fashionPattern(region.pattern);
                        return (
                          <button
                            type="button"
                            key={region.id}
                            className={
                              region.id === fashionState.selectedRegionId
                                ? styles.fashionRegionActive
                                : styles.fashionRegion
                            }
                            onClick={() => onSelectFashionRegion(region.id)}
                          >
                            <i
                              style={{
                                background: fashionColorPreview(region.color),
                              }}
                            />
                            <span>
                              <strong>Shape {index + 1}</strong>
                              <small>
                                {material.label} · {pattern.label}
                              </small>
                            </span>
                            {region.id === fashionState.selectedRegionId && (
                              <Check size={12} />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        )}

        {tab === "create" && (
          <div className={styles.panelStack}>
            <div className={styles.creationPathDivider} aria-hidden="true">
              <i />
              <span>Or describe it</span>
              <i />
            </div>

            <div className={styles.createPromptWrap}>
              <textarea
                value={createPrompt}
                onChange={(event) => setCreatePrompt(event.target.value)}
                placeholder="A sparkly blue cape with silver stars…"
                aria-label="Describe what you want to create"
              />
            </div>

            <button
              className={styles.createAssetButton}
              disabled={creatingAsset}
              onClick={() => onCreateAsset(createPrompt.trim())}
            >
              {creatingAsset ? (
                "Creating…"
              ) : (
                <>
                  <WandSparkles size={17} />
                  Create one of one
                </>
              )}
            </button>

            {creatingAsset && !createdSourceImage ? (
              <div
                className={`${styles.generationSimple} ${styles.generationSimpleCompact}`}
                role="status"
                aria-live="polite"
              >
                <span className={styles.generationSimpleIcon} aria-hidden="true">
                  <WandSparkles size={16} />
                </span>
                <div className={styles.generationSimpleMeter}>
                  <strong>{assetProgress.percent}%</strong>
                  <div
                    className={styles.generationSimpleTrack}
                    role="progressbar"
                    aria-label="Estimated piece generation progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={assetProgress.percent}
                  >
                    <span style={{ width: `${assetProgress.percent}%` }} />
                  </div>
                </div>
              </div>
            ) : null}

            {apiConfigured === false && (
              <div className={styles.apiNotice}>
                <span>API key needed</span>
                Add a fresh <code>OPENAI_API_KEY</code> to <code>.env.local</code>, then restart.
              </div>
            )}

            {createdAssets.length > 0 && !createdSourceImage && (
              <div className={styles.createdPieces}>
                <span className={styles.eyebrow}>
                  {createdAssets.length === 1
                    ? "Just created"
                    : `${createdAssets.length} separate artifacts`}
                </span>
                {createdAssets.map((asset) =>
                  renderCreatedAssetCard(asset),
                )}
              </div>
            )}

          </div>
        )}
      </div>

      {expandedCreation && (
        <div
          className={styles.creationPreviewBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setExpandedCreation(null);
            }
          }}
        >
          <section
            className={styles.creationPreview}
            role="dialog"
            aria-modal="true"
            aria-label={
              expandedCreation.kind === "asset" ||
              expandedCreation.kind === "fashion"
                ? expandedCreation.asset.name
                : "Original uploaded image"
            }
          >
            {(expandedCreation.kind === "asset" ||
              expandedCreation.kind === "fashion") && (
              <button
                type="button"
                className={styles.creationPreviewDiscard}
                aria-label={`Discard ${expandedCreation.asset.name}`}
                onClick={() => {
                  if (expandedCreation.kind === "fashion") {
                    onDismissFashionArtifact(expandedCreation.asset);
                  } else {
                    onDismissCreatedAsset(expandedCreation.asset);
                  }
                  setExpandedCreation(null);
                }}
              >
                <X size={15} />
              </button>
            )}
            <button
              type="button"
              className={styles.creationPreviewClose}
              aria-label="Close preview"
              onClick={() => setExpandedCreation(null)}
            >
              <Minimize2 size={16} />
            </button>
            <div className={styles.creationPreviewImage}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={
                  expandedCreation.kind === "asset" ||
                  expandedCreation.kind === "fashion"
                    ? expandedCreation.asset.src
                    : expandedCreation.src
                }
                alt={
                  expandedCreation.kind === "asset" ||
                  expandedCreation.kind === "fashion"
                    ? expandedCreation.asset.name
                    : expandedCreation.name
                }
              />
            </div>
            <footer className={styles.creationPreviewFooter}>
              <div>
                <span>
                  {expandedCreation.kind === "asset" ||
                  expandedCreation.kind === "fashion"
                    ? expandedCreation.asset.category
                    : "Original image"}
                </span>
                <strong>
                  {expandedCreation.kind === "asset" ||
                  expandedCreation.kind === "fashion"
                    ? expandedCreation.asset.name
                    : expandedCreation.name}
                </strong>
              </div>
              {(expandedCreation.kind === "asset" ||
                expandedCreation.kind === "fashion") && (
                <div className={styles.creationPreviewActions}>
                  <button
                    type="button"
                    className={styles.creationPreviewAdd}
                    onClick={() => {
                      if (expandedCreation.kind === "fashion") {
                        onAddFashionArtifact(expandedCreation.asset);
                      } else {
                        onAddCreatedAsset(expandedCreation.asset);
                      }
                      setExpandedCreation(null);
                    }}
                  >
                    <Plus size={14} /> Add to closet
                  </button>
                  {expandedCreation.kind === "asset" && (
                    <button
                      type="button"
                      onClick={() => {
                        onPlaceAsset(expandedCreation.asset);
                        if (hasPortrait) setExpandedCreation(null);
                      }}
                    >
                      Place on portrait <ChevronRight size={14} />
                    </button>
                  )}
                </div>
              )}
            </footer>
          </section>
        </div>
      )}
    </aside>
  );
}
