/**
 * Lightweight context menu for the offscreen pet overlay.
 *
 * Native Electron menus cannot attach to the hidden offscreen window reliably;
 * this menu is rendered into the same frame stream, so it is hit-tested by the
 * native host's alpha input region like any other pet UI.
 */
export function installPetContextMenu(): void {
  if (document.getElementById("cyrene-pet-context-menu")) return;

  const menu = document.createElement("div");
  menu.id = "cyrene-pet-context-menu";
  menu.setAttribute("role", "menu");
  Object.assign(menu.style, {
    position: "fixed",
    zIndex: "2147483647",
    minWidth: "160px",
    padding: "6px",
    borderRadius: "10px",
    background: "rgba(28,28,34,0.96)",
    color: "#eee",
    font: "13px system-ui, sans-serif",
    boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
    display: "none",
    userSelect: "none",
  });

  const addItem = (label: string, action: () => void) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("role", "menuitem");
    Object.assign(button.style, {
      display: "block",
      width: "100%",
      padding: "8px 10px",
      border: "0",
      borderRadius: "6px",
      background: "transparent",
      color: "inherit",
      textAlign: "left",
      cursor: "pointer",
      font: "inherit",
    });
    button.addEventListener("mouseenter", () => { button.style.background = "rgba(255,255,255,0.12)"; });
    button.addEventListener("mouseleave", () => { button.style.background = "transparent"; });
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      hide();
      action();
    });
    menu.appendChild(button);
  };

  const hide = (): void => { menu.style.display = "none"; };

  const cyrene = (window as unknown as {
    cyrene?: { hide?: () => void; quit?: () => void };
    settings?: { openSection?: (section?: string) => Promise<unknown> };
  }).cyrene;
  const settings = (window as unknown as {
    settings?: { openSection?: (section?: string) => Promise<unknown> };
  }).settings;

  addItem("设置", () => { void settings?.openSection?.("appearance"); });
  addItem("隐藏桌宠", () => { cyrene?.hide?.(); });
  addItem("退出", () => { cyrene?.quit?.(); });

  window.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const x = Math.min(event.clientX, Math.max(0, window.innerWidth - 180));
    const y = Math.min(event.clientY, Math.max(0, window.innerHeight - 140));
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.style.display = "block";
    document.body.appendChild(menu);
  });
  window.addEventListener("pointerdown", (event) => {
    if (event.target !== menu && !menu.contains(event.target as Node)) hide();
  }, true);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  document.body.appendChild(menu);
}
