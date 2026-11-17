#!/usr/bin/env node
import {mkdtemp,mkdir,readFile,writeFile,chmod,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import http from 'node:http';
import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const root=await mkdtemp(path.join(os.tmpdir(),'cyrene-update-feed-'));
const wait=async(condition)=>{const limit=Date.now()+45000;while(Date.now()<limit){if(await condition())return;await new Promise(r=>setTimeout(r,60));}throw new Error('update fixture timed out');};
let child,server;let logs='';
try{
  for(const mode of ['healthy','exit','host-mismatch','checksum']){
    const directory=path.join(root,mode);const shell=path.join(directory,'app');await mkdir(shell,{recursive:true});await mkdir(path.join(directory,'data'));
    const target=path.join(directory,'Cyrene custom.AppImage');
    const old=`#!/usr/bin/python3\nfrom pathlib import Path\nPath(${JSON.stringify(path.join(directory,'old-started'))}).write_text('1.3.7')\n`;
    await writeFile(target,old);await chmod(target,0o755);
    const wanted=mode==='host-mismatch'?'0.1.999':'0.1.5';
    const next=`#!/usr/bin/python3\nimport json,os,subprocess\nfrom pathlib import Path\ns=Path(os.environ['CYRENE_UPDATE_STATE'])\nst=json.loads(s.read_text())\n`
      +(mode==='exit'?`raise SystemExit(7)\n`:`\nfor name in ('cyrene-overlay-host','cyrene-overlay-fullscreen'):\n result=subprocess.check_output([${JSON.stringify(path.join(repo,'resources/bin/linux'))}+'/'+name,'--version'],text=True).strip()\n if result!=name+' ${wanted}': raise SystemExit(8)\np=s.parent/('health-'+st['token']+'.json')\nt=p.with_suffix('.tmp')\nt.write_text(json.dumps({'token':st['token'],'version':'1.3.8','hostVersion':'0.1.5'}))\nt.replace(p)\n`);
    const digest=createHash('sha512').update(mode==='checksum'?'bad':next).digest('base64');
    const yaml=`version: 1.3.8\nfiles:\n  - url: Cyrene-1.3.8.AppImage\n    sha512: ${digest}\n    size: ${Buffer.byteLength(next)}\npath: Cyrene-1.3.8.AppImage\nsha512: ${digest}\nreleaseDate: '2026-11-17T00:00:00.000Z'\n`;
    server=http.createServer((req,res)=>{if(req.url.split('?')[0]==='/latest-linux.yml'){res.end(yaml);}else if(req.url.split('?')[0]==='/Cyrene-1.3.8.AppImage'){res.setHeader('content-length',Buffer.byteLength(next));res.end(next);}else{res.statusCode=404;res.end();}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/`;
    await writeFile(path.join(shell,'package.json'),JSON.stringify({name:'cyrene-update-probe',version:'1.3.7',main:'index.cjs'}));
    await writeFile(path.join(shell,'index.cjs'),await readFile(path.join(repo,'scripts/verify/fixtures/appimage-update.cjs')));
    await writeFile(path.join(shell,'dev-app-update.yml'),`provider: generic\nurl: ${url}\nupdaterCacheDirName: cyrene-update-probe\n`);
    const env={...process.env,XDG_CACHE_HOME:path.join(directory,'cache'),CYRENE_UPDATE_TEST_ROOT:directory,CYRENE_UPDATE_TEST_REPO:repo,CYRENE_UPDATE_TEST_FEED:url,CYRENE_UPDATE_TEST_MODE:mode};delete env.ELECTRON_RUN_AS_NODE;
    child=spawn(path.join(repo,'node_modules/electron/dist/electron'),['--ozone-platform=wayland',shell],{env,detached:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',b=>{logs+=b;});child.stderr.on('data',b=>{logs+=b;});
    await wait(()=>child.exitCode!==null||child.signalCode!==null);assert.equal(child.exitCode,0,logs.slice(-2500));
    if(mode==='checksum'){assert.equal(await readFile(target,'utf8'),old);assert.equal(await readFile(path.join(directory,'checksum-rejected'),'utf8'),'ok');}
    else{
      const stateFile=path.join(directory,'.Cyrene custom.AppImage.cyrene-update','state.json');
      await wait(async()=>{try{return ['healthy','rolled_back'].includes(JSON.parse(await readFile(stateFile,'utf8')).phase);}catch{return false;}});
      const state=JSON.parse(await readFile(stateFile,'utf8'));assert.equal(state.phase,mode==='healthy'?'healthy':'rolled_back');
      assert.equal(await readFile(target,'utf8'),mode==='healthy'?next:old);
      assert.equal(await readFile(path.join(path.dirname(stateFile),'previous.AppImage'),'utf8'),old);
      assert.equal(JSON.parse(await readFile(path.join(directory,'prepared-state'),'utf8')).phase,'preparing_install');
    }
    await new Promise(resolve=>server.close(resolve));server=null;
    console.log(`[appimage-update] local feed ${mode} passed (1.3.7 -> 1.3.8)`);
  }
}catch(error){process.exitCode=1;console.error(error);console.error(logs.slice(-4000));}
finally{
  server?.close();if(child?.pid){try{process.kill(-child.pid,'SIGKILL');}catch{}}
  if(process.exitCode){await writeFile(path.join(root,'electron.log'),logs);console.error(`[appimage-update] diagnostics retained at ${root}`);}
  else await rm(root,{recursive:true,force:true});
}
