import fs from 'node:fs';
import assert from 'node:assert/strict';
import {initializeApp,cert} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
const folder='C:/morphly-private/production-cutover-source-20261005';
const rows=name=>fs.readFileSync(`${folder}/${name}`,'utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);
const admins=new Set(rows('public.admin_users.jsonl').filter(r=>r.is_active).map(r=>r.user_id));
const profiles=rows('public.users.jsonl');
const auth=getAuth(initializeApp({credential:cert(JSON.parse(fs.readFileSync('C:/morphly-private/firebase-service-account.json','utf8')))}));
const config=JSON.parse(fs.readFileSync('C:/morphly-private/firebase-web-config.json','utf8')).result.sdkConfig;
async function token(uid){
  const r=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${config.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:await auth.createCustomToken(uid),returnSecureToken:true})});
  const data=await r.json();if(!r.ok||!data.idToken)throw Error('Migrated account authentication failed');return data.idToken;
}
const report={financialWrites:false,domains:[]};
for(const domain of ['https://live.morphly.fun','https://morphly-alpha.vercel.app']){
  const r=await fetch(`${domain}/api/public-config`);assert.equal(r.status,200);const data=await r.json();
  assert.equal(data.backend,'firebase');assert.equal(data.database,'morphly-production');assert.equal(data.paymentMode,'live');report.domains.push({domain,firebase:true,livePayments:true});
}
for(const admin of [false,true]){
  const user=profiles.find(p=>p.account_status==='active'&&admins.has(p.id)===admin);if(!user)throw Error('Migrated account role unavailable');
  const jwt=await token(user.id),headers={Authorization:`Bearer ${jwt}`};
  const r=await fetch('https://live.morphly.fun/api/admin-me',{headers});assert.equal(r.status,200);assert.equal((await r.json()).isAdmin,admin);
  const wallet=await fetch('https://live.morphly.fun/api/wallet',{headers});assert.equal(wallet.status,200);
}
report.ownerAndAdminAccessVerified=true;
const secret=fs.readFileSync('C:/morphly-private/flutterwave-live-webhook-secret.txt','utf8').trim();
const webhook=await fetch('https://live.morphly.fun/api/flutterwave-webhook',{method:'POST',headers:{'Content-Type':'application/json','verif-hash':secret},body:JSON.stringify({type:'migration.signature_check',data:{}})});
assert.equal(webhook.status,200);assert.equal((await webhook.json()).ignored,true);report.liveWebhookAccepted=true;
const invalid=await fetch('https://live.morphly.fun/api/flutterwave-webhook',{method:'POST',headers:{'Content-Type':'application/json','verif-hash':'invalid'},body:'{}'});assert.equal(invalid.status,401);
report.invalidSignatureRejected=true;report.passed=true;report.checkedAt=new Date().toISOString();
fs.writeFileSync('C:/morphly-private/firebase-live-release-check.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
