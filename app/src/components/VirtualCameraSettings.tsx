import { useEffect, useState } from 'react';
import { Camera, LoaderCircle, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';

type CameraStatus = { success: boolean; canRepair?: boolean; error?: string; message?: string; warning?: string };

export function VirtualCameraSettings() {
  const [status, setStatus] = useState<CameraStatus | null>(null);
  const [busy, setBusy] = useState<'check' | 'repair' | null>(null);
  const available = Boolean(window.electron?.isElectron);
  const run = async (action: 'check' | 'repair') => {
    if (busy || !available) return;
    setBusy(action);
    try { setStatus(await window.electron!.invoke(`virtual-camera:${action === 'check' ? 'status' : 'repair'}`)); }
    catch (error) { setStatus({ success: false, canRepair: true, error: error instanceof Error ? error.message : 'Unable to check the camera. Try again.' }); }
    finally { setBusy(null); }
  };
  useEffect(() => {
    if (!available) return;
    let mounted = true;
    setBusy('check');
    window.electron!.invoke('virtual-camera:status').then((result: CameraStatus) => { if (mounted) setStatus(result); })
      .catch(() => { if (mounted) setStatus({ success: false, canRepair: true, error: 'Unable to check camera registration. Try again.' }); })
      .finally(() => { if (mounted) setBusy(null); });
    return () => { mounted = false; };
  }, [available]);
  return <section aria-labelledby="virtual-camera-settings-title" className="space-y-3 border-t border-border pt-4">
    <h3 id="virtual-camera-settings-title" className="flex items-center gap-2 text-sm font-semibold"><Camera aria-hidden="true" className="size-4" />Virtual Camera</h3>
    <p className="text-xs leading-5 text-muted-foreground">{available
      ? 'Repair missing camera registration after an installation or update. Stop streaming first. Windows will ask for Administrator approval if repair is needed.'
      : 'Open Morphly Desktop on Windows to check or repair its virtual camera.'}</p>
    {status && <p role={status.success ? 'status' : 'alert'} className={`rounded-md border bg-background p-3 text-xs leading-5 ${status.success ? 'border-success/25 text-success' : 'border-destructive/25 text-destructive'}`}>
      {status.success ? status.message : status.error}
    </p>}
    {status?.warning && <p className="text-xs leading-5 text-warning">{status.warning}</p>}
    {available && <div className="flex flex-wrap gap-2" aria-busy={Boolean(busy)}>
      <Button variant="outline" disabled={Boolean(busy)} onClick={() => void run('check')}>{busy === 'check' ? 'Checking camera…' : 'Check registration'}</Button>
      <Button disabled={Boolean(busy) || status?.canRepair === false} onClick={() => void run('repair')}>
        {busy === 'repair' ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Wrench aria-hidden="true" className="size-4" />}
        {busy === 'repair' ? 'Repairing camera…' : 'Repair camera'}
      </Button>
    </div>}
  </section>;
}
