import { ipcMain, Notification, type BrowserWindow } from "electron";

import { parseThreadNotificationRequest, ThreadNotifications } from "./thread-notifications.js";

/** Register `notifications:show`, accepted only from the main window's renderer. */
export function registerThreadNotificationHandler(getMainWindow: () => BrowserWindow | null): void {
  const notifications = new ThreadNotifications({
    getMainWindow,
    notification: {
      isSupported: () => Notification.isSupported(),
      create: (options) => new Notification(options),
    },
  });
  ipcMain.handle("notifications:show", (event, input: unknown) => {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error("Thread notifications require the main renderer");
    }
    notifications.show(parseThreadNotificationRequest(input));
  });
}
