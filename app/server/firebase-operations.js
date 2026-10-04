import { randomUUID } from 'node:crypto';
import { hash, encode } from './firebase-store.js';
import { createPaymentRuntime } from './firebase-payment-runtime.mjs';
import { createFirebaseEngagement } from './firebase-engagement.js';
import { createFirebaseRealtimeBilling } from './firebase-realtime-billing.js';

const now=()=>new Date().toISOString();
const one=rows=>{if(rows.size>1)throw new Error('Ambiguous record');return rows.docs[0];};
const code=()=>{const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';return [...Buffer.from(randomUUID().replaceAll('-',''),'hex').subarray(0,8)].map(x=>alphabet[x%alphabet.length]).join('');};
export function createFirebaseOperations(db,auth){
  const col=name=>db.collection(name);
  const query=(table,field,value)=>col(table).where(field,'==',value);
  const payment=createPaymentRuntime(db);
  const engagement=createFirebaseEngagement(db,auth);
  const realtime=createFirebaseRealtimeBilling(db);
  async function provision(user,requestedCode=''){
    const uid=user.id,profileRef=col('users').doc(uid),timestamp=now();
    requestedCode=String(requestedCode||'').trim().toUpperCase();
    return db.runTransaction(async tx=>{
      const [profile,wallets,referrers]=await Promise.all([tx.get(profileRef),tx.get(query('wallets','user_id',uid)),requestedCode?tx.get(query('users','referral_code',requestedCode)):Promise.resolve(null)]);
      const wallet=one(wallets);
      if(profile.exists){
        if(requestedCode)throw new Error('Referral codes can only be attached at registration');
        if(!profile.data().referral_code)tx.update(profileRef,{referral_code:code(),updated_at:timestamp});
        if(!wallet){const ref=col('wallets').doc(randomUUID());tx.create(ref,{id:ref.id,user_id:uid,credits:0,balance:'0.00',created_at:timestamp,updated_at:timestamp});}
        return {walletCreated:!wallet};
      }
      const referrer=referrers?one(referrers):null;
      if(requestedCode&&(!referrer||referrer.id===uid||referrer.data().account_status!=='active'||! /^[A-HJ-NP-Z2-9]{6,12}$/.test(requestedCode)))throw new Error('INVALID_REFERRAL_CODE');
      const priorReferrals=referrer?await tx.get(query('referrals','referrer_user_id',referrer.id)):null;
      // The profile document is the registration lock. A retry or login must
      // never give a migrated user another signup bonus.
      const walletRef=wallet?.ref||col('wallets').doc(randomUUID()),transaction=col('transactions').doc(randomUUID()),ledger=col('wallet_ledger').doc(randomUUID());
      const credits=Number(wallet?.data().credits||0)+50;
      tx.create(profileRef,{id:uid,email:user.email||'',name:user.user_metadata?.name||'',account_status:'active',referral_code:code(),referred_by_user_id:referrer?.id||null,onboarding_completed:false,onboarding_version:1,signup_bonus_welcome_shown_at:null,created_at:timestamp,updated_at:timestamp});
      tx.set(walletRef,{id:walletRef.id,user_id:uid,balance:wallet?.data().balance||'0.00',credits,created_at:wallet?.data().created_at||timestamp,updated_at:timestamp},{merge:true});
      tx.create(transaction,{id:transaction.id,user_id:uid,type:'signup_bonus',transaction_type:'signup_bonus',status:'success',amount:'0.00',amount_naira:'0.00',credits:50,reference:`signup_bonus:${uid}`,description:'New account testing credits',created_at:timestamp});
      tx.create(ledger,{id:ledger.id,user_id:uid,transaction_id:transaction.id,delta:50,balance_after:credits,entry_type:'signup_bonus',reason:'New account testing credits',idempotency_key:`signup_bonus:${uid}`,created_at:timestamp});
      if(referrer){const ref=col('referrals').doc(randomUUID());const suspicious=priorReferrals.docs.filter(d=>Date.parse(d.data().created_at)>Date.now()-3600000).length>=9;
        tx.create(ref,{id:ref.id,referrer_user_id:referrer.id,referred_user_id:uid,referral_code_used:requestedCode,status:'registered',suspicious,suspicious_reason:suspicious?'High referral registration velocity: 10 or more signups within one hour':null,created_at:timestamp,updated_at:timestamp});
        const audit=col('referral_audit_logs').doc(randomUUID());tx.create(audit,{id:audit.id,action:'referral.attached',referral_id:ref.id,referrer_user_id:referrer.id,referred_user_id:uid,metadata:JSON.stringify({code:requestedCode,suspicious}),created_at:timestamp});}
      return {walletCreated:!wallet};
    });
  }
  async function usage(p,finalize){
    return db.runTransaction(async tx=>{
      const [session,rows,profile]=await Promise.all([tx.get(col('sessions').doc(p.p_session)),tx.get(query('wallets','user_id',p.p_user)),tx.get(col('users').doc(p.p_user))]);
      const wallet=one(rows);if(!wallet)throw new Error('Wallet not found');
      const balance=Number(wallet.data().credits||0),s=session.data();
      if(!s||s.user_id!==p.p_user||s.status!=='active')return {duplicate:true,shouldStop:true,reason:'session_not_found',remainingCredits:balance,creditsUsed:Number(s?.cost||0)};
      if(s.billing_version===2)throw new Error('Timestamp billing is required for this historical session');
      const seconds=Math.min(finalize?7200:60,Math.max(0,Number(finalize?p.p_final_seconds_delta:p.p_seconds_delta)||0));
      if(!finalize&&seconds<=0)throw new Error('A positive seconds delta is required');
      const providerMultiplier=s.provider==='decart'?1.25:1;
      // The client sends legacy 2-credit usage units; Pro uses 1.25 units per
      // elapsed second. Provider limits are expressed in elapsed seconds.
      const debited=Number(s.wallet_debited_credits||0),oldSeconds=Number(s.seconds_used||0),limit=Math.floor(Math.min(7200,Math.max(10,Number(s.provider_max_seconds||7200)))*providerMultiplier);
      const target=Math.min(oldSeconds+seconds,Math.floor((balance+debited)/2),limit),cost=target*2,delta=Math.min(balance,Math.max(0,cost-debited)),remaining=balance-delta,timestamp=now();
      const stop=remaining<2*providerMultiplier||target>=limit||profile.data()?.account_status!=='active';
      tx.update(wallet.ref,{credits:remaining,updated_at:timestamp});
      tx.update(session.ref,{seconds_used:target,cost,credits_used:cost,wallet_debited_credits:debited+delta,last_usage_at:timestamp,...finalize?{status:'ended',end_time:timestamp,end_reason:String(p.p_reason||'client_ended').slice(0,80)}:{}});
      if(cost>0){const ref=col('wallet_ledger').doc(hash(`ai-session:${p.p_session}`));tx.set(ref,{id:ref.id,user_id:p.p_user,delta:-cost,balance_after:remaining,entry_type:'ai_session_usage',reason:'AI realtime generation usage',idempotency_key:`ai-session:${p.p_session}`,created_at:s.created_at||timestamp,updated_at:timestamp});}
      return {sessionId:p.p_session,duplicate:false,recordedSeconds:target-oldSeconds,totalBillableSeconds:target,secondsUsed:target,totalCreditsUsed:cost,creditsUsed:cost,creditsDebited:delta,remainingCredits:remaining,shouldStop:stop};
    });
  }
  async function adminChange(name,p){return db.runTransaction(async tx=>{
    const [admin,actor,target,sessions]=await Promise.all([tx.get(col('admin_users').doc(p.p_admin)),tx.get(col('users').doc(p.p_admin)),tx.get(col(name==='admin_set_user_status'?'users':'referrals').doc(p.p_user||p.p_referral)),name==='admin_set_user_status'?tx.get(query('sessions','user_id',p.p_user)):Promise.resolve(null)]);
    if(!admin.data()?.is_active||actor.data()?.account_status!=='active')throw new Error('Admin access required');
    const reason=String(p.p_reason||'').trim();if(reason.length<3||reason.length>240||!target.exists)throw new Error('Valid target and reason required');
    const before=target.data(),timestamp=now();let after;
    if(name==='admin_set_user_status'){if(!['active','suspended'].includes(p.p_status))throw new Error('Invalid account status');after={account_status:p.p_status,suspended_at:p.p_status==='suspended'?timestamp:null,updated_at:timestamp};
      if(p.p_status==='suspended')for(const s of sessions.docs.filter(d=>d.data().status==='active'))tx.update(s.ref,{status:'ended',end_time:timestamp,end_reason:'account_suspended'});
    }else{if(before.status==='rewarded')throw new Error('A rewarded referral requires a supported reversal');after={status:'disqualified',disqualified_at:timestamp,disqualification_reason:reason,updated_at:timestamp};}
    tx.update(target.ref,after);const audit=col('admin_audit_logs').doc(randomUUID());tx.create(audit,encode({id:audit.id,admin_user_id:p.p_admin,action:name,target_type:name==='admin_set_user_status'?'user':'referral',target_id:target.id,reason,before_data:before,after_data:after,created_at:timestamp}));
    return {id:target.id,...after};
  });}
  async function rpc(name,p){
    if(name==='realtime_wallet_balance')return realtime.balance(p.p_user);
    if(name==='configure_realtime_video')return realtime.configure(p);
    if(name==='authorize_translation_usage')return realtime.translation(p);
    if(name==='apply_verified_package_payment'||name==='apply_verified_ivorypay_payment'){
      const result=await payment.applyPayment({userId:p.p_user,packageId:p.p_package,reference:p.p_reference,gateway:name==='apply_verified_package_payment'?'flutterwave':'ivorypay',gatewayId:String(p.p_gateway_id),amount:p.p_amount,fee:p.p_fee??0});
      if(result.transactionId)await engagement.enqueue(p.p_user,'purchase_feedback',`purchase:${result.transactionId}`,result.transactionId);
      return result;
    }
    if(name==='admin_adjust_credits')return payment.adjustCredits({adminId:p.p_admin,userId:p.p_user,amount:p.p_amount,reason:p.p_reason,key:p.p_key});
    if(['admin_set_user_status','admin_disqualify_referral'].includes(name))return adminChange(name,p);
    if(['record_ai_session_usage','finalize_ai_session','record_realtime_video_usage'].includes(name)){
      const timestampSession=name==='finalize_ai_session'&&(await col('sessions').doc(p.p_session).get()).data()?.billing_version===2;
      const result=name==='record_realtime_video_usage'?await realtime.video(p):timestampSession?await realtime.video({...p,p_epoch_seconds:[],p_close:true}):await usage(p,name==='finalize_ai_session');
      if(result.remainingCredits<=0){
        const purchases=(await query('transactions','user_id',p.p_user).get()).docs.map(d=>d.data()).filter(r=>(r.transaction_type||r.type)==='credit_purchase'&&['success','successful','completed'].includes(String(r.status).toLowerCase())&&(!r.refund_status||r.refund_status==='none')).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||String(b.id).localeCompare(String(a.id)));
        if(purchases[0])await engagement.enqueue(p.p_user,'credits_finished',`credits-finished:${purchases[0].id}`,purchases[0].id);
      }
      return result;
    }
    if(name==='morphly_ensure_user_referral_code'){await provision({id:p.p_user});return (await col('users').doc(p.p_user).get()).data().referral_code;}
    if(name==='morphly_claim_signup_bonus_welcome')return db.runTransaction(async tx=>{const ref=col('users').doc(p.p_user);const [profile,bonus]=await Promise.all([tx.get(ref),tx.get(query('transactions','reference',`signup_bonus:${p.p_user}`))]);if(!profile.exists||profile.data().signup_bonus_welcome_shown_at||!bonus.docs.some(d=>d.data().status==='success'&&d.data().transaction_type==='signup_bonus'))return false;tx.update(ref,{signup_bonus_welcome_shown_at:now(),updated_at:now()});return true;});
    if(name==='morphly_validate_referral_code')return db.runTransaction(async tx=>{if(!p.p_request_hash)throw new Error('Request identity required');const ref=col('firebase_referral_rate_limits').doc(hash(p.p_request_hash));const [state,profiles]=await Promise.all([tx.get(ref),tx.get(query('users','referral_code',p.p_code))]);const start=Date.now()-600000;const attempts=(state.data()?.attempts||[]).filter(t=>t>start);const limited=attempts.length>=20;tx.set(ref,{attempts:[...attempts.slice(-20),Date.now()],updated_at:now()});return {valid:!limited&&/^[A-HJ-NP-Z2-9]{6,12}$/.test(p.p_code)&&profiles.docs.some(d=>d.data().account_status==='active'),rateLimited:limited};});
    if(name==='morphly_submit_review'){const result=await submitReview(p);await engagement.enqueue(p.p_user,'admin_review',`review:${result}`,result);return result;}
    if(name==='morphly_claim_customer_email')return engagement.claim(p);
    if(name==='morphly_schedule_customer_emails')return engagement.schedule(p);
    throw new Error(`Firebase operation not implemented: ${name}`);
  }
  async function submitReview(p){const record=await auth.getUser(p.p_user);return db.runTransaction(async tx=>{const ref=col('customer_reviews').doc(p.p_id),guard=col('firebase_review_rate_limits').doc(p.p_user);const [existing,state]=await Promise.all([tx.get(ref),tx.get(guard)]);const values={id:p.p_id,user_id:p.p_user,email:record.email,category:p.p_category,rating:p.p_rating,message:String(p.p_message).trim(),status:'new',created_at:now()};if(existing.exists){if(['user_id','category','rating','message'].some(k=>existing.data()[k]!==values[k]))throw new Error('Review request conflicts');return ref.id;}const attempts=(state.data()?.attempts||[]).filter(t=>t>Date.now()-86400000);if(attempts.length>=5)throw new Error('You can send up to five reviews per day');tx.set(guard,{attempts:[...attempts,Date.now()]});tx.create(ref,values);return ref.id;});}
  return {rpc,provision,usage};
}
