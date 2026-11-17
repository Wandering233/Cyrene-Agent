import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberOutputPosition } from "../pet-overlay/output-position";
const mocks = vi.hoisted(() => ({ displays: [] as any[], overlay: vi.fn() }));
vi.mock("electron", () => ({
  app: {}, BrowserWindow: class {}, screen: {
    getAllDisplays: () => mocks.displays, getPrimaryDisplay: () => mocks.displays[0],
    getDisplayMatching: ({ x }: { x: number }) => mocks.displays.find((d) => x >= d.bounds.x && x < d.bounds.x + d.bounds.width) ?? mocks.displays[0],
  },
}));
vi.mock("../pet-overlay", () => ({ createPetOverlayWindow: mocks.overlay, shouldUsePetOverlay: () => true }));
import { createPetWindow } from "./create-pet-window";
function display(label: string, x: number, width = 1920) {
  return { label, bounds: { x, y: 0, width, height: 1080 }, workArea: { x, y: 0, width, height: 1080 }, scaleFactor: 1 };
}
beforeEach(() => { mocks.overlay.mockReset().mockReturnValue({ window: {} }); vi.stubEnv("CYRENE_OVERLAY_SCALE", "1"); });

afterEach(() => vi.unstubAllEnvs());

describe("按输出恢复桌宠位置", () => {
  it.each([2238, -1920])("保存/重启后在副屏原点 %i 恢复，并适应输出原点变化", (origin) => {
    mocks.displays = [display("(PRIMARY)", 0), display("(SECONDARY)", origin)];
    const saved = rememberOutputPosition({}, { x: origin + 300, y: 100 }, "SECONDARY", mocks.displays);
    const settings = JSON.parse(JSON.stringify({ petWindowOutput: "SECONDARY", petWindowPositions: saved,
      petWindowX: origin + 300, petWindowY: 100 }));
    createPetWindow({ loadGeneralSettings: () => settings, getCurrentAppIconPath: () => "icon", isDev: false });
    expect(mocks.overlay).toHaveBeenLastCalledWith(expect.objectContaining({ x: origin + 300, y: 100,
      output: "SECONDARY", outputOrigin: { x: origin, y: 0 } }));
    const relocated = origin > 0 ? 3000 : -2500;
    mocks.displays[1] = display("(SECONDARY)", relocated);
    createPetWindow({ loadGeneralSettings: () => settings, getCurrentAppIconPath: () => "icon", isDev: false });
    expect(mocks.overlay).toHaveBeenLastCalledWith(expect.objectContaining({ x: relocated + 300, output: "SECONDARY" }));
  });
  it("副屏移除后保留其记录，并在主屏可见区域恢复", () => {
    mocks.displays = [display("(PRIMARY)", 0)];
    const positions = { SECONDARY: { x: 300, y: 100 } };
    expect(rememberOutputPosition(positions, { x: 2500, y: 100 }, "SECONDARY", mocks.displays)).toEqual(positions);
    createPetWindow({ loadGeneralSettings: () => ({ petWindowOutput: "SECONDARY", petWindowPositions: positions,
      petWindowX: 2500, petWindowY: 100 }), getCurrentAppIconPath: () => "icon", isDev: false });
    expect(mocks.overlay).toHaveBeenLastCalledWith(expect.objectContaining({ output: "PRIMARY", x: 760, y: 290 }));
  });
});
