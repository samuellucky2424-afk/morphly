import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
process.env.GOOGLE_APPLICATION_CREDENTIALS='C:/morphly-private/firebase-service-account.json';
process.env.FIREBASE_PROJECT_ID='luckyweb-f546e';
const {firebaseAdmin,firebaseDb}=await import('../server/firebase-admin.js');
const {initializeApp,cert}=await import('firebase-admin/app');
const {getAuth}=await import('firebase-admin/auth');
const auth=getAuth(initializeApp({credential:cert(JSON.parse(fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS,'utf8')))},'review-validation'));
const config=JSON.parse(fs.readFileSync('C:/morphly-private/firebase-web-config.json','utf8')).result.sdkConfig;
const uid='firebase-review-'+randomUUID(),password=randomUUID()+'aA1!',email=uid+'@example.com';
const user=await auth.createUser({uid,email,password,emailVerified:true,displayName:'Firebase Review Test'});
try{
  const response=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key='+encodeURIComponent(config.apiKey),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});
  const result=await response.json();if(!response.ok)throw new Error(`Firebase email/password sign-in failed: ${result.error?.message}`);
  const verified=await firebaseAdmin.auth.getUser(result.idToken);if(verified.error||verified.data.user.id!==uid)throw new Error('Firebase bearer token validation failed');
  const packages=await firebaseAdmin.from('credit_packages').select('id,credits,price_ngn,status,is_active').eq('status','active').eq('is_active',true);
  if(packages.error||!packages.data.length)throw new Error('Migrated packages unavailable');
  const migrated=(await firebaseDb.collection('users').limit(1).get()).docs[0];
  const wallet=await firebaseAdmin.from('wallets').select('id,credits,balance').eq('user_id',migrated.id).maybeSingle();
  if(wallet.error)throw new Error('Migrated wallet adapter failed');
  console.log(JSON.stringify({backend:'firebase',emailPasswordSignIn:true,bearerTokenVerified:true,activePackages:packages.data.length,migratedWalletRead:!!wallet.data,profileFieldNames:Object.keys(migrated.data()),timestampSample:migrated.data().created_at}));
}finally{await auth.deleteUser(uid);}
