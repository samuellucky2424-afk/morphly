import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const MODEL_FILES = {
  '40ms': [
    'ckpts/pretrained_models/meanvc2_40ms_40ms.safetensors',
    'preprocess/ckpts/fastu2pp_80ms.pt',
  ],
  '120ms': [
    'ckpts/pretrained_models/meanvc2_120ms_40ms.safetensors',
    'preprocess/ckpts/fastu2pp_160ms.pt',
  ],
};

const SHARED_FILES = [
  'ckpts/vocos/vocos.pt',
  'preprocess/ckpts/wavlm_large_cfg.pt',
  'preprocess/ckpts/wavlm_large_finetune.pth',
];

const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;
const MAX_LOG_LINES = 80;
const STANDALONE_EXECUTABLES = {
  '40ms': {
    filename: '40ms_40ms.exe',
    expectedBytes: 2182095422,
  },
  '120ms': {
    filename: '120ms_40ms.exe',
    expectedBytes: 2182063026,
  },
};

function inspectPythonCandidate(command, prefixArgs = []) {
  const result = spawnSync(command, [...prefixArgs, '--version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  const version = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (!/^Python 3\.11(?:\.|$)/.test(version)) {
    return null;
  }

  return {
    command,
    prefixArgs,
    version,
  };
}

function findPython(repositoryRoot) {
  const configuredPython = process.env.MEANVC_PYTHON?.trim();
  const candidates = [
    configuredPython ? { command: configuredPython, prefixArgs: [] } : null,
    {
      command: path.join(repositoryRoot, '.venv', 'Scripts', 'python.exe'),
      prefixArgs: [],
      requireFile: true,
    },
    { command: 'py', prefixArgs: ['-3.11'] },
    { command: 'python', prefixArgs: [] },
    { command: 'python3', prefixArgs: [] },
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.requireFile && !fs.existsSync(candidate.command)) {
      continue;
    }

    const match = inspectPythonCandidate(candidate.command, candidate.prefixArgs);
    if (match) {
      return match;
    }
  }

  return null;
}

function inspectModel(repositoryRoot, model) {
  const requiredFiles = [...MODEL_FILES[model], ...SHARED_FILES];
  const missingFiles = requiredFiles.filter((relativePath) => (
    !fs.existsSync(path.join(repositoryRoot, relativePath))
  ));

  return {
    ready: missingFiles.length === 0,
    missingFiles,
  };
}

function inspectStandalone(dataRoot, model) {
  const definition = STANDALONE_EXECUTABLES[model];
  const executablePath = path.join(dataRoot, 'bin', definition.filename);
  let downloadedBytes = 0;

  try {
    downloadedBytes = fs.statSync(executablePath).size;
  } catch {
    downloadedBytes = 0;
  }

  const available = downloadedBytes === definition.expectedBytes;
  return {
    available,
    installing: downloadedBytes > 0 && !available,
    progress: available
      ? 100
      : Math.min(99, Math.floor((downloadedBytes / definition.expectedBytes) * 100)),
    downloadedBytes,
    expectedBytes: definition.expectedBytes,
    path: executablePath,
  };
}

export function createMeanVcRuntimeController({
  repositoryRoot,
  dataRoot,
  bundledRuntimeRoot = path.join(dataRoot, 'runtime-40ms'),
  bundledBridge = path.resolve(dataRoot, '..', 'server', 'meanvc-realtime.py'),
  spawnProcess = spawn,
  findPythonImpl = findPython,
}) {
  let runtimeProcess = null;
  let warmProcess = null;
  let warmStopRequested = false;
  let warmRestartTimer = null;
  let engineState = 'loading';
  let engineMessage = 'Preloading MorphlyVC models...';
  let voiceState = 'empty';
  let preparedReferenceId = null;
  let runtimeState = 'stopped';
  let runtimeMessage = 'MorphlyVC is warming up with the microphone closed.';
  let runtimeConfiguration = null;
  let startedAt = null;
  let stopRequested = false;
  let environmentCache = null;
  let bundledRuntimeCache = null;
  let bundledAudioDevices = null;
  let performance = null;
  const logs = [];

  const bundledPython = path.join(bundledRuntimeRoot, 'python.exe');

  const inspectEnvironment = (python) => {
    const cacheKey = python ? `${python.command}|${python.prefixArgs.join('|')}` : 'missing';
    if (
      environmentCache
      && environmentCache.key === cacheKey
      && Date.now() - environmentCache.checkedAt < 30000
    ) {
      return environmentCache.result;
    }

    if (!python) {
      const result = { ready: false, error: 'Python 3.11 is not installed.' };
      environmentCache = { key: cacheKey, checkedAt: Date.now(), result };
      return result;
    }

    const probe = spawnSync(
      python.command,
      [
        ...python.prefixArgs,
        '-c',
        'import numpy, safetensors, sounddevice, soundfile, torch, torchaudio',
      ],
      {
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
      },
    );
    const dependencyError = `${probe.stderr || probe.stdout || probe.error?.message || 'MorphlyVC Python dependencies are missing.'}`
      .trim()
      .split(/\r?\n/)
      .find(Boolean)
      ?.slice(0, 300);
    const result = probe.error || probe.status !== 0
      ? {
          ready: false,
          error: dependencyError || 'MorphlyVC Python dependencies are missing.',
        }
      : { ready: true, error: null };

    environmentCache = { key: cacheKey, checkedAt: Date.now(), result };
    return result;
  };

  const appendLog = (source, value) => {
    const lines = String(value ?? '').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      logs.push({ source, message: line, timestamp: new Date().toISOString() });
    }
    if (logs.length > MAX_LOG_LINES) {
      logs.splice(0, logs.length - MAX_LOG_LINES);
    }
  };

  const inspectBundledRuntime = () => {
    if (
      bundledRuntimeCache
      && (bundledRuntimeCache.result.ready || Date.now() - bundledRuntimeCache.checkedAt < 30000)
    ) {
      return bundledRuntimeCache.result;
    }

    const requiredPaths = [
      bundledPython,
      bundledBridge,
      path.join(bundledRuntimeRoot, 'src', 'vc_pipeline_jit.py'),
      path.join(bundledRuntimeRoot, 'models', '18_asr_jit_warm.pt'),
      path.join(
        bundledRuntimeRoot,
        'models',
        'hq1W_v2_40ms_40ms_gtm_32_run4_newasr_e18_l6_asr2_en_zh_alldata',
        'model_750000_jit.pt',
      ),
    ];
    const missingPath = requiredPaths.find((requiredPath) => !fs.existsSync(requiredPath));
    if (missingPath) {
      const result = {
        ready: false,
        error: `Bundled runtime file is missing: ${path.basename(missingPath)}`,
        pythonVersion: null,
        audioDevices: null,
      };
      bundledRuntimeCache = { checkedAt: Date.now(), result };
      return result;
    }

    // The warm server imports the same dependencies and loads the model. Running
    // a separate Python --check process first doubles cold-start work and can
    // time out on slower disks. File presence is enough to start the warm server;
    // its device and readiness events become the authoritative runtime probe.
    const result = {
      ready: true,
      error: null,
      pythonVersion: 'Python 3.11.9 (bundled)',
      audioDevices: bundledAudioDevices,
    };

    bundledRuntimeCache = { checkedAt: Date.now(), result };
    return result;
  };

  const handleWarmEngineLine = (source, line) => {
    if (line.startsWith('[Performance] ')) {
      try { performance = { ...JSON.parse(line.slice('[Performance] '.length)), measuredAt: new Date().toISOString() }; }
      catch { /* A malformed diagnostic must not interrupt live conversion. */ }
      return;
    }
    appendLog(source, line);

    if (line.startsWith('[Devices] Ready ')) {
      try {
        bundledAudioDevices = JSON.parse(line.slice('[Devices] Ready '.length));
        if (bundledRuntimeCache?.result.ready) {
          bundledRuntimeCache.result = {
            ...bundledRuntimeCache.result,
            audioDevices: bundledAudioDevices,
          };
        }
      } catch (error) {
        appendLog('stderr', `Unable to read audio devices: ${error.message}`);
      }
      return;
    }

    if (line.startsWith('[Engine] Ready')) {
      engineState = 'ready';
      engineMessage = 'Models loaded. Microphone is closed.';
      if (runtimeState === 'stopped') {
        runtimeMessage = 'MorphlyVC is ready. Microphone is off.';
      }
      return;
    }

    if (line.startsWith('[Voice] Loading')) {
      voiceState = 'loading';
      return;
    }

    if (line.startsWith('[Voice] Ready')) {
      const match = line.match(/reference=([0-9a-f-]{36})/i);
      preparedReferenceId = match?.[1] ?? preparedReferenceId;
      voiceState = 'ready';
      return;
    }

    if (line.startsWith('[Stream] Running')) {
      runtimeState = 'running';
      runtimeMessage = 'MorphlyVC voice conversion is live.';
      return;
    }

    if (line.startsWith('[Stream] Stopped')) {
      performance = null;
      runtimeState = 'stopped';
      runtimeMessage = 'MorphlyVC is ready. Microphone is off.';
      runtimeConfiguration = null;
      startedAt = null;
      return;
    }

    if (line.startsWith('[Stream] Error')) {
      runtimeState = 'failed';
      runtimeMessage = line.replace(/^\[Stream\] Error\s*/, '') || 'Audio processing failed.';
      runtimeConfiguration = null;
      startedAt = null;
      return;
    }

    if (source === 'stderr' && line.startsWith('[Control]')) {
      const message = line.replace(/^\[Control\]\s*/, '') || 'MorphlyVC could not complete the request.';
      if (voiceState === 'loading') {
        voiceState = 'failed';
      }
      if (runtimeState === 'starting') {
        runtimeState = 'failed';
        runtimeMessage = message;
      }
    }
  };

  const attachLineReader = (stream, source) => {
    let buffered = '';
    stream?.on('data', (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const line of lines.filter(Boolean)) {
        handleWarmEngineLine(source, line);
      }
    });
    stream?.on('end', () => {
      if (buffered) {
        handleWarmEngineLine(source, buffered);
      }
    });
  };

  const ensureWarmEngine = () => {
    if (warmProcess) {
      return;
    }

    const bundledRuntime = inspectBundledRuntime();
    if (!bundledRuntime.ready) {
      engineState = 'failed';
      engineMessage = bundledRuntime.error || 'MorphlyVC could not preload its models.';
      runtimeMessage = engineMessage;
      return;
    }

    warmStopRequested = false;
    engineState = 'loading';
    engineMessage = 'Preloading MorphlyVC models...';
    performance = null;
    runtimeMessage = 'MorphlyVC is warming up with the microphone closed.';
    logs.length = 0;

    warmProcess = spawnProcess(
      bundledPython,
      ['-u', bundledBridge, '--serve', '--steps', '2'],
      {
        cwd: bundledRuntimeRoot,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONNOUSERSITE: '1' },
      },
    );

    attachLineReader(warmProcess.stdout, 'stdout');
    attachLineReader(warmProcess.stderr, 'stderr');
    warmProcess.once('error', (error) => {
      appendLog('stderr', error.message);
      warmProcess = null;
      engineState = 'failed';
      engineMessage = error.message;
      runtimeState = 'failed';
      runtimeMessage = error.message;
    });
    warmProcess.once('exit', (code, signal) => {
      appendLog('system', `MorphlyVC warm engine exited with code ${code ?? 'null'} and signal ${signal ?? 'none'}.`);
      warmProcess = null;
      preparedReferenceId = null;
      voiceState = 'empty';

      if (warmStopRequested) {
        engineState = 'stopped';
        engineMessage = 'MorphlyVC engine is stopped.';
        return;
      }

      engineState = 'failed';
      engineMessage = `MorphlyVC warm engine stopped unexpectedly (exit ${code ?? 'unknown'}).`;
      runtimeState = 'failed';
      runtimeMessage = engineMessage;
      if (!warmRestartTimer) {
        warmRestartTimer = setTimeout(() => {
          warmRestartTimer = null;
          ensureWarmEngine();
        }, 1500);
      }
    });
  };

  const sendWarmCommand = (command) => {
    if (!warmProcess?.stdin?.writable) {
      throw new Error('MorphlyVC is still warming up. Please wait for Ready.');
    }
    warmProcess.stdin.write(`${JSON.stringify(command)}\n`);
  };

  const getStatus = () => {
    const repositoryAvailable = fs.existsSync(path.join(repositoryRoot, 'runtime', 'run_rt.py'));
    const bundledRuntime = inspectBundledRuntime();
    // Never spawn Python/dependency probes on every live status poll when the
    // bundled worker already owns model readiness. Those synchronous processes
    // can stall Electron's main thread (and therefore virtual-camera frames).
    const python = bundledRuntime.ready ? { command: bundledPython, prefixArgs: [], version: bundledRuntime.pythonVersion }
      : repositoryAvailable ? findPythonImpl(repositoryRoot) : null;
    const environment = bundledRuntime.ready ? { ready: engineState === 'ready', error: engineState === 'failed' ? engineMessage : null }
      : inspectEnvironment(python);
    const models = {
      '40ms': inspectModel(repositoryRoot, '40ms'),
      '120ms': inspectModel(repositoryRoot, '120ms'),
    };
    const standalone = {
      '40ms': inspectStandalone(dataRoot, '40ms'),
      '120ms': inspectStandalone(dataRoot, '120ms'),
    };
    standalone['40ms'] = {
      ...standalone['40ms'],
      engineReady: bundledRuntime.ready && engineState === 'ready',
      engineInstalled: bundledRuntime.ready,
      engineError: engineState === 'failed' ? engineMessage : bundledRuntime.error,
      pythonVersion: bundledRuntime.pythonVersion,
      audioDevices: bundledRuntime.audioDevices,
    };

    return {
      repository: {
        available: repositoryAvailable,
        path: repositoryRoot,
      },
      python: {
        available: Boolean(python),
        version: python?.version ?? null,
        dependenciesAvailable: environment.ready,
        dependencyError: environment.error,
      },
      models,
      standalone,
      preload: {
        engineState,
        engineMessage,
        microphoneOpen: runtimeState === 'starting' || runtimeState === 'running',
        voiceState,
        preparedReferenceId,
      },
      runtime: {
        performance,
        state: runtimeState,
        message: runtimeMessage,
        pid: warmProcess?.pid ?? runtimeProcess?.pid ?? null,
        configuration: runtimeConfiguration,
        startedAt,
        logs: logs.slice(-20),
      },
    };
  };

  const saveReference = (buffer, originalName) => {
    if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
      throw new Error('Choose a valid WAV reference recording.');
    }
    if (buffer.length > MAX_REFERENCE_BYTES) {
      throw new Error('Reference recordings must be 25 MB or smaller.');
    }
    if (path.extname(originalName).toLowerCase() !== '.wav') {
      throw new Error('MorphlyVC reference recordings must use the WAV format.');
    }

    const referenceDirectory = path.join(dataRoot, 'references');
    fs.mkdirSync(referenceDirectory, { recursive: true });
    const referenceId = crypto.randomUUID();
    fs.writeFileSync(path.join(referenceDirectory, `${referenceId}.wav`), buffer, { flag: 'wx' });
    preparedReferenceId = null;
    voiceState = 'empty';

    return {
      referenceId,
      name: path.basename(originalName),
      size: buffer.length,
    };
  };

  const prepare = ({ referenceId }) => {
    if (!/^[0-9a-f-]{36}$/i.test(referenceId ?? '')) {
      throw new Error('Upload a WAV reference recording before preparing MorphlyVC.');
    }
    if (runtimeState === 'starting' || runtimeState === 'running') {
      throw new Error('Stop live conversion before changing the voice profile.');
    }
    if (engineState !== 'ready') {
      throw new Error('MorphlyVC is still warming up. Please wait for Ready.');
    }

    const referencePath = path.join(dataRoot, 'references', `${referenceId}.wav`);
    if (!fs.existsSync(referencePath)) {
      throw new Error('The selected MorphlyVC reference recording is no longer available.');
    }

    voiceState = 'loading';
    preparedReferenceId = null;
    sendWarmCommand({
      type: 'prepare',
      target_spk: referencePath,
      reference_id: referenceId,
    });
    return getStatus();
  };

  const start = ({
    model,
    device,
    referenceId,
    pitch = 0,
    inputDevice = null,
    outputDevice = null,
  }) => {
    if (runtimeState === 'starting' || runtimeState === 'running' || runtimeProcess) {
      throw new Error('MorphlyVC is already running.');
    }
    if (!Object.hasOwn(MODEL_FILES, model)) {
      throw new Error('Choose either the 40ms or 120ms MorphlyVC model.');
    }
    if (device !== 'cpu' && device !== 'cuda') {
      throw new Error('Choose either CPU or CUDA processing.');
    }
    const pitchSemitones = Number(pitch);
    if (!Number.isFinite(pitchSemitones) || pitchSemitones < -12 || pitchSemitones > 12) {
      throw new Error('Pitch must be between -12 and +12 semitones.');
    }
    if (!/^[0-9a-f-]{36}$/i.test(referenceId ?? '')) {
      throw new Error('Upload a WAV reference recording before starting MorphlyVC.');
    }

    const referencePath = path.join(dataRoot, 'references', `${referenceId}.wav`);
    if (!fs.existsSync(referencePath)) {
      throw new Error('The selected MorphlyVC reference recording is no longer available.');
    }

    const bundledRuntime = inspectBundledRuntime();
    const useBundledRuntime = model === '40ms' && device === 'cpu' && bundledRuntime.ready;
    const python = useBundledRuntime ? null : findPythonImpl(repositoryRoot);
    const modelStatus = inspectModel(repositoryRoot, model);
    const environment = useBundledRuntime ? { ready: true, error: null } : inspectEnvironment(python);
    const requestedInput = inputDevice === null || inputDevice === undefined
      ? bundledRuntime.audioDevices?.defaultInput
      : Number(inputDevice);
    const requestedOutput = outputDevice === null || outputDevice === undefined
      ? bundledRuntime.audioDevices?.defaultOutput
      : Number(outputDevice);

    if (useBundledRuntime) {
      const validInput = bundledRuntime.audioDevices?.inputs?.some(({ id }) => id === requestedInput);
      const validOutput = bundledRuntime.audioDevices?.outputs?.some(({ id }) => id === requestedOutput);
      if (!validInput) {
        throw new Error('Select an available microphone before starting the voice changer.');
      }
      if (!validOutput) {
        throw new Error('Select an available speaker before starting the voice changer.');
      }
    }

    if (model === '120ms' && !modelStatus.ready) {
      throw new Error('The 120 ms profile is not installed. Use the optimized realtime profile.');
    }
    if (device === 'cuda' && !modelStatus.ready) {
      throw new Error('This computer is configured for the bundled CPU engine.');
    }

    if (useBundledRuntime) {
      if (engineState !== 'ready') {
        throw new Error('MorphlyVC is still warming up. Please wait for Ready.');
      }

      runtimeState = 'starting';
      runtimeMessage = preparedReferenceId === referenceId && voiceState === 'ready'
        ? 'Connecting the microphone to MorphlyVC...'
        : 'Preparing the selected voice...';
      runtimeConfiguration = {
        model,
        device,
        referenceId,
        pitch: pitchSemitones,
        inputDevice: requestedInput ?? null,
        outputDevice: requestedOutput ?? null,
      };
      startedAt = new Date().toISOString();
      sendWarmCommand({
        type: 'start',
        target_spk: referencePath,
        reference_id: referenceId,
        pitch: pitchSemitones,
        input_device: requestedInput,
        output_device: requestedOutput,
      });
      return getStatus();
    }

    if (!fs.existsSync(path.join(repositoryRoot, 'runtime', 'run_rt.py'))) {
      throw new Error('The MorphlyVC engine is not installed.');
    }
    if (!python) {
      throw new Error('Python 3.11 is required before MorphlyVC can start.');
    }
    if (!environment.ready) {
      throw new Error(environment.error || 'Install the MorphlyVC Python dependencies before starting.');
    }
    if (!modelStatus.ready) {
      throw new Error(`MorphlyVC is missing: ${modelStatus.missingFiles.join(', ')}`);
    }

    logs.length = 0;
    stopRequested = false;
    runtimeState = 'starting';
    runtimeMessage = 'Loading MorphlyVC models...';
    runtimeConfiguration = {
      model,
      device,
      referenceId,
      pitch: pitchSemitones,
      inputDevice: requestedInput ?? null,
      outputDevice: requestedOutput ?? null,
    };
    startedAt = new Date().toISOString();

    const runtimeScript = path.join(repositoryRoot, 'runtime', 'run_rt.py');
    const runtimeCommand = python.command;
    const args = [
      ...python.prefixArgs,
      '-u',
      runtimeScript,
      '--mode', 'realtime',
      '--model', model,
      '--device', device,
      '--target-spk', referencePath,
    ];

    runtimeProcess = spawnProcess(runtimeCommand, args, {
      cwd: repositoryRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONNOUSERSITE: '1' },
    });

    runtimeProcess.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      appendLog('stdout', text);
      if (text.includes('[Stream] Running')) {
        runtimeState = 'running';
        runtimeMessage = 'MorphlyVC voice conversion is live.';
      }
    });
    runtimeProcess.stderr?.on('data', (chunk) => appendLog('stderr', chunk));
    runtimeProcess.once('error', (error) => {
      appendLog('stderr', error.message);
      runtimeProcess = null;
      runtimeState = 'failed';
      runtimeMessage = error.message;
    });
    runtimeProcess.once('exit', (code, signal) => {
      appendLog('system', `MorphlyVC exited with code ${code ?? 'null'} and signal ${signal ?? 'none'}.`);
      runtimeProcess = null;
      runtimeState = stopRequested || code === 0 ? 'stopped' : 'failed';
      runtimeMessage = stopRequested || code === 0
        ? 'MorphlyVC is stopped.'
        : `MorphlyVC stopped unexpectedly (exit ${code ?? 'unknown'}).`;
      stopRequested = false;
    });

    return getStatus();
  };

  const setPitch = ({ pitch }) => {
    const pitchSemitones = Number(pitch);
    if (!Number.isFinite(pitchSemitones) || pitchSemitones < -12 || pitchSemitones > 12) {
      throw new Error('Pitch must be between -12 and +12 semitones.');
    }
    if ((runtimeState !== 'starting' && runtimeState !== 'running') || !runtimeConfiguration) {
      throw new Error('Start the voice changer before changing its live pitch.');
    }

    if (warmProcess?.stdin?.writable && runtimeConfiguration.model === '40ms' && runtimeConfiguration.device === 'cpu') {
      sendWarmCommand({ type: 'pitch', semitones: pitchSemitones });
    } else {
      if (!runtimeProcess?.stdin?.writable) {
        throw new Error('This MorphlyVC runtime does not support live pitch changes.');
      }
      runtimeProcess.stdin.write(`${JSON.stringify({
        type: 'pitch',
        semitones: pitchSemitones,
      })}\n`);
    }
    runtimeConfiguration = { ...runtimeConfiguration, pitch: pitchSemitones };
    appendLog('system', `Pitch set to ${pitchSemitones >= 0 ? '+' : ''}${pitchSemitones.toFixed(1)} semitones.`);
    return getStatus();
  };

  const stop = () => {
    if (warmProcess && (runtimeState === 'starting' || runtimeState === 'running')) {
      runtimeMessage = 'Disconnecting the microphone...';
      sendWarmCommand({ type: 'stop' });
      return getStatus();
    }

    if (!runtimeProcess) {
      runtimeState = 'stopped';
      runtimeMessage = engineState === 'ready'
        ? 'MorphlyVC is ready. Microphone is off.'
        : 'MorphlyVC is warming up with the microphone closed.';
      return getStatus();
    }

    stopRequested = true;
    runtimeMessage = 'Stopping MorphlyVC...';
    runtimeProcess.kill();
    return getStatus();
  };

  const shutdown = () => {
    warmStopRequested = true;
    if (warmRestartTimer) {
      clearTimeout(warmRestartTimer);
      warmRestartTimer = null;
    }
    if (warmProcess?.stdin?.writable) {
      warmProcess.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    }
    warmProcess?.kill();
    runtimeProcess?.kill();
  };

  ensureWarmEngine();

  return {
    getStatus,
    saveReference,
    prepare,
    start,
    setPitch,
    stop,
    shutdown,
  };
}
