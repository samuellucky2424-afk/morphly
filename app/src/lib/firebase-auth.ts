import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, signOut, onIdTokenChanged, sendPasswordResetEmail, GoogleAuthProvider, signInWithPopup, getAdditionalUserInfo } from 'firebase/auth';
import type { User as FirebaseUser } from 'firebase/auth';
import type { AuthUser as User, AuthSession as Session } from './auth-types';

const config = JSON.parse(import.meta.env.VITE_FIREBASE_CONFIG || '{}');
const firebaseAuth=getAuth(initializeApp(config));
let registering=false;
async function sessionFor(user:FirebaseUser|null,force=false):Promise<Session|null>{
  if(!user)return null;
  const token=await user.getIdToken(force);
  const mapped={id:user.uid,email:user.email||'',created_at:user.metadata.creationTime||'',user_metadata:{name:user.displayName,avatar_url:user.photoURL},app_metadata:{},aud:'authenticated',identities:[{provider:'firebase'}]} as unknown as User;
  return {access_token:token,user:mapped,token_type:'bearer',expires_in:3600,refresh_token:''} as Session;
}
const resultError=(error:unknown)=>({data:{user:null,session:null},error:(error instanceof Error?error:new Error('Authentication failed')) as Error & {code?:string}});
async function provisionSession(session:Session,referralCode=''){
  const {apiFetch}=await import('./api-client');
  const response=await apiFetch('/firebase-register',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${session.access_token}`},body:JSON.stringify({referralCode})});
  if(!response.ok){const body=await response.json();throw new Error(body.error||'Account setup failed. Sign in to retry.');}
}
// Preserve the existing UI session contract while using only Firebase Auth.
export const firebaseSessionClient={auth:{
  async getSession(){await firebaseAuth.authStateReady();return {data:{session:await sessionFor(firebaseAuth.currentUser)},error:null};},
  async refreshSession(){return {data:{session:await sessionFor(firebaseAuth.currentUser,true)},error:null};},
  onAuthStateChange(callback:(event:string,session:Session|null)=>void){let first=true;const unsubscribe=onIdTokenChanged(firebaseAuth,user=>{if(registering)return;void sessionFor(user).then(session=>{callback(first?'INITIAL_SESSION':user?'SIGNED_IN':'SIGNED_OUT',session);first=false;});});return {data:{subscription:{unsubscribe}}};},
  async signInWithPassword({email,password}:{email:string;password:string}){try{const credential=await signInWithEmailAndPassword(firebaseAuth,email,password);const session=await sessionFor(credential.user);return {data:{session,user:session!.user},error:null};}catch(error){return resultError(error);}},
  async signInWithGoogle(referralCode=''){
    registering=true;
    try{
      const provider=new GoogleAuthProvider();provider.setCustomParameters({prompt:'select_account'});
      const credential=await signInWithPopup(firebaseAuth,provider),session=await sessionFor(credential.user,true);
      await provisionSession(session!,getAdditionalUserInfo(credential)?.isNewUser?referralCode:'');
      return {data:{session,user:session!.user},error:null};
    }catch(error){
      await signOut(firebaseAuth);
      const code=(error as {code?:string})?.code;
      const message=code==='auth/popup-closed-by-user'?'Google sign-in was cancelled.':code==='auth/popup-blocked'?'Allow the sign-in popup, then try again.':code==='auth/account-exists-with-different-credential'?'Sign in with your existing account method first. Your balance remains on that account.':code==='auth/unauthorized-domain'?'Google sign-in is not configured for this site yet.':null;
      return resultError(message?new Error(message):error);
    }finally{registering=false;}
  },
  async signUp({email,password,options}:{email:string;password:string;options?:{data?:Record<string,string>}}){
    registering=true;
    try{
      const credential=await createUserWithEmailAndPassword(firebaseAuth,email,password);
      await updateProfile(credential.user,{displayName:options?.data?.name||''});
      const session=await sessionFor(credential.user,true);
      try{await provisionSession(session!,options?.data?.referral_code||'');}catch(error){await signOut(firebaseAuth);throw error;}
      return {data:{user:session!.user,session},error:null};
    }catch(error){return resultError(error);}finally{registering=false;}
  },
  async signOut(_options?:unknown){await signOut(firebaseAuth);return {error:null};},
  async resetPasswordForEmail(email:string,_options?:unknown){try{await sendPasswordResetEmail(firebaseAuth,email);return {data:{},error:null};}catch(error){return {data:null,error:error instanceof Error?error:new Error('Password reset failed')};}},
}};
