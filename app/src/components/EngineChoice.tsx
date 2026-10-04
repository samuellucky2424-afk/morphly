import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { getCreditRatePerSecond } from '@/lib/billing';
import { getRealtimeProviderLabel, type RealtimeProvider } from '@/lib/realtime-provider';

type Props = {
  value: RealtimeProvider | '';
  onSelect: (provider: RealtimeProvider) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  blended: boolean;
};

export function EngineChoice({ value, onSelect, open, onOpenChange, disabled }: Props) {
  const [choice, setChoice] = useState<RealtimeProvider | ''>(value);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (open) setChoice(value); }, [open, value]);
  const rate = (provider: RealtimeProvider) => getCreditRatePerSecond(false, false, provider);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          data-testid="realtime-provider-selector"
          disabled={disabled}
          aria-label={value ? `Change engine: ${getRealtimeProviderLabel(value)}, ${rate(value)} credits per second` : 'Choose engine, required'}
          className="min-h-11 rounded-md border border-border bg-background px-3 text-xs font-semibold text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {value ? `${getRealtimeProviderLabel(value)} · ${rate(value)} cr/sec` : 'Choose engine'}
        </button>
      </DialogTrigger>
      <DialogContent showCloseButton={false} onOpenAutoFocus={event => { event.preventDefault(); headingRef.current?.focus(); }} className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl p-5 motion-reduce:animate-none sm:max-w-[520px] sm:p-6">
        <DialogHeader className="text-left">
          <DialogTitle ref={headingRef} tabIndex={-1} className="text-xl leading-7 outline-none">Choose your engine</DialogTitle>
          <DialogDescription className="text-sm leading-6">Plus is selected by default. Compare the engines and credit rates below.</DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-3">
          <legend className="sr-only">Engine (required)</legend>
          {([
            { value: 'vidu', label: 'Plus', title: 'Realtime engine', description: 'Replace the person using your reference image.' },
            { value: 'decart', label: 'Pro', title: 'Premium realtime engine', description: 'Transform the person and background with a reference image and prompt.' },
          ] as const).map(engine => (
            <label key={engine.value} className={`flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors focus-within:ring-2 focus-within:ring-ring ${choice === engine.value ? 'border-primary bg-accent' : 'border-border bg-background hover:bg-muted'}`}>
              <input type="radio" name="stream-engine" value={engine.value} checked={choice === engine.value} onChange={() => setChoice(engine.value)} required className="mt-1 h-4 w-4 shrink-0 accent-primary" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-base font-semibold text-foreground">{engine.label}</span>
                  <span className="text-sm font-semibold tabular-nums text-foreground">{rate(engine.value)} cr/sec</span>
                </span>
                <span className="mt-2 block text-sm font-medium text-foreground">{engine.title}</span>
                <span className="mt-1 block text-sm leading-6 text-muted-foreground">{engine.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="text-xs leading-5 text-muted-foreground">Results vary with your image, lighting and connection. Video with live translation uses 4 cr/sec total.</p>
        <div className="flex justify-end gap-3 border-t border-border pt-4">
          <button type="button" onClick={() => onOpenChange(false)} className="min-h-11 rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Cancel</button>
          <button type="button" disabled={!choice || disabled} onClick={() => { if (choice) { onSelect(choice); onOpenChange(false); } }} className="min-h-11 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40">{choice ? `Use ${getRealtimeProviderLabel(choice)}` : 'Select an engine'}</button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
