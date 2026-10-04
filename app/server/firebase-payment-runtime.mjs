import {createHash,createHmac,timingSafeEqual,randomUUID} from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a,b) => typeof a==='string' && typeof b==='string' && Buffer.byteLength(a)===Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function money(value) {
  const text=String(value ?? '');
  if(!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error('Invalid monetary amount');
  const [whole,fraction='']=text.split('.');
  return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
}
const amountString = cents => `${cents/100n}.${String(cents%100n).padStart(2,'0')}`;
const credits = value => { const n=Number(value); if(!Number.isSafeInteger(n)||n<0)throw new Error('Invalid credits');return n; };
const one = snapshot => {if(snapshot.size>1)throw new Error('Ambiguous source record');return snapshot.docs[0];};
const successful = row => ['success','successful','succeeded','completed','paid','verified'].includes(String(row.status??'success').toLowerCase());
const purchase = row => (row.transaction_type==='credit_purchase'||['credit_purchase','purchase','payment'].includes(row.type))&&row.package_id&&money(row.amount_naira??row.amount??0)>0n&&successful(row);

export function createPaymentRuntime(db) {
  const query=(name,field,value)=>db.collection(name).where(field,'==',value).limit(2);
  async function applyPayment(input) {
    const {userId,packageId,reference,gateway,gatewayId}=input;
    if(!userId||!packageId||typeof reference!=='string'||reference.trim().length<3||!gatewayId||!['flutterwave','ivorypay'].includes(gateway))throw new Error('Invalid payment context');
    const paid=money(input.amount),fee=money(input.fee??0);
    if(paid<=0n)throw new Error('Invalid verified amount');
    const txId=randomUUID(),ledgerId=randomUUID(),now=new Date().toISOString();
    const marker=db.collection('payment_dedup').doc(hash(`reference:${reference}`));
    const gatewayMarker=db.collection('payment_dedup').doc(hash(`${gateway}:${gatewayId}`));
    return db.runTransaction(async tx=>{
      // Read old transactions as well as new markers: migrated purchases must
      // never be credited again when a delayed provider callback arrives.
      const [profile,pkg,walletRows,seen,seenGateway,byReference,byGateway,prior,referrals]=await Promise.all([
        tx.get(db.collection('users').doc(userId)),tx.get(db.collection('credit_packages').doc(packageId)),
        tx.get(query('wallets','user_id',userId)),tx.get(marker),tx.get(gatewayMarker),
        tx.get(query('transactions','reference',reference)),tx.get(db.collection('transactions').where('gateway_transaction_id','==',String(gatewayId))),
        tx.get(db.collection('transactions').where('user_id','==',userId)),tx.get(query('referrals','referred_user_id',userId)),
      ]);
      if(!profile.exists)throw new Error('Payment user not found');
      if(profile.data().account_status!=='active')throw new Error('Account unavailable');
      const wallet=one(walletRows),old=credits(wallet?.data().credits??0);
      const historic=one(byReference)??byGateway.docs.find(d=>d.data().payment_gateway===gateway);
      const existing=seen.exists?seen.data():seenGateway.exists?seenGateway.data():historic?.data();
      if(existing){
        if(existing.user_id!==userId||(existing.package_id&&existing.package_id!==packageId)||(existing.payment_gateway&&existing.payment_gateway!==gateway))throw new Error('Payment context mismatch');
        return {status:'success',duplicate:true,transactionId:existing.transaction_id??historic?.id,creditsAdded:credits(existing.package_credits_snapshot??existing.credits??0),newCredits:old,referralRewarded:false};
      }
      if(!pkg.exists||pkg.data().status!=='active'||pkg.data().is_active!==true)throw new Error('Package unavailable');
      const packageData=pkg.data(),added=credits(packageData.credits);
      if(added===0||paid<money(packageData.price_ngn))throw new Error('Verified amount below package price');
      const updated=credits(old+added),first=!prior.docs.some(d=>purchase(d.data()));
      const referral=first?one(referrals):null,referralData=referral?.data();
      let referrer,referrerWallet,rewardExists;
      const eligible=referralData&&['registered','qualified'].includes(referralData.status);
      if(eligible&&referralData.referrer_user_id&&referralData.referrer_user_id!==userId){
        [referrer,referrerWallet,rewardExists]=await Promise.all([
          tx.get(db.collection('users').doc(referralData.referrer_user_id)),
          tx.get(query('wallets','user_id',referralData.referrer_user_id)),
          tx.get(query('transactions','reference',`referral_reward:${userId}`)),
        ]);
      }
      const walletRef=wallet?.ref??db.collection('wallets').doc(randomUUID());
      const record={id:txId,user_id:userId,package_id:packageId,reference,payment_gateway:gateway,gateway_transaction_id:String(gatewayId),amount:amountString(paid),amount_naira:amountString(paid),gateway_fee_ngn:amountString(fee),credits:added,package_name_snapshot:packageData.name,package_price_snapshot_ngn:packageData.price_ngn,package_credits_snapshot:added,type:'credit_purchase',transaction_type:'credit_purchase',status:'success',refund_status:'none',description:`${packageData.name} purchased`,created_at:now,verified_at:now};
      tx.create(db.collection('transactions').doc(txId),record);
      tx.set(walletRef,{...(wallet?.data()??{id:walletRef.id,user_id:userId,balance:'0.00',created_at:now}),credits:updated,updated_at:now});
      tx.create(db.collection('wallet_ledger').doc(ledgerId),{id:ledgerId,user_id:userId,transaction_id:txId,delta:added,balance_after:updated,entry_type:'package_purchase',reason:`Verified ${gateway} payment`,idempotency_key:`payment:${reference}`,created_at:now});
      const dedup={transaction_id:txId,user_id:userId,package_id:packageId,payment_gateway:gateway,credits:added};
      tx.create(marker,dedup);tx.create(gatewayMarker,dedup);
      let referralRewarded=false;
      if(eligible){
        const audit=(action,metadata)=>{const id=randomUUID();tx.create(db.collection('referral_audit_logs').doc(id),{id,action,referral_id:referral.id,referrer_user_id:referralData.referrer_user_id,referred_user_id:userId,metadata:JSON.stringify(metadata),created_at:now});};
        audit('referral.qualified',{purchaseId:txId});
        const qualification={qualified_purchase_id:txId,qualified_at:referralData.qualified_at??now,updated_at:now};
        if(!referrer?.exists||referrer.data().account_status!=='active'){
          tx.update(referral.ref,{...qualification,status:'disqualified',disqualified_at:now,disqualification_reason:'Referrer is unavailable or ineligible'});
          audit('referral.disqualified',{reason:'Referrer is unavailable or ineligible'});
        }else if(!rewardExists.size){
          const rw=one(referrerWallet),rwRef=rw?.ref??db.collection('wallets').doc(randomUUID()),rewardId=randomUUID(),rewardLedger=randomUUID();
          const newCredits=credits(credits(rw?.data().credits??0)+200);
          tx.set(rwRef,{...(rw?.data()??{id:rwRef.id,user_id:referrer.id,balance:'0.00',created_at:now}),credits:newCredits,updated_at:now});
          tx.create(db.collection('transactions').doc(rewardId),{id:rewardId,user_id:referrer.id,type:'credit',transaction_type:'referral_reward',amount:'0.00',amount_naira:'0.00',credits:200,reference:`referral_reward:${userId}`,related_user_id:userId,related_payment_id:txId,description:'Referral reward for first purchase',status:'success',created_at:now,verified_at:now});
          tx.create(db.collection('wallet_ledger').doc(rewardLedger),{id:rewardLedger,user_id:referrer.id,transaction_id:rewardId,delta:200,balance_after:newCredits,entry_type:'referral_reward',reason:'Referral reward for first purchase',idempotency_key:`referral_reward:${userId}`,actor_user_id:userId,created_at:now});
          tx.update(referral.ref,{...qualification,status:'rewarded',reward_transaction_id:rewardId,rewarded_at:now});
          audit('referral.reward_granted',{credits:200,purchaseId:txId,rewardTransactionId:rewardId});referralRewarded=true;
        }else tx.update(referral.ref,{...qualification,status:'qualified'});
      }
      // Side effects are queued atomically, never sent inside a retried transaction.
      tx.create(db.collection('firebase_payment_outbox').doc(txId),{type:'payment.completed',user_id:userId,source_id:txId,created_at:now,status:'pending',gateway});
      return {status:'success',duplicate:false,transactionId:txId,creditsAdded:added,newCredits:updated,referralRewarded};
    });
  }
  async function adjustCredits({adminId,userId,amount,reason,key}) {
    if(!Number.isSafeInteger(amount)||amount===0||Math.abs(amount)>1000000||typeof reason!=='string'||reason.trim().length<3||reason.trim().length>240||typeof key!=='string'||key.trim().length<8||key.trim().length>200)throw new Error('Invalid adjustment');
    const marker=db.collection('admin_adjustment_dedup').doc(hash(key.trim()));
    return db.runTransaction(async tx=>{
      const [admin,profile,rows,seen,historic]=await Promise.all([tx.get(db.collection('admin_users').doc(adminId)),tx.get(db.collection('users').doc(adminId)),tx.get(query('wallets','user_id',userId)),tx.get(marker),tx.get(query('wallet_ledger','idempotency_key',key.trim()))]);
      if(!admin.exists||!admin.data().is_active||!profile.exists||profile.data().account_status!=='active')throw new Error('Admin access required');
      if(amount<0&&admin.data().role!=='super_admin')throw new Error('Super admin required');
      const wallet=one(rows);if(!wallet)throw new Error('Wallet not found');
      const previous=seen.exists?seen.data():one(historic)?.data();
      if(previous){if(previous.user_id!==userId||previous.actor_user_id!==adminId||previous.delta!==amount||previous.reason!==reason.trim())throw new Error('Idempotency key conflict');return {duplicate:true,newCredits:credits(wallet.data().credits)};}
      const before=credits(wallet.data().credits),after=credits(before+amount),now=new Date().toISOString(),id=randomUUID(),auditId=randomUUID();
      const ledger={id,user_id:userId,actor_user_id:adminId,delta:amount,balance_after:after,entry_type:'admin_adjustment',reason:reason.trim(),idempotency_key:key.trim(),created_at:now};
      tx.update(wallet.ref,{credits:after,updated_at:now});tx.create(db.collection('wallet_ledger').doc(id),ledger);tx.create(marker,ledger);
      tx.create(db.collection('admin_audit_logs').doc(auditId),{id:auditId,admin_user_id:adminId,action:amount>0?'credits.added':'credits.deducted',target_type:'user',target_id:userId,reason:reason.trim(),before_data:JSON.stringify({credits:before}),after_data:JSON.stringify({credits:after,adjustment:amount}),created_at:now});
      return {duplicate:false,newCredits:after};
    });
  }
  return {applyPayment,adjustCredits};
}

export function validSignature(gateway,raw,signature,secret,legacy=false){
  if(!Buffer.isBuffer(raw)||!secret||!signature)return false;
  if(gateway==='flutterwave')return same(signature,createHmac('sha256',secret).update(raw).digest('base64'))||(legacy&&same(signature,secret));
  if(gateway!=='ivorypay')return false;
  let payload;try{payload=JSON.parse(raw.toString('utf8'));}catch{return false;}
  return (payload.data&&same(signature,createHmac('sha512',secret).update(JSON.stringify(payload.data)).digest('hex')))||same(signature,createHmac('sha256',secret).update(raw).digest('hex'))||same(signature,createHmac('sha256',secret).update(raw).digest('base64'));
}

export function createWebhook({gateway,secret,verify,applyPayment,legacy=false}){
  return async ({rawBody,signature})=>{
    if(!secret)return {status:503,body:{error:'Webhook not configured'}};
    if(!validSignature(gateway,rawBody,signature,secret,legacy))return {status:401,body:{error:'Invalid signature'}};
    let event;try{event=JSON.parse(rawBody.toString('utf8'));}catch{return {status:400,body:{error:'Invalid JSON'}};}
    const data=event.data??{},name=String(event.type??event.event??'').toLowerCase();
    if(gateway==='flutterwave'&&name&&name!=='charge.completed')return {status:200,body:{ignored:true}};
    if(gateway==='ivorypay'&&!['successful','success','payment.success','transaction.successful','cryptocollection.success','fiatcollection.success','paid'].includes(name)&&!['successful','success','paid','completed'].includes(String(data.status??'').toLowerCase()))return {status:200,body:{ignored:true}};
    const reference=data.tx_ref??data.reference;
    const id=gateway==='flutterwave'?data.id??data.transaction_id:reference;
    if(!id)return {status:400,body:{error:'Missing payment identifier'}};
    try{
      // Only this injected provider adapter can produce verified payment context.
      // The HTTP adapter must re-query the provider, never echo webhook metadata.
      const verified=await verify(id);
      if(!verified||!verified.successful||verified.currency!=='NGN'||!verified.reference||reference&&reference!==verified.reference) return {status:400,body:{error:'Payment verification rejected'}};
      const result=await applyPayment({...verified,gateway});
      return {status:200,body:{received:true,...result}};
    }catch{return {status:500,body:{error:'Payment processing failed; retry'}};}
  };
}
