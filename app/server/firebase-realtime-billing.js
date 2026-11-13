import {randomUUID} from 'node:crypto';
import {hash} from './firebase-store.js';

const single=rows=>{if(rows.size!==1)throw new Error('Wallet not found or ambiguous');return rows.docs[0];};
const epochId=(uid,second)=>hash(JSON.stringify([uid,String(second)]));
export const VOICE_RATE_HALF=4; // 2 credits per second
export const VOICE_GRACE_MS=20000;
export const HEARTBEAT_TIMEOUT_MS=90000;
// Vidu keeps a short rolling hold because its relay can follow server time.
// Plus keeps one Xmax key for the prepaid output lifetime (up to 30 minutes, the
// provider cap) plus a fixed unpaid connect allowance, so a short balance is not
// cut off while the engine is still starting. Heartbeats bill server time only
// after output is confirmed. The key is revoked when the session ends or the
// balance cannot cover the next output second, and a missed heartbeat ends it.
export const PROVIDER_CREDENTIAL_WINDOW_SECONDS=180;
export const XMAX_KEY_MAX_SECONDS=1800;
export const MAX_COMMIT_SECONDS=120;
// Connecting and preparing are not output. The provider credential and the
// relay deadline include this unpaid allowance so a balance of N seconds is
// not spent, and the session is not ended, while the engine is still starting.
// 150s covers the desktop proxy connect timeout (145s). It is not billable.
export const CONNECT_ALLOWANCE_SECONDS=150;
// A session that ends this soon after output is confirmed was a provider or
// connect failure. The desktop sends the confirming heartbeat and the close as
// two requests, so the window covers a slow link. Charge nothing. A session
// that keeps running is billed from the confirmation, including this window.
export const OUTPUT_GRACE_SECONDS=15;
export function providerCredentialSeconds(paidSeconds,ceiling=XMAX_KEY_MAX_SECONDS){
  const paid=Math.floor(Number(paidSeconds)||0);
  if(paid<1)return 0;
  return Math.min(ceiling,paid+CONNECT_ALLOWANCE_SECONDS);
}
export const VOICE_CONVERT_SLOTS=3;
export const PCM_BYTES_PER_SECOND=32000;
const SLOT_TTL_MS=30000;
const utc=value=>Date.parse(typeof value==='string'&&/^\d{4}-\d\d-\d\d /.test(value)?value.replace(' ','T')+'Z':value);

export function paidCredentialSeconds(maxSeconds,ceiling=XMAX_KEY_MAX_SECONDS){
  const paid=Math.floor(Number(maxSeconds)||0);
  if(paid<1)return 0;
  return Math.min(paid,ceiling);
}

export function pcmDurationSeconds(byteLength){
  const bytes=Number(byteLength);
  if(!Number.isSafeInteger(bytes)||bytes<2||bytes%2!==0)throw new Error('Invalid audio duration');
  return Math.max(1,Math.ceil(bytes/PCM_BYTES_PER_SECOND));
}

export function createFirebaseRealtimeBilling(db,options={}){
  const now=()=>options.now?.()??Date.now();
  async function balance(uid){
    const [wallets,carry]=await Promise.all([db.collection('wallets').where('user_id','==',uid).get(),db.collection('realtime_credit_carry').doc(uid).get()]);
    return Number(single(wallets).data().credits)+Number(carry.data()?.half_credit||0)/2;
  }
  async function configure(p){
    if(![4,5,8].includes(p.p_rate_half))throw new Error('Invalid video rate');
    return db.runTransaction(async tx=>{
      const ref=db.collection('sessions').doc(p.p_session),snapshot=await tx.get(ref),row=snapshot.data();
      if(!row||row.user_id!==p.p_user||row.status!=='active'||Number(row.seconds_used||0)!==0)throw new Error('Session not available');
      const others=await tx.get(db.collection('sessions').where('user_id','==',p.p_user));
      if(others.docs.some(doc=>doc.id!==p.p_session&&doc.data().status==='active'))throw new Error('Another streaming session is active');
      tx.update(ref,{billing_version:2,video_rate_half:p.p_rate_half});
      return {billingVersion:2,serverNow:now()};
    });
  }
  function payDelta(state,delta){
    if(delta<0){state.available-=delta;return true;}
    if(delta===0)return true;
    const fromReserved=Math.min(state.reserved,delta);
    state.reserved-=fromReserved;
    const fromWallet=delta-fromReserved;
    if(fromWallet>state.available)return false;
    state.available-=fromWallet;
    return true;
  }
  async function chargeSeconds(tx,state,seconds,kind,sessionId,close){
    const refs=seconds.map(second=>db.collection('realtime_usage_seconds').doc(epochId(state.uid,second)));
    const buckets=refs.length?await tx.getAll(...refs):[];
    const ledgers=await Promise.all(seconds.map(second=>tx.get(db.collection('wallet_ledger').where('idempotency_key','==',`rt-second:${state.uid}:${second}`).limit(2))));
    const changes=[],ledgerChanges=[];
    let stopped=false;
    for(let i=0;i<seconds.length;i++){
      const second=seconds[i],old=buckets[i].data()||{},previousVideo=old.video_session||null;
      if(kind==='video'&&previousVideo&&previousVideo!==sessionId)throw new Error('Overlapping video sessions');
      const video=previousVideo||(kind==='video'?sessionId:null);
      const voice=kind==='translation'&&close&&old.translation_session===sessionId?null:old.translation_session||(kind==='translation'?sessionId:null);
      const rate=Math.max(Number(old.video_rate_half||0),kind==='video'?Number(state.videoRate):0);
      const cost=voice?(video?rate+VOICE_RATE_HALF:VOICE_RATE_HALF):rate;
      const delta=cost-Number(old.cost_half||0);
      if(kind==='video'&&state.count>=Math.min(Number(state.cap||7200),7200)&&previousVideo!==sessionId){stopped=true;break;}
      if(!payDelta(state,delta)){stopped=true;break;}
      const beforeWallet=state.walletFloor;state.walletFloor=Math.floor(state.available/2);
      changes.push({ref:refs[i],exists:buckets[i].exists,data:{user_id:state.uid,epoch_second:String(second),video_session:video,video_rate_half:rate,translation_session:voice,cost_half:cost}});
      if(kind==='video'&&previousVideo!==sessionId)state.count++;
      if(kind==='translation'&&!close)state.target++;
      state.lastSecond=second;
      if(beforeWallet!==state.walletFloor){
        if(ledgers[i].size>1)throw new Error('Ambiguous usage ledger');
        const oldLedger=ledgers[i].docs[0],id=oldLedger?.id||randomUUID();
        ledgerChanges.push({ref:oldLedger?.ref||db.collection('wallet_ledger').doc(id),exists:!!oldLedger,data:{...(oldLedger?.data()||{id,user_id:state.uid,entry_type:'realtime_usage',reason:'Realtime usage; fractional change retained',idempotency_key:`rt-second:${state.uid}:${second}`,created_at:new Date(now()).toISOString()}),delta:Number(oldLedger?.data().delta||0)+state.walletFloor-beforeWallet,balance_after:state.walletFloor}});
      }
    }
    return {changes,ledgerChanges,stopped};
  }
  function writeCharges(tx,state,wallet,carryRef,changes,ledgerChanges){
    const timestamp=new Date(now()).toISOString();
    tx.update(wallet.ref,{credits:Math.floor(state.available/2),updated_at:timestamp});
    tx.set(carryRef,{user_id:state.uid,half_credit:state.available%2});
    for(const change of changes)change.exists?tx.update(change.ref,change.data):tx.create(change.ref,change.data);
    for(const change of ledgerChanges)change.exists?tx.update(change.ref,change.data):tx.create(change.ref,change.data);
    return timestamp;
  }
  async function mutateVideo(p,mode){
    const uid=p.p_user,sessionId=p.p_session;
    if(!uid||!sessionId)throw new Error('Session ownership required');
    return db.runTransaction(async tx=>{
      const sessionRef=db.collection('sessions').doc(sessionId),carryRef=db.collection('realtime_credit_carry').doc(uid);
      const [wallets,carry,session,profile,associated,owned]=await Promise.all([
        tx.get(db.collection('wallets').where('user_id','==',uid)),tx.get(carryRef),tx.get(sessionRef),tx.get(db.collection('users').doc(uid)),
        tx.get(db.collection('realtime_usage_seconds').where('video_session','==',sessionId)),
        tx.get(db.collection('sessions').where('user_id','==',uid)),
      ]);
      if(profile.data()?.account_status!=='active')throw new Error('Account unavailable');
      if(owned.docs.some(doc=>doc.id!==sessionId&&doc.data().status==='active'))throw new Error('Another streaming session is active');
      const wallet=single(wallets);
      const row=session.data();
      if(!row||row.user_id!==uid||row.billing_version!==2)throw new Error('Session ownership or billing version mismatch');
      const availableNow=Number(wallet.data().credits)*2+Number(carry.data()?.half_credit||0);
      if(!Number.isSafeInteger(availableNow)||availableNow<0)throw new Error('Invalid wallet balance');
      if(row.status!=='active')return {shouldStop:true,remainingCredits:availableNow/2,reason:'session_not_found',ended:true};
      if(!Number.isSafeInteger(Number(row.video_rate_half))||Number(row.video_rate_half)<=0)throw new Error('Invalid video rate');
      const time=Math.floor(now()/1000);
      const start=Math.floor(utc(row.start_time)/1000);
      const anchor=Number.isSafeInteger(start)?start:time;
      const cap=Math.min(Number(row.provider_max_seconds||7200),7200);
      const state={uid,available:availableNow,reserved:Number(row.reserved_half||0),walletFloor:Math.floor(availableNow/2),videoRate:Number(row.video_rate_half),count:associated.size,cap,target:0,lastSecond:Number.isSafeInteger(Number(row.last_billed_epoch))?Number(row.last_billed_epoch):anchor-1};
      let outputStarted=Number.isSafeInteger(Number(row.output_started_epoch))?Number(row.output_started_epoch):null;
      let outputBudget=Number.isFinite(Number(row.output_budget_seconds))?Number(row.output_budget_seconds):null;
      let prepaidUntil=Number(row.prepaid_until_epoch||anchor);
      const expiresAt=Date.parse(row.credential_expires_at||'');
      let close=p.p_close===true;
      const lastBeat=Date.parse(row.last_heartbeat_at||row.start_time||0);
      let reason=close?String(p.p_reason||'client_ended').slice(0,80):null;
      if(!close&&Number.isFinite(lastBeat)&&row.last_heartbeat_at&&now()-lastBeat>HEARTBEAT_TIMEOUT_MS){close=true;reason='heartbeat_timeout';}
      if(!close&&row.provider==='xmax'&&Number.isFinite(expiresAt)&&expiresAt<=now()){close=true;reason='credential_expired';}
      // Plus and Pro both top up on every server touch. Plus is capped at the
      // key already issued, so an old client keeps that key and unpaid time is
      // never added past it. The paid window is measured from confirmed output,
      // not from session creation, so connect time is not reserved as spent.
      const extend=!close&&(mode.reserveOnly||mode.extend||row.provider==='vidu'||row.provider==='xmax');
      let added=0;
      const capAnchor=outputStarted??anchor;
      if(extend||mode.reserveOnly){
        const requested=Math.max(1,Math.floor(Number(p.p_window)||(row.provider==='xmax'?cap:PROVIDER_CREDENTIAL_WINDOW_SECONDS)));
        const windowCap=row.provider==='xmax'?XMAX_KEY_MAX_SECONDS:PROVIDER_CREDENTIAL_WINDOW_SECONDS;
        const windowSeconds=Math.min(requested,windowCap);
        let horizon=time+windowSeconds;
        if(!mode.reserveOnly&&row.provider==='xmax'&&Number.isFinite(expiresAt))horizon=Math.min(horizon,Math.floor(expiresAt/1000));
        const targetExclusive=Math.min(capAnchor+cap,Math.max(prepaidUntil,horizon));
        added=Math.min(Math.max(0,targetExclusive-prepaidUntil),Math.floor(state.available/state.videoRate));
        if(added>0){state.available-=added*state.videoRate;state.reserved+=added*state.videoRate;state.walletFloor=Math.floor(state.available/2);prepaidUntil+=added;}
        // One unpaid connect allowance, fixed at reservation. Later heartbeats must
        // not slide it forward, or a client could keep the relay open without output.
        if(outputStarted==null&&!Number.isFinite(Number(row.prepaid_until_epoch))){
          const held=Math.floor(state.reserved/state.videoRate);
          prepaidUntil=time+CONNECT_ALLOWANCE_SECONDS+held;
        }
        if(mode.reserveOnly){
          const timestamp=writeCharges(tx,state,wallet,carryRef,[],[]);
          tx.update(sessionRef,{reserved_half:state.reserved,prepaid_until_epoch:prepaidUntil,last_heartbeat_at:timestamp});
          return {reservedSeconds:added,prepaidUntilEpoch:prepaidUntil,remainingCredits:(state.available+state.reserved)/2,shouldStop:added<1};
        }
      }
      // A live heartbeat or session-status poll is the server's confirmation that
      // output started. Client epoch lists are ignored. The clock starts at this
      // server second, so earlier connect time is never billed. A close with no
      // prior confirmation, or a close inside the short grace window, charges nothing.
      if(outputStarted==null&&!close&&!mode.reserveOnly){
        outputStarted=time;
        outputBudget=Math.floor((state.available+state.reserved)/state.videoRate);
      }
      const startup=outputStarted==null||time-outputStarted<=OUTPUT_GRACE_SECONDS;
      if(!startup&&outputStarted!=null){
        const budget=outputBudget??Math.floor((state.available+state.reserved)/state.videoRate)+state.count;
        const paidEnd=outputStarted+budget;
        if(prepaidUntil>paidEnd)prepaidUntil=paidEnd;
      }
      // Sessions opened before prepaid windows still bill elapsed server time
      // from the wallet instead of trusting a client timestamp list.
      if(!startup&&!Number.isFinite(Number(row.prepaid_until_epoch))&&prepaidUntil<=outputStarted)prepaidUntil=Math.min(outputStarted+cap,time);
      const keyEnd=Number.isFinite(expiresAt)?Math.floor(expiresAt/1000):prepaidUntil;
      const timeoutEnd=Math.floor((lastBeat+HEARTBEAT_TIMEOUT_MS)/1000);
      // A late or missing heartbeat bills through the moment the session should
      // have stopped when that is still before the key expires. After the key
      // itself has expired, the prepaid lifetime was usable and is billed.
      // Nothing before output confirmation is included.
      const usageThrough=reason==='heartbeat_timeout'&&time<keyEnd?Math.min(time,timeoutEnd):reason==='credential_expired'?Math.min(time,keyEnd):time;
      const billAnchor=outputStarted??time;
      const endInclusive=startup?-1:Math.min(usageThrough-1,prepaidUntil-1,billAnchor+cap-1);
      const chunkEnd=Math.min(endInclusive,Math.max(state.lastSecond,billAnchor-1)+MAX_COMMIT_SECONDS);
      const seconds=[];
      if(!startup){
        for(let second=Math.max(state.lastSecond+1,billAnchor);second<=chunkEnd;second++)seconds.push(second);
      }
      const charged=await chargeSeconds(tx,state,seconds,'video',sessionId,false);
      const billingIncomplete=!startup&&endInclusive>chunkEnd&&!charged.stopped;
      let ended=false;
      if(charged.stopped){close=true;reason='no_credits';}
      if(close&&!billingIncomplete){state.available+=state.reserved;state.reserved=0;state.walletFloor=Math.floor(state.available/2);ended=true;}
      const timestamp=writeCharges(tx,state,wallet,carryRef,charged.changes,charged.ledgerChanges);
      tx.update(sessionRef,{
        seconds_used:state.count,last_billed_epoch:state.lastSecond,reserved_half:state.reserved,prepaid_until_epoch:prepaidUntil,
        ...outputStarted!=null?{output_started_epoch:outputStarted}:{},
        ...outputBudget!=null?{output_budget_seconds:outputBudget}:{},
        last_usage_at:timestamp,last_heartbeat_at:timestamp,
        ...ended?{status:'ended',end_time:timestamp,end_reason:reason}:{}});
      const remainingCredits=(state.available+state.reserved)/2;
      const covered=Math.floor((state.available+state.reserved)/state.videoRate)>=1;
      // Connecting must not look like an empty wallet. The hold is still the
      // customer's balance until output is confirmed and the grace window passes.
      const shouldStop=ended||(!startup&&remainingCredits<state.videoRate/2)||(startup&&!ended&&!covered);
      const renewalDue=!ended&&row.provider==='xmax'&&Number.isFinite(expiresAt)&&expiresAt-now()<45000&&expiresAt>now();
      return {totalBillableSeconds:state.count,remainingCredits,shouldStop,billingIncomplete,ended,reason,renewalDue,
        provider:row.provider,providerKeyId:row.provider_key_id||null,providerLiveId:row.provider_live_id||null,prepaidUntilEpoch:prepaidUntil};
    });
  }
  // Per-second usage buckets record which features ran in each second.
  // `translation` sessions now meter the voice changer (the collection names
  // are kept for compatibility with existing records).
  async function meter(kind,p){
    const uid=p.p_user,sessionId=p.p_session,close=p.p_close===true,time=Math.floor(now()/1000),auto=p.p_auto===true;
    if(!uid||!sessionId)throw new Error('Session ownership required');
    if(kind==='video')return mutateVideo(p,{reserveOnly:false,extend:p.p_extend===true});
    if(kind==='translation'&&!auto&&(!Number.isInteger(p.p_seconds)||p.p_seconds<0||p.p_seconds>7200))throw new Error('Invalid voice duration');
    return db.runTransaction(async tx=>{
      const sessionRef=db.collection(kind==='video'?'sessions':'translation_sessions').doc(sessionId),carryRef=db.collection('realtime_credit_carry').doc(uid);
      const [wallets,carry,session,profile,associated,videoSessions,translationSessions]=await Promise.all([
        tx.get(db.collection('wallets').where('user_id','==',uid)),tx.get(carryRef),tx.get(sessionRef),tx.get(db.collection('users').doc(uid)),
        tx.get(db.collection('realtime_usage_seconds').where(kind==='video'?'video_session':'translation_session','==',sessionId)),
        kind==='translation'?tx.get(db.collection('sessions').where('user_id','==',uid)):Promise.resolve(null),
        kind==='translation'?tx.get(db.collection('translation_sessions').where('user_id','==',uid)):Promise.resolve(null),
      ]);
      if(profile.data()?.account_status!=='active')throw new Error('Account unavailable');
      const wallet=single(wallets);
      const state={uid,available:Number(wallet.data().credits)*2+Number(carry.data()?.half_credit||0),reserved:0,walletFloor:0,videoRate:0,count:associated.size,cap:7200,target:0,lastSecond:null};
      state.walletFloor=Math.floor(state.available/2);
      if(!Number.isSafeInteger(state.available)||state.available<0)throw new Error('Invalid wallet balance');
      let row=session.data();
      if(row&&row.user_id!==uid)throw new Error('Session ownership mismatch');
      if(kind==='translation'&&row?.closed_at)return {closed:true,authorizedSeconds:Number(row.authorized_seconds),remainingCredits:state.available/2};
      const stale=[];
      if(!close&&videoSessions.docs.some(doc=>doc.data().status==='active'&&doc.data().billing_version!==2))throw new Error('Restart face streaming in the updated app before using the voice changer');
      for(const doc of translationSessions.docs){const other=doc.data();if(doc.id===sessionId||other.closed_at)continue;if(Number(other.started_epoch)+Number(other.authorized_seconds)+30<time)stale.push(doc);else throw Object.assign(new Error('The voice changer is already running on another device or window. Stop it there first.'),{code:'23505'});}
      const existed=session.exists;
      row||={id:sessionId,user_id:uid,started_epoch:String(time),authorized_seconds:0,closed_at:null};
      state.target=Number(row.authorized_seconds);
      const elapsed=Math.max(0,time-Number(row.started_epoch));
      const requested=auto?(close?elapsed+1:elapsed+5):p.p_seconds;
      let seconds;
      if(close){state.target=Math.min(requested,state.target);seconds=associated.docs.map(doc=>Number(doc.data().epoch_second)).filter(second=>second>=Number(row.started_epoch)+state.target).sort((a,b)=>a-b);}
      else{
        if(requested>elapsed+5)throw new Error('Reservation too far ahead');
        seconds=Array.from({length:Math.max(0,requested-state.target)},(_,index)=>Number(row.started_epoch)+state.target+index);
      }
      if(seconds.length>120)throw new Error('Voice changer reservation expired; start voice conversion again');
      const charged=await chargeSeconds(tx,state,seconds,'translation',sessionId,close);
      if(!existed&&state.target===0){
        for(const doc of stale)tx.update(doc.ref,{closed_at:new Date(now()).toISOString()});
        return {closed:false,authorizedSeconds:0,requestedSeconds:requested,outOfCredits:true,startedAtMs:null,remainingCredits:state.available/2};
      }
      const timestamp=writeCharges(tx,state,wallet,carryRef,charged.changes,charged.ledgerChanges);
      for(const doc of stale)tx.update(doc.ref,{closed_at:timestamp});
      const updated={...row,authorized_seconds:state.target,audio_seconds_consumed:Number(row.audio_seconds_consumed||0),...close?{closed_at:timestamp}:{}};
      existed?tx.update(sessionRef,updated):tx.create(sessionRef,updated);
      return {closed:close,authorizedSeconds:state.target,requestedSeconds:requested,outOfCredits:!close&&state.target<requested,
        startedAtMs:Number(row.started_epoch)*1000,remainingCredits:state.available/2};
    });
  }
  async function billVoiceConvert(p){
    const uid=p.p_user,sessionId=p.p_session;
    const duration=pcmDurationSeconds(p.p_bytes);
    const slot=typeof p.p_slot==='string'&&p.p_slot.length>0?p.p_slot:randomUUID();
    return db.runTransaction(async tx=>{
      const sessionRef=db.collection('translation_sessions').doc(sessionId),carryRef=db.collection('realtime_credit_carry').doc(uid);
      const [wallets,carry,session,profile]=await Promise.all([
        tx.get(db.collection('wallets').where('user_id','==',uid)),tx.get(carryRef),tx.get(sessionRef),tx.get(db.collection('users').doc(uid)),
      ]);
      if(profile.data()?.account_status!=='active')throw new Error('Account unavailable');
      const row=session.data();
      if(!row||row.user_id!==uid||Number(row.authorized_seconds)<=0)return {accepted:false,outOfCredits:true,remainingCredits:0};
      const closed=Boolean(row.closed_at);
      if(closed&&(row.grace_phrase_used||now()-Date.parse(row.closed_at)>VOICE_GRACE_MS))return {accepted:false,outOfCredits:true,remainingCredits:0};
      const slots=(Array.isArray(row.voice_convert_slots)?row.voice_convert_slots:[]).filter(item=>item&&now()-Number(item.at)<SLOT_TTL_MS);
      if(slots.length>=VOICE_CONVERT_SLOTS)throw Object.assign(new Error('Too many voice conversions are already running.'),{code:'voice_busy'});
      const wallet=single(wallets);
      const state={uid,available:Number(wallet.data().credits)*2+Number(carry.data()?.half_credit||0),reserved:0,walletFloor:0,videoRate:0,count:0,cap:7200,target:Number(row.authorized_seconds),lastSecond:null};
      state.walletFloor=Math.floor(state.available/2);
      if(!Number.isSafeInteger(state.available)||state.available<0)throw new Error('Invalid wallet balance');
      const consumed=Number(row.audio_seconds_consumed||0);
      const covered=Math.max(0,state.target-consumed);
      const shortfall=Math.max(0,duration-covered);
      const seconds=Array.from({length:shortfall},(_,index)=>Number(row.started_epoch)+state.target+index);
      const charged=shortfall?await chargeSeconds(tx,state,seconds,'translation',sessionId,false):{changes:[],ledgerChanges:[],stopped:false};
      if(charged.stopped||state.target<Number(row.authorized_seconds)+shortfall)return {accepted:false,outOfCredits:true,remainingCredits:state.available/2};
      const timestamp=writeCharges(tx,state,wallet,carryRef,charged.changes,charged.ledgerChanges);
      tx.update(sessionRef,{authorized_seconds:state.target,audio_seconds_consumed:consumed+duration,voice_convert_slots:[...slots,{id:slot,at:now()}],...closed?{grace_phrase_used:true}:{}});
      return {accepted:true,slot,durationSeconds:duration,outOfCredits:false,remainingCredits:state.available/2,authorizedSeconds:state.target,closed,paidUntilMs:(Number(row.started_epoch)+state.target)*1000,timestamp};
    });
  }
  async function releaseVoiceConvert(p){
    const ref=db.collection('translation_sessions').doc(p.p_session);
    await db.runTransaction(async tx=>{
      const snapshot=await tx.get(ref),row=snapshot.data();
      if(!row||row.user_id!==p.p_user||!Array.isArray(row.voice_convert_slots))return;
      tx.update(ref,{voice_convert_slots:row.voice_convert_slots.filter(item=>item?.id!==p.p_slot)});
    });
    return {released:true};
  }
  // A voice conversion is allowed only inside a paid voice session.
  // Grace covers one phrase spoken just before Stop, and only after time was billed.
  async function voiceActive(p){
    const snapshot=await db.collection('translation_sessions').doc(p.p_session).get(),row=snapshot.data();
    if(!row||row.user_id!==p.p_user||Number(row.authorized_seconds)<=0)return {active:false};
    if(row.closed_at)return {active:now()-Date.parse(row.closed_at)<=VOICE_GRACE_MS&&!row.grace_phrase_used};
    const paidUntilMs=(Number(row.started_epoch)+Number(row.authorized_seconds))*1000;
    return {active:paidUntilMs>=now()};
  }
  return {balance,configure,video:p=>mutateVideo(p,{reserveOnly:false,extend:p.p_extend===true}),reserveVideo:p=>mutateVideo(p,{reserveOnly:true,extend:true}),
    translation:p=>meter('translation',p),voice:p=>meter('translation',{...p,p_auto:true}),voiceActive,billVoiceConvert,releaseVoiceConvert};
}
