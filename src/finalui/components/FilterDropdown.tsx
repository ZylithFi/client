import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "./Icons";

export function FilterDropdown({
  label,
  value,
  options,
  onChange,
  triggerLabel,
  icon,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  triggerLabel?: string;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const selected = menuRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
      (selected ?? menuRef.current?.querySelector<HTMLElement>("button"))?.focus();
    });
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const closeOnOutsideFocus = (event: FocusEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("focusin", closeOnOutsideFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("focusin", closeOnOutsideFocus);
    };
  }, [open]);

  return (
    <div className="filter-dropdown" ref={rootRef}>
      <button
        ref={triggerRef}
        className={`filter-trigger ${triggerLabel ? "standalone" : ""}`}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon}
        {triggerLabel ? <span>{triggerLabel}</span> : <span>＋ {label}:</span>}
        {(!triggerLabel || value !== "All") && <strong>{value}</strong>}
        <ChevronDownIcon className="icon-14" />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          className="filter-menu"
          role="listbox"
          aria-label={`Filter by ${label.toLowerCase()}`}
          onKeyDown={(event) => {
            const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            let next = index;
            if (event.key === "ArrowDown") next = Math.min(items.length - 1, index + 1);
            else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = items.length - 1;
            else return;
            event.preventDefault();
            items[next]?.focus();
          }}
        >
          <div className="filter-menu-title">{label}</div>
          {options.map((option) => (
            <button key={option} type="button" role="option" aria-selected={option === value} className={option === value ? "selected" : ""} onClick={() => { onChange(option); setOpen(false); triggerRef.current?.focus(); }}>
              <span>{option}</span><i aria-hidden="true">{option === value ? "✓" : ""}</i>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
