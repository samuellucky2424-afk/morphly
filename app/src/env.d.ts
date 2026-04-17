export {};

declare global {
  interface Window {
    electron?: {
      invoke: (channel: string, ...args: any[]) => Promise<any>;
      on: (channel: string, listener: (...args: any[]) => void) => () => void;
      isElectron: boolean;
    };
  }
}
