"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { Bot, Ticket } from "lucide-react";

type Props = {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Visible name of the assistant ("AI Co-Pilot" / "Guest Concierge"); the dialog and launcher are named after it. */
  title: string;
  titleId: string;
  guest: boolean;
  children: ReactNode;
};

/**
 * Floating launcher + right-hand modal drawer around the existing chat.
 *
 * Uses the native <dialog> with showModal(): the browser puts it in the top layer, makes the dashboard inert
 * (no clicks, focus or screen-reader browsing behind it), fires `cancel` on Escape and keeps Tab inside the page
 * content of the dialog. The dialog element stays mounted while closed (display: none), so the chat transcript,
 * the typed draft and pending approval cards keep their state in their existing owners.
 */
export default function CopilotDrawer({ open, onOpen, onClose, title, titleId, guest, children }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const downOnBackdrop = useRef(false);
  const dialogId = `${titleId}-dialog`;

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      d.showModal();
      // Desktop: straight to the message box. Touch-sized screens: the close button, so the keyboard doesn't pop up uninvited.
      const wide = window.matchMedia("(min-width: 768px)").matches;
      const target = d.querySelector<HTMLElement>(wide ? "[data-drawer-autofocus]" : "[data-drawer-close]") ?? d.querySelector<HTMLElement>("[data-drawer-close]");
      target?.focus();
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // Native close (Escape, our close button, backdrop, or a state change): sync state, then put focus back where it came from.
  const handleClose = () => {
    if (open) onClose();
    const opener = openerRef.current;
    openerRef.current = null;
    const back = opener && opener.isConnected && !opener.closest("dialog") ? opener : launcherRef.current;
    back?.focus();
  };

  return (
    <>
      <button ref={launcherRef} type="button" onClick={onOpen} data-testid="copilot-launcher"
        aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId} aria-label={`Open ${title}`} title={`Open ${title}`}
        className={`fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-[calc(1rem+env(safe-area-inset-right))] z-30 flex h-12 min-w-12 items-center justify-center gap-2 rounded-full px-3.5 text-sm font-semibold text-white shadow-lg ring-1 ring-white/20 sm:px-4 ${guest ? "bg-violet-700 hover:bg-violet-800" : "bg-slate-900 hover:bg-slate-800"}`}>
        {guest ? <Ticket size={18} /> : <Bot size={18} />}
        <span className="hidden sm:inline">{title}</span>
      </button>
      <dialog ref={dialogRef} id={dialogId} aria-labelledby={titleId} data-testid="copilot-drawer"
        onClose={handleClose}
        onPointerDown={e => { downOnBackdrop.current = e.target === e.currentTarget; }}
        onClick={e => { if (downOnBackdrop.current && e.target === e.currentTarget) dialogRef.current?.close(); downOnBackdrop.current = false; }}
        className="drawer fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-full max-w-none overflow-hidden border-l border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-900/40 sm:w-[min(420px,calc(100vw-16px))]">
        {children}
      </dialog>
    </>
  );
}
