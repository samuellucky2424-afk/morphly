import { initializeApp, getApps, cert, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { FirebaseQuery } from './firebase-store.js';
import { createFirebaseOperations } from './firebase-operations.js';

export const firebaseAdminConfigError = !process.env.FIREBASE_PROJECT_ID ? 'Missing FIREBASE_PROJECT_ID' : null;
export let firebaseAdmin = null;
export let firebaseDb = null;
if (!firebaseAdminConfigError) {
  const credential = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) : applicationDefault();
  const app = getApps().find(a=>a.name==='morphly-review') || initializeApp({credential,projectId:process.env.FIREBASE_PROJECT_ID},'morphly-review');
  const auth = getAuth(app);
  firebaseDb = getFirestore(app,process.env.FIREBASE_DATABASE_ID || '(default)');
  const operations=createFirebaseOperations(firebaseDb,auth);
  async function mapUser(record){
    const safe=(await firebaseDb.collection('migrated_auth_profiles').doc(record.uid).get()).data()||{};
    let metadata=safe.raw_user_meta_data||safe.user_metadata||{};
    if(typeof metadata==='string'){try{metadata=JSON.parse(metadata);}catch{metadata={};}}
    return {id:record.uid,email:record.email,created_at:record.metadata.creationTime?new Date(record.metadata.creationTime).toISOString():null,
      last_sign_in_at:record.metadata.lastSignInTime?new Date(record.metadata.lastSignInTime).toISOString():null,
      email_confirmed_at:record.emailVerified?record.metadata.creationTime:null,
      user_metadata:{...metadata,name:record.displayName||metadata.name,avatar_url:record.photoURL||metadata.avatar_url},
      identities:record.providerData.map(p=>({provider:p.providerId}))};
  }
  const wrapped=fn=>async(...args)=>{try{return {data:await fn(...args),error:null};}catch(e){return {data:null,error:{message:e.message,code:e.code}};}};
  firebaseAdmin={
    provider:'firebase',db:firebaseDb,
    from:table=>new FirebaseQuery(firebaseDb,table),
    rpc:wrapped(async(name,args)=>operations.rpc(name,args)),
    provision:operations.provision,
    auth:{
      getUser:wrapped(async token=>{const decoded=await auth.verifyIdToken(token,true);return {user:await mapUser(await auth.getUser(decoded.uid))};}),
      admin:{
        getUserById:wrapped(async id=>({user:await mapUser(await auth.getUser(id))})),
        deleteUser:wrapped(async id=>{await auth.deleteUser(id);return {}; }),
        listUsers:wrapped(async({page=1,perPage=1000}={})=>{let cursor,result;for(let i=0;i<page;i++){result=await auth.listUsers(perPage,cursor);cursor=result.pageToken;if(!cursor&&i<page-1)return {users:[]};}return {users:await Promise.all(result.users.map(mapUser))};}),
      },
    },
  };
}
