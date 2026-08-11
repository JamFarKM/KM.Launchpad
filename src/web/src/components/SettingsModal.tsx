import { useState } from "react";
import { getSettings, setSettings, type Theme } from "../lib/settings";
import { ensureNotifyPermission } from "../lib/notify";

const THEMES: Theme[] = ["system", "light", "dark"];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState(getSettings());

  function update(next: typeof s) {
    setS(next);
    setSettings(next);
  }

  const denied = "Notification" in window && Notification.permission === "denied";

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-head">
          <div className="title">Settings</div>
          <button className="btn ghost small" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label className="label">Theme</label>
            <div className="row">
              {THEMES.map((t) => (
                <button
                  key={t}
                  className={`btn small ${s.theme === t ? "primary" : ""}`}
                  style={{ textTransform: "capitalize", flex: 1 }}
                  onClick={() => update({ ...s, theme: t })}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="label">Desktop notifications</label>
            <label className="row" style={{ gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={s.notifications}
                onChange={(e) => {
                  const on = e.target.checked;
                  update({ ...s, notifications: on });
                  if (on) ensureNotifyPermission();
                }}
              />
              <span>Notify me when a run or sequence finishes</span>
            </label>
            {s.notifications && denied && (
              <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
                Your browser is blocking notifications for this site — enable them in the browser’s site settings.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
