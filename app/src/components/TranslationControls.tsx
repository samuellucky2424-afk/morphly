import { useState } from 'react';
import { Languages } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { TRANSLATION_LANGUAGES } from '../../shared/translation.js';

export type TranslationSettings = {
  enabled: boolean;
  targetLanguage: string;
  incoming: boolean;
  incomingDevice: number | null;
  headphonesDevice: number | null;
};
type Device = { id: number; name: string; hostapi: string };

export function TranslationControls({ value, onChange, disabled, devices }: {
  value: TranslationSettings;
  onChange: (value: TranslationSettings) => void;
  disabled: boolean;
  devices?: { inputs: Device[]; outputs: Device[] } | null;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cable = (name: string) => /\bCABLE(?:-[A-D])?\s+(?:Input|Output)\b/i.test(name);
  const incomingDevices = devices?.inputs.filter(device => cable(device.name)) || [];
  const headphones = devices?.outputs.filter(device => !cable(device.name)) || [];
  const update = (patch: Partial<TranslationSettings>) => onChange({ ...value, ...patch });
  return (
    <section className="space-y-3 border-b border-border px-4 py-4" aria-labelledby="translation-title">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Languages aria-hidden="true" className="size-4 text-primary" />
          <label id="translation-title" htmlFor="translation-enabled" className="text-sm font-semibold">Morphly Translator</label>
        </div>
        <Switch id="translation-enabled" checked={value.enabled} disabled={disabled}
          onCheckedChange={checked => checked ? setConfirmOpen(true) : update({ enabled: false })} />
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Translate your English speech before changing your voice. Translator only: 2.5 credits per second. With face streaming: 4 credits per second total.
      </p>
      {disabled && <p className="text-xs text-muted-foreground">Stop voice conversion to change translation settings.</p>}
      {value.enabled && <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0 space-y-1.5">
            <label htmlFor="translation-source" className="text-xs font-medium">Your language</label>
            <Select value="en" disabled><SelectTrigger id="translation-source" className="w-full min-w-0"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="en">English</SelectItem></SelectContent></Select>
          </div>
          <div className="min-w-0 space-y-1.5">
            <label htmlFor="translation-target" className="text-xs font-medium">Translate to</label>
            <Select value={value.targetLanguage} disabled={disabled} onValueChange={targetLanguage => update({ targetLanguage })}>
              <SelectTrigger id="translation-target" className="w-full min-w-0"><SelectValue /></SelectTrigger>
              <SelectContent>{TRANSLATION_LANGUAGES.map(language => <SelectItem key={language.code} value={language.code}>{language.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="translation-incoming" className="text-xs leading-5">Translate incoming speech to English</label>
          <Switch id="translation-incoming" checked={value.incoming} disabled={disabled} onCheckedChange={incoming => update({ incoming })} />
        </div>
        {value.incoming && <>
          <div className="space-y-1.5">
            <label htmlFor="translation-cable" className="text-xs font-medium">Incoming call cable</label>
            <Select value={value.incomingDevice === null ? '' : String(value.incomingDevice)} disabled={disabled} onValueChange={id => update({ incomingDevice: Number(id) })}>
              <SelectTrigger id="translation-cable" className="w-full min-w-0"><SelectValue placeholder="Choose a second virtual cable" /></SelectTrigger>
              <SelectContent>{incomingDevices.map(device => <SelectItem key={device.id} value={String(device.id)}>{device.name} ({device.hostapi})</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="translation-headphones" className="text-xs font-medium">Listen on</label>
            <Select value={value.headphonesDevice === null ? '' : String(value.headphonesDevice)} disabled={disabled} onValueChange={id => update({ headphonesDevice: Number(id) })}>
              <SelectTrigger id="translation-headphones" className="w-full min-w-0"><SelectValue placeholder="Choose physical headphones" /></SelectTrigger>
              <SelectContent>{headphones.map(device => <SelectItem key={device.id} value={String(device.id)}>{device.name} ({device.hostapi})</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">In WhatsApp, select the outgoing cable as your microphone and the second cable as your speaker. Use different cables for the two directions and wear headphones.</p>
        </>}
        <p className="text-xs leading-5 text-muted-foreground">Translation latency depends on your internet speed. The rate includes both translation directions.</p>
      </div>}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on Morphly Translator?</AlertDialogTitle>
            <AlertDialogDescription>
              Voice translation alone costs 2.5 credits per second. When face streaming and voice translation run together, the total is 4 credits per second, including both services. Translation latency depends on your internet speed. Your audio is processed online by Morphly Translator.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction onClick={() => update({ enabled: true })}>Enable translation</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
