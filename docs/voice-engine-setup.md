# Voice engine setup and audio detection

Morphly 2.5.17 automatically starts voice-engine setup when the packaged desktop app opens if a complete engine is not present. Setup runs independently of login and the voice panel. An existing complete runtime is reused.

Downloads are pinned to the desktop version. The partial ZIP and manifest live under Morphly's user-data directory, `morphlyvc/downloads/download-<version>`. Network interruptions and timeouts retry indefinitely, with a delay capped at 15 seconds. Reopening the same app version resumes those saved bytes automatically. Completed parts and the assembled archive must pass SHA-256 checks. If a server ignores HTTP Range, only the current incomplete part restarts; verified parts remain. Disk errors, permanently missing release assets and repeated corruption produce a visible error and a Retry setup action.

The panel shows setup progress, saved percentage and retry feedback even if setup started before the panel opened. After extraction, Morphly starts the voice engine and detects audio devices automatically.

Audio enumeration now precedes Torch/model loading. A model dependency failure therefore need not hide otherwise available devices. Speakers remain listed when no microphone is selected. Refresh devices restarts the idle audio worker so USB/Bluetooth changes and newly installed virtual cables are enumerated again; it reloads models and invalidates old device IDs. It is disabled during voice conversion and reference preparation.

If devices are still absent, check Windows Sound settings for enabled input/output devices and Windows microphone privacy settings for desktop-app access. Then use Refresh devices. An uninstalled engine and a failed audio scan each have explicit setup guidance. The lightweight `meanvc-realtime.py --devices-only` diagnostic enumerates devices without importing Torch or opening the microphone.

Automated checks cover interrupted downloads, exact byte-offset resume, persisted partial files, ignored/invalid ranges, checksum rejection, startup deduplication, state snapshots, device refresh, bounded startup retries and detection without Torch. These checks do not replace a test on the affected laptop.
