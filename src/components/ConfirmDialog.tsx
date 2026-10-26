"use client";
// v8 Part 0c: a short native modal <dialog> for a decision: "Delete {title}?", "Delete forever?", and the chooser when a
// deletion and unsaved edits meet ("Restore with my edits" / "Keep deleted"). Escape or Cancel closes it with nothing
// changed. Focus starts on the safe button (Cancel, or the first action when there is none) and returns to the opener.
import { useEffect, useId, useRef, type ReactNode } from "react";

export type ConfirmAction = { label: string; onClick: () => void; tone: "danger" | "primary" | "neutral"; testId: string };

type Props = {
  title: string; children: ReactNode; actions: ConfirmAction[]; cancelLabel?: string; onClose: () => void; testId?: string;
  /** false: Escape does nothing, so a decision that must be made (the deleted-elsewhere chooser) can't be dismissed by accident. */
  dismissible?: boolean;
};
export default function ConfirmDialog({ open, ...rest }: Props & { open: boolean }) {
  if (!open) return null;
  return <ConfirmOpen {...rest} />;
}

const tones: Record<ConfirmAction["tone"], string> = {
  danger: "bg-red-700 font-semibold text-white hover:bg-red-800",
  primary: "bg-primary font-semibold text-white hover:bg-primary-hover",
  neutral: "border border-line-strong bg-surface font-medium text-sand-800 hover:bg-sand-100",
};

function ConfirmOpen({ title, children, actions, cancelLabel, onClose, testId = "confirm-dialog", dismissible = true }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const safe = useRef<HTMLButtonElement>(null);
  const titleId = useId(), descId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!d.open) d.showModal();
    safe.current?.focus();
    // React Strict Mode (dev) runs this effect twice: the cleanup's close() queues a "close" event that lands after the
    // second showModal(), so onClose below ignores a close event that arrives while the dialog is open again (fix6).
    return () => { if (d.open) d.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const btn = "flex min-h-11 items-center justify-center rounded-lg px-4 text-sm";
  return (
    <dialog ref={ref} aria-labelledby={titleId} aria-describedby={descId} data-testid={testId}
      onClose={() => { if (!ref.current?.open) onClose(); }} onCancel={e => { if (!dismissible) e.preventDefault(); }}
      className="m-auto max-h-[min(85dvh,100%)] w-[calc(100%-2rem)] max-w-md overflow-hidden rounded-2xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-sand-900/40">
      <div className="max-h-[min(85dvh,100%)] overflow-y-auto overscroll-contain p-5">
        <h2 id={titleId} className="break-words text-base font-semibold">{title}</h2>
        <div id={descId} className="mt-1 text-sm text-ink-muted">{children}</div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {cancelLabel && (
            <button ref={safe} type="button" onClick={onClose} data-testid={`${testId}-cancel`} className={`${btn} ${tones.neutral}`}>{cancelLabel}</button>
          )}
          {actions.map((a, i) => (
            <button key={a.testId} ref={!cancelLabel && i === 0 ? safe : undefined} type="button" onClick={a.onClick} data-testid={a.testId}
              className={`${btn} ${tones[a.tone]}`}>{a.label}</button>
          ))}
        </div>
      </div>
    </dialog>
  );
}
