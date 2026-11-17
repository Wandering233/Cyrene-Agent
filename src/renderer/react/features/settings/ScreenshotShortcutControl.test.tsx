// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { ScreenshotShortcutControl } from "./ScreenshotShortcutControl";
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; delete (window as any).settings; });
it("录制、取消、冲突反馈和禁用通过主进程契约", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const begin = vi.fn().mockResolvedValue(true), end = vi.fn().mockResolvedValue(true);
  const configure = vi.fn().mockResolvedValueOnce({ ok: false, error: "conflict", status: { phase: "active" } })
    .mockResolvedValue({ ok: true, status: { phase: "disabled" } });
  (window as any).settings = { beginScreenshotHotkeyCapture: begin, endScreenshotHotkeyCapture: end,
    getScreenshotShortcutStatus: async () => ({ phase: "active" }), configureScreenshotShortcut: configure };
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<ScreenshotShortcutControl initialShortcut="Alt+Shift+S" initialEnabled />));
    const input = host.querySelector<HTMLInputElement>("input")!;
    const buttons = host.querySelectorAll("button");
    await act(async () => buttons[0].click()); expect(begin).toHaveBeenCalledOnce();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", ctrlKey: true, shiftKey: true, bubbles: true })));
    expect(input.value).toBe("Control+Shift+S"); expect(end).toHaveBeenCalledOnce();
    await act(async () => buttons[1].click()); expect(host.textContent).toContain("shortcutErrors.conflict");
    await act(async () => buttons[0].click());
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(input.value).toBe("Control+Shift+S");
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => buttons[1].click());
    expect(configure).toHaveBeenLastCalledWith({ accelerator: "Control+Shift+S", enabled: false });
  } finally { await act(async () => root.unmount()); }
});
