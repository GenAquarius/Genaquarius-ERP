import React, { useEffect, useRef, useState } from "react";
import { fmtDate } from "./dateFormat";

// Shared by ui.tsx's Field and components.tsx's Input (both wrap this rather than each other, to
// avoid a circular import between those two modules — ui.tsx already imports from components.tsx).
//
// type="date" gets the native picker for ACTUALLY picking a date (browsers won't render that any
// other way), but shows Company Settings -> Date & Time Format's configured format the rest of the
// time — a bare native <input type="date"> always displays in the browser's own locale format,
// which this app has no control over while keeping the real calendar widget. Clicking (or tabbing
// into) the formatted display swaps in the live native input; blurring it swaps back.
export function DateInput({ value, onChange, disabled, style, required, ...rest }: any) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing || !inputRef.current) return;
    inputRef.current.focus();
    // showPicker() opens the calendar immediately on Chrome/Edge; Safari/Firefox simply fall back
    // to a focused native input (still fully usable, just one extra click to open the calendar).
    try { (inputRef.current as any).showPicker?.(); } catch { /* unsupported — fine */ }
  }, [editing]);
  if (editing && !disabled) {
    return <input ref={inputRef} type="date" value={value || ""} required={required} disabled={disabled} style={style}
      onChange={onChange} onBlur={() => setEditing(false)} {...rest} />;
  }
  return <input type="text" readOnly value={value ? fmtDate(value) : ""} disabled={disabled} style={{ cursor: disabled ? "default" : "pointer", ...style }}
    onClick={() => !disabled && setEditing(true)} onFocus={() => !disabled && setEditing(true)} placeholder={rest.placeholder} />;
}
