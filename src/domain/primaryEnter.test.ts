import { describe, expect, it, vi } from "vitest";
import { runPrimaryActionOnEnter, shouldRunPrimaryActionForEnter } from "./primaryEnter";

function enterEvent(target: EventTarget) {
  return {
    key: "Enter",
    defaultPrevented: false,
    isComposing: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target,
    preventDefault: vi.fn(),
  };
}

describe("primary Enter actions", () => {
  it("runs for text inputs and prevents the browser default", () => {
    const input = document.createElement("input");
    input.type = "text";
    const event = enterEvent(input);
    const action = vi.fn();

    expect(runPrimaryActionOnEnter(event, true, action)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(action).toHaveBeenCalledOnce();
  });

  it("does not hijack controls with native Enter behavior", () => {
    for (const target of [
      document.createElement("button"),
      document.createElement("select"),
      document.createElement("textarea"),
      Object.assign(document.createElement("input"), { type: "checkbox" }),
      Object.assign(document.createElement("input"), { type: "range" }),
    ]) {
      expect(shouldRunPrimaryActionForEnter(enterEvent(target))).toBe(false);
    }
  });

  it("does not run disabled primary actions", () => {
    const event = enterEvent(document.createElement("input"));
    const action = vi.fn();

    expect(runPrimaryActionOnEnter(event, false, action)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });
});
