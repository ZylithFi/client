import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import type { NormalizedFailure, Recovery } from "../domain/userFacingErrors";

type RecoveryHandler = () => void | Promise<void>;

export type FailureNoticeActions = {
  retry?: RecoveryHandler;
  reconnect?: RecoveryHandler;
  switchNetwork?: RecoveryHandler;
  editInput?: RecoveryHandler;
  refreshState?: RecoveryHandler;
  checkStatus?: RecoveryHandler;
  contactSupport?: RecoveryHandler;
  dismiss?: RecoveryHandler;
};

const RECOVERY_LABELS: Record<Exclude<Recovery, "none">, string> = {
  retry: "Try again",
  reconnect: "Reconnect wallet",
  "switch-network": "Switch network",
  "edit-input": "Edit amount",
  "refresh-state": "Refresh",
  "check-status": "Check status",
  "contact-support": "Copy support details",
};

function recoveryHandler(
  recovery: Recovery,
  actions: FailureNoticeActions,
): RecoveryHandler | undefined {
  switch (recovery) {
    case "retry": return actions.retry;
    case "reconnect": return actions.reconnect;
    case "switch-network": return actions.switchNetwork;
    case "edit-input": return actions.editInput;
    case "refresh-state": return actions.refreshState;
    case "check-status": return actions.checkStatus;
    case "contact-support": return actions.contactSupport;
    case "none": return undefined;
  }
}

export function FailureNotice({
  failure,
  className = "",
  actions = {},
  id,
}: {
  failure: NormalizedFailure;
  className?: string;
  actions?: FailureNoticeActions;
  id?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [working, setWorking] = useState(false);
  const [supportCopied, setSupportCopied] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const requestedHandler = recoveryHandler(failure.recovery, actions);
  const primaryHandler = failure.recovery === "retry" && !failure.retrySafe
    ? undefined
    : requestedHandler;
  const isModal = failure.presentation === "modal";
  const isToast = failure.presentation === "toast";

  useEffect(() => {
    if (!isModal) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const appRoot = document.getElementById("root");
    const wasInert = appRoot?.inert ?? false;
    if (appRoot) appRoot.inert = true;
    const frame = window.requestAnimationFrame(() => {
      (primaryRef.current ?? dialogRef.current)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (appRoot) appRoot.inert = wasInert;
      previousFocusRef.current?.focus({ preventScroll: true });
      previousFocusRef.current = null;
    };
  }, [isModal, failure.code]);

  function trapModalFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!isModal) return;
    if (event.key === "Escape" && actions.dismiss) {
      event.preventDefault();
      event.stopPropagation();
      void run(actions.dismiss);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])];
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function run(handler: RecoveryHandler | undefined) {
    if (!handler || working) return;
    setWorking(true);
    setActionFailed(false);
    try {
      await handler();
      if (failure.recovery === "contact-support") setSupportCopied(true);
    } catch {
      setActionFailed(true);
    } finally {
      setWorking(false);
    }
  }

  const role = failure.severity === "informational" ? "status" : "alert";
  const classes = [
    "failure-notice",
    `failure-${failure.severity}`,
    `failure-surface-${failure.presentation}`,
    className,
  ].filter(Boolean).join(" ");

  const content = (
    <div
      id={id}
      ref={dialogRef}
      className={classes}
      role={isModal ? "alertdialog" : role}
      aria-modal={isModal || undefined}
      aria-labelledby={titleId}
      aria-describedby={failure.message ? descriptionId : undefined}
      tabIndex={isModal ? -1 : undefined}
      onKeyDown={trapModalFocus}
      data-error-code={failure.code}
      data-presentation={failure.presentation}
      data-recovery={failure.recovery}
      data-retry-safe={failure.retrySafe ? "true" : "false"}
    >
      <div className="failure-notice-copy">
        <strong id={titleId}>{failure.title}</strong>
        {failure.message && <span id={descriptionId}>{failure.message}</span>}
        {failure.correlationId && failure.presentation !== "field" && (
          <small>Reference: {failure.correlationId}</small>
        )}
      </div>
      {(primaryHandler || actions.dismiss) && (
        <div className="failure-notice-actions">
          {primaryHandler && (
            <button
              ref={primaryRef}
              type="button"
              className="failure-primary-action"
              disabled={working}
              onClick={() => void run(primaryHandler)}
            >
              {working
                ? "Working…"
                : supportCopied && failure.recovery === "contact-support"
                  ? "Support details copied"
                  : failure.actionLabel
                    ?? RECOVERY_LABELS[failure.recovery as Exclude<Recovery, "none">]}
            </button>
          )}
          {actions.dismiss && (
            <button
              ref={primaryHandler ? undefined : primaryRef}
              type="button"
              className="failure-secondary-action"
              disabled={working}
              aria-label={isToast ? "Dismiss notification" : undefined}
              onClick={() => void run(actions.dismiss)}
            >
              {isToast ? "Dismiss" : "Close"}
            </button>
          )}
        </div>
      )}
      {actionFailed && (
        <small className="failure-action-result" role="status">
          That action could not be completed. Try again.
        </small>
      )}
    </div>
  );

  if (!isModal) return content;
  return createPortal(
    <div className="failure-modal-backdrop" data-slide-dialog-portal>
      {content}
    </div>,
    document.body,
  );
}
