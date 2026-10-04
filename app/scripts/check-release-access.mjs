import {execFile} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
const credential=await new Promise((resolve,reject)=>{
  const child=execFile('git',['credential','fill'],{env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never'},timeout:15000},(error,stdout)=>error?reject(new Error('GitHub release credentials are not available locally')):resolve(Object.fromEntries(stdout.trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}))));
  child.stdin.end('protocol=https\nhost=github.com\n\n');
});
if(!credential.password)throw new Error('GitHub release credentials are not available locally');
const response=await fetch('https://api.github.com/repos/samuellucky2424-afk/morphly',{headers:{Authorization:`Bearer ${credential.password}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});
if(!response.ok)throw new Error(`GitHub release access failed (${response.status})`);
const repo=await response.json();
if(!repo.permissions?.push)throw new Error('GitHub repository write access is unavailable');
await writeFile('C:/morphly-private/github-release-access.json',JSON.stringify({token:credential.password}),{mode:0o600});
console.log(JSON.stringify({repository:repo.full_name,releaseWriteAccess:true}));
