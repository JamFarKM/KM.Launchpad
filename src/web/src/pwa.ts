// Captures the browser's install prompt so a custom "Install" button can trigger it.
// Imported for its side effects early in main.tsx so the event isn't missed.

let deferred: (Event & { prompt: () => void; userChoice: Promise<{ outcome: string }> }) | null = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e as typeof deferred;
  window.dispatchEvent(new Event("pl-can-install"));
});

window.addEventListener("appinstalled", () => {
  deferred = null;
  window.dispatchEvent(new Event("pl-installed"));
});

export function canInstall(): boolean {
  return !!deferred;
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  deferred.prompt();
  const choice = await deferred.userChoice.catch(() => ({ outcome: "dismissed" }));
  deferred = null;
  return choice.outcome === "accepted";
}
