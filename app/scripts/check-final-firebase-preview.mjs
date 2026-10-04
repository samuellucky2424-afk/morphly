import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {initializeApp,cert} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';
const deployment=process.argv[2],paymentMode=process.argv[3]||'sandbox',report={deployment,backend:'firebase'};
if(!['sandbox','live'].includes(paymentMode))throw new Error('Invalid payment mode');
if(!deployment?.startsWith('https://morphly-'))throw new Error('Review deployment required');
const app=initializeApp({credential:cert(JSON.parse(fs.readFileSync('C:/morphly-private/firebase-service-account.json','utf8')))}),auth=getAuth(app),db=getFirestore(app);
const config=JSON.parse(fs.readFileSync('C:/morphly-private/firebase-web-config.json','utf8')).result.sdkConfig;
const earlier=JSON.parse(fs.readFileSync('C:/morphly-private/firebase-live-review/result.json','utf8'));
const uid=earlier.users.buyer;
const response=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key='+config.apiKey,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:await auth.createCustomToken(uid),returnSecureToken:true})});
const authData=await response.json();if(!response.ok)throw new Error('Synthetic test sign-in failed');
const cache='C:/Users/HP/AppData/Local/npm-cache/_npx';let cli;
for(const dir of fs.readdirSync(cache)){const pkg=path.join(cache,dir,'node_modules/vercel/package.json');if(fs.existsSync(pkg)&&JSON.parse(fs.readFileSync(pkg,'utf8')).version==='62.2.0')cli=path.join(cache,dir,'node_modules/vercel/dist/index.js');}
const run=promisify(execFile),workspace=path.resolve(import.meta.dirname,'../..');
async function request(route,body,authenticated=true){
  const file='C:/morphly-private/firebase-live-review/final-'+randomUUID()+'.json';
  const args=[cli,'curl',route,'--deployment',deployment,'--','--silent','--output',file,'--write-out','%{http_code}'];
  if(authenticated)args.push('--header','Authorization: Bearer '+authData.idToken);
  if(body){const input=file+'.body';fs.writeFileSync(input,JSON.stringify(body));args.push('--header','Content-Type: application/json','--header','Origin: '+deployment,'--request','POST','--data-binary','@'+input);}
  const result=await run(process.execPath,args,{cwd:workspace,timeout:90000,maxBuffer:10000});
  const status=Number(result.stdout.match(/\d{3}\s*$/)?.[0]),text=fs.readFileSync(file,'utf8');fs.unlinkSync(file);
  let data;try{data=JSON.parse(text);}catch{data={html:text};}return {status,data};
}
try{
  const health=await request('/api/public-config',null,false);assert.equal(health.status,200);assert.equal(health.data.backend,'firebase');assert.equal(health.data.firebaseConfig.projectId,'luckyweb-f546e');assert.equal(health.data.paymentMode,paymentMode);assert.deepEqual(health.data.realtimeProviders,['vidu','decart']);assert.equal(health.data.reviewVersion,'firebase-vidu-decart-v1');report.providers=health.data.realtimeProviders;report.paymentMode=paymentMode;
  const home=await request('/',null,false);assert.equal(home.status,200);assert.match(home.data.html,/assets\/index-/);report.homeLoaded=true;
  const admin=await request('/private/morphly/login',null,false);assert.equal(admin.status,200);assert.match(admin.data.html,/firebase\.js/);report.adminUsesFirebase=true;
  const wallet=await request('/api/wallet');assert.equal(wallet.status,200);report.firebaseWalletReadable=true;
  await db.collection('users').doc(uid).update({account_status:'suspended'});
  try{const denied=await request('/api/wallet');assert.equal(denied.status,403);report.suspendedAccountDenied=true;}finally{await db.collection('users').doc(uid).update({account_status:'active'});}
  const stream=await request('/api/start-session',{provider:'decart',platform:'web',userId:uid,installationId:'firebase-review-check'});
  report.streaming={provider:'decart',model:stream.data.model,status:stream.status,allowed:!!stream.data.allowed,tokenIssued:!!stream.data.token,timings:stream.data.startupTimings||null};
  assert.equal(stream.status,200);assert.equal(stream.data.allowed,true);assert.ok(stream.data.token);assert.equal(stream.data.model,'lucy-2.5');
  if(stream.data.sessionId){const ended=await request('/api/end-session',{sessionId:stream.data.sessionId,secondsDelta:0});report.streaming.sessionClosed=ended.status===200;}
  const legacy=await request('/api/start-session',{provider:'xmax',platform:'web'});assert.equal(legacy.status,400);report.xmaxRejected=true;report.passed=true;
}catch(error){report.passed=false;report.error=error.message;process.exitCode=1;}
report.checkedAt=new Date().toISOString();fs.writeFileSync('C:/morphly-private/firebase-live-review/final-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
