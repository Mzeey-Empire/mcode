import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterAll, expect, it } from "vitest";

// Runs only inside the act guard test's child Vitest, which names the case to run.
const fixtureCase = process.env.MCODE_ACT_GUARD_FIXTURE;

let setCountOutsideAct: ((count: number) => void) | undefined;

function Counter() {
  const [count, setCount] = useState(0);
  setCountOutsideAct = setCount;
  return <output>{count}</output>;
}

it.runIf(fixtureCase === "one")("updates React state outside act()", () => {
  render(<Counter />);
  setCountOutsideAct?.(1);
  expect(screen.getByRole("status")).toBeInTheDocument();
});

it.runIf(fixtureCase === "flood")("updates React state outside act() 500 times", () => {
  render(<Counter />);
  for (let count = 1; count <= 500; count += 1) setCountOutsideAct?.(count);
  expect(screen.getByRole("status")).toBeInTheDocument();
});

it.runIf(fixtureCase === "after-all")("passes before the file's afterAll runs", () => {
  expect(fixtureCase).toBe("after-all");
});

afterAll(() => {
  if (fixtureCase !== "after-all") return;
  render(<Counter />);
  setCountOutsideAct?.(1);
});
