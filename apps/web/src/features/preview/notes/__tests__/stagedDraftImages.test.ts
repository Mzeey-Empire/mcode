import { mockTransport } from "@/__tests__/mocks/transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildComposerAnnotationBundle } from "@/features/conversation/composer/submission/composer-annotations";
import { stagedSnapshotIds } from "@/lib/staged-snapshot-ids";
import { useComposerDraftStore } from "@/stores/composerDraftStore";
import { materializeStagedSnapshots, readStagedDraftImage, stageDraftImage } from "../stagedDraftImages";
import { BILLING_PAGE, seedPage, stagedImage } from "./fixtures";

const mockStage = vi.mocked(mockTransport.stageDraftImage);
vi.mock("@/transport", () => ({ getTransport: () => mockTransport }));

beforeEach(() => {
  vi.mocked(mockTransport.stageDraftImage).mockReset();
});

const THREAD = "thread-staged-images";
const readStaged = vi.fn();
const saveClipboardFile = vi.fn();

function sentBundle() {
  const bundle = buildComposerAnnotationBundle(THREAD);
  if (bundle?.schemaVersion !== 2) throw new Error("expected a v2 bundle");
  return bundle;
}

describe("staged draft images", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ drafts: {} });
    readStaged.mockReset();
    saveClipboardFile.mockReset().mockResolvedValue({
      id: "temp-1",
      name: "page.png",
      mimeType: "image/png",
      sizeBytes: 3,
      sourcePath: "C:/tmp/page.png",
    });
    mockStage.mockReset().mockImplementation(async () => stagedImage());
    vi.stubGlobal("window", { desktopBridge: { readStagedDraftImage: readStaged, saveClipboardFile } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads an image once and serves later reads from memory", async () => {
    const image = stagedImage();
    readStaged.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const first = await readStagedDraftImage(THREAD, image);
    const second = await readStagedDraftImage(THREAD, image);

    expect(second).toBe(first);
    expect(readStaged).toHaveBeenCalledTimes(1);
  });

  it("does not remember a missing image, so a later read can find a restaged one", async () => {
    const image = stagedImage();
    readStaged.mockResolvedValueOnce(null).mockResolvedValueOnce(new Uint8Array([7]));

    expect(await readStagedDraftImage(THREAD, image)).toBeNull();
    expect(await readStagedDraftImage(THREAD, image)).toEqual(new Uint8Array([7]));
  });

  it("serves the bytes it just staged without reading them back", async () => {
    const staged = await stageDraftImage(THREAD, new Uint8Array([9, 9]), "page.png");

    expect(await readStagedDraftImage(THREAD, staged)).toEqual(new Uint8Array([9, 9]));
    expect(readStaged).not.toHaveBeenCalled();
    expect(mockStage).toHaveBeenCalledWith(THREAD, expect.objectContaining({ sourcePath: "C:/tmp/page.png" }));
  });

  it("fails to stage when the desktop app cannot save the image", async () => {
    saveClipboardFile.mockResolvedValue(null);

    await expect(stageDraftImage(THREAD, new Uint8Array([1]), "page.png")).rejects.toThrow("Could not save");
    expect(mockStage).not.toHaveBeenCalled();
  });

  describe("materializing staged snapshots for a Send that creates a thread", () => {
    it("replaces each staged snapshot with a temp-file attachment holding its bytes", async () => {
      seedPage(THREAD);
      const bundle = sentBundle();
      expect(stagedSnapshotIds(bundle)).toHaveLength(1);
      readStaged.mockResolvedValue(new Uint8Array([4, 5, 6]));

      const materialized = await materializeStagedSnapshots(THREAD, bundle);

      expect(saveClipboardFile).toHaveBeenCalledWith(new Uint8Array([4, 5, 6]), "image/png", expect.any(String));
      expect(materialized?.schemaVersion === 2 && materialized.pages[0]?.snapshot).toEqual(
        expect.objectContaining({ id: "temp-1", sourcePath: "C:/tmp/page.png", sizeBytes: 3 }),
      );
      expect(stagedSnapshotIds(materialized)).toEqual([]);
    });

    it("fails the Send, naming the page, when a staged snapshot is gone", async () => {
      seedPage(THREAD, BILLING_PAGE, "Billing");
      readStaged.mockResolvedValue(null);

      await expect(materializeStagedSnapshots(THREAD, sentBundle())).rejects.toThrow("snapshot of Billing is gone");
      expect(saveClipboardFile).not.toHaveBeenCalled();
    });
  });
});
