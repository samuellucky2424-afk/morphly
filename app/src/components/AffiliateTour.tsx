import { useEffect, useId, useRef, useState } from 'react';
import type { AffiliateTourStep } from '@/lib/affiliate-experience';
import './affiliate-tour.css';

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function AffiliateTour({
  steps,
  stepIndex,
  onNext,
  onBack,
  onSkip,
  onFinish,
}: {
  steps: AffiliateTourStep[];
  stepIndex: number;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
  onFinish: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const step = steps[stepIndex];
  const [rect, setRect] = useState<Rect | null>(null);
  const [narrow, setNarrow] = useState(false);
  const last = stepIndex === steps.length - 1;

  useEffect(() => {
    const measure = () => {
      setNarrow(window.innerWidth < 720);
      const target = document.querySelector(`[data-affiliate-tour="${step?.target}"]`);
      if (!target) {
        setRect(null);
        return;
      }
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const box = target.getBoundingClientRect();
      setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
    };
    const frame = window.requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step?.target, stepIndex]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, [stepIndex]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onSkip();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (last) onFinish();
        else onNext();
      } else if (event.key === 'ArrowLeft' && stepIndex > 0) {
        event.preventDefault();
        onBack();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [last, onBack, onFinish, onNext, onSkip, stepIndex]);

  if (!step) return null;

  return (
    <div className="affiliate-tour">
      <button type="button" className="affiliate-tour-shade" tabIndex={-1} aria-hidden="true" />
      {rect ? (
        <div
          className="affiliate-tour-ring"
          style={{ top: rect.top - 6, left: rect.left - 6, width: rect.width + 12, height: rect.height + 12 }}
        />
      ) : null}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="affiliate-tour-card"
        style={narrow || !rect ? undefined : { top: Math.min(rect.top + rect.height + 12, window.innerHeight - 220), left: Math.min(Math.max(16, rect.left), window.innerWidth - 360) }}
      >
        <p className="affiliate-tour-progress" aria-hidden="true">
          {steps.map((item, index) => <span key={item.id} className={index === stepIndex ? 'is-current' : index < stepIndex ? 'is-done' : ''} />)}
        </p>
        <h2 id={titleId}>{step.title}</h2>
        <p>{step.body}</p>
        <div className="affiliate-tour-actions">
          <button type="button" onClick={onSkip}>Skip</button>
          <span className="sr-only">Step {stepIndex + 1} of {steps.length}</span>
          <div>
            {stepIndex > 0 ? <button type="button" onClick={onBack}>Back</button> : null}
            {last
              ? <button type="button" className="is-primary" onClick={onFinish}>Done</button>
              : <button type="button" className="is-primary" onClick={onNext}>Next</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
