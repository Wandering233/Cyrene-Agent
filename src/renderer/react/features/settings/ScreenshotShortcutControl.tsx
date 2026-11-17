import { useEffect, useRef, useState } from "react";
import { normalizeScreenshotShortcut, shortcutFromKeyboardEvent, type ScreenshotShortcutStatus } from "../../../../shared/screenshot-shortcut";
import { useTranslation } from "../../i18n";

export function ScreenshotShortcutControl({ initialShortcut, initialEnabled }: { initialShortcut: string; initialEnabled: boolean }) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initialShortcut);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const previous = useRef(initialShortcut);
  const capture = useRef(false);
  const finishCapture = async () => {
    if (!capture.current) return;
    capture.current = false;
    await window.settings?.endScreenshotHotkeyCapture?.().catch(() => {});
  };
  useEffect(() => {
    void window.settings?.getScreenshotShortcutStatus?.().then((status: ScreenshotShortcutStatus) => {
      if (status.phase === "error") setNotice(t(`settingsPage.shortcutErrors.${status.error ?? "unavailable"}`));
    }).catch(() => { setNotice(t("settingsPage.shortcutErrors.unavailable")); });
    return () => { void finishCapture(); };
  }, []);
  const record = async () => {
    if (busy) return;
    previous.current = value;
    try {
      capture.current = true;
      await window.settings?.beginScreenshotHotkeyCapture?.();
    } catch { capture.current = false; setNotice(t("settingsPage.shortcutErrors.unavailable")); return; }
    setRecording(true); setNotice(t("settingsPage.shortcutRecording")); input.current?.focus();
  };
  const apply = async () => {
    const normalized = normalizeScreenshotShortcut(value);
    if (!normalized) { setNotice(t("settingsPage.shortcutErrors.invalid")); return; }
    setBusy(true);
    try {
      await finishCapture(); setRecording(false);
      const result = await window.settings?.configureScreenshotShortcut?.({ accelerator: normalized, enabled });
      if (!result) throw new Error("unavailable");
      if (!result.ok) { setNotice(t(`settingsPage.shortcutErrors.${result.error}`)); return; }
      setValue(normalized); setEnabled(result.status.phase !== "disabled"); setNotice(t("settingsPage.saved"));
    } catch { setNotice(t("settingsPage.shortcutErrors.unavailable")); }
    finally { setBusy(false); }
  };
  return <div className="cy-shortcut-control">
    <div className="cy-shortcut-control__actions">
      <input ref={input} className="cy-settings-hotkey-input" aria-label={t("settingsPage.screenshotHotkey")}
        value={value} disabled={busy} readOnly={recording}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (!recording) return;
          event.preventDefault(); event.stopPropagation();
          if (event.key === "Escape") {
            setValue(previous.current); setRecording(false); setNotice(""); void finishCapture(); return;
          }
          const shortcut = shortcutFromKeyboardEvent(event.nativeEvent);
          if (shortcut) { setValue(shortcut); setRecording(false); setNotice(""); void finishCapture(); }
        }}
        onBlur={() => { if (recording) { setValue(previous.current); setRecording(false); setNotice(""); void finishCapture(); } }} />
      <button type="button" onClick={() => { void record(); }} disabled={busy || recording}>{t("settingsPage.shortcutRecord")}</button>
      <button type="button" onClick={() => { void apply(); }} disabled={busy || recording}>{t("settingsPage.shortcutApply")}</button>
    </div>
    <label><input type="checkbox" checked={enabled} disabled={busy || recording}
      onChange={(event) => setEnabled(event.target.checked)} />{t("settingsPage.shortcutEnabled")}</label>
    <span role="status" aria-live="polite">{notice}</span>
  </div>;
}
