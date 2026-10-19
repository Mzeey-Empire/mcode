import { describeRefusal, type StartupRefusal } from "@mcode/contracts";

const BUTTONS = ["Quit", "Open data folder", "Copy details"] as const;
const QUIT = 0;
const OPEN_DATA_FOLDER = 1;
const COPY_DETAILS = 2;

const TITLES: Record<StartupRefusal["kind"], string> = {
  "database-newer": "Mcode cannot open this data",
  "database-busy": "Mcode is already updating this data",
  "database-unreadable": "Mcode cannot read the database",
  "database-unknown-history": "Mcode cannot identify this database",
  "migration-mismatch": "This database does not match this version of Mcode",
  "ledger-damaged": "The database update history is damaged",
  "migration-failed": "The database update failed",
};

/** The Electron surface the dialog uses, so tests can fake it at the boundary. */
export interface StartupRefusalDialogDependencies {
  dialog: {
    showMessageBox(options: {
      type: "error";
      title: string;
      message: string;
      detail: string;
      buttons: string[];
      defaultId: number;
      cancelId: number;
    }): Promise<{ response: number }>;
  };
  shell: { openPath(path: string): Promise<string> };
  clipboard: { writeText(text: string): void };
  /** The Mcode data folder. Opening it only shows it; nothing here changes its contents. */
  dataDir: string;
}

/** The title shown for a refusal. */
export function startupRefusalTitle(refusal: StartupRefusal): string {
  return TITLES[refusal.kind];
}

function refusalDetails(refusal: StartupRefusal): string {
  return `${startupRefusalTitle(refusal)}\n\n${describeRefusal(refusal)}\n\n${JSON.stringify(refusal, null, 2)}`;
}

/**
 * Tells the user why Mcode refused to start, and stays up until they choose Quit. Open data folder
 * and Copy details leave the box showing so the user can still quit afterwards. No choice
 * deletes, moves, or repairs data: the refusal exists to leave the files exactly as they are.
 */
export async function showStartupRefusalDialog(
  refusal: StartupRefusal,
  dependencies: StartupRefusalDialogDependencies,
): Promise<void> {
  const title = startupRefusalTitle(refusal);
  for (;;) {
    const { response } = await dependencies.dialog.showMessageBox({
      type: "error",
      title,
      message: title,
      detail: describeRefusal(refusal),
      buttons: [...BUTTONS],
      defaultId: QUIT,
      cancelId: QUIT,
    });
    if (response === OPEN_DATA_FOLDER) await openDataFolder(dependencies);
    else if (response === COPY_DETAILS) dependencies.clipboard.writeText(refusalDetails(refusal));
    else return;
  }
}

async function openDataFolder(dependencies: StartupRefusalDialogDependencies): Promise<void> {
  const failure = await dependencies.shell.openPath(dependencies.dataDir);
  if (failure) console.warn("[startup-refusal] Could not open the data folder", failure);
}
