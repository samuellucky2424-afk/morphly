/**
 * VirtualCameraService
 * 
 * Lightweight virtual camera implementation that captures the video output
 * to a canvas and exposes it as a MediaStream.
 * 
 * Note: For full system-wide virtual camera (Zoom/WhatsApp), a driver like OBS Virtual Camera
 * is typically required. This service prepares the stream for such integrations and
 * manages the frame processing efficiently.
 */

export class VirtualCameraService {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private stream: MediaStream | null = null;
  private animationFrameId: number | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private isActive: boolean = false;
  private targetWidth: number = 1280;
  private targetHeight: number = 720;

  constructor() {}

  public async start(videoElement: HTMLVideoElement): Promise<MediaStream | null> {
    if (this.isActive) return this.stream;

    this.videoElement = videoElement;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.targetWidth;
    this.canvas.height = this.targetHeight;
    this.ctx = this.canvas.getContext('2d', { 
      alpha: false, 
      desynchronized: true, // Optimize for frequent changes
      willReadFrequently: false // Optimize for write-only
    });

    if (!this.ctx) {
      console.error('Failed to get 2D context from canvas');
      return null;
    }

    try {
      // Capture stream - fps=0 means capture every frame drawn by our renderLoop
      this.stream = this.canvas.captureStream(0);
      this.isActive = true;
      this.renderLoop();
      return this.stream;
    } catch (error) {
      console.error('Failed to create virtual camera stream:', error);
      return null;
    }
  }

  private renderLoop = () => {
    if (!this.isActive || !this.videoElement || !this.ctx || !this.canvas) return;

    // Check if video is ready before drawing
    if (this.videoElement.readyState >= 2) {
      try {
        this.ctx.drawImage(
          this.videoElement,
          0, 0,
          this.targetWidth,
          this.targetHeight
        );
      } catch (error) {
        console.warn('Virtual Camera frame draw error:', error);
      }
    }

    this.animationFrameId = requestAnimationFrame(this.renderLoop);
  };

  public stop() {
    this.isActive = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
    }
    this.ctx = null;
    this.videoElement = null;
  }

  public getStream(): MediaStream | null {
    return this.stream;
  }

  public getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  public setResolution(width: number, height: number) {
    if (this.canvas) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.targetWidth = width;
    this.targetHeight = height;
  }

  public setFramerate(_fps: number) {
    // Math.min(_fps, 30); Cap at 30
  }
}