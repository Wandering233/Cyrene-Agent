// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../ui/theme", () => ({}));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });
it("提醒中心键盘关闭按钮只 dismiss，卡片 Space 激活，Escape 关闭窗口", async () => {
  vi.resetModules();
  window.history.replaceState({}, "", "/toast/?interactive=1");
  document.body.innerHTML = '<div id="toast-stack"></div>';
  vi.stubGlobal("ResizeObserver", class { observe() {} });
  vi.stubGlobal("Audio", class { play() { return Promise.resolve(); } });
  const clicked = vi.fn(), dismissed = vi.fn(), resized = vi.fn(), close = vi.spyOn(window, "close").mockImplementation(() => {});
  (window as any).toast = { getAll: async () => [{ id: "one", title: "test", tier: "notify", createdAt: 1 }],
    clicked, dismissed, reportHeight: resized, onPush() {}, onRemove() {} };
  await import("./toast"); await Promise.resolve();
  const card = document.querySelector<HTMLElement>(".toast-card")!;
  const button = card.querySelector("button")!;
  button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  expect(dismissed).toHaveBeenCalledOnce(); expect(clicked).not.toHaveBeenCalled();
  card.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
  expect(clicked).toHaveBeenCalledWith("one"); expect(resized).not.toHaveBeenCalled();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); expect(close).toHaveBeenCalledOnce();
});
