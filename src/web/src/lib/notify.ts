// Desktop notifications for pipeline run completions.

export function ensureNotifyPermission(): void {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

export function canNotify(): boolean {
  return "Notification" in window && Notification.permission === "granted";
}

export function notify(title: string, body: string, tag?: string): void {
  if (!canNotify()) return;
  try {
    new Notification(title, { body, tag });
  } catch {
    /* some browsers throw if constructed outside a user gesture; ignore */
  }
}
