import type { WebContents } from "electron";
import {
  findBrowserPreviewDevicePreset,
  type McodeBrowserCaptureEmulation,
  type PreviewDeviceEmulationConfig,
} from "@mcode/contracts";

export type Bounds = { x: number; y: number; width: number; height: number };

export type ResolvedPreviewEmulation = {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly deviceScaleFactor: number;
  readonly label: string;
};

/**
 * Resolved emulation metrics and Chrome version token for a mobile-style user-agent string.
 */
export function buildPreviewMobileUserAgent(chromeVersion: string): string {
  const cv = chromeVersion.trim() || "0.0.0.0";
  return `Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${cv} Mobile Safari/537.36 McodePreview/1.0`;
}

/**
 * Maps a per-thread emulation config to CSS viewport size, DPR, and a short label.
 */
export function resolvePreviewDeviceEmulation(
  cfg: PreviewDeviceEmulationConfig,
): ResolvedPreviewEmulation | null {
  if (cfg.kind === "off") return null;
  if (cfg.kind === "custom") {
    const dpr = cfg.deviceScaleFactor ?? 2;
    return {
      cssWidth: cfg.width,
      cssHeight: cfg.height,
      deviceScaleFactor: dpr,
      label: `${cfg.width}×${cfg.height}`,
    };
  }
  const preset = findBrowserPreviewDevicePreset(cfg.presetId);
  if (!preset) return null;
  const baseW: number = preset.width;
  const baseH: number = preset.height;
  const cssWidth = cfg.orientation === "landscape" ? baseH : baseW;
  const cssHeight = cfg.orientation === "landscape" ? baseW : baseH;
  const orient = cfg.orientation === "landscape" ? "landscape" : "portrait";
  return {
    cssWidth,
    cssHeight,
    deviceScaleFactor: preset.deviceScaleFactor,
    label: orient === "portrait" ? preset.label : `${preset.label} · landscape`,
  };
}

/**
 * Places a centered guest rectangle inside the shell surface and returns the uniform fit scale (max 1).
 */
export function layoutGuestBoundsForEmulation(
  shell: Bounds,
  cssWidth: number,
  cssHeight: number,
): { guest: Bounds; scaleToFit: number } {
  const sw = Math.max(4, Math.floor(shell.width));
  const sh = Math.max(4, Math.floor(shell.height));
  const scaleToFit = Math.min(sw / cssWidth, sh / cssHeight, 1);
  const gw = Math.max(4, Math.floor(cssWidth * scaleToFit));
  const gh = Math.max(4, Math.floor(cssHeight * scaleToFit));
  const x = shell.x + Math.floor((shell.width - gw) / 2);
  const y = shell.y + Math.floor((shell.height - gh) / 2);
  return {
    guest: { x, y, width: gw, height: gh },
    scaleToFit,
  };
}

/**
 * Applies or clears Chromium device emulation and guest user-agent for the preview surface.
 */
export function applyPreviewDeviceEmulation(
  wc: WebContents,
  opts: {
    active: boolean;
    cssViewport: { width: number; height: number };
    deviceScaleFactor: number;
    scaleToFit: number;
    mobileUserAgent: string;
    defaultUserAgent: string;
  },
): void {
  if (wc.isDestroyed()) return;
  if (!opts.active) {
    wc.disableDeviceEmulation();
    wc.setUserAgent(opts.defaultUserAgent);
    return;
  }
  // Guard: calling enableDeviceEmulation on a BrowserView that hasn't loaded
  // any content (empty URL or about:blank) can crash the Chromium compositor
  // on Windows. Defer emulation until the guest has a real document.
  const guestUrl = wc.getURL();
  if (!guestUrl || guestUrl === "about:blank" || guestUrl.startsWith("about:")) {
    return;
  }
  wc.setUserAgent(opts.mobileUserAgent);
  const w = opts.cssViewport.width;
  const h = opts.cssViewport.height;
  wc.enableDeviceEmulation({
    screenPosition: "mobile",
    screenSize: { width: w, height: h },
    viewPosition: { x: 0, y: 0 },
    viewSize: { width: w, height: h },
    deviceScaleFactor: opts.deviceScaleFactor,
    scale: opts.scaleToFit,
  });
}

/**
 * Builds the structured emulation block attached to browser capture v2 payloads.
 */
export function buildCaptureEmulationSnapshot(
  cfg: PreviewDeviceEmulationConfig,
  resolved: ResolvedPreviewEmulation,
  scaleToFit: number,
  mobileUserAgent: string,
): McodeBrowserCaptureEmulation {
  const base = {
    label: resolved.label,
    cssViewport: { width: resolved.cssWidth, height: resolved.cssHeight },
    deviceScaleFactor: resolved.deviceScaleFactor,
    scaleToFit,
    userAgent: mobileUserAgent.length > 512 ? mobileUserAgent.slice(0, 512) : mobileUserAgent,
  };
  if (cfg.kind === "preset") {
    return {
      mode: "preset",
      ...base,
      presetId: cfg.presetId,
      orientation: cfg.orientation,
    };
  }
  return {
    mode: "custom",
    ...base,
  };
}
