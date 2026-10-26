"use client";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { Bot, Ticket } from "lucide-react";

type LauncherProps = {
  ref: RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpen: () => void;
  /** Visible name of the assistant ("AI Co-Pilot" / "Guest Concierge"); the launcher is named after it. */
  title: string;
  dialogId: string;
  guest: boolean;
};

/**
 * The one Co-Pilot launcher: a round floating button at the bottom right (the header's top-right slot belongs to the
 * account control). It clears the safe-area insets, and below 768px it sits above the bottom tab bar when that bar is
 * shown (`aboveTabBar`). The planner pads the bottom of every page by --fab-space, so it never covers the last content.
 * Icon only; the accessible name is "Open AI Co-Pilot" / "Open Guest Concierge". Focus shows the app's focus ring.
 */
export function CopilotLauncher({ ref, open, onOpen, title, dialogId, guest, aboveTabBar = false }: LauncherProps & { aboveTabBar?: boolean }) {
  return (
    <button ref={ref} type="button" onClick={onOpen} data-testid="copilot-launcher" data-floating="true"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId} aria-label={`Open ${title}`} title={`Open ${title}`}
      className={`fixed right-[calc(1rem+env(safe-area-inset-right))] z-30 grid h-14 w-14 place-items-center rounded-full text-white shadow-lg ring-2 ring-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700 ${aboveTabBar ? "bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+0.75rem)] md:bottom-[calc(1rem+env(safe-area-inset-bottom))]" : "bottom-[calc(1rem+env(safe-area-inset-bottom))]"} ${guest ? "bg-primary hover:bg-primary-hover" : "bg-maroon-800 hover:bg-maroon-900"}`}>
      <span aria-hidden="true">{guest ? <Ticket size={24} /> : <Bot size={24} />}</span>
    </button>
  );
}

type Props = {
  open: boolean;
  onClose: () => void;
  /** Visible name of the assistant; the dialog is named after it. */
  titleId: string;
  dialogId: string;
  /** Focus falls back here when the element that opened the drawer is gone. */
  launcherRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
};

/**
 * Right-hand modal drawer around the existing chat.
 *
 * Uses the native <dialog> with showModal(): the browser puts it in the top layer, makes the dashboard inert
 * (no clicks, focus or screen-reader browsing behind it), fires `cancel` on Escape and keeps Tab inside the page
 * content of the dialog. The dialog element stays mounted while closed (display: none), so the chat transcript,
 * the typed draft and pending approval cards keep their state in their existing owners.
 */
export default function CopilotDrawer({ open, onClose, titleId, dialogId, launcherRef, children }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const downOnBackdrop = useRef(false);

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
    <dialog ref={dialogRef} id={dialogId} aria-labelledby={titleId} data-testid="copilot-drawer"
      onClose={handleClose}
      onPointerDown={e => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={e => { if (downOnBackdrop.current && e.target === e.currentTarget) dialogRef.current?.close(); downOnBackdrop.current = false; }}
      className="drawer fixed inset-y-0 left-auto right-0 m-0 h-dvh max-h-none w-full max-w-none overflow-hidden border-l border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-sand-900/40 sm:w-[min(420px,calc(100vw-16px))]">
      {children}
    </dialog>
  );
}
