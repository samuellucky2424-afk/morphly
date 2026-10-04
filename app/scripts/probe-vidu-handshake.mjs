import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {initializeApp,cert} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';
const deployment=process.argv[2],report={deployment,backend:'firebase'};
if(!deployment?.startsWith('https://morphly-'))throw new Error('Review deployment required');
const app=initializeApp({credential:cert(JSON.parse(fs.readFileSync('C:/morphly-private/firebase-service-account.json','utf8')))}),auth=getAuth(app),db=getFirestore(app);
const config=JSON.parse(fs.readFileSync('C:/morphly-private/firebase-web-config.json','utf8')).result.sdkConfig;
const earlier=JSON.parse(fs.readFileSync('C:/morphly-private/firebase-live-review/result.json','utf8'));
const uid=earlier.users.buyer;
const response=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key='+config.apiKey,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:await auth.createCustomToken(uid),returnSecureToken:true})});
const authData=await response.json();if(!response.ok)throw new Error('Synthetic test sign-in failed');
const cache='C:/Users/HP/AppData/Local/npm-cache/_npx';let cli;
for(const dir of fs.readdirSync(cache)){const pkg=path.join(cache,dir,'node_modules/vercel/package.json');if(fs.existsSync(pkg)&&JSON.parse(fs.readFileSync(pkg,'utf8')).version==='62.2.0')cli=path.join(cache,dir,'node_modules/vercel/dist/index.js');}
const run=promisify(execFile),workspace=path.resolve(import.meta.dirname,'../..');
async function request(route,body,authenticated=true){
  const file='C:/morphly-private/firebase-live-review/final-'+randomUUID()+'.json';
  const args=[cli,'curl',route,'--deployment',deployment,'--','--silent','--output',file,'--write-out','%{http_code}'];
  if(authenticated)args.push('--header','Authorization: Bearer '+authData.idToken);
  if(body){const input=file+'.body';fs.writeFileSync(input,JSON.stringify(body));args.push('--header','Content-Type: application/json','--header','Origin: '+deployment,'--request','POST','--data-binary','@'+input);}
  const result=await run(process.execPath,args,{cwd:workspace,timeout:90000,maxBuffer:10000});
  const status=Number(result.stdout.match(/\d{3}\s*$/)?.[0]),text=fs.readFileSync(file,'utf8');fs.unlinkSync(file);
  let data;try{data=JSON.parse(text);}catch{data={html:text};}return {status,data};
}

async function handshake(host,credential){return new Promise(resolve=>{
 const url=new URL('/live/ws/live/connect',host);url.protocol='wss:';url.search=new URLSearchParams({live_id:credential.liveId,conn_id:randomUUID(),client_secret:credential.token}).toString();
 const socket=new WebSocket(url,{origin:deployment,handshakeTimeout:12000});let finished=false;
 const finish=result=>{if(finished)return;finished=true;socket.removeAllListeners();socket.on('error',()=>{});socket.terminate();resolve({host,...result});};
 socket.on('open',()=>finish({upgraded:true,status:101}));socket.on('unexpected-response',(_req,res)=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>finish({status:res.statusCode,message:data.slice(0,300).replace(/v1\.[A-Za-z0-9_.-]+/g,'[redacted]')}));});
 socket.on('error',error=>finish({errorCode:error.code||null,message:'WebSocket network failure'}));
 });}
let sessionId;
try{
 const stream=await request('/api/start-session',{provider:'vidu',platform:'web',userId:uid,installationId:'firebase-vidu-handshake',imageUrl:'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=512&h=512&fit=crop'});
 report.creation={status:stream.status,allowed:stream.data.allowed,liveIdType:typeof stream.data.liveId};sessionId=stream.data.sessionId;
 if(!stream.data.allowed)throw new Error(stream.data.error+' '+(stream.data.details||''));
 report.handshakes=[];
 for(const host of ['https://api.vidu.com','https://api.vidu.cn'])report.handshakes.push(await handshake(host,stream.data));
}catch(error){report.error=error.message;process.exitCode=1;}
finally{if(sessionId){const end=await request('/api/end-session',{sessionId,secondsDelta:0});report.sessionClosed=end.status===200;}}
console.log(JSON.stringify(report,null,2));
