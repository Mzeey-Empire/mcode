import { describe, expect, it, vi } from "vitest";
import { describeRefusal, type StartupRefusal } from "@mcode/contracts/startup-failure";
import { showStartupRefusalDialog, startupRefusalTitle } from "../startup-refusal-dialog.js";

const QUIT = 0;
const OPEN_DATA_FOLDER = 1;
const COPY_DETAILS = 2;

const DATA_DIR = "/home/user/.mcode";
const refusal: StartupRefusal = { kind: "database-newer", databasePath: `${DATA_DIR}/mcode.db`, raisedBy: "0093_next" };

function fakeElectron(responses: number[], openPathResult = "") {
  const remaining = [...responses];
  const dialog = { showMessageBox: vi.fn(async () => ({ response: remaining.shift() ?? QUIT })) };
  const shell = { openPath: vi.fn(async () => openPathResult) };
  const clipboard = { writeText: vi.fn() };
  return { dialog, shell, clipboard, dataDir: DATA_DIR };
}

describe("showStartupRefusalDialog", () => {
  it("shows one error box with the refusal's title and plain-word description", async () => {
    const electron = fakeElectron([QUIT]);

    await showStartupRefusalDialog(refusal, electron);

    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(electron.dialog.showMessageBox).toHaveBeenCalledWith({
      type: "error",
      title: startupRefusalTitle(refusal),
      message: startupRefusalTitle(refusal),
      detail: describeRefusal(refusal),
      buttons: ["Quit", "Open data folder", "Copy details"],
      defaultId: QUIT,
      cancelId: QUIT,
    });
    expect(describeRefusal(refusal)).toContain(refusal.databasePath);
  });

  it("opens the data folder, then keeps the box up so the user can still quit", async () => {
    const electron = fakeElectron([OPEN_DATA_FOLDER, QUIT]);

    await showStartupRefusalDialog(refusal, electron);

    expect(electron.shell.openPath).toHaveBeenCalledExactlyOnceWith(DATA_DIR);
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(electron.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("copies the title, the description, and the refusal data to the clipboard", async () => {
    const electron = fakeElectron([COPY_DETAILS, QUIT]);

    await showStartupRefusalDialog(refusal, electron);

    expect(electron.clipboard.writeText).toHaveBeenCalledTimes(1);
    const copied = electron.clipboard.writeText.mock.calls[0]?.[0];
    expect(copied).toContain(startupRefusalTitle(refusal));
    expect(copied).toContain(describeRefusal(refusal));
    expect(copied).toContain('"raisedBy": "0093_next"');
    expect(electron.shell.openPath).not.toHaveBeenCalled();
    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2);
  });

  it("keeps the box up when the data folder cannot be opened", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const electron = fakeElectron([OPEN_DATA_FOLDER, QUIT], "Failed to open path");

    await showStartupRefusalDialog(refusal, electron);

    expect(electron.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith("[startup-refusal] Could not open the data folder", "Failed to open path");
    warn.mockRestore();
  });
});
