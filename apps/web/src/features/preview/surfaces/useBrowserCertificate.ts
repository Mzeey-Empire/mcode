import { useCallback, useEffect, useState } from "react";
import type { BrowserCertificateState } from "@mcode/contracts";
import type { BrowserSurfaceIdentity } from "../browser-surfaces";
import { browserSurfaceHost } from "./BrowserSurfaceHostRoot";
import { showFailure } from "./useProjectServers";

function certificateBridge() {
  return window.desktopBridge?.preview?.certificate ?? null;
}

function currentSurface(identity: BrowserSurfaceIdentity | null) {
  const generation = identity ? browserSurfaceHost.getSnapshot(identity)?.generation : undefined;
  return identity && generation !== undefined ? { identity, generation } : null;
}

async function readCertificateState(identity: BrowserSurfaceIdentity | null): Promise<BrowserCertificateState | null> {
  const bridge = certificateBridge();
  const surface = currentSurface(identity);
  return bridge && surface ? bridge.state(surface) : null;
}

/** What the Browser chrome can do about a certificate on one tab. */
export interface BrowserCertificate {
  /** Latest warning and host trust, or null until the desktop answers. */
  readonly state: BrowserCertificateState | null;
  /** Trusts the recorded certificate for this host in this project, then reloads. */
  readonly proceed: (fingerprint: string) => Promise<void>;
  /** Stops trusting this host in this project, then reloads. */
  readonly revoke: () => Promise<void>;
}

/**
 * Reads the desktop's certificate state for a tab and re-reads whenever `revision` changes,
 * which the caller bumps on each navigation outcome. The web runtime has no bridge and
 * reports no state.
 */
export function useBrowserCertificate(
  identity: BrowserSurfaceIdentity | null,
  revision: string,
  reload: () => void,
): BrowserCertificate {
  const [state, setState] = useState<BrowserCertificateState | null>(null);

  useEffect(() => {
    let active = true;
    readCertificateState(identity).then(
      (next) => {
        if (active) setState(next);
      },
      (error: unknown) => {
        if (active) showFailure("Couldn't read the certificate", error);
      },
    );
    return () => {
      active = false;
    };
  }, [identity, revision]);

  const proceed = useCallback(async (fingerprint: string) => {
    const bridge = certificateBridge();
    const surface = currentSurface(identity);
    if (!bridge || !surface) return;
    try {
      if (await bridge.proceed(surface, fingerprint)) reload();
      else showFailure("Couldn't trust this certificate", "The page changed. Reload and try again.");
    } catch (error) {
      showFailure("Couldn't trust this certificate", error);
    }
  }, [identity, reload]);

  const revoke = useCallback(async () => {
    const bridge = certificateBridge();
    const surface = currentSurface(identity);
    if (!bridge || !surface) return;
    try {
      await bridge.revoke(surface);
      reload();
    } catch (error) {
      showFailure("Couldn't stop trusting this site", error);
    }
  }, [identity, reload]);

  return { state, proceed, revoke };
}
