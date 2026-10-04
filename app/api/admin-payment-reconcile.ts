// @ts-nocheck
import {requireAdminContext} from '../../shared/admin-auth.js';
import {supabaseAdmin} from '../server/supabase-admin.js';
import webhook from '../server/api/flutterwave-webhook.js';
import {reconcileFlutterwavePage} from '../server/reconcile-flutterwave.js';
export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  if(!await requireAdminContext(req,res,supabaseAdmin))return;
  if(process.env.MORPHLY_PAYMENT_MODE!=='live')return res.status(409).json({error:'Live reconciliation only'});
  try{
    const result=await reconcileFlutterwavePage({since:req.body?.since,page:req.body?.page||1,secretKey:process.env.FLUTTERWAVE_SECRET_KEY,processTransaction:async id=>{
      const response={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}};
      // Reuse the real webhook: every charge is fetched and independently
      // verified, with the same package, owner and idempotency checks.
      await webhook({method:'POST',headers:{'verif-hash':process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH},body:{type:'charge.completed',data:{id,status:'successful'}}},response);
      return {status:response.statusCode,data:response.data};
    }});
    return res.json(result);
  }catch{return res.status(503).json({error:'Payment reconciliation unavailable; retry'});}
}
