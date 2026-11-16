/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MCODE_WEB_AUTOMATION?: string;
}

declare module "*.css" {
  const content: string;
  export default content;
}

// The package's exports map this extensionless specifier to a stylesheet, so the "*.css" pattern above misses it,
// and TypeScript 7 rejects a side-effect import it cannot resolve to a declaration.
declare module "vlist/styles";
