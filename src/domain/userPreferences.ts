export type WithdrawalRoutePreference = "privacy_window" | "immediate";

export type UserPreferences = {
  withdrawalRoute: WithdrawalRoutePreference;
};

const USER_PREFERENCES_KEY = "zylith.user.preferences.v1";

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  withdrawalRoute: "privacy_window",
};

function isWithdrawalRoute(value: unknown): value is WithdrawalRoutePreference {
  return value === "privacy_window" || value === "immediate";
}

export function loadUserPreferences(): UserPreferences {
  try {
    const raw = sessionStorage.getItem(USER_PREFERENCES_KEY);
    if (!raw) return DEFAULT_USER_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<UserPreferences>;
    return {
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
    sessionStorage.setItem(USER_PREFERENCES_KEY, JSON.stringify(preferences));
    localStorage.removeItem(USER_PREFERENCES_KEY);
  } catch {
    /* Session preference persistence is non-critical. */
  }
}
