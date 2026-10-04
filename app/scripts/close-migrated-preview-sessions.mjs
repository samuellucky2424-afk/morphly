import fs from 'node:fs';
import {initializeApp,cert} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
const db=getFirestore(initializeApp({credential:cert(JSON.parse(fs.readFileSync('C:/morphly-private/firebase-service-account.json','utf8'))),projectId:'luckyweb-f546e'}));
const snapshot=await db.collection('sessions').where('status','==','active').get();
// Only SQL snapshot rows: sessions created by the Firebase preview use ISO.
const copied=snapshot.docs.filter(d=>/^\d{4}-\d\d-\d\d /.test(String(d.data().created_at||'')));
fs.writeFileSync('C:/morphly-private/firebase-live-review/copied-active-sessions-before.json',JSON.stringify(copied.map(d=>({id:d.id,data:d.data()})),null,2));
for(let i=0;i<copied.length;i+=400){const batch=db.batch();for(const doc of copied.slice(i,i+400)){const row=doc.data();batch.update(doc.ref,{migration_original_status:row.status,migration_original_end_time:row.end_time??null,status:'ended',end_time:row.last_usage_at||row.updated_at||row.start_time||row.created_at,end_reason:'firebase_preview_snapshot',migration_session_closed_at:new Date().toISOString()});}await batch.commit();}
console.log(JSON.stringify({copiedSessionsClosed:copied.length,remainingActiveSessions:(await db.collection('sessions').where('status','==','active').get()).size,supabaseWrites:false,walletWrites:false,billingWrites:false}));
