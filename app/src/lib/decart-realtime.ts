import { createDecartClient, models, type RealTimeClient, type RealTimeClientConnectOptions } from '@decartai/sdk';
import { DECART_REALTIME_MODEL } from './realtime-provider.ts';

type Transform = { prompt: string; image: File | null; enhance: boolean };
type Options = Pick<RealTimeClientConnectOptions, 'onRemoteStream' | 'onConnectionChange'> & { signal: AbortSignal };

// Keep the image and prompt atomic on the first frame and on every later set().
export async function connectDecartRealtime(
  stream: MediaStream, token: string, transform: Transform, options: Options,
  createClient = createDecartClient,
): Promise<RealTimeClient> {
  options.signal.throwIfAborted();
  let session: RealTimeClient | undefined;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    session?.disconnect();
    rejectAbort(new Error('Pro session was cancelled.'));
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  const client = createClient({ apiKey: token });
  const connecting = client.realtime.connect(stream, {
    model: models.realtime(DECART_REALTIME_MODEL),
    mirror: 'auto',
    resolution: '720p',
    initialState: {
      prompt: { text: transform.prompt, enhance: transform.enhance },
      ...(transform.image ? { image: transform.image } : {}),
    },
    onConnectionChange: state => { if (!options.signal.aborted) options.onConnectionChange?.(state); },
    onRemoteStream: remote => { if (!options.signal.aborted) options.onRemoteStream(remote); },
  }).then(result => {
    session = result;
    if (options.signal.aborted) result.disconnect();
    return result;
  });
  try {
    const result = await Promise.race([connecting, aborted]);
    const disconnect = result.disconnect.bind(result);
    return {
      ...result,
      disconnect: () => {
        options.signal.removeEventListener('abort', onAbort);
        disconnect();
      },
    };
  } catch (error) {
    options.signal.removeEventListener('abort', onAbort);
    session?.disconnect();
    throw error;
  }
}
