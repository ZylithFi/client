export type SubmissionTimingPreference = "fast" | "balanced" | "private";
export type WithdrawalRoutePreference = "privacy_window" | "immediate";

export type UserPreferences = {
  submissionTiming: SubmissionTimingPreference;
  withdrawalRoute: WithdrawalRoutePreference;
  redactSensitiveUi: boolean;
};

const USER_PREFERENCES_KEY = "zylith.user.preferences.v1";

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  submissionTiming: "balanced",
  withdrawalRoute: "privacy_window",
  redactSensitiveUi: false,
};

function isSubmissionTiming(value: unknown): value is SubmissionTimingPreference {
  return value === "fast" || value === "balanced" || value === "private";
}

function isWithdrawalRoute(value: unknown): value is WithdrawalRoutePreference {
  return value === "privacy_window" || value === "immediate";
}

export function loadUserPreferences(): UserPreferences {
  try {
    const raw = sessionStorage.getItem(USER_PREFERENCES_KEY);
    if (!raw) return DEFAULT_USER_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    return {
      submissionTiming: isSubmissionTiming(parsed.submissionTiming)
        ? parsed.submissionTiming
        : DEFAULT_USER_PREFERENCES.submissionTiming,
      withdrawalRoute: isWithdrawalRoute(parsed.withdrawalRoute)
        ? parsed.withdrawalRoute
        : DEFAULT_USER_PREFERENCES.withdrawalRoute,
      redactSensitiveUi: parsed.redactSensitiveUi === true,
    };
  } catch {
    return DEFAULT_USER_PREFERENCES;
  }
}

export function saveUserPreferences(preferences: UserPreferences): void {
  try {
    sessionStorage.setItem(USER_PREFERENCES_KEY, JSON.stringify(preferences));
    localStorage.removeItem(USER_PREFERENCES_KEY);
  } catch {
    /* Session preference persistence is non-critical. */
  }
}
