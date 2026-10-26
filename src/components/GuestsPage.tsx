"use client";
// v8 Part 1: the Guests page. v8 Part 1c (open RSVP) reorganised it for 500 to 800 guest weddings, where a hand-made guest
// list doesn't scale:
//   1. Share RSVP link: the event's one link with its QR (Copy, WhatsApp, PNG / SVG, Reset). No guest list is needed.
//   2. The RSVP dashboard (RsvpDashboard.tsx): headcount per function and meal computed in code, the RSVP list with
//      search, filters, VIP, Remove (with Undo), Merge for possible duplicates and CSV, and the RSVP settings.
//   3. "Guest list (optional)", collapsed: the Part 1 households, imports, the group join link and the change log.
// Every change goes through the reducer (commit); removing people shows the same approval card the Co-Pilot uses. Phone
// numbers never leave the organizer's view.
import { useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { Check, ClipboardPaste, Contact, Copy, Download, FileUp, History, Link2, MessageCircle, Phone, Plus, QrCode, RefreshCw, RotateCcw, ShieldCheck, Sparkles, Trash2, UserPlus, Users, X } from "lucide-react";
import type { AgentState } from "@/schema";
import type { BatchInput } from "@/commands";
import { contactPickerSupported, parsePasteList, parseVcf, pickContacts, previewImport, VCF_MAX_BYTES, type ImportEntryInput, type ImportSource, type ParseIssue } from "@/guest-import";
import { formatPhone } from "@/phone";
import { joinLink, joinMessage, privateLink, rsvpMessage, waLink } from "@/invites";
import RsvpDashboard from "./RsvpDashboard";
import QrImage, { downloadQrPng, downloadQrSvg } from "./QrImage";
import { usePlanner } from "./planner-context";
import ApprovalPreview from "./ApprovalPreview";
import { Badge, Card, Empty, IconButton, InlineEdit, saveWith, useHighlight } from "./ui";
import { refAnchor } from "@/routes";

const field = "mt-1 block min-h-10 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-ink max-md:min-h-11";
const btn = "flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-sand-800 hover:bg-sand-100 disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11 pointer-coarse:min-h-11";
const primary = "flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50 max-md:min-h-11";
const SOURCE_LABEL = { organizer: "You", copilot: "Co-Pilot", guest_link: "Guest link", guest_preview: "Guest View preview" } as const;

type GuestT = AgentState["guests"][number];
/** The sub-events a guest is invited to that collect RSVPs, in date order. */
const invitedSubs = (plan: AgentState, g: GuestT) => plan.subEvents.filter(s => s.collectsRsvp && s.id in g.rsvp).sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);
const whenText = (at: string) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? at : d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); };
const CHIP_TONE = { yes: "success", no: "danger", maybe: "warning", invited: "neutral" } as const;
const CHIP_TEXT = { yes: "yes", no: "no", maybe: "maybe", invited: "no reply" } as const;

/** Copy text: navigator.clipboard on secure origins, else a hidden textarea + execCommand. */
async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall back */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { return document.execCommand("copy"); } catch { return false; } finally { ta.remove(); }
}
const useOrigin = () => useSyncExternalStore(() => () => {}, () => window.location.origin, () => "");
const usePickerSupported = () => useSyncExternalStore(() => () => {}, contactPickerSupported, () => false);

export default function GuestsPage() {
  const { plan } = usePlanner();
  const households = plan.households.length, guests = plan.guests.length;
  const pending = plan.joinRequests.filter(r => r.status === "pending").length;
  return (
    <div className="space-y-5">
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted" data-testid="guests-summary">
        <span className="flex items-center gap-1"><ShieldCheck size={14} aria-hidden="true" className="text-emerald-700" />Phone numbers are visible to you only, never to guests, the Co-Pilot or the logs.</span>
      </p>
      <ShareRsvpCard />
      <RsvpDashboard />
      <details id="guests-optional" className="group rounded-2xl border border-line bg-surface" data-testid="guests-optional">
        <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl px-4 py-3 text-base font-semibold text-ink hover:bg-surface-muted">
          Guest list (optional)
          <span className="text-sm font-normal text-ink-muted">Not needed for RSVPs. {guests} guest{guests === 1 ? "" : "s"} in {households} household{households === 1 ? "" : "s"}</span>
          {pending > 0 && <Badge tone="warning">{pending} join request{pending === 1 ? "" : "s"} waiting</Badge>}
        </summary>
        <div className="space-y-5 p-3 sm:p-4">
          <p className="text-sm text-ink-muted">Keep your own list of households and phone numbers here if you like (for invitations or seating). RSVPs come in through the link above, not through this list.</p>
          <AddGuests />
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start">
            <HouseholdList />
            <div className="space-y-5">
              <JoinLinkCard />
              <ChangeLog />
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- adding people
type Mode = "household" | "paste" | "vcf";
type Pending = { source: ImportSource; entries: ImportEntryInput[]; issues: ParseIssue[]; truncated: boolean };

function AddGuests() {
  const { plan, commit, ask } = usePlanner();
  const [mode, setMode] = useState<Mode>("household");
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const picker = usePickerSupported();
  const pick = async () => {
    setNotice(null);
    try {
      const entries = await pickContacts();
      if (entries.length) setPending({ source: "contacts", entries, issues: [], truncated: false });
    } catch { setNotice("The contact picker didn't open. Try a contacts file instead."); }
  };
  const tabs: [Mode, string, ReactNode][] = [["household", "One household", <UserPlus key="h" size={15} />], ["paste", "Paste a list", <ClipboardPaste key="p" size={15} />], ["vcf", "Contacts file (.vcf)", <FileUp key="v" size={15} />]];
  return (
    <Card id="guests-add" title="Add guests" icon={<UserPlus size={18} className="text-brand-700" />}
      subtitle="Add one household, paste a list from WhatsApp or a spreadsheet, or import a contacts file. Duplicates (same phone) are skipped.">
      <div role="group" aria-label="How to add guests" className="mb-4 flex flex-wrap gap-2">
        {tabs.map(([m, label, icon]) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => { setMode(m); setPending(null); }} data-testid={`guests-mode-${m}`}
            className={`${btn} ${mode === m ? "border-brand-700 bg-brand-50 text-brand-800" : ""}`}><span aria-hidden="true">{icon}</span>{label}</button>
        ))}
        {/* Contact Picker API: Chrome on Android only, so the button exists only where it works. */}
        {picker && <button type="button" onClick={() => void pick()} data-testid="guests-pick-contacts" className={btn}><Contact size={15} aria-hidden="true" />Pick from phone contacts</button>}
      </div>
      {notice && <p role="status" className="mb-3 text-sm text-ink-muted">{notice}</p>}
      {mode === "household" && <HouseholdForm />}
      {mode === "paste" && <PasteForm onParsed={setPending} onAskAi={text => ask(`Add these guests: ${text}`)} />}
      {mode === "vcf" && <VcfForm onParsed={setPending} />}
      {pending && <ImportReview plan={plan} pending={pending} onDone={() => setPending(null)} commit={commit} />}
    </Card>
  );
}

function HouseholdForm() {
  const { commit } = usePlanner();
  const [f, setF] = useState({ label: "", side: "", phone: "", members: "" });
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const label = f.label.trim();
    if (!label) { setError("Enter the household's name."); return; }
    const names = f.members.split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
    const r = commit({ summary: `Add household ${label}`, commands: [{ op: "add_household", label, ...(f.side.trim() ? { side: f.side.trim() } : {}),
      ...(f.phone.trim() ? { phone: f.phone.trim() } : {}), members: (names.length ? names : [label]).map(name => ({ name })) }] });
    if (!r.ok) { setError(r.reason); setOk(null); return; }
    setError(null); setOk(`Added ${label}.`); setF({ label: "", side: f.side, phone: "", members: "" });
  };
  return (
    <form onSubmit={submit} noValidate className="grid gap-3 sm:grid-cols-2" data-testid="hh-form">
      <label className="text-sm text-ink-muted">Household name <span aria-hidden="true" className="text-danger">*</span>
        <input value={f.label} onChange={e => setF({ ...f, label: e.target.value })} maxLength={120} required autoComplete="off" data-testid="hh-label"
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined} className={field} />
      </label>
      <label className="text-sm text-ink-muted">Side or group (optional)
        <input value={f.side} onChange={e => setF({ ...f, side: e.target.value })} maxLength={40} placeholder="bride, groom, friends…" data-testid="hh-side" className={field} />
      </label>
      <label className="text-sm text-ink-muted">WhatsApp number (optional)
        <input value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} maxLength={40} type="tel" inputMode="tel" autoComplete="off" placeholder="98480 12345" data-testid="hh-phone" className={field} />
        <span className="mt-0.5 block text-xs text-ink-muted">Indian numbers need no +91. Visible to you only.</span>
      </label>
      <label className="text-sm text-ink-muted">People in it (one per line, optional)
        <textarea value={f.members} onChange={e => setF({ ...f, members: e.target.value })} rows={3} data-testid="hh-members" className={`${field} py-2`} />
        <span className="mt-0.5 block text-xs text-ink-muted">Leave empty to add just the household name as one guest.</span>
      </label>
      {error && <p id={`${id}-err`} role="alert" className="text-sm font-medium text-danger sm:col-span-2">{error}</p>}
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button type="submit" data-testid="hh-submit" className={primary}><Plus size={15} aria-hidden="true" />Add household</button>
        <span role="status" className="text-sm text-ink-muted">{ok}</span>
      </div>
    </form>
  );
}

function PasteForm({ onParsed, onAskAi }: { onParsed: (p: Pending) => void; onAskAi: (text: string) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const preview = () => {
    const r = parsePasteList(text);
    if (!r.entries.length) { setError(r.issues.length ? "No names found: put one guest per line, like \"Ravi Kumar, +91 98480 12345\"." : "Paste at least one name."); return; }
    setError(null);
    onParsed({ source: "paste", ...r });
  };
  return (
    <div className="space-y-2">
      <label htmlFor={`${id}-t`} className="block text-sm text-ink-muted">One guest per line: a name, then a phone if you have it (&quot;Ravi Kumar, +91 98480 12345&quot; or &quot;Sita - 98765 43210&quot;).</label>
      <textarea id={`${id}-t`} value={text} onChange={e => setText(e.target.value)} rows={6} data-testid="paste-input" aria-describedby={error ? `${id}-err` : undefined}
        className={`${field} py-2 font-mono`} />
      {error && <p id={`${id}-err`} role="alert" className="text-sm font-medium text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={preview} data-testid="paste-preview" className={primary}>Preview</button>
        <button type="button" onClick={() => text.trim() && onAskAi(text.trim())} disabled={!text.trim()} data-testid="paste-ask-ai" className={btn}>
          <Sparkles size={15} aria-hidden="true" className="text-marigold-700" />Messy text? Ask the Co-Pilot
        </button>
      </div>
    </div>
  );
}

function VcfForm({ onParsed }: { onParsed: (p: Pending) => void }) {
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const read = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > VCF_MAX_BYTES) { setError("That file is over 1 MB. Export fewer contacts at a time."); return; }
    const text = await file.text();
    // Parsed here in the browser: the contacts file is never uploaded.
    const r = parseVcf(text);
    if (!r.entries.length) { setError("No contacts with a name were found in that file."); return; }
    setError(null);
    onParsed({ source: "vcf", ...r });
  };
  return (
    <div className="space-y-2">
      <label htmlFor={`${id}-f`} className="block text-sm text-ink-muted">A .vcf file from iPhone Contacts (Share contact, Save to Files) or Google Contacts (Export, vCard). It is read on this device and never uploaded.</label>
      <input id={`${id}-f`} type="file" accept=".vcf,text/vcard,text/x-vcard" data-testid="vcf-input" onChange={e => void read(e.target.files?.[0])}
        aria-describedby={error ? `${id}-err` : undefined}
        className="block min-h-11 w-full max-w-md rounded-lg border border-line-strong bg-surface p-2 text-sm text-ink file:mr-3 file:min-h-9 file:rounded-md file:border-0 file:bg-sand-100 file:px-3 file:text-sm file:font-medium file:text-sand-800" />
      {error && <p id={`${id}-err`} role="alert" className="text-sm font-medium text-danger">{error}</p>}
    </div>
  );
}

const STATUS_TONE = { new: "success", duplicate: "neutral", invalid: "danger" } as const;
const STATUS_TEXT = { new: "New", duplicate: "Duplicate", invalid: "Can't add" } as const;

/** Step 1: the preview table (what will happen to each row). Step 2: the approval card (the same dry-run the Co-Pilot shows). */
function ImportReview({ plan, pending, onDone, commit }: { plan: AgentState; pending: Pending; onDone: () => void; commit: (b: BatchInput) => unknown }) {
  const [step, setStep] = useState<"preview" | "approve">("preview");
  const p = useMemo(() => previewImport(plan, pending.entries, pending.source), [plan, pending]);
  const fresh = p.rows.filter(r => r.status === "new").length;
  const box = useRef<HTMLDivElement>(null);
  return (
    <div ref={box} className="mt-4 space-y-3 rounded-xl border border-line p-3 sm:p-4" data-testid="import-preview" role="region" aria-label="Import preview">
      <p className="text-sm text-ink" role="status" data-testid="import-counts">
        <b>{fresh}</b> new · {p.duplicates} duplicate{p.duplicates === 1 ? "" : "s"} · {p.invalid + pending.issues.length} can&apos;t be added
        {pending.truncated && <> · only the first {pending.entries.length} were read (the limit per import)</>}
      </p>
      {/* Focusable so keyboard users can scroll a long preview (WCAG 2.1.1). */}
      <div tabIndex={0} role="group" aria-label="Rows to import" className="relative max-h-80 overflow-auto rounded-lg border border-line-soft focus-visible:outline-offset-2">
        <table className="w-full min-w-[28rem] text-sm">
          <thead className="sticky top-0 bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-ink-muted">
            <tr><th scope="col" className="px-2 py-1.5">Name</th><th scope="col" className="px-2 py-1.5">Phone</th><th scope="col" className="px-2 py-1.5">Result</th></tr>
          </thead>
          <tbody>
            {p.entries.map((e, i) => {
              const r = p.rows[i]!;
              return (
                <tr key={i} className="border-t border-line-soft" data-testid="import-row" data-status={r.status}>
                  <td className="px-2 py-1.5 font-medium text-ink">{e.name}</td>
                  <td className="px-2 py-1.5 tabular-nums text-ink-muted">{r.phone ? formatPhone(r.phone) : e.phone ?? "—"}</td>
                  <td className="px-2 py-1.5"><Badge tone={STATUS_TONE[r.status]}>{STATUS_TEXT[r.status]}</Badge> <span className="text-xs text-ink-muted">{r.reason}</span></td>
                </tr>
              );
            })}
            {pending.issues.map((x, i) => (
              <tr key={`x${i}`} className="border-t border-line-soft" data-testid="import-row" data-status="invalid">
                <td className="px-2 py-1.5 text-ink-muted">{x.text}</td><td className="px-2 py-1.5">—</td>
                <td className="px-2 py-1.5"><Badge tone="danger">Can&apos;t add</Badge> <span className="text-xs text-ink-muted">{x.reason}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {step === "preview" ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!p.batch} onClick={() => setStep("approve")} data-testid="import-continue" className={primary}>Continue to approval</button>
          <button type="button" onClick={onDone} className={btn}><X size={15} aria-hidden="true" />Cancel</button>
        </div>
      ) : p.batch && (
        <ApprovalPreview plan={plan} batch={p.batch} label={`Review: ${p.batch.summary}`} testId="import-approval"
          onCancel={onDone} onApprove={() => { commit(p.batch!); onDone(); }} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the RSVP link and its QR (v8 Part 1b)
/**
 * The one link the organizer shares: in a WhatsApp group, on a printed card (the QR), anywhere. Each family opens it and
 * fills in one form. Reset makes a new link: the old link and any printed QR stop working; RSVPs already sent stay.
 */
function ShareRsvpCard() {
  const { plan, sharing } = usePlanner();
  const origin = useOrigin();
  const share = sharing.share;
  const link = share?.rsvpToken ? privateLink(origin, share.eventId, share.rsvpToken) : null;
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const textId = useId();
  const qrLabel = `QR code for the RSVP link to ${plan.event.title}`;
  const file = `rsvp-qr-${plan.event.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "event"}`;
  const reset = async () => {
    setBusy(true);
    const err = await sharing.resetRsvpLink();
    setBusy(false); setConfirmReset(false);
    setMsg(err ? `Couldn't make a new link: ${err}` : share?.rsvpToken ? "New RSVP link made. The old link and any printed QR no longer work; RSVPs already sent are kept." : "Your RSVP link is ready.");
  };
  const copy = async () => { if (link) setMsg((await copyText(link)) ? "RSVP link copied." : `Copy this link: ${link}`); };
  const png = async () => { if (link) setMsg((await downloadQrPng(link, qrLabel, `${file}.png`)) ? "QR code saved as PNG." : "Couldn't make the PNG here: try the SVG instead."); };
  return (
    <Card id="guests-share" title="Share RSVP link" icon={<QrCode size={18} className="text-brand-700" />}
      subtitle="One link for everyone: post it in your WhatsApp group or print the QR on the card. Each family fills in one short form; nobody sees anyone else's answers.">
      {!share ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-surface-muted p-3 text-sm text-ink-muted" data-testid="guests-unpublished">
          <Link2 size={16} aria-hidden="true" className="text-brand-700" />
          <span className="min-w-0 flex-1">Publish guest links to get your RSVP link and its QR code.</span>
          <button type="button" onClick={sharing.publish} disabled={sharing.status.state === "publishing"} data-testid="guests-publish" className={primary}>
            {sharing.status.state === "publishing" ? "Publishing…" : "Publish guest links"}
          </button>
        </div>
      ) : !link ? (
        <div className="flex flex-wrap items-center gap-3 text-sm text-ink-muted" data-testid="rsvp-missing">
          <span className="min-w-0 flex-1">This event was shared before the RSVP link existed. Make one now; household links you already sent open the same form.</span>
          <button type="button" disabled={busy} onClick={() => void reset()} data-testid="rsvp-make" className={primary}>Make the RSVP link</button>
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-4" data-testid="rsvp-share">
          <figure className="m-0 shrink-0">
            <QrImage value={link} label={qrLabel} describedBy={textId} testId="rsvp-qr" className="h-44 w-44 rounded-lg ring-1 ring-line" />
            <figcaption className="mt-1 text-center text-xs text-ink-muted">Scan to RSVP</figcaption>
          </figure>
          <div className="min-w-0 flex-1 basis-64 space-y-3">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">RSVP link</span>
              <p id={textId} data-testid="rsvp-link-text" className="mt-1 break-all rounded-lg bg-surface-muted px-2 py-1.5 font-mono text-xs text-sand-800">{link}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void copy()} data-testid="rsvp-copy" className={btn}><Copy size={15} aria-hidden="true" />Copy link</button>
              <a href={waLink("", rsvpMessage(plan, link))} target="_blank" rel="noopener noreferrer" data-testid="rsvp-wa"
                className="flex min-h-9 items-center gap-1.5 rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800 max-md:min-h-11 pointer-coarse:min-h-11">
                <MessageCircle size={15} aria-hidden="true" />Share on WhatsApp<span className="sr-only"> (opens WhatsApp)</span>
              </a>
              <button type="button" onClick={() => void png()} data-testid="rsvp-qr-png" className={btn}><Download size={15} aria-hidden="true" />QR as PNG</button>
              <button type="button" onClick={() => { downloadQrSvg(link, qrLabel, `${file}.svg`); setMsg("QR code saved as SVG."); }} data-testid="rsvp-qr-svg" className={btn}><Download size={15} aria-hidden="true" />QR as SVG</button>
            </div>
            {!confirmReset ? (
              <button type="button" onClick={() => setConfirmReset(true)} data-testid="rsvp-reset" className={btn}><RotateCcw size={15} aria-hidden="true" />Reset RSVP link</button>
            ) : (
              <span role="group" aria-label="Reset the RSVP link?" className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-2 py-1 text-sm text-amber-900 ring-1 ring-inset ring-amber-300">
                The old link and any printed QR stop working at once. RSVPs already sent are kept.
                <button type="button" disabled={busy} onClick={() => void reset()} data-testid="rsvp-reset-confirm" className="min-h-9 rounded-lg bg-amber-800 px-3 font-semibold text-white max-md:min-h-11">Make a new link</button>
                <button type="button" onClick={() => setConfirmReset(false)} className="min-h-9 rounded-lg px-2 font-medium underline max-md:min-h-11">Cancel</button>
              </span>
            )}
            <p className="text-xs text-ink-muted">Anyone with this link can send an RSVP, so share it with your guests only. If it spreads too far, reset it and share the new one.</p>
          </div>
        </div>
      )}
      {sharing.status.state === "unconfigured" && <p role="alert" className="mt-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-900 ring-1 ring-inset ring-amber-300">Guest links aren&apos;t available on this server yet. {sharing.status.message}</p>}
      <p role="status" className="mt-2 text-sm text-ink-muted empty:hidden" data-testid="rsvp-msg">{msg}</p>
    </Card>
  );
}

// ---------------------------------------------------------------- the list
function HouseholdList() {
  const { plan, commit, highlight } = usePlanner();
  const [q, setQ] = useState("");
  const [review, setReview] = useState<{ batch: BatchInput; label: string } | null>(null);
  const hl = useHighlight(highlight);
  const ql = q.trim().toLowerCase();
  const shown = plan.households.filter(h => !ql || h.label.toLowerCase().includes(ql) || h.phone.includes(ql.replace(/\s/g, "")) ||
    plan.guests.some(g => g.householdId === h.id && g.name.toLowerCase().includes(ql)));
  return (
    <Card id="guests-list" title="Households" icon={<Users size={18} className="text-maroon-700" />}
      subtitle="Your own list, for invitations and seating. Guests don't need to be on it to RSVP.">
      {review && (
        <div className="mb-4">
          <ApprovalPreview plan={plan} batch={review.batch} label={review.label} testId="guest-remove-preview" onCancel={() => setReview(null)}
            onApprove={() => { commit(review.batch); setReview(null); }} />
        </div>
      )}
      {plan.households.length > 6 && (
        <label className="mb-3 block max-w-sm text-sm text-ink-muted">Find a household or guest
          <input type="search" value={q} onChange={e => setQ(e.target.value)} data-testid="guests-search" className={field} />
        </label>
      )}
      {plan.households.length === 0 ? <Empty>No households yet. Add one above, paste a list, or share the group join link.</Empty> : (
        <ul className="space-y-3" data-testid="household-list">
          {shown.map(h => <HouseholdRow key={h.id} plan={plan} h={h} hl={hl(h.id)} onReview={setReview} />)}
          {shown.length === 0 && <li><Empty>No household matches &quot;{q}&quot;.</Empty></li>}
        </ul>
      )}
    </Card>
  );
}

type HouseholdT = AgentState["households"][number];
function HouseholdRow({ plan, h, hl, onReview }: { plan: AgentState; h: HouseholdT; hl: string; onReview: (r: { batch: BatchInput; label: string }) => void }) {
  const { commit } = usePlanner();
  const everyone = plan.guests.filter(g => g.householdId === h.id);
  const members = everyone;
  const [adding, setAdding] = useState("");
  const [addErr, setAddErr] = useState<string | null>(null);
  const id = useId();
  const upd = (patch: Record<string, string>, summary: string) => saveWith(commit, { summary, commands: [{ op: "update_household", householdId: h.id, ...patch }] });
  const addMember = (e: FormEvent) => {
    e.preventDefault();
    const name = adding.trim();
    if (!name) { setAddErr("Enter a name."); return; }
    const r = commit({ summary: `Add ${name} to ${h.label}`, commands: [{ op: "add_guest", householdId: h.id, name }] });
    if (!r.ok) { setAddErr(r.reason); return; }
    setAddErr(null); setAdding("");
  };
  return (
    <li id={refAnchor(h.id)} data-testid={`household-${h.id}`} className={`rounded-xl border border-line p-3 ${hl}`}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56 space-y-1">
          <InlineEdit label={`household name ${h.label}`} value={h.label}
            onSave={(name: string) => saveWith(commit, { summary: `Rename household ${h.label}`, commands: [{ op: "rename_entity", kind: "household", id: h.id, name }] })}>
            <h3 className="break-words text-base font-semibold text-ink">{h.label}</h3>
          </InlineEdit>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">
            <InlineEdit label={`side for ${h.label}`} value={h.side} inputSize="w-40" onSave={(side: string) => upd({ side }, `Side for ${h.label}`)}>
              <span>{h.side || "No side set"}</span>
            </InlineEdit>
            <span className="flex items-center gap-1">
              <InlineEdit label={`phone for ${h.label}`} value={h.phone} inputSize="w-44" hint="Indian numbers need no +91" testId={`hh-phone-edit-${h.id}`}
                onSave={(phone: string) => upd({ phone }, `Phone for ${h.label}`)}>
                <span className="flex items-center gap-1 tabular-nums" data-testid={`hh-phone-${h.id}`}><Phone size={13} aria-hidden="true" />{h.phone ? formatPhone(h.phone) : "No phone"}</span>
              </InlineEdit>
              {h.phone && <IconButton label={`Remove phone for ${h.label}`} onClick={() => upd({ phone: "" }, `Remove phone for ${h.label}`)}><X size={14} /></IconButton>}
            </span>
          </div>
        </div>
        <IconButton label={`Remove household ${h.label}`} data-testid={`hh-remove-${h.id}`}
          onClick={() => onReview({ batch: { summary: `Remove household ${h.label}`, commands: [{ op: "remove_household", householdId: h.id }] }, label: `Review: remove ${h.label}` })}><Trash2 size={15} /></IconButton>
      </div>
      <ul className="mt-2 divide-y divide-line-soft" aria-label={`People in ${h.label}`}>
        {members.map(g => <GuestRow key={g.id} plan={plan} g={g} onReview={onReview} />)}
        {everyone.length === 0 && <li className="py-1 text-sm text-ink-muted">Nobody in this household yet.</li>}
      </ul>
      <form onSubmit={addMember} noValidate className="mt-2 flex flex-wrap items-end gap-2">
        <label className="min-w-0 flex-1 basis-40 text-sm text-ink-muted">Add a person
          <input value={adding} onChange={e => setAdding(e.target.value)} maxLength={120} data-testid={`add-member-${h.id}`} aria-describedby={addErr ? `${id}-err` : undefined} className={field} />
        </label>
        <button type="submit" className={btn}><Plus size={15} aria-hidden="true" />Add<span className="sr-only"> to {h.label}</span></button>
        {addErr && <p id={`${id}-err`} role="alert" className="basis-full text-sm font-medium text-danger">{addErr}</p>}
      </form>
    </li>
  );
}

/** One person on the optional guest list: name (inline rename), remove, and their invitation status per sub-event. */
function GuestRow({ plan, g, onReview }: { plan: AgentState; g: GuestT; onReview: (r: { batch: BatchInput; label: string }) => void }) {
  const { commit } = usePlanner();
  const subs = invitedSubs(plan, g);
  return (
    <li className="space-y-1.5 py-2" data-testid={`guest-${g.id}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <InlineEdit label={`guest name ${g.name}`} value={g.name} grow
          onSave={(name: string) => saveWith(commit, { summary: `Rename guest ${g.name}`, commands: [{ op: "rename_entity", kind: "guest", id: g.id, name }] })}>
          <span className="text-sm font-medium text-ink">{g.name}{g.ageGroup !== "adult" && <span className="font-normal text-ink-muted"> ({g.ageGroup})</span>}</span>
        </InlineEdit>
        <IconButton label={`Remove ${g.name}`} data-testid={`guest-remove-${g.id}`}
          onClick={() => onReview({ batch: { summary: `Remove ${g.name}`, commands: [{ op: "remove_guest", guestId: g.id }] }, label: `Review: remove ${g.name}` })}><X size={14} /></IconButton>
      </div>
      {subs.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`Invitation status for ${g.name}`}>
          {subs.map(s => {
            const v = g.rsvp[s.id] ?? "invited";
            return <li key={s.id} data-testid={`rsvp-chip-${g.id}-${s.id}`} data-status={v}><Badge tone={CHIP_TONE[v]}>{v === "yes" ? <Check size={12} aria-hidden="true" /> : null}{s.name}: {CHIP_TEXT[v]}</Badge></li>;
          })}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- the group join link
function JoinLinkCard() {
  const { plan, commit, sharing } = usePlanner();
  const origin = useOrigin();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<BatchInput | null>(null);
  const share = sharing.share;
  const token = share?.joinToken ?? null;
  const link = share && token ? joinLink(origin, share.eventId, token) : null;
  const pending = plan.joinRequests.filter(r => r.status === "pending");
  const recent = plan.joinRequests.filter(r => r.status !== "pending").slice(-5).reverse();
  const act = async (a: "enable" | "rotate" | "disable") => {
    setBusy(true);
    const err = await sharing.setJoinLink(a);
    setBusy(false);
    setMsg(err ? `Couldn't change the join link: ${err}` : a === "disable" ? "Join link turned off. The old link now says it isn't active." : a === "rotate" ? "New join link made. The old one no longer works." : "Join link is on.");
  };
  const approve = (rid: string, name: string) => {
    const r = commit({ summary: `Approve ${name}`, commands: [{ op: "approve_join_request", requestId: rid }] });
    if (r.ok) { setMsg(`${name} is on the guest list. Share the RSVP link with them to collect their answer.`); sharing.syncNow(); } else setMsg(r.reason);
  };
  return (
    <Card id="guests-join" title="Group join link" icon={<Link2 size={18} className="text-peacock-700" />}
      subtitle="Optional: let people ask to be added to your guest list. Nobody is on the list until you approve them. RSVPs don't need this: they come through the RSVP link.">
      {!share ? (
        <p className="text-sm text-ink-muted" data-testid="join-unpublished">Publish guest links first (on the share card above or with Share in the header).</p>
      ) : (
        <div className="space-y-3">
          {link ? (
            <>
              <input readOnly value={link} aria-label="Group join link" data-testid="join-link" onFocus={e => e.currentTarget.select()}
                className="h-9 w-full truncate rounded border border-line-strong bg-surface-muted px-2 font-mono text-xs text-sand-800 max-md:h-11" />
              <div className="flex flex-wrap gap-2">
                <a href={waLink("", joinMessage(plan, link))} target="_blank" rel="noopener noreferrer" data-testid="join-wa"
                  className="flex min-h-9 items-center gap-1.5 rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800 max-md:min-h-11 pointer-coarse:min-h-11">
                  <MessageCircle size={15} aria-hidden="true" />Share on WhatsApp<span className="sr-only"> (opens WhatsApp)</span>
                </a>
                <button type="button" onClick={() => void copyText(link).then(ok => setMsg(ok ? "Join link copied." : "Select the link above and copy it."))} data-testid="join-copy" className={btn}><Copy size={15} aria-hidden="true" />Copy</button>
                <button type="button" disabled={busy} onClick={() => void act("rotate")} data-testid="join-rotate" className={btn}><RotateCcw size={15} aria-hidden="true" />New link</button>
                <button type="button" disabled={busy} onClick={() => void act("disable")} data-testid="join-disable" className={btn}><X size={15} aria-hidden="true" />Turn off</button>
              </div>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => void act("enable")} data-testid="join-enable" className={primary}><Link2 size={15} aria-hidden="true" />Turn on the join link</button>
          )}
          <p role="status" className="text-sm text-ink-muted" data-testid="join-msg">{msg}</p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-ink">Waiting for you <span className="font-normal tabular-nums text-ink-muted">({pending.length})</span></h3>
            <button type="button" onClick={sharing.syncNow} data-testid="join-refresh" className={btn}><RefreshCw size={14} aria-hidden="true" />Check for new requests</button>
          </div>
          {review && <ApprovalPreview plan={plan} batch={review} label="Review: decline a join request" testId="join-reject-preview" onCancel={() => setReview(null)} onApprove={() => { commit(review); setReview(null); }} />}
          {pending.length === 0 ? <Empty>No requests waiting.</Empty> : (
            <ul className="space-y-2" data-testid="join-requests">
              {pending.map(r => (
                <li key={r.id} data-testid={`join-request-${r.id}`} className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-2.5">
                  <span className="min-w-0 flex-1 basis-40 text-sm"><b className="text-ink">{r.name}</b> <span className="text-ink-muted">· {r.size} {r.size === 1 ? "person" : "people"}{r.phone ? ` · ${formatPhone(r.phone)}` : ""}</span></span>
                  <button type="button" onClick={() => approve(r.id, r.name)} data-testid={`join-approve-${r.id}`} className="flex min-h-9 items-center gap-1 rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800 max-md:min-h-11"><Check size={14} aria-hidden="true" />Approve<span className="sr-only"> {r.name}</span></button>
                  <button type="button" onClick={() => setReview({ summary: `Decline ${r.name}`, commands: [{ op: "reject_join_request", requestId: r.id }] })} data-testid={`join-reject-${r.id}`} className={btn}>Decline<span className="sr-only"> {r.name}</span></button>
                </li>
              ))}
            </ul>
          )}
          {recent.length > 0 && (
            <p className="text-xs text-ink-muted">Recently: {recent.map(r => `${r.name} ${r.status}`).join(" · ")}</p>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- the change log
function ChangeLog() {
  const { plan } = usePlanner();
  const [all, setAll] = useState(false);
  const rows = [...plan.rsvpLog].reverse();
  const shown = all ? rows : rows.slice(0, 25);
  const sub = (id: string | null) => (id ? plan.subEvents.find(s => s.id === id)?.name ?? "a removed sub-event" : "");
  const when = whenText;
  return (
    <Card id="guests-log" title="RSVP change log" icon={<History size={18} className="text-sand-700" />}
      subtitle={`Who changed which answer, when, and from where. Only you see this. The newest ${300} changes are kept.`}>
      {rows.length === 0 ? <Empty>No RSVP or meal changes yet.</Empty> : (
        <div tabIndex={0} role="group" aria-label="Change log" className="relative overflow-x-auto focus-visible:outline-offset-2">
          <table className="w-full min-w-[30rem] text-sm" data-testid="rsvp-log">
            <thead className="text-left text-xs font-semibold uppercase tracking-wide text-ink-muted">
              <tr><th scope="col" className="py-1 pr-2">When</th><th scope="col" className="py-1 pr-2">Who</th><th scope="col" className="py-1 pr-2">Change</th><th scope="col" className="py-1">Via</th></tr>
            </thead>
            <tbody>
              {shown.map(e => (
                <tr key={e.id} className="border-t border-line-soft align-top" data-testid="rsvp-log-row" data-source={e.source}>
                  <td className="whitespace-nowrap py-1.5 pr-2 tabular-nums text-ink-muted">{when(e.at)}</td>
                  <td className="py-1.5 pr-2 text-ink">{e.guestName}<span className="block text-xs text-ink-muted">{e.householdLabel}</span></td>
                  <td className="py-1.5 pr-2 text-ink">{e.field === "rsvp" ? `${sub(e.subEventId)}: ` : "Meals: "}<span className="text-ink-muted">{e.before}</span> <span aria-hidden="true">→</span><span className="sr-only">to</span> <b>{e.after}</b></td>
                  <td className="py-1.5 text-ink-muted">{SOURCE_LABEL[e.source]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 25 && <button type="button" onClick={() => setAll(v => !v)} className={`${btn} mt-2`}>{all ? "Show fewer" : `Show all ${rows.length}`}</button>}
        </div>
      )}
    </Card>
  );
}
