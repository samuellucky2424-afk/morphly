import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirebaseOperations } from '../server/firebase-operations.js';
import { FirebaseQuery } from '../server/firebase-store.js';
import { createFirebaseEngagement } from '../server/firebase-engagement.js';

if(!process.env.FIRESTORE_EMULATOR_HOST)throw new Error('These tests require the Firestore emulator');
const db=getFirestore(initializeApp({projectId:'demo-morphly-payments'}));
const ops=createFirebaseOperations(db,{getUser:async()=>({email:'review@example.com'})});
const get=async(table,id)=>(await db.collection(table).doc(id).get()).data();
const list=async(table,uid)=>(await db.collection(table).where('user_id','==',uid).get()).docs.map(d=>d.data());
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
  await db.collection('sessions').doc('pro-session').set({id:'pro-session',user_id:'pro-user',provider:'vidu',status:'active',seconds_used:0,wallet_debited_credits:0,provider_max_seconds:120});
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
