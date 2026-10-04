import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { initializeApp,cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const deployment=process.argv[2];if(!deployment?.startsWith('https://morphly-'))throw new Error('A review deployment URL is required');
const app=initializeApp({credential:cert(JSON.parse(fs.readFileSync('C:/morphly-private/firebase-service-account.json','utf8')))});
const auth=getAuth(app),db=getFirestore(app),config=JSON.parse(fs.readFileSync('C:/morphly-private/firebase-web-config.json','utf8')).result.sdkConfig;
const cache='C:/Users/HP/AppData/Local/npm-cache/_npx';let cli;
for(const name of fs.readdirSync(cache)){const pkg=path.join(cache,name,'node_modules/vercel/package.json');if(fs.existsSync(pkg)&&JSON.parse(fs.readFileSync(pkg,'utf8')).version==='62.2.0'){cli=path.join(cache,name,'node_modules/vercel/dist/index.js');break;}}
if(!cli)throw new Error('Vercel CLI not found');
const run=promisify(execFile),workspace=path.resolve(import.meta.dirname,'../..');
const folder='C:/morphly-private/firebase-live-review';fs.mkdirSync(folder,{recursive:true});
const timings=[];
async function request(route,token,body){
  const id=randomUUID(),file=path.join(folder,id+'.json'),start=Date.now();
  const args=[cli,'curl',route,'--deployment',deployment,'--','--silent','--output',file,'--write-out','%{http_code}'];
  if(token)args.push('--header','Authorization: Bearer '+token);
  if(body){const bodyFile=path.join(folder,id+'-body.json');fs.writeFileSync(bodyFile,JSON.stringify(body));args.push('--request','POST','--header','Content-Type: application/json','--data-binary','@'+bodyFile);}
  const result=await run(process.execPath,args,{cwd:workspace,timeout:90000,maxBuffer:100000});
  const status=Number(result.stdout.match(/\d{3}\s*$/)?.[0]);
  let data;try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error(`Non-JSON preview response at ${route} (${status})`);}
  timings.push({route,status,elapsedMs:Date.now()-start});return {status,data};
}
async function createUser(label){
  const uid=randomUUID(),email=`firebase-review-${uid}@example.com`,password=randomUUID()+'aA1!';
  await auth.createUser({uid,email,password,emailVerified:true,displayName:label});
  const response=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key='+config.apiKey,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});
  const data=await response.json();if(!response.ok)throw new Error('Firebase password sign-in failed');return {uid,token:data.idToken};
}
const report={deployment,backend:'firebase',paymentEnvironment:'sandbox',startedAt:new Date().toISOString()};
try{
  const publicConfig=await request('/api/public-config');assert.equal(publicConfig.status,200);assert.equal(publicConfig.data.backend,'firebase');assert.equal(publicConfig.data.firebaseConfig.projectId,'luckyweb-f546e');assert.equal(publicConfig.data.paymentMode,'sandbox');
  const referrer=await createUser('Firebase Review Referrer');const setup=await request('/api/firebase-register',referrer.token,{});assert.equal(setup.status,200);
  const code=(await db.collection('users').doc(referrer.uid).get()).data().referral_code;
  const buyer=await createUser('Firebase Review Buyer');const register=await request('/api/firebase-register',buyer.token,{referralCode:code});assert.equal(register.status,200);
  const wallet=await request('/api/wallet',buyer.token);assert.equal(wallet.status,200);assert.equal(wallet.data.credits,50);
  const foreign=await request('/api/wallet?userId='+referrer.uid,buyer.token);assert.equal(foreign.status,403);
  const adminDenied=await request('/api/admin-users',buyer.token);assert.equal(adminDenied.status,403);
  const packages=await request('/api/credit-packages');assert.equal(packages.status,200);
  const packageRows=Array.isArray(packages.data)?packages.data:packages.data.packages;
  const pkg=packageRows.sort((a,b)=>Number(a.credits)-Number(b.credits))[0];assert.ok(pkg?.id);
  const payment=await request('/api/initiate-flutterwave-payment',buyer.token,{packageId:pkg.id});assert.equal(payment.status,200,JSON.stringify(payment.data));
  assert.equal(payment.data.status,'success');const reference=payment.data.reference,transactionId=new URL(payment.data.checkoutUrl).searchParams.get('transaction_id');
  const duplicate=await request('/api/verify-payment',buyer.token,{reference,transactionId,userId:buyer.uid,packageId:pkg.id});assert.equal(duplicate.status,200);assert.equal(duplicate.data.duplicate,true);
  const deniedPayment=await request('/api/verify-payment',referrer.token,{reference,transactionId,userId:buyer.uid,packageId:pkg.id});assert.equal(deniedPayment.status,403);
  const finalWallet=await request('/api/wallet',buyer.token),referrerWallet=await request('/api/wallet',referrer.token);
  assert.equal(finalWallet.data.credits,50+Number(pkg.credits));assert.equal(referrerWallet.data.credits,250);
  const referrals=await request('/api/referrals',referrer.token);assert.equal(referrals.status,200);
  const session=await db.collection('sessions').add({id:randomUUID(),user_id:buyer.uid,status:'active',seconds_used:0,wallet_debited_credits:0,provider_max_seconds:60,created_at:new Date().toISOString()});await session.update({id:session.id});
  const usage=await request('/api/heartbeat',buyer.token,{sessionId:session.id,secondsDelta:5});assert.equal(usage.status,200);assert.equal(usage.data.creditsDebited,10);
  const end=await request('/api/end-session',buyer.token,{sessionId:session.id,secondsDelta:0});assert.equal(end.status,200);
  report.users={buyer:buyer.uid,referrer:referrer.uid};report.payment={reference,transactionId,creditsAdded:payment.data.creditsAdded,referralRewarded:payment.data.referralRewarded,duplicatesSafe:true};report.authorization={foreignWalletDenied:true,nonAdminDenied:true,foreignPaymentDenied:true};report.streamingBilling={heartbeatDebited:10,finalizationSucceeded:true};report.passed=true;
}catch(error){report.passed=false;report.error=error.message;process.exitCode=1;}
report.timings=timings;report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(folder,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
