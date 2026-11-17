import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const state=vi.hoisted(()=>({clients:[] as any[],calls:[] as string[][],error:null as Error|null}));
vi.mock("electron",()=>({}));
vi.mock("node:child_process",()=>({execFile:(_command:string,args:string[],_options:unknown,done:(error:Error|null,stdout:string,stderr:string)=>void)=>{
  if(state.error){done(state.error,"","");return;}
  if(args[0]==="-j"){done(null,JSON.stringify(state.clients),"");return;}
  state.calls.push(args);done(null,"ok","");
}}));
import {isWindowMaximized,toggleWindowMaximized} from "./window-display-mode";
const client={pid:process.pid,address:"0x123",title:"Cyrene mode",initialTitle:"Cyrene mode",at:[100,100],size:[500,400],floating:true,fullscreen:0};
const window=()=>({getTitle:()=>"Cyrene mode",isDestroyed:()=>false,isMaximized:()=>true,maximize:vi.fn(),unmaximize:vi.fn()});
beforeEach(()=>{vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE","test");state.clients=[{...client}];state.calls=[];state.error=null;});
afterEach(()=>vi.unstubAllEnvs());
describe("Hyprland 窗口显示模式",()=>{
  it("Electron 返回 maximized 的普通窗口仍显示还未最大化；点击明确设置 compositor 最大化",async()=>{
    const win=window();expect(await isWindowMaximized(win as never)).toBe(false);
    expect(await toggleWindowMaximized(win as never)).toBe(true);
    expect(state.calls[0][1]).toBe('hl.dsp.window.fullscreen({window="address:0x123",mode="maximized",action="set"})');
    expect(win.unmaximize).not.toHaveBeenCalled();
  });
  it("最大化窗口执行 unset，真正全屏保持模式；并发请求只发送一次",async()=>{
    const win=window();state.clients=[{...client,fullscreen:1}];expect(await isWindowMaximized(win as never)).toBe(true);
    await Promise.all([toggleWindowMaximized(win as never),toggleWindowMaximized(win as never)]);
    expect(state.calls).toHaveLength(1);expect(state.calls[0][1]).toContain('action="unset"');
    state.clients=[{...client,fullscreen:2}];expect(await isWindowMaximized(win as never)).toBe(false);
    expect(await toggleWindowMaximized(win as never)).toBe(false);expect(state.calls).toHaveLength(1);
  });
  it("窗口缺失、其他进程、同名歧义、关闭或查询失败不修改窗口",async()=>{
    const win=window();
    for(const clients of [[],[{...client,pid:process.pid+1}],[client,{...client,address:"0x456"}],[{...client,address:'0x123";bad'}]]){
      state.clients=clients;expect(await toggleWindowMaximized(win as never)).toBe(false);
    }
    state.clients=[client];expect(await toggleWindowMaximized({...win,isDestroyed:()=>true} as never)).toBe(false);
    state.error=new Error("compositor unavailable");await expect(toggleWindowMaximized(win as never)).rejects.toThrow("unavailable");
    expect(state.calls).toHaveLength(0);state.error=null;
    expect(await toggleWindowMaximized(win as never)).toBe(true);
  });
  it("非 Hyprland 保留 Electron 原来的切换行为",async()=>{
    vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE","");const win=window();
    expect(await isWindowMaximized(win as never)).toBe(true);await toggleWindowMaximized(win as never);
    expect(win.unmaximize).toHaveBeenCalledOnce();expect(state.calls).toHaveLength(0);
  });
});
