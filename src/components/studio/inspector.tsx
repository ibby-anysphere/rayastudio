"use client";

import {
  useMemo,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  Brush,
  Check,
  ChevronRight,
  Eraser,
  Gem,
  Glasses,
  Palette,
  Plus,
  RotateCcw,
  Scissors,
  Search,
  Shirt,
  Sparkles,
  Trash2,
  WandSparkles,
} from "lucide-react";
import type { EstimatedProgress } from "@/components/studio/use-estimated-progress";
import { assetStarterPrompts, makeupProducts } from "@/lib/studio-catalog";
import type {
  AssetCategory,
  BrushSettings,
  CanvasTool,
  MakeupProduct,
  MakeupProductId,
  StudioAsset,
  StudioTab,
} from "@/lib/studio-types";
import styles from "./studio.module.css";

interface InspectorProps {
  tab: StudioTab;
  onTabChange: (tab: StudioTab) => void;
  brush: BrushSettings;
  onBrushChange: (patch: Partial<BrushSettings>) => void;
  tool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
  hasGuide: boolean;
  canUndoGuide: boolean;
  guideProducts: MakeupProductId[];
  onUndoGuide: () => void;
  onClearGuide: () => void;
  assets: StudioAsset[];
  customAssets: StudioAsset[];
  onPlaceAsset: (asset: StudioAsset) => void;
  onDeleteCustomAsset: (asset: StudioAsset) => void;
  onCreateAsset: (prompt: string, category: AssetCategory) => void;
  creatingAsset: boolean;
  assetProgress: EstimatedProgress;
  createdAsset: StudioAsset | null;
  apiConfigured: boolean | null;
  hasPortrait: boolean;
}

const tabItems: Array<{ id: StudioTab; label: string; icon: typeof Palette }> = [
  { id: "makeup", label: "Beauty", icon: Palette },
  { id: "wardrobe", label: "Closet", icon: Gem },
  { id: "create", label: "Create", icon: WandSparkles },
];

const categoryItems: Array<{ id: "all" | AssetCategory; label: string }> = [
  { id: "all", label: "All" },
  { id: "jewelry", label: "Jewelry" },
  { id: "eyewear", label: "Eyewear" },
  { id: "hair", label: "Hair" },
  { id: "garment", label: "Garments" },
  { id: "accessory", label: "Extras" },
];

const createTypes: Array<{ id: AssetCategory; label: string; icon: typeof Shirt }> = [
  { id: "garment", label: "Garment", icon: Shirt },
  { id: "jewelry", label: "Jewelry", icon: Gem },
  { id: "hair", label: "Hair", icon: Scissors },
  { id: "accessory", label: "Object", icon: Glasses },
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
}: {
  asset: StudioAsset;
  onPlace: () => void;
  onDelete?: () => void;
}) {
  const startDrag = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData("application/riya-asset", asset.id);
    event.dataTransfer.effectAllowed = "copy";
  };

  const handleKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onPlace();
    }
  };

  return (
    <div
      className={styles.assetCard}
      role="button"
      tabIndex={0}
      draggable
      aria-label={`Place ${asset.name}`}
      onDragStart={startDrag}
      onClick={onPlace}
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
  brush,
  onBrushChange,
  tool,
  onToolChange,
  hasGuide,
  canUndoGuide,
  guideProducts,
  onUndoGuide,
  onClearGuide,
  assets,
  customAssets,
  onPlaceAsset,
  onDeleteCustomAsset,
  onCreateAsset,
  creatingAsset,
  assetProgress,
  createdAsset,
  apiConfigured,
  hasPortrait,
}: InspectorProps) {
  const [category, setCategory] = useState<"all" | AssetCategory>("all");
  const [query, setQuery] = useState("");
  const [createType, setCreateType] = useState<AssetCategory>("garment");
  const [createPrompt, setCreatePrompt] = useState("");
  const [productMemory, setProductMemory] = useState(
    () =>
      Object.fromEntries(
        makeupProducts.map((product) => [
          product.id,
          { color: product.shades[0].color, size: product.defaultSize },
        ]),
      ) as Record<MakeupProductId, Pick<BrushSettings, "color" | "size">>,
  );

  const selectedProduct =
    makeupProducts.find((product) => product.id === brush.product) ?? makeupProducts[0];
  const selectedShade =
    selectedProduct.shades.find((shade) => shade.color === brush.color) ??
    selectedProduct.shades[0];

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

  return (
    <aside className={styles.inspector}>
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
            <div className={styles.panelHeading}>
              <div>
                <span className={styles.eyebrow}>Beauty shelf</span>
                <h2>Pick up a product</h2>
              </div>
              <span className={styles.stepCount}>04</span>
            </div>

            <p className={styles.beautyIntro}>
              Choose a product and shade, then paint only where you want it. Each
              product stays on its own intelligent layer.
            </p>

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
                      <small>{product.note}</small>
                    </span>
                    <i
                      className={styles.makeupProductSwatch}
                      style={{ background: previewColor }}
                    />
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
                  <small>{selectedProduct.instruction}</small>
                </div>
                <span className={styles.makeupLayerTag}>
                  <i style={{ background: brush.color }} />
                  Own layer
                </span>
              </div>

              <div className={styles.shadePanel}>
                <div className={styles.shadePanelHead}>
                  <span>Choose a shade</span>
                  <small>{selectedShade.name}</small>
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

              <div className={styles.makeupTools}>
                <div className={styles.makeupModeButtons} role="group" aria-label="Paint tool">
                  <button
                    type="button"
                    className={tool === "brush" ? styles.makeupModeActive : styles.makeupMode}
                    aria-pressed={tool === "brush"}
                    onClick={() => onToolChange("brush")}
                  >
                    <Brush size={14} />
                    Paint
                  </button>
                  <button
                    type="button"
                    className={tool === "eraser" ? styles.makeupModeActive : styles.makeupMode}
                    aria-pressed={tool === "eraser"}
                    onClick={() => onToolChange("eraser")}
                  >
                    <Eraser size={14} />
                    Erase
                  </button>
                </div>

                <label className={styles.makeupSize}>
                  <span>
                    Brush size
                    <b>{brush.size}px</b>
                  </span>
                  <input
                    type="range"
                    min={selectedProduct.minSize}
                    max={selectedProduct.maxSize}
                    value={brush.size}
                    style={{
                      background: `linear-gradient(90deg, ${brush.color}, ${brush.color}36)`,
                    }}
                    onChange={(event) =>
                      updateMakeupBrush({ size: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
            </section>

            <div className={styles.guideActions}>
              <div className={styles.guideStatus}>
                <span className={hasGuide ? styles.guideReady : styles.guideEmpty}>
                  <i />
                  {hasGuide ? "Product layers ready" : "Paint on the portrait"}
                </span>
                {guideProducts.length > 0 && (
                  <span className={styles.guideProductNames}>
                    {guideProducts.map((productId) => {
                      const product = makeupProducts.find(
                        (candidate) => candidate.id === productId,
                      );
                      if (!product) return null;
                      return (
                        <span key={product.id}>
                          <i
                            style={{
                              background: productMemory[product.id].color,
                            }}
                          />
                          {product.shortName}
                        </span>
                      );
                    })}
                  </span>
                )}
              </div>
              <button type="button" onClick={onUndoGuide} disabled={!canUndoGuide}>
                <RotateCcw size={13} /> Undo
              </button>
              <button type="button" onClick={onClearGuide} disabled={!canUndoGuide}>
                <Trash2 size={13} /> Clear
              </button>
            </div>
          </div>
        )}

        {tab === "wardrobe" && (
          <div className={styles.panelStack}>
            <div className={styles.panelHeading}>
              <div>
                <span className={styles.eyebrow}>The closet</span>
                <h2>Drag on every detail</h2>
              </div>
              <span className={styles.itemCount}>{visibleAssets.length}</span>
            </div>

            {!hasPortrait && (
              <div className={styles.smallNotice}>
                <ImagePlusNotice />
                Upload a portrait first, then drag pieces directly onto it.
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
                  className={category === item.id ? styles.categoryActive : styles.category}
                  onClick={() => setCategory(item.id)}
                >
                  {item.label}
                </button>
              ))}
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

            <button className={styles.createShortcut} onClick={() => onTabChange("create")}>
              <span>
                <WandSparkles size={16} />
              </span>
              <div>
                <strong>Can’t find it?</strong>
                <small>Design a one-of-one piece with AI</small>
              </div>
              <ChevronRight size={16} />
            </button>
          </div>
        )}

        {tab === "create" && (
          <div className={styles.panelStack}>
            <div className={styles.panelHeading}>
              <div>
                <span className={styles.eyebrow}>Atelier lab</span>
                <h2>Imagine something new</h2>
              </div>
              <span className={styles.stepCount}>∞</span>
            </div>

            <p className={styles.panelIntro}>
              Describe any garment, jewel, accessory, or hairstyle. RIYA creates an isolated
              piece you can keep in your private closet.
            </p>

            <div className={styles.createTypes}>
              {createTypes.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={createType === item.id ? styles.createTypeActive : styles.createType}
                    onClick={() => setCreateType(item.id)}
                  >
                    <Icon size={16} />
                    {item.label}
                  </button>
                );
              })}
            </div>

            <div className={styles.createPromptWrap}>
              <textarea
                value={createPrompt}
                maxLength={800}
                onChange={(event) => setCreatePrompt(event.target.value)}
                placeholder="A silk evening dress with ten pearl buttons, cobalt hand-stitching, and a softly sculpted waist…"
              />
              <span>{createPrompt.length}/800</span>
            </div>

            <div className={styles.inspirationList}>
              <span>Try an idea</span>
              {assetStarterPrompts.map((prompt) => (
                <button key={prompt} onClick={() => setCreatePrompt(prompt)}>
                  <Sparkles size={12} />
                  {prompt}
                </button>
              ))}
            </div>

            <button
              className={styles.createAssetButton}
              disabled={creatingAsset || createPrompt.trim().length < 8 || apiConfigured === false}
              onClick={() => onCreateAsset(createPrompt.trim(), createType)}
            >
              {creatingAsset ? (
                "Creating…"
              ) : (
                <>
                  <WandSparkles size={17} />
                  Create one-of-one
                </>
              )}
            </button>

            {creatingAsset && (
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
            )}

            {apiConfigured === false && (
              <div className={styles.apiNotice}>
                <span>API key needed</span>
                Add a fresh <code>OPENAI_API_KEY</code> to <code>.env.local</code>, then restart.
              </div>
            )}

            {createdAsset && (
              <div className={styles.createdPiece}>
                <div className={styles.createdPieceArt}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={createdAsset.src} alt={createdAsset.name} />
                  <span>
                    <Check size={12} /> Saved
                  </span>
                </div>
                <div>
                  <span className={styles.eyebrow}>Just created</span>
                  <strong>{createdAsset.name}</strong>
                  <div className={styles.createdPieceActions}>
                    <button type="button" onClick={() => onPlaceAsset(createdAsset)}>
                      Place on portrait <ChevronRight size={13} />
                    </button>
                    <button
                      type="button"
                      className={styles.createdPieceDelete}
                      onClick={() => onDeleteCustomAsset(createdAsset)}
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className={styles.creationPromise}>
              <Sparkles size={15} />
              <p>
                Transparent background, couture-level detail, and permanent storage in this
                browser.
              </p>
            </div>
          </div>
        )}
      </div>

    </aside>
  );
}

function ImagePlusNotice() {
  return (
    <span className={styles.smallNoticeIcon}>
      <Plus size={13} />
    </span>
  );
}
