import { WandSparkles } from "lucide-react";
import { RayaLogo } from "@/components/brand/raya-logo";
import styles from "./raya-brand.module.css";

interface RayaLoadingScreenProps {
  exiting?: boolean;
}

export function RayaLoadingScreen({
  exiting = false,
}: RayaLoadingScreenProps) {
  return (
    <div
      className={`${styles.loadingScreen} ${
        exiting ? styles.loadingScreenExiting : ""
      }`}
      role="status"
      aria-live="polite"
      aria-label="Loading Raya Studio"
    >
      <div className={styles.loadingContent}>
        <span className={styles.loadingLogoWrap}>
          <RayaLogo className={styles.loadingLogo} />
          <RayaLogo
            className={styles.loadingLogoShimmer}
            decorative
          />
        </span>
        <span className={styles.markerOrbit} aria-hidden="true">
          <span className={styles.magicMarker}>
            <WandSparkles size={62} strokeWidth={2.1} />
          </span>
        </span>
      </div>
      <span className={styles.visuallyHidden}>Loading Raya Studio</span>
    </div>
  );
}
