export async function reconcileFlutterwavePage({since,page=1,secretKey,processTransaction,fetchImpl=fetch,now=Date.now()}){
  const start=Date.parse(since);
  if(!Number.isFinite(start)||start>now||now-start>86400000||!Number.isInteger(page)||page<1||page>200)throw Error('Invalid reconciliation window or page');
  const query=new URLSearchParams({from:new Date(start-86400000).toISOString().slice(0,10),to:new Date(now+86400000).toISOString().slice(0,10),status:'successful',page:String(page)});
  const response=await fetchImpl(`https://api.flutterwave.com/v3/transactions?${query}`,{headers:{Authorization:`Bearer ${secretKey}`},signal:AbortSignal.timeout(15000)});
  const data=await response.json();
  if(!response.ok||data.status!=='success'||!Array.isArray(data.data))throw Error('Flutterwave history could not be verified');
  const report={page,processed:0,duplicate:0,failed:0,ignored:0,failures:[]};
  for(const row of data.data){
    const created=Date.parse(row.created_at);
    if(row.status!=='successful'||!/^morphly_/.test(row.tx_ref||'')||!Number.isFinite(created)||created<start-86400000||created>now||!row.id){report.ignored++;continue;}
    const result=await processTransaction(row.id);
    if(result.status!==200||!result.data?.processed){report.failed++;report.failures.push({transactionId:row.id,status:result.status,reason:result.data?.message||result.data?.error||'Payment was not fulfilled'});continue;}
    result.data.duplicate?report.duplicate++:report.processed++;
  }
  const total=Number(data.meta?.page_info?.total_pages??page);
  report.nextPage=page<total?page+1:null;
  return report;
}
