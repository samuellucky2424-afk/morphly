import fs from 'node:fs';
import {initializeApp,cert} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
const db=getFirestore(initializeApp({credential:cert(JSON.parse(fs.readFileSync('C:/morphly-private/firebase-service-account.json','utf8')))}));
const report=JSON.parse(fs.readFileSync('C:/morphly-private/firebase-live-review/result.json','utf8'));
const receipts=await db.collection('review_webhook_receipts').where('chargeId','==',report.payment.transactionId).get();
const result={chargeId:report.payment.transactionId,vendorWebhookReceived:!receipts.empty,receipts:receipts.docs.map(d=>({verifiedSignature:d.data().verifiedSignature,mode:d.data().mode,duplicate:d.data().fulfillment?.duplicate,fulfilled:!!d.data().fulfillment}))};
fs.writeFileSync('C:/morphly-private/firebase-live-review/webhook-result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
if(!result.vendorWebhookReceived||!result.receipts.some(r=>r.verifiedSignature&&r.mode==='sandbox-firebase-review'&&r.fulfilled))process.exitCode=1;
