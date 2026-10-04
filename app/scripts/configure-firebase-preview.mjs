import fs from 'node:fs';
const token=JSON.parse(fs.readFileSync('C:/Users/HP/AppData/Roaming/com.vercel.cli/Data/auth.json','utf8')).token;
const config=JSON.parse(fs.readFileSync('C:/morphly-private/firebase-web-config.json','utf8')).result.sdkConfig;
const settings={};
for(const line of fs.readFileSync('C:/morphly-private/migration.env','utf8').split(/\r?\n/)){const match=line.match(/^\s*(FLUTTERWAVE_[A-Z_]+)\s*=(.*)$/);if(match)settings[match[1]]=match[2].trim().replace(/^["']|["']$/g,'');}
const values={FIREBASE_PROJECT_ID:config.projectId,FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify(JSON.parse(fs.readFileSync('C:/morphly-private/firebase-service-account.json','utf8'))),VITE_FIREBASE_CONFIG:JSON.stringify(config),VITE_PAYMENT_MODE:'sandbox',MORPHLY_PAYMENT_MODE:'sandbox'};
for(const key of ['FLUTTERWAVE_CLIENT_ID','FLUTTERWAVE_CLIENT_SECRET','FLUTTERWAVE_ENCRYPTION_KEY','FLUTTERWAVE_WEBHOOK_SECRET_HASH']){if(!settings[key])throw new Error(`Missing ${key}`);values[key]=settings[key];}
const variables=Object.entries(values).map(([key,value])=>({key,value,type:key.startsWith('VITE_')||key.endsWith('MODE')||key==='FIREBASE_PROJECT_ID'?'plain':'encrypted',target:['preview'],gitBranch:'test/vidu-pro-quality'}));
const response=await fetch('https://api.vercel.com/v10/projects/prj_rME29907uR31V5VD6GaCbNWfyRPo/env?teamId=team_Rqjlq0vnQIpM7meLPFVDdeHR&upsert=true',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(variables)});
const result=await response.json();
if(!response.ok)throw new Error(`Preview environment update failed (${response.status}): ${result.error?.code||'unknown'}`);
console.log(JSON.stringify({previewOnly:true,branch:'test/vidu-pro-quality',configuredKeys:Object.keys(values),created:result.created?.length,updated:result.updated?.length}));
