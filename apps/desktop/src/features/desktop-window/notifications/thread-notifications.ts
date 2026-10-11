/** Renderer channel that receives the tag of a clicked thread notification. */
export const THREAD_NOTIFICATION_CLICKED_CHANNEL = "notifications:clicked";

const TAG_MAX_LENGTH = 256;
const TITLE_MAX_LENGTH = 200;
const BODY_MAX_LENGTH = 300;

/** A validated request from the renderer to raise one OS notification for a thread. */
export interface ThreadNotificationRequest {
  /** Identifies the thread; one live notification exists per tag. */
  readonly tag: string;
  readonly title: string;
  readonly body: string;
}

/** The main-window surface a notification click needs. */
export interface ThreadNotificationWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  readonly webContents: { send(channel: string, tag: string): void };
}

/** The subset of Electron's `Notification` instance this feature drives. */
export interface ThreadNotificationHandle {
  on(event: "click" | "close", listener: () => void): void;
  show(): void;
  close(): void;
}

/** Dependencies for {@link ThreadNotifications}. */
export interface ThreadNotificationsDependencies {
  readonly getMainWindow: () => ThreadNotificationWindow | null;
  readonly notification: {
    isSupported(): boolean;
    create(options: { title: string; body: string }): ThreadNotificationHandle;
  };
}

function requireText(record: Record<string, unknown>, key: string, maxLength: number, allowEmpty: boolean): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`Thread notification ${key} must be a string`);
  if (!allowEmpty && value.length === 0) throw new Error(`Thread notification ${key} must not be empty`);
  if (value.length > maxLength) throw new Error(`Thread notification ${key} exceeds ${maxLength} characters`);
  return value;
}

/** Parse an untrusted renderer payload into a notification request, or throw. */
export function parseThreadNotificationRequest(input: unknown): ThreadNotificationRequest {
  if (typeof input !== "object" || input === null) throw new Error("Thread notification must be an object");
  const record = input as Record<string, unknown>;
  return {
    tag: requireText(record, "tag", TAG_MAX_LENGTH, false),
    title: requireText(record, "title", TITLE_MAX_LENGTH, false),
    body: requireText(record, "body", BODY_MAX_LENGTH, true),
  };
}

/** Raises one OS notification per thread and brings Mcode forward on that thread when clicked. */
export class ThreadNotifications {
  private readonly live = new Map<string, ThreadNotificationHandle>();

  constructor(private readonly dependencies: ThreadNotificationsDependencies) {}

  /** Replace any live notification for the request's tag with a new one. */
  show(request: ThreadNotificationRequest): void {
    if (!this.dependencies.notification.isSupported()) return;
    this.live.get(request.tag)?.close();
    const notification = this.dependencies.notification.create({ title: request.title, body: request.body });
    this.live.set(request.tag, notification);
    notification.on("click", () => {
      this.forget(request.tag, notification);
      this.focusThread(request.tag);
    });
    notification.on("close", () => this.forget(request.tag, notification));
    notification.show();
  }

  private forget(tag: string, notification: ThreadNotificationHandle): void {
    // A replaced notification's late close must not drop its successor.
    if (this.live.get(tag) === notification) this.live.delete(tag);
  }

  private focusThread(tag: string): void {
    const window = this.dependencies.getMainWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send(THREAD_NOTIFICATION_CLICKED_CHANNEL, tag);
  }
}
