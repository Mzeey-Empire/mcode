/**
 * Ambient module declaration for win-dpapi.
 * The package's own .d.ts declares "node-dpapi" instead of "win-dpapi",
 * so we provide the correct declaration here.
 */
declare module "win-dpapi" {
  /**
   * Decrypts DPAPI-protected data.
   */
  function unprotectData(
    encryptedData: Buffer,
    optionalEntropy: null | Buffer,
    scope: "CurrentUser" | "LocalMachine",
  ): Buffer;

  /**
   * Encrypts data with DPAPI.
   */
  function protectData(
    userData: Buffer,
    optionalEntropy: null | Buffer,
    scope: "CurrentUser" | "LocalMachine",
  ): Buffer;
}
