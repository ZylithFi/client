export type PrimaryEnterEvent = {
  key: string;
  defaultPrevented: boolean;
  isComposing?: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  preventDefault: () => void;
};

const ignoredInteractiveSelector = [
  "button",
  "a[href]",
  "select",
  "textarea",
  "[role='button']",
  "[contenteditable='true']",
].join(",");

const ignoredInputTypes = new Set([
  "button",
  "checkbox",
  "color",
  "date",
  "datetime-local",
  "file",
  "month",
  "radio",
  "range",
  "reset",
  "submit",
  "time",
  "week",
]);

export function shouldRunPrimaryActionForEnter(event: PrimaryEnterEvent) {
  if (
    event.key !== "Enter" ||
    event.defaultPrevented ||
    event.isComposing ||
    event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  ) {
    return false;
  }
  const target = event.target;
  if (!(target instanceof HTMLElement)) return true;
  if (target.closest("[data-primary-enter-ignore]")) return false;
  if (target.closest(ignoredInteractiveSelector)) return false;
  if (target instanceof HTMLInputElement) {
    return !ignoredInputTypes.has(target.type.toLowerCase());
  }
  return true;
}

export function runPrimaryActionOnEnter(
  event: PrimaryEnterEvent,
  enabled: boolean,
  action: () => void,
) {
  if (!enabled || !shouldRunPrimaryActionForEnter(event)) return false;
  event.preventDefault();
  action();
  return true;
}
