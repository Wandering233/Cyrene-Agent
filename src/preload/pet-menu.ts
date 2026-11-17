import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";

contextBridge.exposeInMainWorld("petMenu", {
  action: (action: "settings" | "hide" | "quit" | "close") => ipcRenderer.invoke(IPC.PET_MENU_ACTION, action),
});
