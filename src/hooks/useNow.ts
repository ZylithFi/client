import { useSyncExternalStore } from "react";

type Clock = {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
};

type ClockState = {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  clock: Clock;
};

const clocks = new Map<number, ClockState>();

function clockFor(intervalMs: number): Clock {
  const normalizedInterval = Math.max(250, Math.floor(intervalMs));
  const existing = clocks.get(normalizedInterval);
  if (existing) return existing.clock;

  const state: ClockState = {
    now: Date.now(),
    listeners: new Set(),
    timer: null,
    clock: {
      getSnapshot: () => state.now,
      subscribe: (listener) => {
        state.listeners.add(listener);
        if (state.timer === null) {
          state.now = Date.now();
          state.timer = setInterval(() => {
            state.now = Date.now();
            for (const notify of state.listeners) notify();
          }, normalizedInterval);
        }
        return () => {
          state.listeners.delete(listener);
          if (state.listeners.size === 0 && state.timer !== null) {
            clearInterval(state.timer);
            state.timer = null;
          }
        };
      },
    },
  };
  clocks.set(normalizedInterval, state);
  return state.clock;
}

export function useNow(intervalMs = 1000): number {
  const clock = clockFor(intervalMs);
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
