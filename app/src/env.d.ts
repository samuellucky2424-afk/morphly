export {};

declare global {
  interface Window {
    electron?: {
      invoke: (channel: string, ...args: any[]) => Promise<any>;
      on: (channel: string, listener: (...args: any[]) => void) => () => void;
      sendVirtualCameraFrame: (frame: {
        width: number;
        height: number;
        stride: number;
        pixels: Uint8ClampedArray | Uint8Array;
      }) => void;
      isElectron: boolean;
    };
  }
}
