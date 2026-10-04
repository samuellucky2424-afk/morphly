import {useState} from 'react';
import {Link} from 'react-router-dom';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Card,CardContent,CardHeader,CardTitle} from '@/components/ui/card';
import {firebaseSessionClient} from '@/lib/firebase-auth';
import {normalizeEmail,RESET_REQUEST_MESSAGE} from '@/lib/auth-flow';

export default function ResetPassword(){
  const [email,setEmail]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(false);
  async function submit(event:React.FormEvent){
    event.preventDefault();if(busy)return;setBusy(true);setError(false);setMessage('');
    try{const result=await firebaseSessionClient.auth.resetPasswordForEmail(normalizeEmail(email));if(result.error)throw result.error;setMessage(RESET_REQUEST_MESSAGE);}
    catch(reason){setError(true);setMessage(reason instanceof Error?reason.message:'Unable to send the reset link. Please try again.');}
    finally{setBusy(false);}
  }
  return <main className="min-h-screen flex items-center justify-center bg-background p-4"><Card className="w-full max-w-[400px]"><CardHeader><CardTitle>Reset your password</CardTitle></CardHeader><CardContent><p className="mb-4 text-sm text-muted-foreground">Enter your account email. Open the secure link in your email to choose a new password.</p><form onSubmit={submit} className="space-y-4"><label htmlFor="reset-email" className="block text-sm font-medium">Email</label><Input id="reset-email" type="email" autoComplete="email" required value={email} onChange={event=>setEmail(event.target.value)} disabled={busy}/>{message&&<p role={error?'alert':'status'} className={error?'text-sm text-destructive':'text-sm text-foreground'}>{message}</p>}<Button type="submit" className="w-full" disabled={busy}>{busy?'Sending…':'Send reset link'}</Button></form><Link to="/login" className="mt-4 block text-sm text-primary">Return to sign in</Link></CardContent></Card></main>;
}
