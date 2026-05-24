export type SubmissionTimingPreference = "fast" | "balanced" | "private";
export type WithdrawalRoutePreference = "privacy_window" | "immediate";

export type UserPreferences = {
  submissionTiming: SubmissionTimingPreference;
  withdrawalRoute: WithdrawalRoutePreference;
};

const USER_PREFERENCES_KEY = "zylith.user.preferences.v1";

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  submissionTiming: "balanced",
  withdrawalRoute: "privacy_window",
};

function isSubmissionTiming(value: unknown): value is SubmissionTimingPreference {
  return value === "fast" || value === "balanced" || value === "private";
}

function isWithdrawalRoute(value: unknown): value is WithdrawalRoutePreference {
  return value === "privacy_window" || value === "immediate";
}

export function loadUserPreferences(): UserPreferences {
  try {
    const raw = localStorage.getItem(USER_PREFERENCES_KEY);
    if (!raw) return DEFAULT_USER_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    return {
      submissionTiming: isSubmissionTiming(parsed.submissionTiming)
        ? parsed.submissionTiming
        : DEFAULT_USER_PREFERENCES.submissionTiming,
      withdrawalRoute: isWithdrawalRoute(parsed.withdrawalRoute)
        ? parsed.withdrawalRoute
        : DEFAULT_USER_PREFERENCES.withdrawalRoute,
    };
  } catch {
    return DEFAULT_USER_PREFERENCES;
  }
}

export function saveUserPreferences(preferences: UserPreferences): void {
  try {
    localStorage.setItem(USER_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    /* local preference persistence is non-critical */
  }
}
