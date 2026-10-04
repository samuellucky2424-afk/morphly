import fs from 'node:fs';
import {randomBytes} from 'node:crypto';
const token=JSON.parse(fs.readFileSync('C:/Users/HP/AppData/Roaming/com.vercel.cli/Data/auth.json','utf8')).token;
const secretFile='C:/morphly-private/flutterwave-live-webhook-secret.txt';
const secret=fs.existsSync(secretFile)?fs.readFileSync(secretFile,'utf8').trim():randomBytes(32).toString('hex');
if(secret.length<32)throw Error('Webhook secret is too short');
fs.writeFileSync(secretFile,secret,{mode:0o600});
const url='https://api.vercel.com/v10/projects/prj_rME29907uR31V5VD6GaCbNWfyRPo/env?teamId=team_Rqjlq0vnQIpM7meLPFVDdeHR&upsert=true';
const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify([
  {key:'FLUTTERWAVE_WEBHOOK_SECRET_HASH',value:secret,type:'sensitive',target:['production']},
  {key:'MORPHLY_CUSTOMER_EMAILS_ENABLED',value:'true',type:'plain',target:['production']},
])});
if(!response.ok)throw Error(`Live cutover configuration failed (${response.status})`);
console.log(JSON.stringify({futureDeploymentConfigured:true,webhookSecretFile:secretFile,currentDeploymentUnchanged:true}));
