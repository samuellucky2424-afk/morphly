export interface DashboardOnboardingState {
  completed: boolean;
  version: number;
  currentVersion: number;
}

export function shouldAutoStartOnboarding(state: DashboardOnboardingState): boolean {
  // A completed older tour stays completed. Increasing the current version alone
  // does not surprise users with a new tour; a trusted restart action explicitly
  // clears `completed` when a future walkthrough should run again.
  return !state.completed && state.version <= state.currentVersion;
}
