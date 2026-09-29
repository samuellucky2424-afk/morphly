export const TRANSLATION_CREDITS_PER_SECOND = 2.5;
export const COMBINED_TRANSLATION_CREDITS_PER_SECOND = 4;
export const TRANSLATION_SOURCE_LANGUAGE = 'en';
export const TRANSLATION_LANGUAGES = [
  ['ar', 'Arabic'], ['zh-Hans', 'Chinese (Simplified)'], ['zh-Hant', 'Chinese (Traditional)'],
  ['nl', 'Dutch'], ['fr', 'French'], ['de', 'German'], ['el', 'Greek'], ['ha', 'Hausa'],
  ['hi', 'Hindi'], ['id', 'Indonesian'], ['it', 'Italian'], ['ja', 'Japanese'], ['ko', 'Korean'],
  ['pl', 'Polish'], ['pt-BR', 'Portuguese (Brazil)'], ['pt-PT', 'Portuguese (Portugal)'],
  ['ro', 'Romanian'], ['ru', 'Russian'], ['es', 'Spanish'], ['sw', 'Swahili'], ['sv', 'Swedish'],
  ['ta', 'Tamil'], ['th', 'Thai'], ['tr', 'Turkish'], ['uk', 'Ukrainian'], ['ur', 'Urdu'],
  ['vi', 'Vietnamese'], ['yo', 'Yoruba'],
].map(([code, label]) => ({ code, label }));

export function validateTranslationOptions(value) {
  if (!value?.enabled) return null;
  if (!TRANSLATION_LANGUAGES.some(({ code }) => code === value.targetLanguage)) throw new Error('Select a supported translation language.');
  return { enabled: true, sourceLanguage: 'en', targetLanguage: value.targetLanguage, incoming: value.incoming !== false };
}

export function buildTranslationSetup(targetLanguage, model = 'gemini-3.5-live-translate-preview') {
  if (targetLanguage !== 'en' && !TRANSLATION_LANGUAGES.some(({ code }) => code === targetLanguage)) throw new Error('Unsupported translation language.');
  return { setup: {
    model: `models/${model}`,
    generationConfig: { responseModalities: ['AUDIO'], translationConfig: { targetLanguageCode: targetLanguage, echoTargetLanguage: false } },
  } };
}

export function validateTranslationRouting(options, devices, inputDevice, outputDevice) {
  const input = devices?.inputs?.find(({ id }) => id === inputDevice);
  const output = devices?.outputs?.find(({ id }) => id === outputDevice);
  const cable = (name) => /\bCABLE(?:-[A-D])?\s+(?:Input|Output)\b/i.test(name || '');
  if (!input || cable(input.name)) throw new Error('Choose a physical microphone for your English speech.');
  if (!output || !cable(output.name)) throw new Error('Choose a virtual cable as the converted output for your call microphone.');
  if (!options.incoming) return;
  const incoming = devices?.inputs?.find(({ id }) => id === options.incomingDevice);
  const headphones = devices?.outputs?.find(({ id }) => id === options.headphonesDevice);
  if (!incoming || !cable(incoming.name)) throw new Error('Choose a second virtual cable for incoming call audio.');
  if (!headphones || cable(headphones.name)) throw new Error('Choose physical headphones for translated incoming speech.');
  const cableId = (name) => name.match(/\bCABLE(?:-([A-D]))?\s+(?:Input|Output)\b/i)?.[1]?.toUpperCase() || 'default';
  if (cableId(incoming.name) === cableId(output.name)) throw new Error('Incoming and outgoing audio must use different virtual cables to prevent feedback.');
}
