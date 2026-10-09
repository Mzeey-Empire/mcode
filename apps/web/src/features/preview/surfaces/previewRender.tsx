/**
 * Owns the existing conditional render helpers shared by page and design layers, preserving nullable-value narrowing without adding DOM elements.
 */
import type { ReactNode } from "react";

/** Renders children only while the condition holds, without a DOM wrapper. */
export function RenderWhen({
  condition,
  children,
}: {
  readonly condition: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return condition ? <>{children}</> : null;
}

/** Renders a present value with null and undefined excluded from the child argument. */
export function RenderValue<T>({
  value,
  children,
}: {
  readonly value: T | null | undefined;
  readonly children: (value: T) => ReactNode;
}): ReactNode {
  if (value === null || value === undefined) return null;
  return children(value);
}
