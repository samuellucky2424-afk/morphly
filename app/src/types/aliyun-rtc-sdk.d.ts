// Narrow surface verified against the pinned 7.1.9 package (which omits its declared types).
declare module 'aliyun-rtc-sdk' {
  export interface RtcEngine {
    on(event: string, handler: (...args: any[]) => void): void;
    removeAllListeners(): void;
    publishLocalAudioStream(enabled: boolean): Promise<void>;
    publishLocalVideoStream(enabled: boolean): Promise<void>;
    setDefaultSubscribeAllRemoteAudioStreams(enabled: boolean): void;
    setDefaultSubscribeAllRemoteVideoStreams(enabled: boolean): void;
    /** track: 0 none, 1 camera, 2 screen, 3 both. Re-requests the remote user's streams. */
    subscribeRemoteMediaStream?(userId: string, track: number, subscribeVideo: boolean, subscribeAudio: boolean): void;
    switchCamera(deviceId: string | undefined, track: MediaStreamTrack): Promise<void>;
    joinChannel(token: string, displayName: string): Promise<void>;
    getVideoTrack(options: { userId?: string; streamType: number }): Promise<MediaStreamTrack | undefined>;
    destroy(): Promise<void>;
  }
  const AliRtcEngine: {
    AliRtcLogLevel: { NONE: 5 };
    isSupported(): Promise<{ support: boolean; reason?: string }>;
    setLogLevel(level: number): void;
    getInstance(): RtcEngine;
  };
  export default AliRtcEngine;
}
