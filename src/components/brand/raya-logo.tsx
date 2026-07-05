import { Fredoka } from "next/font/google";
import styles from "./raya-brand.module.css";

const fredoka = Fredoka({
  subsets: ["latin"],
  weight: "700",
  display: "swap",
  fallback: ["Arial Rounded MT Bold", "Arial", "sans-serif"],
});

interface RayaLogoProps {
  className?: string;
  decorative?: boolean;
  layout?: "stacked" | "horizontal";
  markOnly?: boolean;
  label?: string;
}

export function RayaLogo({
  className,
  decorative = false,
  layout = "stacked",
  markOnly = false,
  label = "Raya Studio",
}: RayaLogoProps) {
  return (
    <span
      className={[
        fredoka.className,
        styles.logo,
        layout === "horizontal" ? styles.logoHorizontal : "",
        markOnly ? styles.logoMark : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative || undefined}
    >
      <span className={`${styles.logoLine} ${styles.logoRaya}`} aria-hidden="true">
        {markOnly ? "R" : "Raya"}
      </span>
      {!markOnly && (
        <span
          className={`${styles.logoLine} ${styles.logoStudio}`}
          aria-hidden="true"
        >
          Studio
        </span>
      )}
    </span>
  );
}
