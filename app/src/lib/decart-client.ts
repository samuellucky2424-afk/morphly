import { createDecartClient, models as decartModels, noopLogger } from '@decartai/sdk';
import type { ViduClientOptions, ViduRealtimeSession, ViduTransformInput } from './vidu-realtime';

export function createViduClient({apiKey}:{apiKey:string;baseUrl?:string}) {
  // Adapt the shared camera lifecycle, not the provider. This connects directly
  // to Decart with a Decart-only temporary token and Lucy model.
  const client=createDecartClient({apiKey,logger:noopLogger});
  return {async connect(stream:MediaStream, options:ViduClientOptions):Promise<ViduRealtimeSession>{
    if(options.signal?.aborted)throw new Error('Decart session was cancelled');
    const session=await client.realtime.connect(stream,{
      model:decartModels.realtime('lucy-2.5'),mirror:options.mirror,
      initialState:{passthrough:true},onRemoteStream:stream=>{if(!options.signal?.aborted)options.onRemoteStream?.(stream);},
      onConnectionChange:state=>{if(!options.signal?.aborted)options.onConnectionChange?.(state);},
    });
    if(options.signal?.aborted){session.disconnect();throw new Error('Decart session was cancelled');}
    const abort=()=>session.disconnect();options.signal?.addEventListener('abort',abort,{once:true});
    return {sessionId:crypto.randomUUID(),getConnectionState:()=>session.getConnectionState(),
      set:async(input:ViduTransformInput)=>{await session.set({...(input.prompt?.trim()?{prompt:input.prompt.trim()}:{}),enhance:!!input.enhance,image:input.image??null});},
      disconnect:async()=>{options.signal?.removeEventListener('abort',abort);await session.disconnect();},on:(_event,handler)=>{session.on('error',handler);},off:(_event,handler)=>{session.off('error',handler);},
    };
  }};
}
export const models={realtime:(_modelName?:string)=> 'lucy-2.5'};
