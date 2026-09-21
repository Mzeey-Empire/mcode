/** Start the Mcode server process. */
import { startServer } from "./application/bootstrap/server-bootstrap.js";
import { installServerDiagnostics } from "./runtime/diagnostics/server-diagnostics.js";

installServerDiagnostics();

void startServer().catch((error: unknown) => {
  console.error("Mcode server startup failed", error);
  process.exit(1);
});
