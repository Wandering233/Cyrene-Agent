import { EventEmitter } from "node:events";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
const state=vi.hoisted(()=>({calls:[] as string[][],title:"",fail:false}));
vi.mock("node:child_process",()=>({execFile:(_command:string,args:string[],_options:unknown,done:(error:Error|null,stdout:string,stderr:string)=>void)=>{
  state.calls.push(args);
  if(state.fail){done(new Error("rule denied"),"","");return;}
  if(args[0]==="-j") done(null,JSON.stringify([{pid:process.pid,initialTitle:state.title,mapped:true,hidden:false}]),"");
  else done(null,"ok","");
}}));
import {showWindowInactive,disposeInactiveWindowRules} from "./inactive-window";
function windowStub(){let visible=false,destroyed=false,title="Cyrene reminder";return Object.assign(new EventEmitter(),{
 getTitle:()=>title,setTitle:vi.fn((value:string)=>{title=value;state.title=value;}),isDestroyed:()=>destroyed,isVisible:()=>visible,
 webContents:{isLoadingMainFrame:()=>false},
 showInactive:vi.fn(()=>{visible=true;}),hide:()=>{visible=false;},destroy(){destroyed=true;this.emit("closed");},
});}
beforeEach(()=>{vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE","test");state.calls=[];state.title="";state.fail=false;});
afterEach(async()=>{await disposeInactiveWindowRules();vi.unstubAllEnvs();});
describe("Hyprland 非聚焦窗口",()=>{
 it("显示前安装唯一规则，标题恢复，重显沿用规则，关闭后只禁用自己的规则",async()=>{
  const win=windowStub();await Promise.all([showWindowInactive(win as never),showWindowInactive(win as never)]);
  expect(win.showInactive).toHaveBeenCalledOnce();expect(state.calls[0][0]).toBe("eval");
  expect(state.calls[0][1]).toMatch(/initial_title="\^cyrene-inactive-\d+-[a-f0-9]{32}\$"/);
  expect(state.calls[0][1]).toContain('xwayland=false},no_initial_focus=true,no_focus=true');
  expect(win.getTitle()).toBe("Cyrene reminder");win.hide();await showWindowInactive(win as never);
  expect(win.showInactive).toHaveBeenCalledTimes(2);expect(state.calls.filter(args=>args[0]==="eval")).toHaveLength(2);
  win.destroy();await Promise.resolve();await Promise.resolve();
  expect(state.calls.at(-1)?.[1]).toMatch(/enabled=false/);
 });
 it("规则失败不显示窗口；关闭发生在等待规则期间也不显示",async()=>{
  state.fail=true;const denied=windowStub();await expect(showWindowInactive(denied as never)).rejects.toThrow("denied");
  expect(denied.showInactive).not.toHaveBeenCalled();
  state.fail=false;const closed=windowStub();const showing=showWindowInactive(closed as never);closed.destroy();await showing;
  expect(closed.showInactive).not.toHaveBeenCalled();
 });
 it("队列取消时不映射窗口；失败可重试，退出隐藏并等待规则禁用",async()=>{
  const win=windowStub();await showWindowInactive(win as never,()=>false);expect(win.showInactive).not.toHaveBeenCalled();
  state.fail=true;await expect(showWindowInactive(win as never)).rejects.toThrow("denied");state.fail=false;
  await showWindowInactive(win as never);expect(win.showInactive).toHaveBeenCalledOnce();
  await disposeInactiveWindowRules();expect(win.isVisible()).toBe(false);expect(state.calls.at(-1)?.[1]).toContain("enabled=false");
  const count=state.calls.length;await showWindowInactive(win as never);expect(state.calls).toHaveLength(count);
 });
 it("页面加载完成后才映射，等待加载期间取消不显示",async()=>{
  const win=windowStub();let loading=true;win.webContents.isLoadingMainFrame=()=>loading;
  vi.useFakeTimers();
  try {
    const show=showWindowInactive(win as never);await vi.advanceTimersByTimeAsync(100);
    expect(win.showInactive).not.toHaveBeenCalled();loading=false;await vi.advanceTimersByTimeAsync(50);await show;
    expect(win.showInactive).toHaveBeenCalledOnce();win.hide();loading=true;let wanted=true;
    const cancelled=showWindowInactive(win as never,()=>wanted);await vi.advanceTimersByTimeAsync(50);
    wanted=false;await vi.advanceTimersByTimeAsync(50);await cancelled;
    expect(win.showInactive).toHaveBeenCalledTimes(1);win.destroy();
  } finally {vi.useRealTimers();}
 });
 it("非 Hyprland 维持 Electron showInactive；已经可见或销毁不重复显示",async()=>{
  vi.stubEnv("HYPRLAND_INSTANCE_SIGNATURE","");const win=windowStub();await showWindowInactive(win as never);await showWindowInactive(win as never);
  win.destroy();await showWindowInactive(win as never);expect(win.showInactive).toHaveBeenCalledOnce();expect(state.calls).toHaveLength(0);
 });
});
