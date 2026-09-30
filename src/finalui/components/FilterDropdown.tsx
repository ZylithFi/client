import { useEffect, useRef, useState, type ReactNode } from "react";
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

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="filter-dropdown" ref={rootRef}>
      <button className={`filter-trigger ${triggerLabel ? "standalone" : ""}`} type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        {icon}
        {triggerLabel ? <span>{triggerLabel}</span> : <span>＋ {label}:</span>}
        {(!triggerLabel || value !== "All") && <strong>{value}</strong>}
        <ChevronDownIcon className="icon-14" />
      </button>
      {open && (
        <div className="filter-menu" role="listbox" aria-label={`Filter by ${label.toLowerCase()}`}>
          <div className="filter-menu-title">{label}</div>
          {options.map((option) => (
            <button key={option} type="button" role="option" aria-selected={option === value} className={option === value ? "selected" : ""} onClick={() => { onChange(option); setOpen(false); }}>
              <span>{option}</span><i aria-hidden="true">{option === value ? "✓" : ""}</i>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
