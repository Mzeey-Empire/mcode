import type { z } from "zod";

/** Allowlisted database operation with validated cloneable inputs and committed outputs. */
export interface DatabaseWriteOperation<Input, Output> {
  readonly name: string;
  readonly input: z.ZodType<Input, z.ZodTypeDef, unknown>;
  readonly output: z.ZodType<Output, z.ZodTypeDef, unknown>;
}

/** Define one operation without exposing SQL or transaction state to callers. */
export function databaseWriteOperation<Input, Output>(
  name: string,
  input: z.ZodType<Input, z.ZodTypeDef, unknown>,
  output: z.ZodType<Output, z.ZodTypeDef, unknown>,
): DatabaseWriteOperation<Input, Output> {
  return { name, input, output };
}

/** Parse both sides while existing synchronous storage owns the business operation. */
export function databaseWriteHandler<Input, Output>(
  operation: DatabaseWriteOperation<Input, Output>,
  handler: (input: Input) => Output,
): (input: unknown) => unknown {
  return (input) => operation.output.parse(handler(operation.input.parse(input)));
}
