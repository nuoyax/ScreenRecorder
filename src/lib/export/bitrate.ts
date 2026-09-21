/**
 * Export bitrate policy.
 *
 * Ported from Recordly's `src/lib/exporter/exportBitrate.ts`. The rule worth keeping
 * from it: an export must never be budgeted *below* what the source already carries.
 * Transcoding a 25 Mbps recording to a 5 Mbps "medium" preset throws away detail the
 * user already has, so the requested bitrate is treated as a floor-bounded target
 * rather than an instruction.
 */

export type ExportQuality = "low" | "medium" | "high" | "source";

export interface QualityPreset {
  id: ExportQuality;
  label: string;
  /** Reference bitrate at 1080p30, in bits per second. */
  refBps: number;
}

/** 1080p is the anchor all scaling is measured against. */
const FULL_HD_PIXELS = 1920 * 1080;
const REFERENCE_FPS = 30;

/** Below this an export looks broken regardless of what was asked for. */
const MIN_BITRATE_BPS = 2_000_000;

/** Above this the file grows without anyone seeing a difference. */
const MAX_BITRATE_BPS = 160_000_000;

export const EXPORT_QUALITIES: QualityPreset[] = [
  { id: "low", label: "低 · 小文件", refBps: 5_000_000 },
  { id: "medium", label: "中", refBps: 8_000_000 },
  { id: "high", label: "高 · 推荐", refBps: 12_000_000 },
  { id: "source", label: "与源相同", refBps: 0 },
];

/**
 * Bitrate the source itself carries, estimated from its resolution.
 *
 * Only an estimate: the true rate lives in the MP4 header, which this app does not
 * parse. Erring high is the safe direction — the failure mode of over-estimating is
 * a slightly larger file, and of under-estimating is visible quality loss.
 */
export function sourceBitrateBps(width: number, height: number): number {
  const pixels = Math.max(1, width * height);
  if (pixels <= 1280 * 720) return 8_000_000;
  if (pixels <= FULL_HD_PIXELS) return 12_000_000;
  if (pixels >= 3840 * 2160) return 45_000_000;
  // Interpolate the 1080p→4K range rather than stepping.
  const progress = (pixels - FULL_HD_PIXELS) / (3840 * 2160 - FULL_HD_PIXELS);
  return Math.round(12_000_000 + (45_000_000 - 12_000_000) * progress);
}

/**
 * True when `candidate` would carry more detail than `reference`.
 *
 * Used to decide whether re-encoding is an upgrade at all: transcoding to a *lower*
 * target than the source is a downgrade the user should be warned about, not a
 * silent default.
 */
export function isQualitySuperior(
  candidate: { width: number; height: number; bitrateBps: number },
  reference: { width: number; height: number; bitrateBps: number },
): boolean {
  const candidatePixels = candidate.width * candidate.height;
  const referencePixels = reference.width * reference.height;
  // More pixels at no worse a bitrate is unambiguously better.
  if (candidatePixels > referencePixels) {
    return candidate.bitrateBps >= reference.bitrateBps;
  }
  // Same or fewer pixels has to be paid for with a strictly higher bitrate.
  return candidate.bitrateBps > reference.bitrateBps;
}

/**
 * Bitrate to encode an export at.
 *
 * Scaling follows the square root of the frame-rate ratio rather than the ratio
 * itself: bitrate and perceptual quality track roughly with √fps, and scaling
 * linearly would double the file for a 60fps export that looks no better.
 */
export function exportBitrateBps(options: {
  width: number;
  height: number;
  fps: number;
  quality: ExportQuality;
  /** Source resolution + rate, so `quality: "source"` and the superior-quality
   *  guard have something to compare against. */
  source: { width: number; height: number; bitrateBps?: number };
}): number {
  const { width, height, fps, quality, source } = options;
  const sourceBps = source.bitrateBps ?? sourceBitrateBps(source.width, source.height);

  if (quality === "source") return clampBitrate(sourceBps);

  const preset = EXPORT_QUALITIES.find((q) => q.id === quality) ?? EXPORT_QUALITIES[2];
  const pixels = Math.max(1, width * height);
  const fpsMultiplier = Math.sqrt(Math.max(1, fps / REFERENCE_FPS));
  const requested = preset.refBps * (pixels / FULL_HD_PIXELS) * fpsMultiplier;

  // Never below the source: re-encoding a 25 Mbps recording at 5 Mbps is a downgrade
  // the preset name does not imply.
  const floored = Math.max(requested, sourceBps);

  // ...but an export that is genuinely smaller (downscaled) may legitimately carry
  // less than the source, so the floor is capped by what the output resolution can
  // justify. Without this, exporting a 4K source at 480p would still demand 45 Mbps.
  const outputCeiling = sourceBitrateBps(width, height) * 1.5;
  return clampBitrate(Math.min(floored, Math.max(outputCeiling, MIN_BITRATE_BPS)));
}

function clampBitrate(bps: number): number {
  if (!Number.isFinite(bps) || bps <= 0) return MIN_BITRATE_BPS;
  return Math.round(Math.min(MAX_BITRATE_BPS, Math.max(MIN_BITRATE_BPS, bps)));
}

/** Human-readable bitrate for the export panel. */
export function formatBitrate(bps: number): string {
  return bps >= 1_000_000
    ? `${(bps / 1_000_000).toFixed(1)} Mbps`
    : `${Math.round(bps / 1000)} kbps`;
}
