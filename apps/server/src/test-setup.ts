import { logger } from "@mcode/shared";

// Tests remove per-test data directories before the process-wide logger shuts down.
// Keep console diagnostics without the format that lazily attaches a file transport.
logger.configure({
  format: { transform: (info) => info },
  transports: logger.transports,
});
