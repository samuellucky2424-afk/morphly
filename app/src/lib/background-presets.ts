import type { ComponentType } from 'react';
import { Briefcase, Camera, Home, Trees } from 'lucide-react';
export const DECART_REFERENCE_PROMPT = 'Turn the person into the reference image';
import { type RealtimeProvider, VIDU_REALTIME_PROVIDER } from './realtime-provider.ts';

export interface BackgroundPreset {
  id: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  prompt: string;
  avatarPrompt?: string;
  snippet?: string;
}

const REFERENCE_IDENTITY_INSTRUCTION = 'Preserve the reference person\'s identity and facial attributes exactly, including face shape, eyes, nose, mouth, skin tone, hair, age, and body proportions. Do not beautify, stylize, or invent facial features.';

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: 'original',
    label: 'Original Room (Natural Camera)',
    description: 'Keep your real camera background',
    icon: Camera,
    prompt: '',
    avatarPrompt: 'Substitute the character in the video with the person in the reference image.',
    snippet: '',
  },
  {
    id: 'office',
    label: 'Executive Office (Sitting at Desk)',
    description: 'Sitting in black leather chair at wooden desk with laptop & paperwork',
    icon: Briefcase,
    prompt: 'Change the background to a realistic executive office with a black leather desk chair, wooden desk with laptop and paperwork, window blinds, and natural warm indoor lighting, photorealistic real photo camera shot.',
    avatarPrompt: 'Substitute the character in the video with the person in the reference image sitting naturally upright in a black leather executive office chair behind a wooden desk with an open laptop, notebooks, pen, window blinds, and natural warm indoor lighting, photorealistic candid webcam shot.',
    snippet: 'a realistic executive office with a black leather desk chair, wooden desk with laptop and paperwork, window blinds, and natural warm indoor lighting, photorealistic real photo.',
  },
  {
    id: 'room',
    label: 'Modern Living Room (Sunlit Interior)',
    description: 'Inside a bright modern home with wooden staircase and sunlit glass doors',
    icon: Home,
    prompt: 'Change the background to a bright modern home interior with an open wooden staircase, tall glass patio doors, clean architecture, indoor potted plants, and natural soft daylight, photorealistic real photo camera shot.',
    avatarPrompt: 'Substitute the character in the video with the person in the reference image naturally inside a clean modern home interior with an open wooden staircase, tall sunlit glass doors, indoor potted plants, and soft natural daylight, photorealistic candid home webcam shot.',
    snippet: 'a bright modern home interior with an open wooden staircase, tall glass patio doors, clean architecture, and natural soft daylight, photorealistic real photo.',
  },
  {
    id: 'garden',
    label: 'Sunny Garden (Outdoor Lawn)',
    description: 'Sitting outdoors in a lush green backyard garden with trees and sunlight',
    icon: Trees,
    prompt: 'Change the background to a lush green backyard garden with leafy trees, blooming flowers, manicured green grass lawn, low wall, and warm natural outdoor sunlight, photorealistic real photo camera shot.',
    avatarPrompt: 'Substitute the character in the video with the person in the reference image sitting comfortably outdoors in a lush green backyard garden with leafy green trees, grass lawn, low wall, and warm natural outdoor sunlight, photorealistic candid outdoor shot.',
    snippet: 'a lush green backyard garden with leafy trees, blooming flowers, manicured green grass lawn, and warm natural outdoor sunlight, photorealistic real photo.',
  },
];

export function buildViduTransformPrompt(
  hasReferenceImage: boolean,
  presetId: string,
  customText: string = '',
): string {
  const customTrimmed = customText.trim();
  if (customTrimmed) {
    const cleanCustom = customTrimmed.replace(/^change the background to\s+/i, '');
    if (hasReferenceImage) {
      return `Replace only the person in the video with the person in the reference image. ${REFERENCE_IDENTITY_INSTRUCTION} Keep the original pose, expression, clothing, camera framing, and motion. Change the background to ${cleanCustom}, with natural room lighting and a photorealistic candid camera appearance.`;
    }
    return `Change the background to ${cleanCustom}, natural room lighting, photorealistic candid shot.`;
  }

  const preset = BACKGROUND_PRESETS.find((item) => item.id === presetId) || BACKGROUND_PRESETS[0];
  if (preset.id === 'original' || !preset.prompt) {
    if (hasReferenceImage) {
      return `${preset.avatarPrompt} ${REFERENCE_IDENTITY_INSTRUCTION} Keep the original background, camera framing, pose, expression, and motion natural.`;
    }
    return 'Preserve the person, clothing, background, lighting, framing, and natural camera appearance exactly as the input.';
  }

  if (hasReferenceImage && preset.avatarPrompt) {
    return `${preset.avatarPrompt} ${REFERENCE_IDENTITY_INSTRUCTION} Keep the person's original pose, expression, and motion natural.`;
  }

  if (hasReferenceImage && preset.snippet) {
    return `Substitute the character in the video with the person in the reference image naturally fitting into ${preset.snippet}`;
  }

  return preset.prompt;
}

export function buildDecartTransformPrompt(hasReferenceImage: boolean, presetId: string, customText = ''): string {
  const preset = BACKGROUND_PRESETS.find(item => item.id === presetId) || BACKGROUND_PRESETS[0];
  const custom = customText.trim().replace(/^change the background to\s+/i, '');
  const background = custom ? `Change the background to ${custom}.` : preset.prompt;
  if (hasReferenceImage) return background ? `${DECART_REFERENCE_PROMPT}. ${background}` : DECART_REFERENCE_PROMPT;
  return background || 'Preserve the original camera appearance.';
}
export function buildRealtimeTransformPrompt(provider: RealtimeProvider, hasReferenceImage: boolean, presetId: string, customText = ''): string {
  return provider === VIDU_REALTIME_PROVIDER
    ? buildViduTransformPrompt(hasReferenceImage, presetId, customText)
    : buildDecartTransformPrompt(hasReferenceImage, presetId, customText);
}
