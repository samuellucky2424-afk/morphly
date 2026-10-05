import fs from 'node:fs';
import {initializeApp,cert} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
const folder='C:/morphly-private/production-cutover-source-20261005';
const rows=name=>fs.readFileSync(`${folder}/${name}`,'utf8').trim().split('\n').map(JSON.parse);
const admins=new Set(rows('public.admin_users.jsonl').filter(r=>r.is_active).map(r=>r.user_id));
const admin=rows('public.users.jsonl').find(r=>r.account_status==='active'&&admins.has(r.id));
if(!admin)throw Error('No active migrated administrator');
const auth=getAuth(initializeApp({credential:cert(JSON.parse(fs.readFileSync('C:/morphly-private/firebase-service-account.json','utf8')))}));
const config=JSON.parse(fs.readFileSync('C:/morphly-private/firebase-web-config.json','utf8')).result.sdkConfig;
const login=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${config.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:await auth.createCustomToken(admin.id),returnSecureToken:true})});
const credentials=await login.json();if(!login.ok||!credentials.idToken)throw Error('Admin authentication failed');
const since=JSON.parse(fs.readFileSync('C:/morphly-private/source-cutover-lock.json','utf8')).completedAt;
const report={since,pages:[],processed:0,duplicate:0,failed:0,ignored:0,completed:false};
let page=1;
while(page){
 const response=await fetch('https://live.morphly.fun/api/admin-payment-reconcile',{method:'POST',headers:{Authorization:`Bearer ${credentials.idToken}`,'Content-Type':'application/json'},body:JSON.stringify({since,page}),signal:AbortSignal.timeout(310000)});
 if(!response.ok)throw Error(`Reconciliation failed (${response.status})`);
 const result=await response.json();report.pages.push(result);
 for(const key of ['processed','duplicate','failed','ignored'])report[key]+=result[key];
 fs.writeFileSync('C:/morphly-private/firebase-live-cutover-reconciliation.json',JSON.stringify(report,null,2));
 page=result.nextPage;if(page>200)throw Error('Reconciliation page limit reached');
}
report.completed=true;report.checkedAt=new Date().toISOString();
fs.writeFileSync('C:/morphly-private/firebase-live-cutover-reconciliation.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report));if(report.failed)process.exitCode=1;
