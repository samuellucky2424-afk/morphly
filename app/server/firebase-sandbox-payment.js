import { randomUUID, createCipheriv } from 'node:crypto';
import { firebaseDb } from './firebase-admin.js';
import { hash } from './firebase-store.js';
import { createPaymentRuntime, money } from './firebase-payment-runtime.mjs';

export const sandboxPayments=()=>process.env.MORPHLY_PAYMENT_MODE==='sandbox';
let tokenCache=null;
async function token(){
  if(tokenCache?.expires>Date.now())return tokenCache.value;
  const response=await fetch('https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:process.env.FLUTTERWAVE_CLIENT_ID,client_secret:process.env.FLUTTERWAVE_CLIENT_SECRET,grant_type:'client_credentials'}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error('Flutterwave sandbox authentication failed');
  const body=await response.json();tokenCache={value:body.access_token,expires:Date.now()+(body.expires_in-30)*1000};return tokenCache.value;
}
async function request(path,body,idempotency=randomUUID()){
  const response=await fetch('https://developersandbox-api.flutterwave.com/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+await token(),'Content-Type':'application/json','X-Trace-Id':randomUUID(),'X-Idempotency-Key':idempotency},...body?{body:JSON.stringify(body)}:{},signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error(`Flutterwave sandbox request failed (${response.status})`);
  const payload=await response.json();if(payload.status!=='success')throw new Error('Flutterwave sandbox returned an unsuccessful response');return payload.data;
}
export async function verifySandboxPayment({reference,transactionId,userId}){
  if(!sandboxPayments()||!reference||!transactionId)throw new Error('Sandbox payment context required');
  const order=await firebaseDb.collection('review_payment_orders').doc(hash(reference)).get();
  if(!order.exists||order.data().scope!=='firebase-preview'||order.data().userId!==userId)throw new Error('Payment owner mismatch');
  const charge=await request('charges/'+encodeURIComponent(transactionId));
  const expected=order.data();
  if(charge.id!==transactionId||charge.reference!==reference||charge.currency!==expected.currency||charge.status!=='succeeded'||money(charge.amount)!==money(expected.amount))throw new Error('Verified payment does not match the order');
  return createPaymentRuntime(firebaseDb).applyPayment({userId,packageId:expected.packageId,reference,gateway:'flutterwave',gatewayId:charge.id,amount:charge.amount,fee:0});
}
export async function createSandboxPayment(user,packageId,origin){
  if(!sandboxPayments())throw new Error('Sandbox is disabled');
  const [pkg,profile]=await Promise.all([firebaseDb.collection('credit_packages').doc(packageId).get(),firebaseDb.collection('users').doc(user.id).get()]);
  if(!pkg.exists||!pkg.data().is_active||pkg.data().status!=='active')throw new Error('Package unavailable');
  if(profile.data()?.account_status!=='active')throw new Error('Account unavailable');
  const reference=randomUUID(),amount=pkg.data().price_ngn;
  const orderRef=firebaseDb.collection('review_payment_orders').doc(hash(reference));
  await orderRef.create({scope:'firebase-preview',userId:user.id,packageId,reference,amount,currency:'NGN',created_at:new Date().toISOString()});
  const customer=await request('customers',{email:`review-${reference}@example.com`,name:{first:'Morphly',last:'Sandbox'}});
  const key=Buffer.from(process.env.FLUTTERWAVE_ENCRYPTION_KEY||'','base64');if(key.length!==32)throw new Error('Invalid sandbox encryption configuration');
  const nonce=Buffer.from(randomUUID().replaceAll('-','').slice(0,12));
  const encrypt=value=>{const cipher=createCipheriv('aes-256-gcm',key,nonce);return Buffer.concat([cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64');};
  const method=await request('payment-methods',{type:'card',card:{nonce:nonce.toString(),encrypted_card_number:encrypt('5061460166976054667'),encrypted_expiry_month:encrypt('10'),encrypted_expiry_year:encrypt('29'),encrypted_cvv:encrypt('564')}});
  const charge=await request('charges',{reference,currency:'NGN',amount:Number(amount),customer_id:customer.id,payment_method_id:method.id,redirect_url:new URL('/api/flutterwave-payment-return',origin).toString(),meta:{purpose:'firebase-preview'}},reference);
  await orderRef.set({chargeId:charge.id},{merge:true});
  // The normal callback and provider webhook can race. Both reverify the
  // charge and use the same transaction deduplication records.
  const result=await verifySandboxPayment({reference,transactionId:charge.id,userId:user.id});
  const url=new URL('/api/flutterwave-payment-return',origin);url.searchParams.set('status','successful');url.searchParams.set('tx_ref',reference);url.searchParams.set('transaction_id',charge.id);
  return {reference,checkoutUrl:url.toString(),mode:'sandbox',...result};
}
