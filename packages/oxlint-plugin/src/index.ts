import { definePlugin } from "@oxlint/plugins";
import { namespaceNodeImports } from "./rules/namespace-node-imports.ts";
import { noArbitraryTextSize } from "./rules/no-arbitrary-text-size.ts";
import { noNumericZIndex } from "./rules/no-numeric-z-index.ts";
import { noFunctionScopeZodSchema } from "./rules/no-function-scope-zod-schema.ts";
import { noEllipsisTruncation } from "./rules/no-ellipsis-truncation.ts";
import { noGlobalHostRuntime } from "./rules/no-global-host-runtime.ts";
import { noNativeTitleTooltip } from "./rules/no-native-title-tooltip.ts";
import { noRawColor } from "./rules/no-raw-color.ts";
import { noRawShadow } from "./rules/no-raw-shadow.ts";
import { noRealTimerSleep } from "./rules/no-real-timer-sleep.ts";
import { noInlineModuleMock } from "./rules/no-inline-module-mock.ts";
import { noSourceTextTest } from "./rules/no-source-text-test.ts";
import { requireLazyNontrivialSchema } from "./rules/require-lazy-nontrivial-schema.ts";
import { useTestBuilder } from "./rules/use-test-builder.ts";

/** Mcode-specific code-quality rules for Oxlint. */
export const mcodePlugin = definePlugin({
  meta: { name: "mcode" },
  rules: {
    "namespace-node-imports": namespaceNodeImports,
    "no-arbitrary-text-size": noArbitraryTextSize,
    "no-numeric-z-index": noNumericZIndex,
    "no-function-scope-zod-schema": noFunctionScopeZodSchema,
    "no-ellipsis-truncation": noEllipsisTruncation,
    "no-global-host-runtime": noGlobalHostRuntime,
    "no-native-title-tooltip": noNativeTitleTooltip,
    "no-raw-color": noRawColor,
    "no-raw-shadow": noRawShadow,
    "no-real-timer-sleep": noRealTimerSleep,
    "no-inline-module-mock": noInlineModuleMock,
    "no-source-text-test": noSourceTextTest,
    "require-lazy-nontrivial-schema": requireLazyNontrivialSchema,
    "use-test-builder": useTestBuilder,
  },
});

export default mcodePlugin;
