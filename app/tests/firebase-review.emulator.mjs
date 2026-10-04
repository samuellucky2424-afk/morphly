import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirebaseOperations } from '../server/firebase-operations.js';
import { FirebaseQuery } from '../server/firebase-store.js';
import { createFirebaseEngagement } from '../server/firebase-engagement.js';
import { deliverCustomerEmails } from '../server/customer-engagement.js';

if(!process.env.FIRESTORE_EMULATOR_HOST)throw new Error('These tests require the Firestore emulator');
const db=getFirestore(initializeApp({projectId:'demo-morphly-payments'}));
const ops=createFirebaseOperations(db,{getUser:async()=>({email:'review@example.com'})});
const get=async(table,id)=>(await db.collection(table).doc(id).get()).data();
const list=async(table,uid)=>(await db.collection(table).where('user_id','==',uid).get()).docs.map(d=>d.data());
test('verified payment delivers one purchase alert despite webhook retries and marketing opt-out',async()=>{
  const uid='purchase-alert-user';
  const liveOps=createFirebaseOperations(db,{}, {MORPHLY_PAYMENT_MODE:'live'});
  await db.collection('users').doc(uid).set({id:uid,account_status:'active'});
  await db.collection('wallets').doc(uid).set({user_id:uid,credits:0});
  await db.collection('credit_packages').doc('alert-package').set({id:'alert-package',name:'Test package',credits:100,price_ngn:'500.00',status:'active',is_active:true});
  await db.collection('customer_email_preferences').doc(uid).set({user_id:uid,enabled:false,unsubscribe_token:'test-token'});
  const p={p_user:uid,p_package:'alert-package',p_reference:'purchase-alert-reference',p_gateway_id:'alert-charge',p_amount:'500.00'};
  const first=await liveOps.rpc('apply_verified_package_payment',p);
  await liveOps.rpc('apply_verified_package_payment',p);
  const adapter={from:name=>new FirebaseQuery(db,name),rpc:async(name,p)=>({data:await liveOps.rpc(name,p),error:null}),auth:{admin:{getUserById:async()=>({data:{user:{email:'buyer@example.com',email_confirmed_at:new Date().toISOString()}},error:null})}}};
  const sent=[];
  const result=await deliverCustomerEmails(adapter,{userId:uid,sourceId:first.transactionId,env:{RESEND_API_KEY:'mock-key',RESEND_FROM_EMAIL:'support@example.com'},fetchImpl:async(_url,request)=>{sent.push(JSON.parse(request.body));return {ok:true,json:async()=>({id:'resend-mock-id'})};}});
  assert.equal(result.sent,1);assert.match(sent[0].text,/100 credits were added/);
  await deliverCustomerEmails(adapter,{userId:uid,sourceId:first.transactionId,env:{RESEND_API_KEY:'mock-key',RESEND_FROM_EMAIL:'support@example.com'},fetchImpl:async()=>{throw Error('Purchase alert must not send twice');}});
  assert.equal((await list('customer_email_jobs',uid)).filter(j=>j.kind==='purchase_confirmation').length,1);
  assert.equal((await list('wallets',uid))[0].credits,100);
});
test('Firebase timestamp meter retains half credits, deduplicates concurrent retries and enforces owner',async()=>{
  const uid='timestamp-pro',second=Math.floor(Date.now()/1000)-2;
  await db.collection('users').doc(uid).set({account_status:'active'});
  await db.collection('wallets').doc(uid).set({user_id:uid,credits:20});
  await db.collection('sessions').doc(uid).set({user_id:uid,status:'active',seconds_used:0,start_time:new Date((second-1)*1000).toISOString(),provider_max_seconds:120});
  await ops.rpc('configure_realtime_video',{p_user:uid,p_session:uid,p_rate_half:5});
  const p={p_user:uid,p_session:uid,p_epoch_seconds:[second]};
  await Promise.all([ops.rpc('record_realtime_video_usage',p),ops.rpc('record_realtime_video_usage',p)]);
  assert.equal(await ops.rpc('realtime_wallet_balance',{p_user:uid}),17.5);
  await assert.rejects(ops.rpc('record_realtime_video_usage',{...p,p_epoch_seconds:[second+500]}),/timestamp/);
  await db.collection('users').doc('timestamp-wrong').set({account_status:'active'});
  await db.collection('wallets').doc('timestamp-wrong').set({user_id:'timestamp-wrong',credits:20});
  await assert.rejects(ops.rpc('record_realtime_video_usage',{...p,p_user:'timestamp-wrong'}),/ownership/);
  await ops.rpc('record_realtime_video_usage',{...p,p_epoch_seconds:[second+1]});
  assert.equal(await ops.rpc('realtime_wallet_balance',{p_user:uid}),15);
  await ops.rpc('finalize_ai_session',{p_user:uid,p_session:uid});
  assert.equal(await ops.rpc('realtime_wallet_balance',{p_user:uid}),15);
});
test('Firebase translation reservation refunds unused seconds without losing fractional credits',async()=>{
  const uid='timestamp-translation';
  await db.collection('users').doc(uid).set({account_status:'active'});
  await db.collection('wallets').doc(uid).set({user_id:uid,credits:20});
  const p={p_user:uid,p_session:uid,p_seconds:5,p_close:false};
  await ops.rpc('authorize_translation_usage',p);
  assert.equal(await ops.rpc('realtime_wallet_balance',{p_user:uid}),7.5);
  await ops.rpc('authorize_translation_usage',{...p,p_seconds:1,p_close:true});
  assert.equal(await ops.rpc('realtime_wallet_balance',{p_user:uid}),17.5);
  await ops.rpc('authorize_translation_usage',{...p,p_seconds:1,p_close:true});
  assert.equal(await ops.rpc('realtime_wallet_balance',{p_user:uid}),17.5);
});
test('Firebase charges four total credits for overlapping video and translation and refunds only unused translation',async()=>{
  const uid='timestamp-combined',second=Math.floor(Date.now()/1000);
  await db.collection('users').doc(uid).set({account_status:'active'});
  await db.collection('wallets').doc(uid).set({user_id:uid,credits:20});
  await db.collection('sessions').doc(uid).set({user_id:uid,status:'active',seconds_used:0,start_time:new Date((second-2)*1000).toISOString(),provider_max_seconds:120});
  await ops.rpc('configure_realtime_video',{p_user:uid,p_session:uid,p_rate_half:5});
  await db.collection('translation_sessions').doc(uid).set({id:uid,user_id:uid,started_epoch:String(second),authorized_seconds:0,closed_at:null});
  await ops.rpc('authorize_translation_usage',{p_user:uid,p_session:uid,p_seconds:1,p_close:false});
  await ops.rpc('record_realtime_video_usage',{p_user:uid,p_session:uid,p_epoch_seconds:[second]});
  assert.equal(await ops.rpc('realtime_wallet_balance',{p_user:uid}),16);
  await ops.rpc('authorize_translation_usage',{p_user:uid,p_session:uid,p_seconds:0,p_close:true});
  assert.equal(await ops.rpc('realtime_wallet_balance',{p_user:uid}),17.5);
});
test('existing migrated profile and UUID wallet keep their balance and do not get a new signup grant',async()=>{
  await db.collection('users').doc('migrated').set({id:'migrated',account_status:'active',referral_code:'ABCDEF23'});
  await db.collection('wallets').doc('original-wallet-uuid').set({id:'original-wallet-uuid',user_id:'migrated',credits:127,balance:'101.27'});
  await Promise.all([ops.provision({id:'migrated'}),ops.provision({id:'migrated'})]);
  assert.equal((await get('wallets','original-wallet-uuid')).credits,127);
  assert.equal((await list('transactions','migrated')).length,0);
});
test('concurrent registrations grant signup credits once and attach a valid referral',async()=>{
  await ops.provision({id:'new-referrer',email:'referrer@example.com'});
  const referrer=await get('users','new-referrer');
  const results=await Promise.allSettled([ops.provision({id:'new-buyer'},referrer.referral_code),ops.provision({id:'new-buyer'},referrer.referral_code)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await list('wallets','new-buyer'))[0].credits,50);
  assert.equal((await list('transactions','new-buyer')).length,1);
  assert.equal((await get('users','new-buyer')).referred_by_user_id,'new-referrer');
});
test('Firebase payment RPC and referral reward stay atomic under repeated delivery',async()=>{
  await db.collection('credit_packages').doc('firebase-pkg').set({id:'firebase-pkg',credits:100,price_ngn:'100.00',is_active:true,status:'active',name:'test'});
  const input={p_user:'new-buyer',p_package:'firebase-pkg',p_reference:'firebase-review-payment',p_gateway_id:'charge-review',p_amount:'100.00',p_fee:0};
  const results=await Promise.all(Array.from({length:5},()=>ops.rpc('apply_verified_package_payment',input)));
  assert.equal(results.filter(r=>!r.duplicate).length,1);
  assert.equal((await list('wallets','new-buyer'))[0].credits,150);
  assert.equal((await list('wallets','new-referrer'))[0].credits,250);
});
test('usage debits incrementally, does not charge again on finalization, and rejects another owner',async()=>{
  await db.collection('sessions').doc('review-session').set({id:'review-session',user_id:'new-buyer',status:'active',seconds_used:0,wallet_debited_credits:0,provider_max_seconds:120});
  const wrong=await ops.rpc('record_ai_session_usage',{p_user:'migrated',p_session:'review-session',p_seconds_delta:30});assert.equal(wrong.shouldStop,true);
  const result=await ops.rpc('record_ai_session_usage',{p_user:'new-buyer',p_session:'review-session',p_seconds_delta:30});assert.equal(result.remainingCredits,90);
  const end=await ops.rpc('finalize_ai_session',{p_user:'new-buyer',p_session:'review-session',p_final_seconds_delta:5});assert.equal(end.remainingCredits,80);
  const duplicate=await ops.rpc('finalize_ai_session',{p_user:'new-buyer',p_session:'review-session',p_final_seconds_delta:5});assert.equal(duplicate.duplicate,true);assert.equal(duplicate.remainingCredits,80);
});
test('server query adapter handles ownership, migrated JSON and SQL OR expressions',async()=>{
  await db.collection('analytics_events').doc('review-json').set({id:'review-json',user_id:'new-buyer',metadata:'{"provider":"vidu"}',created_at:new Date().toISOString()});
  const result=await new FirebaseQuery(db,'analytics_events').select('*',{count:'exact'}).eq('user_id','new-buyer').or('metadata.is.null,id.eq.review-json').single();
  assert.equal(result.error,null);assert.equal(result.data.metadata.provider,'vidu');assert.equal(result.count,1);
  await db.collection('analytics_events').doc('sql-time').set({id:'sql-time',created_at:'2026-10-04 10:00:00.123456'});
  await db.collection('analytics_events').doc('iso-time').set({id:'iso-time',created_at:'2026-10-04T11:00:00.000Z'});
  const dates=await new FirebaseQuery(db,'analytics_events').select('id').gte('created_at','2026-10-04T09:00:00.000Z').lte('created_at','2026-10-04T12:00:00.000Z');
  assert.equal(dates.error,null);assert.deepEqual(dates.data.map(r=>r.id).sort(),['iso-time','sql-time']);
});

test('Pro allows its full physical duration while charging 2.5 credits per elapsed second',async()=>{
  await db.collection('users').doc('pro-user').set({id:'pro-user',account_status:'active'});
  await db.collection('wallets').doc('pro-wallet').set({id:'pro-wallet',user_id:'pro-user',credits:400});
  await db.collection('sessions').doc('pro-session').set({id:'pro-session',user_id:'pro-user',provider:'decart',status:'active',seconds_used:0,wallet_debited_credits:0,provider_max_seconds:120});
  await ops.rpc('record_ai_session_usage',{p_user:'pro-user',p_session:'pro-session',p_seconds_delta:60});
  const second=await ops.rpc('record_ai_session_usage',{p_user:'pro-user',p_session:'pro-session',p_seconds_delta:60});
  assert.equal(second.shouldStop,false);
  const end=await ops.rpc('finalize_ai_session',{p_user:'pro-user',p_session:'pro-session',p_final_seconds_delta:30});
  assert.equal(end.creditsUsed,300);assert.equal(end.remainingCredits,100);
});
test('admin adjustments enforce role, idempotency and active membership',async()=>{
  await db.collection('admin_users').doc('new-referrer').set({user_id:'new-referrer',role:'admin',is_active:true});
  await assert.rejects(ops.rpc('admin_adjust_credits',{p_admin:'new-buyer',p_user:'migrated',p_amount:10,p_reason:'test grant',p_key:'firebase-admin-key'}));
  const input={p_admin:'new-referrer',p_user:'migrated',p_amount:10,p_reason:'test grant',p_key:'firebase-admin-key'};
  await Promise.all([ops.rpc('admin_adjust_credits',input),ops.rpc('admin_adjust_credits',input)]);
  assert.equal((await get('wallets','original-wallet-uuid')).credits,137);
  await assert.rejects(ops.rpc('admin_adjust_credits',{...input,p_amount:-10,p_key:'firebase-negative-key'}));
});

test('email jobs stay disabled in sandbox and preserve migrated event deduplication in live mode',async()=>{
  const sandbox=createFirebaseEngagement(db,{}, {MORPHLY_PAYMENT_MODE:'sandbox'});
  await sandbox.enqueue('email-user','purchase_feedback','email-sandbox','purchase-sandbox');
  assert.deepEqual(await sandbox.claim(),[]);
  assert.equal((await db.collection('customer_email_jobs').where('event_key','==','email-sandbox').get()).size,0);
  const live=createFirebaseEngagement(db,{}, {MORPHLY_PAYMENT_MODE:'live'});
  await db.collection('customer_email_jobs').doc('migrated-job').set({id:'migrated-job',user_id:'email-user',event_key:'email-migrated',kind:'purchase_feedback',status:'sent'});
  await Promise.all([live.enqueue('email-user','purchase_feedback','email-migrated'),live.enqueue('email-user','purchase_feedback','email-migrated')]);
  assert.equal((await db.collection('customer_email_jobs').where('event_key','==','email-migrated').get()).size,1);
});

test('concurrent email workers lease a job once and stop retries before provider idempotency expires',async()=>{
  const live=createFirebaseEngagement(db,{}, {MORPHLY_PAYMENT_MODE:'live'});
  await live.enqueue('lease-user','purchase_feedback','email-lease','lease-purchase');
  const claims=await Promise.all([live.claim({p_user:'lease-user'}),live.claim({p_user:'lease-user'})]);
  assert.equal(claims.flat().length,1);
  const job=claims.flat()[0];
  await db.collection('customer_email_jobs').doc(job.id).update({first_attempt_at:new Date(Date.now()-24*3600000).toISOString(),locked_until:new Date(Date.now()-1000).toISOString()});
  assert.deepEqual(await live.claim({p_user:'lease-user'}),[]);
  assert.equal((await get('customer_email_jobs',job.id)).status,'failed');
});
