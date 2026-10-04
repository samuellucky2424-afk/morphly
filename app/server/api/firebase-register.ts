// @ts-nocheck
import { firebaseAdmin } from '../firebase-admin.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';
export default async function handler(req,res){
  if(req.method!=='POST')return res.status(405).json({error:'Method not allowed'});
  if(!firebaseAdmin)return res.status(503).json({error:'Firebase is not configured'});
  const context=await authenticateRequestUser(req,firebaseAdmin);
  if(context.error)return res.status(context.status).json({error:context.error});
  try{return res.json({ok:true,...await firebaseAdmin.provision(context.user,req.body?.referralCode)});}catch(error){return res.status(400).json({error:error.message});}
}
