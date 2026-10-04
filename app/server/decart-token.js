import {createDecartClient,noopLogger} from '@decartai/sdk';
export async function createDecartTemporaryKey({apiKey,maxSeconds,allowedOrigins=[],userId,sessionId}){
  const sessionLimit=Math.max(10,Math.min(Math.floor(Number(maxSeconds)||10),3600));
  try{
    const token=await createDecartClient({apiKey,logger:noopLogger}).tokens.create({expiresIn:Math.min(3600,sessionLimit+120),allowedModels:['lucy-2.5'],...(allowedOrigins.length?{allowedOrigins}:{}),constraints:{realtime:{maxSessionDuration:sessionLimit}},metadata:{morphlySessionId:sessionId,morphlyUserId:userId}});
    return {token:token.apiKey,expiresAt:token.expiresAt,sessionLimit};
  }catch(error){return {error:{error:'AI_SESSION_CREATION_FAILED',providerStatus:Number(error?.status)||null,details:'Decart could not create this session. Check its provider account and try again.'}};}
}
