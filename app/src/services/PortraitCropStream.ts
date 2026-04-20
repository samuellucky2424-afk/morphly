type PortraitCropOptions = {
  width?: number;
  height?: number;
  fps?: number;
};

/**
 * Crops a webcam stream to a stable upper-body portrait before it is sent to realtime.
 * This reduces the model's exposure to lower-frame limb motion that tends to stick.
 */
export class PortraitCropStream {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private outputStream: MediaStream | null = null;
  private sourceVideo: HTMLVideoElement | null = null;
  private animationFrameId: number | null = null;
  private width = 640;
  private height = 480;
  private fps = 24;
  private active = false;

  public async start(sourceStream: MediaStream, options?: PortraitCropOptions): Promise<MediaStream> {
    this.stop();

    this.width = options?.width ?? this.width;
    this.height = options?.height ?? this.height;
    this.fps = options?.fps ?? this.fps;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
      willReadFrequently: false,
    });

    if (!this.ctx) {
      throw new Error('Failed to get canvas context for portrait crop stream');
    }

    this.sourceVideo = document.createElement('video');
    this.sourceVideo.muted = true;
    this.sourceVideo.autoplay = true;
    this.sourceVideo.playsInline = true;
    this.sourceVideo.srcObject = sourceStream;

    await this.sourceVideo.play().catch(() => undefined);

    this.outputStream = this.canvas.captureStream(this.fps);
    this.active = true;
    this.renderLoop();

    return this.outputStream;
  }

  public stop() {
    this.active = false;

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (this.outputStream) {
      this.outputStream.getTracks().forEach((track) => track.stop());
      this.outputStream = null;
    }

    if (this.sourceVideo) {
      this.sourceVideo.pause();
      this.sourceVideo.srcObject = null;
      this.sourceVideo.remove();
      this.sourceVideo = null;
    }

    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
    }

    this.ctx = null;
  }

  public getStream(): MediaStream | null {
    return this.outputStream;
  }

  private renderLoop = () => {
    if (!this.active || !this.ctx || !this.canvas || !this.sourceVideo) {
      return;
    }

    const videoWidth = this.sourceVideo.videoWidth;
    const videoHeight = this.sourceVideo.videoHeight;

    if (videoWidth > 0 && videoHeight > 0 && this.sourceVideo.readyState >= 2) {
      const targetAspect = this.width / this.height;
      let cropHeight = videoHeight * 0.72;
      let cropWidth = cropHeight * targetAspect;
      const maxCropWidth = videoWidth * 0.72;

      if (cropWidth > maxCropWidth) {
        cropWidth = maxCropWidth;
        cropHeight = cropWidth / targetAspect;
      }

      cropWidth = Math.min(cropWidth, videoWidth);
      cropHeight = Math.min(cropHeight, videoHeight);

      const cropX = Math.max(0, (videoWidth - cropWidth) / 2);
      const cropY = Math.max(0, Math.min(videoHeight - cropHeight, videoHeight * 0.02));

      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.width, this.height);
      this.ctx.drawImage(
        this.sourceVideo,
        cropX,
        cropY,
        cropWidth,
        cropHeight,
        0,
        0,
        this.width,
        this.height,
      );
    }

    this.animationFrameId = requestAnimationFrame(this.renderLoop);
  };
}