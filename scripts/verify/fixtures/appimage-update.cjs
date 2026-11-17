const {app}=require('electron');
const fs=require('node:fs');const path=require('node:path');
const root=process.env.CYRENE_UPDATE_TEST_ROOT;const repo=process.env.CYRENE_UPDATE_TEST_REPO;
app.setPath('userData',path.join(root,'data'));
process.env.APPIMAGE=path.join(root,'Cyrene custom.AppImage');
app.whenReady().then(async()=>{
  try {
    const {TransactionalAppImageUpdater}=require(path.join(repo,'dist/main/main/updater/transactional-appimage-updater.js'));
    const {AppImageTransaction}=require(path.join(repo,'dist/main/main/updater/appimage-transaction.js'));
    const {createAppUpdateService}=require(path.join(repo,'dist/main/main/updater/app-update-service.js'));
    const updater=new TransactionalAppImageUpdater({provider:'generic',url:process.env.CYRENE_UPDATE_TEST_FEED},undefined,
      target=>new AppImageTransaction({target,currentVersion:app.getVersion(),hostVersion:'0.1.5',workerScript:path.join(repo,'scripts/update/appimage-worker.py'),healthTimeoutMs:4000}));
    updater.forceDevUpdateConfig=true;updater.disableDifferentialDownload=true;
    const service=createAppUpdateService({updater,currentVersion:app.getVersion(),isPackaged:true});
    await service.check();
    if(service.getState().phase!=='available')throw new Error('release not detected: '+JSON.stringify(service.getState()));
    await service.download();
    if(process.env.CYRENE_UPDATE_TEST_MODE==='checksum'){
      if(service.getState().error!=='download_failed')throw new Error('corrupt download accepted');
      fs.writeFileSync(path.join(root,'checksum-rejected'),'ok');app.exit(0);return;
    }
    if(service.getState().phase!=='downloaded')throw new Error('download failed: '+JSON.stringify(service.getState()));
    if(!await service.prepareInstall())throw new Error('preparation failed: '+JSON.stringify(service.getState()));
    fs.writeFileSync(path.join(root,'prepared-state'),JSON.stringify(service.getState()));
    if(!service.install())throw new Error('install rejected');
  } catch(error){console.error(error);app.exit(1);}
});
