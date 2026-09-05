import { useRef } from 'react';
import {
  ACTIONS,
  EVENTS,
  Joyride,
  STATUS,
  type EventData,
  type TooltipRenderProps,
} from 'react-joyride';

import { dashboardTourSteps } from './dashboardTourSteps';

interface MorphlyDashboardTourProps {
  run: boolean;
  onFinish: () => void;
  onSkip: () => void;
}

function MorphlyTooltip({
  backProps,
  continuous,
  index,
  isLastStep,
  primaryProps,
  skipProps,
  step,
  tooltipProps,
  size,
}: TooltipRenderProps) {
  const handleSkip = (event: React.MouseEvent<HTMLButtonElement>) => {
    const confirmed = window.confirm('Skip the setup guide? You can restart it later from Settings.');
    if (confirmed) {
      skipProps.onClick(event);
    }
  };

  return (
    <div
      {...tooltipProps}
      className="w-[min(390px,calc(100vw-32px))] rounded-2xl border border-warning/30 bg-background p-5 text-left text-foreground shadow-2xl shadow-black/5"
    >
      <div className="mb-3 flex items-start justify-between gap-4">
        <h2 className="text-base font-semibold leading-6 text-foreground">{step.title}</h2>
        <span className="whitespace-nowrap rounded-full bg-warning-soft px-2.5 py-1 text-[11px] font-semibold text-warning">
          Step {index + 1} of {size}
        </span>
      </div>
      <div className="text-sm leading-6 text-foreground">{step.content}</div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <button
          {...skipProps}
          type="button"
          onClick={handleSkip}
          className="rounded-lg px-2 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-2 focus:ring-warning"
        >
          Skip tour
        </button>
        <div className="flex items-center gap-2">
          {index > 0 && (
            <button
              {...backProps}
              type="button"
              className="rounded-lg border border-border px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus:outline-none focus:ring-2 focus:ring-warning"
            >
              Back
            </button>
          )}
          <button
            {...primaryProps}
            type="button"
            className="rounded-lg bg-primary px-3.5 py-2 text-xs font-bold text-primary-foreground transition-colors hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-warning focus:ring-offset-2 focus:ring-offset-background"
          >
            {isLastStep ? 'Start using Morphly' : continuous ? 'Next' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function MorphlyDashboardTour({
  run,
  onFinish,
  onSkip,
}: MorphlyDashboardTourProps) {
  const resolvedRef = useRef(false);

  const handleEvent = (data: EventData) => {
    if (data.type === EVENTS.TARGET_NOT_FOUND) {
      console.warn('Morphly guided-tour target was not found:', data.step.target);
    }

    if (data.action === ACTIONS.START) {
      resolvedRef.current = false;
    }

    if (resolvedRef.current) return;

    if (data.status === STATUS.FINISHED) {
      resolvedRef.current = true;
      onFinish();
    } else if (data.status === STATUS.SKIPPED) {
      resolvedRef.current = true;
      onSkip();
    }
  };

  return (
    <Joyride
      run={run}
      steps={dashboardTourSteps}
      onEvent={handleEvent}
      continuous
      scrollToFirstStep
      tooltipComponent={MorphlyTooltip}
      options={{
        blockTargetInteraction: true,
        buttons: ['back', 'primary', 'skip'],
        dismissKeyAction: false,
        overlayClickAction: false,
        overlayColor: 'rgba(32, 37, 45, 0.42)',
        primaryColor: '#c82436',
        scrollOffset: 24,
        showProgress: true,
        skipBeacon: true,
        skipScroll: false,
        spotlightRadius: 12,
        targetWaitTimeout: 1500,
        textColor: '#20252d',
        zIndex: 10000,
      }}
      styles={{
        spotlight: {
          filter: 'drop-shadow(0 0 4px rgba(200, 36, 54, 0.25))',
        },
      }}
    />
  );
}
