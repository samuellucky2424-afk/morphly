import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {initializeApp,cert} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
const deployment=process.argv[2];if(!deployment?.startsWith('https://morphly-'))throw new Error('Staged deployment URL required');
const folder='C:/morphly-private/production-preflight-source-20261005';
const rows=file=>fs.readFileSync(`${folder}/${file}`,'utf8').trimEnd().split('\n').map(JSON.parse);
const admins=new Set(rows('public.admin_users.jsonl').filter(r=>r.is_active).map(r=>r.user_id));
const profiles=rows('public.users.jsonl'),authRows=rows('auth.users.jsonl');
const user=profiles.find(p=>p.account_status==='active'&&!admins.has(p.id)&&authRows.some(a=>a.id===p.id&&a.email_confirmed_at&&!a.deleted_at));
if(!user)throw new Error('No eligible migrated owner available');
const app=initializeApp({credential:cert(JSON.parse(fs.readFileSync('C:/morphly-private/firebase-service-account.json','utf8')))}),auth=getAuth(app);
const config=JSON.parse(fs.readFileSync('C:/morphly-private/firebase-web-config.json','utf8')).result.sdkConfig;
const login=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${config.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:await auth.createCustomToken(user.id),returnSecureToken:true})});
const credentials=await login.json();if(!login.ok)throw new Error('Migrated owner authentication failed');
const cache='C:/Users/HP/AppData/Local/npm-cache/_npx';let cli;
for(const dir of fs.readdirSync(cache)){const pkg=path.join(cache,dir,'node_modules/vercel/package.json');if(fs.existsSync(pkg)&&JSON.parse(fs.readFileSync(pkg,'utf8')).version==='62.2.0')cli=path.join(cache,dir,'node_modules/vercel/dist/index.js');}
const run=promisify(execFile),workspace=path.resolve(import.meta.dirname,'../..');
async function request(route,{authenticated=true,body,headers={}}={}){
  const file=`C:/morphly-private/production-check-${randomUUID()}.json`;
  const args=[cli,'curl',route,'--deployment',deployment,'--','--silent','--output',file,'--write-out','%{http_code}'];
  if(authenticated)args.push('--header',`Authorization: Bearer ${credentials.idToken}`);
  for(const [key,value]of Object.entries(headers))args.push('--header',`${key}: ${value}`);
  if(body!==undefined){fs.writeFileSync(file+'.body',JSON.stringify(body));args.push('--request','POST','--header','Content-Type: application/json','--data-binary','@'+file+'.body');}
  const result=await run(process.execPath,args,{cwd:workspace,timeout:90000,maxBuffer:10000});
  const status=Number(result.stdout.match(/\d{3}\s*$/)?.[0]),raw=fs.readFileSync(file,'utf8');fs.unlinkSync(file);
  if(body!==undefined)fs.unlinkSync(file+'.body');
  let data;try{data=JSON.parse(raw);}catch{data={html:raw};}return {status,data};
}
const report={deployment,database:'morphly-production',financialWrites:false};
try{
  const health=await request('/api/public-config',{authenticated:false});assert.equal(health.status,200);assert.equal(health.data.backend,'firebase');assert.equal(health.data.database,'morphly-production');assert.equal(health.data.paymentMode,'live');assert.equal(health.data.firebaseConfig.projectId,'luckyweb-f546e');report.firebaseLiveConfiguration=true;
  const wallet=await request('/api/wallet');assert.equal(wallet.status,200);report.migratedWalletReadable=true;
  const denied=await request('/api/admin-me');assert.equal(denied.status,200);assert.equal(denied.data.isAdmin,false);report.nonAdminRestricted=true;
  for(const route of ['/api/flutterwave-webhook','/api/ivorypay-webhook']){const response=await request(route,{authenticated:false,body:{event:'charge.completed',data:{id:'invalid-test'}},headers:{'verif-hash':'invalid-signature','flutterwave-signature':'invalid-signature','x-ivorypay-signature':'invalid-signature'}});assert.equal(response.status,401);}
  report.invalidWebhooksRejected=true;report.passed=true;
  if(process.env.CHECK_LIVE_WEBHOOK_SECRET==='true'){
    const secret=fs.readFileSync('C:/morphly-private/flutterwave-live-webhook-secret.txt','utf8').trim();
    const response=await request('/api/flutterwave-webhook',{authenticated:false,body:{type:'migration.signature_check',data:{}},headers:{'verif-hash':secret}});
    assert.equal(response.status,200);assert.equal(response.data.ignored,true);report.liveWebhookSecretAccepted=true;
  }
}catch(error){report.passed=false;report.error=error.message;process.exitCode=1;}
report.checkedAt=new Date().toISOString();fs.writeFileSync('C:/morphly-private/production-staging-check.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
