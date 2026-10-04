import fs from 'node:fs';
const token=JSON.parse(fs.readFileSync('C:/Users/HP/AppData/Roaming/com.vercel.cli/Data/auth.json','utf8')).token;
const response=await fetch('https://api.vercel.com/v9/projects/prj_rME29907uR31V5VD6GaCbNWfyRPo/env?teamId=team_Rqjlq0vnQIpM7meLPFVDdeHR',{headers:{Authorization:'Bearer '+token}});
if(!response.ok)throw new Error('Unable to inspect streaming environment');
const result=await response.json();
if(process.argv.includes('--enable-preview')){
  const env=result.envs.find(e=>e.key==='XMAX_API_KEY'&&e.target.includes('production')&&!e.gitBranch);
  if(!env)throw new Error('Existing Xmax credential was not found');
  if(!env.target.includes('preview')){
    const update=await fetch('https://api.vercel.com/v9/projects/prj_rME29907uR31V5VD6GaCbNWfyRPo/env/'+env.id+'?teamId=team_Rqjlq0vnQIpM7meLPFVDdeHR',{method:'PATCH',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({target:[...env.target,'preview']})});
    if(!update.ok)throw new Error('Unable to enable the existing Xmax credential for preview');
    console.log(JSON.stringify({xmaxEnabledForPreview:true,credentialValueUnchanged:true,productionTargetPreserved:true}));
  }
}
console.log(JSON.stringify(result.envs.filter(e=>['XMAX_API_KEY','VIDU_API_KEY','DECART_API_KEY','VIDU_API_BASE_URL'].includes(e.key)).map(e=>({key:e.key,targets:e.target,branch:e.gitBranch||null}))));
