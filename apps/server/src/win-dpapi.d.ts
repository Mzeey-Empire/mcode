/**
 * Ambient module declaration for win-dpapi.
 * The package's own .d.ts declares "node-dpapi" instead of "win-dpapi",
 * so we provide the correct declaration here.
 */
declare module "win-dpapi" {
  /**
   * Decrypts a DPAPI-protected buffer using the current user's key.
   * Only available on Windows (win32).
   */
  function unprotectData(
    buffer: Buffer,
    optionalEntropy: Buffer | null,
    scope: "CurrentUser" | "LocalMachine",
  ): Buffer;

  /**
   * Encrypts data with DPAPI.
   */
  function protectData(
    userData: Buffer,
    optionalEntropy: Buffer | null,
    scope: "CurrentUser" | "LocalMachine",
  ): Buffer;

  export { unprotectData, protectData };
}
