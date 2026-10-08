/**
 * Missing durable image, mapped to a structured RPC failure by the router.
 * Kept free of DI imports so the router can load it without the reflect polyfill.
 */
export class DraftImageMissingError extends Error {
  readonly code = "draft_image_missing";
  constructor(readonly stagingId: string) {
    super(`Draft image is missing: ${stagingId}`);
  }
}
