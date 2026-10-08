import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noNumericZIndex } from "../rules/no-numeric-z-index.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
});

ruleTester.run("no-numeric-z-index", noNumericZIndex, {
  valid: [
  "const c = \"z-(--layer-modal) z-[var(--layer-modal)] z-[-1] -z-10 my-z-50 z-50-extra\";",
  "const s = { zIndex: \"var(--layer-modal)\", other: 50 };",
  "const s = { zIndex: offscreen ? 29 : 31 }; const t = { zIndex: layer };",
  "const s = { [key]: 50, [\"zIndex\"]: 50, zIndex: -1 };",
  "const c = `z-${layer}`;"
],
  invalid: [
  {
    "code": "const e = <div className=\"z-50\" />;",
    "errors": [
      {
        "messageId": "layerClass",
        "data": {
          "token": "z-50"
        }
      }
    ]
  },
  {
    "code": "const c = cn(\"z-[2]\", active && \"md:z-10\");",
    "errors": [
      {
        "messageId": "layerClass",
        "data": {
          "token": "z-[2]"
        }
      },
      {
        "messageId": "layerClass",
        "data": {
          "token": "md:z-10"
        }
      }
    ]
  },
  {
    "code": "const c = \"[&:hover]:!z-0 md:z-[70]!\";",
    "errors": [
      {
        "messageId": "layerClass",
        "data": {
          "token": "[&:hover]:!z-0"
        }
      },
      {
        "messageId": "layerClass",
        "data": {
          "token": "md:z-[70]!"
        }
      }
    ]
  },
  {
    "code": "const c = `z-20 ${tone} hover:z-[40]`;",
    "errors": [
      {
        "messageId": "layerClass",
        "data": {
          "token": "z-20"
        }
      },
      {
        "messageId": "layerClass",
        "data": {
          "token": "hover:z-[40]"
        }
      }
    ]
  },
  {
    "code": "const e = <div style={{ zIndex: 50 }} />;",
    "errors": [
      {
        "messageId": "layerStyle"
      }
    ]
  },
  {
    "code": "const s = { \"zIndex\": \"50\" };",
    "errors": [
      {
        "messageId": "layerStyle"
      }
    ]
  },
  {
    "code": "const s = { zIndex: 0 };",
    "errors": [
      {
        "messageId": "layerStyle"
      }
    ]
  }
],
});
