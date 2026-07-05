"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type GenerationProfile =
  | "portrait-fast"
  | "portrait-max"
  | "asset"
  | "asset-upload"
  | "fashion-artifact";

export interface EstimatedProgress {
  percent: number;
}

interface ProgressProfile {
  baseMs: number;
  perExtraInputMs: number;
}

interface TimingSample {
  profile: GenerationProfile;
  inputCount: number;
  durationMs: number;
}

const TIMING_STORAGE_KEY = "riya-generation-timings-v1";

const progressProfiles: Record<GenerationProfile, ProgressProfile> = {
  "portrait-fast": {
    baseMs: 10_000,
    perExtraInputMs: 500,
  },
  "portrait-max": {
    baseMs: 28_000,
    perExtraInputMs: 1_200,
  },
  asset: {
    baseMs: 24_000,
    perExtraInputMs: 0,
  },
  "asset-upload": {
    baseMs: 68_000,
    perExtraInputMs: 0,
  },
  "fashion-artifact": {
    baseMs: 62_000,
    perExtraInputMs: 7_000,
  },
};

const initialProgress: EstimatedProgress = {
  percent: 0,
};

function readTimingSamples() {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(TIMING_STORAGE_KEY) || "[]",
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (sample): sample is TimingSample =>
        Boolean(sample) &&
        typeof sample === "object" &&
        "profile" in sample &&
        (sample.profile === "portrait-fast" ||
          sample.profile === "portrait-max" ||
          sample.profile === "asset" ||
          sample.profile === "asset-upload" ||
          sample.profile === "fashion-artifact") &&
        "inputCount" in sample &&
        typeof sample.inputCount === "number" &&
        "durationMs" in sample &&
        typeof sample.durationMs === "number",
    );
  } catch {
    return [];
  }
}

function estimateDuration(profile: GenerationProfile, inputCount: number) {
  const config = progressProfiles[profile];
  const extraInputMs =
    Math.max(0, Math.min(10, inputCount) - 1) * config.perExtraInputMs;
  const samples = readTimingSamples()
    .filter((sample) => sample.profile === profile)
    .slice(-8);

  if (samples.length === 0) return config.baseMs + extraInputMs;

  const normalizedDurations = samples
    .map(
      (sample) =>
        sample.durationMs -
        Math.max(0, Math.min(10, sample.inputCount) - 1) *
          config.perExtraInputMs,
    )
    .sort((left, right) => left - right);
  const middle = Math.floor(normalizedDurations.length / 2);
  const median =
    normalizedDurations.length % 2 === 0
      ? (normalizedDurations[middle - 1] + normalizedDurations[middle]) / 2
      : normalizedDurations[middle];
  const learnedBase = Math.min(
    config.baseMs * 1.8,
    Math.max(config.baseMs * 0.65, median),
  );
  const learnedWeight = Math.min(0.7, samples.length * 0.14);

  return (
    config.baseMs * (1 - learnedWeight) + learnedBase * learnedWeight + extraInputMs
  );
}

function saveTimingSample(sample: TimingSample) {
  if (sample.durationMs < 3_000 || sample.durationMs > 300_000) return;
  try {
    const samples = readTimingSamples();
    window.localStorage.setItem(
      TIMING_STORAGE_KEY,
      JSON.stringify([...samples, sample].slice(-24)),
    );
  } catch {
    // Timing history is an optional enhancement when browser storage is available.
  }
}

function scheduledPercent(elapsedMs: number, estimateMs: number) {
  const ratio = elapsedMs / Math.max(1, estimateMs);

  if (ratio <= 0.08) return 4 + (ratio / 0.08) * 12;
  if (ratio <= 0.32) return 16 + ((ratio - 0.08) / 0.24) * 24;
  if (ratio <= 0.62) return 40 + ((ratio - 0.32) / 0.3) * 25;
  if (ratio <= 0.86) return 65 + ((ratio - 0.62) / 0.24) * 19;
  if (ratio <= 1) return 84 + ((ratio - 0.86) / 0.14) * 8;

  return Math.min(98, 92 + 6 * (1 - Math.exp(-(ratio - 1) * 0.9)));
}

export function useEstimatedProgress() {
  const [progress, setProgress] = useState<EstimatedProgress>(initialProgress);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const profileRef = useRef<GenerationProfile>("portrait-fast");
  const inputCountRef = useRef(1);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const start = useCallback(
    (profile: GenerationProfile, inputCount = 1) => {
      clearTimer();
      const safeInputCount = Math.max(1, Math.min(10, Math.round(inputCount)));
      const estimateMs = estimateDuration(profile, safeInputCount);
      const startedAt = performance.now();

      profileRef.current = profile;
      inputCountRef.current = safeInputCount;
      startedAtRef.current = startedAt;

      const update = () => {
        const elapsedMs = performance.now() - startedAt;
        const percent = Math.floor(scheduledPercent(elapsedMs, estimateMs));

        setProgress((current) => {
          if (current.percent === percent) return current;
          return { percent };
        });
      };

      update();
      timerRef.current = setInterval(update, 180);
    },
    [clearTimer],
  );

  const complete = useCallback(() => {
    clearTimer();
    const startedAt = startedAtRef.current;
    const profile = profileRef.current;
    if (startedAt !== null) {
      saveTimingSample({
        profile,
        inputCount: inputCountRef.current,
        durationMs: performance.now() - startedAt,
      });
    }
    startedAtRef.current = null;
    setProgress({ percent: 100 });
  }, [clearTimer]);

  const cancel = useCallback(() => {
    clearTimer();
    startedAtRef.current = null;
    setProgress(initialProgress);
  }, [clearTimer]);

  useEffect(
    () => () => {
      clearTimer();
    },
    [clearTimer],
  );

  return { progress, start, complete, cancel };
}
