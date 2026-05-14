import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/**
 * Curated device frames for responsive preview emulation (CSS viewport sizes in portrait).
 * Desktop maps orientation by swapping width and height when needed.
 */
export const BROWSER_PREVIEW_DEVICE_PRESETS = [
  {
    id: "iphone-se",
    label: "iPhone SE",
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
  },
  {
    id: "iphone-14-pro",
    label: "iPhone 14 Pro",
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
  },
  {
    id: "pixel-7",
    label: "Pixel 7",
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
  },
  {
    id: "galaxy-s21",
    label: "Galaxy S21",
    width: 360,
    height: 800,
    deviceScaleFactor: 3,
  },
  {
    id: "ipad-mini",
    label: "iPad Mini",
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
  },
] as const;

/** Union of built-in preset ids. */
export type BrowserPreviewDevicePresetId = (typeof BROWSER_PREVIEW_DEVICE_PRESETS)[number]["id"];

/**
 * Looks up a device preset by id for emulation layout and capture labels.
 */
export function findBrowserPreviewDevicePreset(
  id: string,
): (typeof BROWSER_PREVIEW_DEVICE_PRESETS)[number] | undefined {
  return BROWSER_PREVIEW_DEVICE_PRESETS.find((p) => p.id === id);
}

/** Default emulation state when no mobile frame is active. */
export const PREVIEW_DEVICE_EMULATION_OFF = { kind: "off" } as const;

/** Screen rotation for preset emulation. */
export const PreviewDeviceOrientationSchema = lazySchema(() => z.enum(["portrait", "landscape"]));

export type PreviewDeviceOrientation = z.infer<ReturnType<typeof PreviewDeviceOrientationSchema>>;

/**
 * Per-thread preview device emulation choice synced from the renderer and applied in the main process.
 */
export const PreviewDeviceEmulationConfigSchema = lazySchema(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("off") }),
    z.object({
      kind: z.literal("preset"),
      presetId: z.string().min(1).max(64),
      orientation: PreviewDeviceOrientationSchema(),
    }),
    z.object({
      kind: z.literal("custom"),
      width: z.number().int().min(100).max(8192),
      height: z.number().int().min(100).max(8192),
      deviceScaleFactor: z.number().min(0.75).max(4).optional(),
    }),
  ]),
);

export type PreviewDeviceEmulationConfig = z.infer<ReturnType<typeof PreviewDeviceEmulationConfigSchema>>;

/**
 * Structured emulation metadata embedded in {@link McodeBrowserCaptureV2} for agent context.
 */
export const McodeBrowserCaptureEmulationSchema = lazySchema(() =>
  z.object({
    mode: z.enum(["preset", "custom"]),
    label: z.string().max(80),
    presetId: z.string().max(64).optional(),
    orientation: PreviewDeviceOrientationSchema().optional(),
    cssViewport: z.object({
      width: z.number().int().min(1).max(8192),
      height: z.number().int().min(1).max(8192),
    }),
    deviceScaleFactor: z.number().min(0.25).max(4),
    /** Scale applied so the emulated viewport fits the preview panel (0–1). */
    scaleToFit: z.number().min(0.05).max(1).optional(),
    /** User-Agent string applied to the guest for this session (truncated in fences if needed). */
    userAgent: z.string().max(512).optional(),
  }),
);

export type McodeBrowserCaptureEmulation = z.infer<ReturnType<typeof McodeBrowserCaptureEmulationSchema>>;
