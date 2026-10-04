import {randomUUID} from 'node:crypto';
import {hash} from './firebase-store.js';

const single=rows=>{if(rows.size!==1)throw new Error('Wallet not found or ambiguous');return rows.docs[0];};
const epochId=(uid,second)=>hash(JSON.stringify([uid,String(second)]));
const utc=value=>Date.parse(typeof value==='string'&&/^\d{4}-\d\d-\d\d /.test(value)?value.replace(' ','T')+'Z':value);
export function createFirebaseRealtimeBilling(db){
  async function balance(uid){
    const [wallets,carry]=await Promise.all([db.collection('wallets').where('user_id','==',uid).get(),db.collection('realtime_credit_carry').doc(uid).get()]);
    return Number(single(wallets).data().credits)+Number(carry.data()?.half_credit||0)/2;
  }
  async function configure(p){
    if(![4,5,8].includes(p.p_rate_half))throw new Error('Invalid video rate');
    return db.runTransaction(async tx=>{
      const ref=db.collection('sessions').doc(p.p_session),snapshot=await tx.get(ref),row=snapshot.data();
      if(!row||row.user_id!==p.p_user||row.status!=='active'||Number(row.seconds_used||0)!==0)throw new Error('Session not available');
      tx.update(ref,{billing_version:2,video_rate_half:p.p_rate_half});
      return {billingVersion:2,serverNow:Date.now()};
    });
  }
  async function meter(kind,p){
    const uid=p.p_user,sessionId=p.p_session,close=p.p_close===true,time=Math.floor(Date.now()/1000);
    if(!uid||!sessionId)throw new Error('Session ownership required');
    if(kind==='video'&&(!Array.isArray(p.p_epoch_seconds)||p.p_epoch_seconds.length>60||p.p_epoch_seconds.some(s=>!Number.isSafeInteger(s))))throw new Error('Invalid video usage timestamps');
    if(kind==='translation'&&(!Number.isInteger(p.p_seconds)||p.p_seconds<0||p.p_seconds>7200))throw new Error('Invalid translation duration');
    return db.runTransaction(async tx=>{
      const sessionRef=db.collection(kind==='video'?'sessions':'translation_sessions').doc(sessionId),carryRef=db.collection('realtime_credit_carry').doc(uid);
      const [wallets,carry,session,profile,associated,videoSessions,translationSessions]=await Promise.all([
        tx.get(db.collection('wallets').where('user_id','==',uid)),tx.get(carryRef),tx.get(sessionRef),tx.get(db.collection('users').doc(uid)),
        tx.get(db.collection('realtime_usage_seconds').where(kind==='video'?'video_session':'translation_session','==',sessionId)),
        kind==='translation'?tx.get(db.collection('sessions').where('user_id','==',uid)):Promise.resolve(null),
        kind==='translation'?tx.get(db.collection('translation_sessions').where('user_id','==',uid)):Promise.resolve(null),
      ]);
      if(profile.data()?.account_status!=='active')throw new Error('Account unavailable');
      const wallet=single(wallets);let available=Number(wallet.data().credits)*2+Number(carry.data()?.half_credit||0);
      if(!Number.isSafeInteger(available)||available<0)throw new Error('Invalid wallet balance');
      let row=session.data();
      if(row&&row.user_id!==uid)throw new Error('Session ownership mismatch');
      if(kind==='video'&&(!row||row.billing_version!==2))throw new Error('Session ownership or billing version mismatch');
      if(kind==='video'&&row.status!=='active')return {shouldStop:true,remainingCredits:available/2};
      if(kind==='translation'&&row?.closed_at)return {closed:true,authorizedSeconds:Number(row.authorized_seconds),remainingCredits:available/2};
      let seconds,target=0;
      const stale=[];
      if(kind==='video'){
        seconds=[...new Set(p.p_epoch_seconds)].sort((a,b)=>a-b);
        if(seconds.some(s=>s>time||s<time-120||s<Math.floor(utc(row.start_time)/1000)))throw new Error('Invalid usage timestamp');
      }else{
        if(!close&&videoSessions.docs.some(d=>d.data().status==='active'&&d.data().billing_version!==2))throw new Error('Restart face streaming in the updated app before translating');
        for(const doc of translationSessions.docs){const other=doc.data();if(doc.id===sessionId||other.closed_at)continue;if(Number(other.started_epoch)+Number(other.authorized_seconds)+30<time)stale.push(doc);else throw Object.assign(new Error('Another translation session is active'),{code:'23505'});}
        row||={id:sessionId,user_id:uid,started_epoch:String(time),authorized_seconds:0,closed_at:null};
        target=Number(row.authorized_seconds);
        if(close){target=Math.min(p.p_seconds,target);seconds=associated.docs.map(d=>Number(d.data().epoch_second)).filter(s=>s>=Number(row.started_epoch)+target).sort((a,b)=>a-b);}
        else{
          if(p.p_seconds>time-Number(row.started_epoch)+5)throw new Error('Reservation too far ahead');
          seconds=Array.from({length:Math.max(0,p.p_seconds-target)},(_,i)=>Number(row.started_epoch)+target+i);
        }
        // Normal relay reservations are five seconds. Bound a delayed request
        // so its ledger and bucket writes remain within one Firestore commit.
        if(seconds.length>120)throw new Error('Translation reservation expired; restart translation');
      }
      const refs=seconds.map(s=>db.collection('realtime_usage_seconds').doc(epochId(uid,s)));
      const buckets=refs.length?await tx.getAll(...refs):[];
      const ledgers=await Promise.all(seconds.map(s=>tx.get(db.collection('wallet_ledger').where('idempotency_key','==',`rt-second:${uid}:${s}`).limit(2))));
      const changes=[],ledgerChanges=[];let count=associated.size,stopped=false;
      for(let i=0;i<seconds.length;i++){
        const second=seconds[i],old=buckets[i].data()||{},previousVideo=old.video_session||null;
        if(kind==='video'&&previousVideo&&previousVideo!==sessionId)throw new Error('Overlapping video sessions');
        const video=previousVideo||(kind==='video'?sessionId:null);
        const voice=kind==='translation'&&close&&old.translation_session===sessionId?null:old.translation_session||(kind==='translation'?sessionId:null);
        // Plus/Pro video prices are fixed; translation with video is 4 total.
        const rate=Math.max(Number(old.video_rate_half||0),kind==='video'?Number(row.video_rate_half):0);
        const cost=voice?(video?8:5):rate,delta=cost-Number(old.cost_half||0);
        if(kind==='video'&&count>=Math.min(Number(row.provider_max_seconds||7200),7200)&&previousVideo!==sessionId){stopped=true;break;}
        if(delta>available){stopped=true;break;}
        const beforeWallet=Math.floor(available/2);available-=delta;const afterWallet=Math.floor(available/2);
        changes.push({ref:refs[i],exists:buckets[i].exists,data:{user_id:uid,epoch_second:String(second),video_session:video,video_rate_half:rate,translation_session:voice,cost_half:cost}});
        if(kind==='video'&&previousVideo!==sessionId)count++;
        if(kind==='translation'&&!close)target++;
        if(beforeWallet!==afterWallet){
          if(ledgers[i].size>1)throw new Error('Ambiguous usage ledger');
          const oldLedger=ledgers[i].docs[0],id=oldLedger?.id||randomUUID();
          ledgerChanges.push({ref:oldLedger?.ref||db.collection('wallet_ledger').doc(id),exists:!!oldLedger,data:{...(oldLedger?.data()||{id,user_id:uid,entry_type:'realtime_usage',reason:'Realtime usage; fractional change retained',idempotency_key:`rt-second:${uid}:${second}`,created_at:new Date().toISOString()}),delta:Number(oldLedger?.data().delta||0)+afterWallet-beforeWallet,balance_after:afterWallet}});
        }
      }
      const timestamp=new Date().toISOString();
      tx.update(wallet.ref,{credits:Math.floor(available/2),updated_at:timestamp});tx.set(carryRef,{user_id:uid,half_credit:available%2});
      for(const change of changes)change.exists?tx.update(change.ref,change.data):tx.create(change.ref,change.data);
      for(const change of ledgerChanges)change.exists?tx.update(change.ref,change.data):tx.create(change.ref,change.data);
      for(const doc of stale)tx.update(doc.ref,{closed_at:timestamp});
      if(kind==='video'){
        tx.update(sessionRef,{seconds_used:count,last_usage_at:timestamp,...close?{status:'ended',end_time:timestamp}:{}});
        return {totalBillableSeconds:count,remainingCredits:available/2,shouldStop:stopped||available<Number(row.video_rate_half)};
      }
      const updated={...row,authorized_seconds:target,...close?{closed_at:timestamp}:{}};
      session.exists?tx.update(sessionRef,updated):tx.create(sessionRef,updated);
      return {closed:close,authorizedSeconds:target,startedAtMs:Number(row.started_epoch)*1000,remainingCredits:available/2};
    });
  }
  return {balance,configure,video:p=>meter('video',p),translation:p=>meter('translation',p)};
}
