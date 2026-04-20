// TextEncoder/TextDecoder are available in both Node.js (>=11) and browsers.
// Declaring them here avoids pulling the full DOM lib into a package that
// must remain environment-agnostic.
declare const TextEncoder: typeof globalThis.TextEncoder;
declare const TextDecoder: typeof globalThis.TextDecoder;
