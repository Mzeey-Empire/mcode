import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noArbitraryTextSize } from "../rules/no-arbitrary-text-size.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "tsx" } },
});

ruleTester.run("no-arbitrary-text-size", noArbitraryTextSize, {
  valid: [
  "const c = \"text-caption text-body-small text-label text-body text-code text-xl\";",
  "const c = \"text-[var(--size)] text-[#fff] text-[length:var(--size)] text-[120%] my-text-[12px] text-[12px]-extra\";",
  "const c = `text-${size}`;"
],
  invalid: [
  {
    "code": "const e = <span className=\"text-[10px]\" />;",
    "errors": [
      {
        "messageId": "textSize",
        "data": {
          "token": "text-[10px]"
        }
      }
    ]
  },
  {
    "code": "const c = cn(\"text-[1.1rem]\", active && \"md:text-[.8em]\");",
    "errors": [
      {
        "messageId": "textSize",
        "data": {
          "token": "text-[1.1rem]"
        }
      },
      {
        "messageId": "textSize",
        "data": {
          "token": "md:text-[.8em]"
        }
      }
    ]
  },
  {
    "code": "const c = \"[&:hover]:!text-[10.5px] md:text-[14px]!\";",
    "errors": [
      {
        "messageId": "textSize",
        "data": {
          "token": "[&:hover]:!text-[10.5px]"
        }
      },
      {
        "messageId": "textSize",
        "data": {
          "token": "md:text-[14px]!"
        }
      }
    ]
  },
  {
    "code": "const c = `text-[12px] ${tone} hover:text-[15px]`;",
    "errors": [
      {
        "messageId": "textSize",
        "data": {
          "token": "text-[12px]"
        }
      },
      {
        "messageId": "textSize",
        "data": {
          "token": "hover:text-[15px]"
        }
      }
    ]
  }
],
});
