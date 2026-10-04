import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {listPackage,extractFile} from '@electron/asar';
const root=path.resolve(import.meta.dirname,'../..'),release=path.join(root,'app/release'),version=JSON.parse(fs.readFileSync(path.join(root,'app/package.json'),'utf8')).version;
const name=`Morphly-Setup-${version}.exe`,binary=fs.readFileSync(path.join(release,name)),yaml=fs.readFileSync(path.join(release,'latest.yml'),'utf8');
const sha256=createHash('sha256').update(binary).digest('hex'),sha512=createHash('sha512').update(binary).digest('base64');
if(!yaml.includes(`version: ${version}`)||!yaml.includes(`sha512: ${sha512}`))throw new Error('Installer checksum metadata mismatch');
const archive=path.join(release,'win-unpacked/resources/app.asar');
const packaged=listPackage(archive).map(f=>f.replaceAll('\\','/'));
if(packaged.some(f=>/(?:^|\/)\.env(?:\.|$)|firebase-service-account\.json$/i.test(f)))throw new Error('Private environment file found in desktop package');
if(JSON.parse(extractFile(archive,'package.json').toString()).version!==version)throw new Error('Packaged application version mismatch');
const assets=listPackage(archive).filter(f=>/^\/dist\/assets\/.*\.js$/.test(f.replaceAll('\\','/')));
if(!assets.some(f=>extractFile(archive,f.slice(1)).toString().includes('luckyweb-f546e')))throw new Error('Firebase project missing from packaged client');
for(const file of ['unity-capture/morphly_unity_capture_sender.exe','media-foundation-camera/MorphlyVirtualCameraMF.dll','media-foundation-camera/morphly_cam_registrar.exe']){
  if(!fs.existsSync(path.join(release,'win-unpacked/resources',file)))throw new Error('Missing native camera resource: '+file);
}
const token=JSON.parse(fs.readFileSync('C:/morphly-private/github-release-access.json','utf8')).token;
const api='https://api.github.com/repos/samuellucky2424-afk/morphly',headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json'};
const existing=await fetch(api+'/releases?per_page=100',{headers});if(!existing.ok)throw new Error(`Release inspection failed (${existing.status})`);
let draft=(await existing.json()).find(r=>r.tag_name===`v${version}`);
if(draft&&!draft.draft)throw new Error('Release already published; do not replace a public installer');
if(!draft){
  const response=await fetch(api+'/releases',{method:'POST',headers,body:JSON.stringify({tag_name:`v${version}`,target_commitish:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),name:`Morphly Desktop ${version}`,draft:true,prerelease:false,body:'Firebase authentication and account data, Plus at 2 credits/sec and Pro at 2.5 credits/sec, improved realtime connection retries, and native Windows camera integration. This release remains a draft until the live Firebase backend and payment callbacks are verified.'})});
  if(!response.ok)throw new Error(`Draft release creation failed (${response.status})`);draft=await response.json();
}
for(const filename of [name,'latest.yml']){
  const bytes=filename===name?binary:fs.readFileSync(path.join(release,filename)),digest=createHash('sha256').update(bytes).digest('hex'),old=draft.assets.find(a=>a.name===filename);
  if(old){if(old.digest!==`sha256:${digest}`)throw new Error('Draft asset differs; review before replacing');continue;}
  const endpoint=draft.upload_url.replace(/\{.*\}$/,'')+'?name='+encodeURIComponent(filename);
  const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':filename.endsWith('.exe')?'application/octet-stream':'text/yaml'},body:bytes,signal:AbortSignal.timeout(180000)});
  if(!response.ok)throw new Error(`Draft asset upload failed (${response.status})`);const uploaded=await response.json();
  if(uploaded.state!=='uploaded'||uploaded.size!==bytes.length||uploaded.digest&&uploaded.digest!==`sha256:${digest}`)throw new Error('Uploaded release asset verification failed');
}
const report={version,draft:true,releaseId:draft.id,releasePage:draft.html_url,installer:name,bytes:binary.length,sha256,sha512,packageFirebaseVerified:true};
fs.writeFileSync('C:/morphly-private/firebase-desktop-draft-release.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
