export function voiceSetupError(value){
  const text=String(value?.stderr||value?.message||value||'').trim();
  const space=/VOICE_SETUP_SPACE (\d+(?:\.\d+)?)/.exec(text);
  if(space)return `Voice setup needs ${space[1]} GB of free disk space. Free some space and retry; your download is saved.`;
  if(/not enough.*(?:disk|space)|disk.*full|0x80070070/i.test(text))return 'Not enough disk space for the voice engine. Free some disk space, then retry setup; your download is saved.';
  if(/unsafe path/i.test(text))return 'The voice engine archive contains an unsafe path. Setup stopped. Contact support with the setup log.';
  if(/access.*denied|unauthorizedaccess|0x80070005/i.test(text))return 'Voice setup cannot write to its folder. Check folder permissions, then retry setup; your download is saved.';
  if(/path.*too long|pathtoolong/i.test(text))return 'Voice setup could not unpack a long Windows path. Update Morphly, then retry setup; your download is saved.';
  if(/ECONN|ENOTFOUND|ETIMEDOUT|failed to fetch|socket|network/i.test(text))return 'The voice download was interrupted. Check your connection and retry; saved progress will resume.';
  if(!text||text.length>300||/EncodedCommand|Command failed:|Traceback|[A-Za-z0-9+/=]{160}/.test(text))return 'Voice engine setup could not finish. Retry setup; your downloaded files are saved.';
  return text;
}
