/** Ambient declaration for win-dpapi@1.1.0 (the package's own .d.ts uses the wrong module name). */
declare module "win-dpapi" {
  /**
   * Encrypts data using DPAPI with the current user's key.
   * Only available on Windows (win32).
   */
  function protectData(
    buffer: Buffer,
    optionalEntropy: Buffer | null,
    scope: "CurrentUser" | "LocalMachine",
  ): Buffer;

  /**
   * Decrypts a DPAPI-protected buffer using the current user's key.
   * Only available on Windows (win32).
   */
  function unprotectData(
    buffer: Buffer,
    optionalEntropy: Buffer | null,
    scope: "CurrentUser" | "LocalMachine",
  ): Buffer;

  export { protectData, unprotectData };
}
