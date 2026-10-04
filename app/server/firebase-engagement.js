import { randomUUID } from 'node:crypto';
import { hash } from './firebase-store.js';

const successful = row => ['success','successful','completed'].includes(String(row.status).toLowerCase()) && (row.transaction_type || row.type) === 'credit_purchase';
const unrefunded = row => !row.refund_status || row.refund_status === 'none';
export function createFirebaseEngagement(db, auth, env = process.env) {
  const live = () => env.MORPHLY_PAYMENT_MODE === 'live' && env.MORPHLY_CUSTOMER_EMAILS_ENABLED !== 'false';
  async function enqueue(userId, kind, eventKey, sourceId = null) {
    if (!live()) return;
    const ref = db.collection('customer_email_jobs').doc(hash(eventKey));
    return db.runTransaction(async tx => {
      const [existing, historic] = await Promise.all([tx.get(ref), tx.get(db.collection('customer_email_jobs').where('event_key','==',eventKey))]);
      if (existing.exists || !historic.empty) return;
      const timestamp = new Date().toISOString();
      tx.create(ref,{id:ref.id,user_id:userId,kind,event_key:eventKey,source_id:sourceId,due_at:timestamp,status:'pending',attempts:0,created_at:timestamp});
    });
  }
  async function schedule({ p_inactivity_days = 14 } = {}) {
    if (!live()) return;
    if (!Number.isInteger(p_inactivity_days) || p_inactivity_days < 1 || p_inactivity_days > 365) throw new Error('Invalid reminder interval');
    const [purchases, prefs, subscriptions, outbox, profiles] = await Promise.all([
      db.collection('transactions').get(), db.collection('customer_email_preferences').get(),
      db.collection('subscriptions').get(), db.collection('firebase_payment_outbox').where('status','==','pending').get(),db.collection('users').get(),
    ]);
    const byUser = new Map();
    for (const doc of purchases.docs) { const row=doc.data(); if(successful(row)){const rows=byUser.get(row.user_id)||[];rows.push(row);byUser.set(row.user_id,rows);} }
    const disabled = new Set(prefs.docs.filter(d=>d.data().enabled===false).map(d=>d.data().user_id));
    const activeUsers = new Set(profiles.docs.filter(d=>d.data().account_status==='active').map(d=>d.id));
    const time=Date.now(); let cursor, signupCount=0, reminderCount=0;
    do {
      const page=await auth.listUsers(1000,cursor); cursor=page.pageToken;
      for(const user of page.users){
        if(signupCount<1000 && activeUsers.has(user.uid) && user.emailVerified && Date.parse(user.metadata.creationTime)<=time-7*86400000 && !disabled.has(user.uid) && !byUser.has(user.uid)){
          await enqueue(user.uid,'signup_checkin',`signup:${user.uid}`); signupCount++;
        }
      }
    } while(cursor);
    for(const [uid,rows] of byUser){
      if(reminderCount<1000 && rows.length===1 && unrefunded(rows[0]) && Date.parse(rows[0].created_at)<=time-p_inactivity_days*86400000){await enqueue(uid,'first_purchase_reminder',`first-purchase-reminder:${uid}`,rows[0].id);reminderCount++;}
    }
    for(const doc of subscriptions.docs){const row=doc.data();if(row.status==='expired'||row.status==='active'&&Date.parse(row.ends_at)<=time)await enqueue(row.user_id,'subscription_finished',`subscription-finished:${row.id}`,row.id);}
    for(const doc of outbox.docs){const row=doc.data();if(row.type!=='payment.completed')continue;
      const purchase=(byUser.get(row.user_id)||[]).find(p=>p.id===row.source_id);
      if(purchase&&unrefunded(purchase)){
        await enqueue(row.user_id,'purchase_confirmation',`purchase-confirmation:${row.source_id}`,row.source_id);
        await enqueue(row.user_id,'purchase_feedback',`purchase:${row.source_id}`,row.source_id);
      }
      await doc.ref.update({status:'processed',processed_at:new Date().toISOString()});
    }
  }
  async function claim({ p_user = null, p_job = null } = {}) {
    if (!live()) return [];
    return db.runTransaction(async tx => {
      const snapshot=await tx.get(db.collection('customer_email_jobs').where('status','in',['pending','processing']));
      const time=Date.now(), candidates=[], expired=[];
      for(const doc of snapshot.docs){const row=doc.data();
        if(row.first_attempt_at && Date.parse(row.first_attempt_at)<time-23*3600000){expired.push(doc);continue;}
        if((!p_user||row.user_id===p_user)&&(!p_job||row.source_id===p_job)&&
          (row.status==='pending'&&Date.parse(row.due_at)<=time||row.status==='processing'&&Date.parse(row.locked_until)<time))candidates.push(doc);
      }
      candidates.sort((a,b)=>Number(b.data().kind==='purchase_confirmation')-Number(a.data().kind==='purchase_confirmation')||Date.parse(a.data().due_at)-Date.parse(b.data().due_at)||a.id.localeCompare(b.id));
      for(const doc of expired.slice(0,400))tx.update(doc.ref,{status:'failed',last_error:'Delivery needs review; retry window expired',locked_until:null});
      if(!candidates.length)return [];
      const doc=candidates[0], row=doc.data(), claimed={...row,status:'processing',attempts:Number(row.attempts||0)+1,first_attempt_at:row.first_attempt_at||new Date(time).toISOString(),locked_until:new Date(time+600000).toISOString(),lease_id:randomUUID()};
      tx.update(doc.ref,claimed);
      if(typeof claimed.payload==='string')claimed.payload=JSON.parse(claimed.payload);
      return [claimed];
    });
  }
  return {enqueue,schedule,claim};
}
