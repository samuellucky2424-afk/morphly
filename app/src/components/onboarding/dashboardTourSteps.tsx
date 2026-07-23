import type { Step } from 'react-joyride';

export const DASHBOARD_TOUR_VERSION = 1;

export const dashboardTourSteps: Step[] = [
  {
    target: '[data-tour="dashboard"]',
    title: 'Welcome to Morphly',
    content: (
      <p>
        This quick guide will show you how to select your camera, upload an image, start and stop
        Avatar Mimic Real Time, buy credits and check for application updates.
      </p>
    ),
    placement: 'center',
    skipBeacon: true,
  },
  {
    target: '[data-tour="camera-selector"]',
    title: 'Select your laptop camera',
    content: (
      <div className="space-y-3">
        <p>
          Choose your physical laptop camera before starting. Select a real hardware camera such as
          HP Integrated Camera, Integrated Webcam, Lenovo EasyCamera, Dell Webcam or another built-in
          or USB camera connected to your computer.
        </p>
        <p className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-2.5 text-amber-100">
          Do not select Morphly Virtual Camera, Avatar Mimic Real Time Windows Virtual Camera, OBS
          Virtual Camera, VB-CABLE or any other virtual camera.
        </p>
        <p>This selector is the physical input camera that captures your face.</p>
      </div>
    ),
    placement: 'top',
  },
  {
    target: '[data-tour="upload-image"]',
    title: 'Upload your avatar image',
    content: (
      <div className="space-y-3">
        <p>
          Upload a clear image of the face or avatar you want Morphly to mimic. Select your laptop
          camera before uploading the image and before starting the stream.
        </p>
        <p>For the best result, use a clear front-facing image with good lighting and only one visible face.</p>
      </div>
    ),
    placement: 'top',
  },
  {
    target: '[data-tour="start-stream"]',
    title: 'Start Avatar Mimic Real Time',
    content: (
      <div className="space-y-3">
        <p>
          After selecting your physical laptop camera and uploading an image, click Start. Morphly
          will process your camera feed and publish the transformed output through the Morphly virtual camera.
        </p>
        <p className="font-semibold text-amber-200">
          Input = physical laptop camera. Output = Morphly virtual camera.
        </p>
      </div>
    ),
    placement: 'top',
  },
  {
    target: '[data-tour="stop-stream"]',
    title: 'Stop the stream when finished',
    content: (
      <p>
        When you finish streaming or making a call, click Stop to end the Morphly processing session
        and prevent unnecessary credit usage.
      </p>
    ),
    placement: 'top',
  },
  {
    target: '[data-tour="buy-credits"]',
    title: 'Buy more credits',
    content: (
      <p>
        Click Buy Credits to open the subscription and credit-purchase screen. Select a package and
        complete payment to add credits to your account.
      </p>
    ),
    placement: 'top',
  },
  {
    target: '[data-tour="settings"]',
    title: 'Check for the latest version',
    content: (
      <p>
        Open Settings and select Check for Updates to see whether a newer Morphly version is
        available. Download and install updates to receive the latest fixes and improvements.
      </p>
    ),
    placement: 'left',
  },
];
