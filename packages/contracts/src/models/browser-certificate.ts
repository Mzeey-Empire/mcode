import { z } from "zod";
import { lazySchema } from "../utils/lazySchema.js";

/** Bounded certificate details exposed by desktop main, with validity times in Unix seconds. */
export const BrowserCertificateFailureSchema = lazySchema(() => z.object({
  host: z.string().min(1).max(253),
  error: z.string().min(1).max(120),
  fingerprint: z.string().min(1).max(256),
  subjectName: z.string().max(500),
  issuerName: z.string().max(500),
  validStart: z.number().finite(),
  validExpiry: z.number().finite(),
}));

/** Latest rejected main-frame certificate for a Browser guest. */
export type BrowserCertificateFailure = z.infer<ReturnType<typeof BrowserCertificateFailureSchema>>;

/** Certificate warning and active host trust for one Browser surface. */
export const BrowserCertificateStateSchema = lazySchema(() => z.object({
  failure: BrowserCertificateFailureSchema().nullable(),
  exceptionInUse: z.boolean(),
}));

/** Certificate state read by the user-facing Browser chrome. */
export type BrowserCertificateState = z.infer<ReturnType<typeof BrowserCertificateStateSchema>>;
