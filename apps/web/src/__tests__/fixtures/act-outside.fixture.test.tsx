import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";

// Runs only inside the act guard test's child Vitest, which sets this variable.
const runFixture = process.env.MCODE_ACT_GUARD_FIXTURE === "1";

let setCountOutsideAct: ((count: number) => void) | undefined;

function Counter() {
  const [count, setCount] = useState(0);
  setCountOutsideAct = setCount;
  return <output>{count}</output>;
}

it.runIf(runFixture)("updates React state outside act()", () => {
  render(<Counter />);
  setCountOutsideAct?.(1);
  expect(screen.getByRole("status")).toBeInTheDocument();
});
