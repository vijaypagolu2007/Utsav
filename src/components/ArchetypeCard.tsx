"use client";
// The event-type card: a generic frame that renders the sections the active template's layout lists
// (config/event-templates.ts). Each section is an ordinary component keyed by its id; configuration only picks and
// arranges them, so a new template reuses these instead of needing a fourth hand-built layout.
import { useContext, useId, useState, type ComponentType, type FormEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Building2, Cake, ExternalLink, Eye, EyeOff, Gift, Handshake, Heart, Megaphone, Plus, ShieldCheck, Sparkles, Timer, Trash2, Users, X } from "lucide-react";
import ApprovalPreview from "./ApprovalPreview";
import type { AgentState, SponsorTier } from "@/schema";
import { ACTIVITY_LIMITS, daysBetween } from "@/commands";
import { computeRunSheetTimes, parseAges, parseMinutes, runSheetEnd, runSheetTotal } from "@/run-sheet";
import { PlannerContext } from "./planner-context";
import type { Commit, Highlight } from "./PlannerApp";
import Link from "next/link";
import { pageById, refAnchor } from "@/routes";
import { Badge, Card, Empty, IconButton, InlineEdit, inr, longDate, parseInline, relDays, saveWith, useHighlight, type Tone } from "./ui";
import { sponsorProgress } from "@/budget-a11y";
import { formatTokens, templateTokens, type EventTemplate, type OrganizerSectionId } from "@/config/event-templates";
import { labelOf, PERMIT_STATUS_OPTIONS, SPONSOR_STATUS_OPTIONS, SPONSOR_TIER_OPTIONS } from "@/config/planner-options";

type SectionProps = { plan: AgentState; today: string; commit: Commit; highlight: Highlight; onAsk: (text: string) => void };
type Props = SectionProps & { template: EventTemplate };
const sel = "min-h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm text-ink max-md:min-h-11 pointer-coarse:min-h-11";
const field = "mt-1 block min-h-10 w-full rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-ink max-md:min-h-11";
function SubHead({ icon, children, right }: { icon: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      <h3 className="flex items-center gap-2 text-base font-semibold text-ink"><span aria-hidden="true">{icon}</span>{children}</h3>
      {right && <span className="ml-auto text-sm tabular-nums text-ink-muted">{right}</span>}
    </div>
  );
}

/** Wedding: the couple, traditions and RSVP deadline. */
function CoupleProfile({ plan }: SectionProps) {
  const ext = plan.event.ext;
  if (ext.type !== "wedding") return null;
  return (
    <div className="rounded-xl bg-gradient-to-br from-maroon-50 to-marigold-50 p-4 ring-1 ring-inset ring-maroon-200">
      <h3 className="flex items-center gap-2 text-base font-semibold text-maroon-800"><Heart size={16} aria-hidden="true" /> {ext.partners.filter(Boolean).join(" & ") || "Partners"}</h3>
      <div className="mt-2 flex flex-wrap gap-1.5">{ext.traditions.map(t => <Badge key={t} tone="secondary">{t}</Badge>)}</div>
      {ext.rsvpDeadline && <p className="mt-2 text-sm tabular-nums text-sand-700">RSVP deadline <b>{longDate(ext.rsvpDeadline)}</b></p>}
    </div>
  );
}

/** Dietary counts among guests who said yes to the main event. */
function DietSummary({ plan }: SectionProps) {
  const main = plan.subEvents.find(s => s.isMain);
  const diets = new Map<string, number>();
  for (const g of plan.guests) if (main && g.rsvp[main.id] === "yes") for (const d of g.diet.length ? g.diet : ["no restriction"]) diets.set(d, (diets.get(d) ?? 0) + 1);
  return (
    <div className="rounded-xl p-4 ring-1 ring-inset ring-line">
      <h3 className="mb-2 text-base font-semibold text-ink">Dietary counts · {main?.name ?? "main"} (yes)</h3>
      {diets.size === 0 ? <p className="text-sm text-ink-muted">No confirmations yet.</p> :
        <ul className="space-y-1 text-sm">{[...diets].sort((a, b) => b[1] - a[1]).map(([d, n]) => <li key={d} className="flex justify-between gap-3"><span className="capitalize text-sand-700">{d}</span><b className="tabular-nums text-ink">{n}</b></li>)}</ul>}
      {/* v8 Part 1f: RSVPs are answered through the RSVP link and managed on the Guests page, not here. */}
      <Link href={pageById("guests").href} data-testid="event-manage-rsvps"
        className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-brand-800 underline underline-offset-2 hover:text-brand-900 md:min-h-9">Manage RSVPs on Guests</Link>
    </div>
  );
}

/**
 * Birthday wishlist / wedding gift registry (v8 Part 1): add, edit and remove gifts, record who claimed each one, and
 * surprise mode. In surprise mode this view hides who claimed (the honoree may be looking over the organiser's
 * shoulder) until "Show who claimed" is pressed, and the public link hides which gifts are claimed.
 */
function WishlistManager({ plan, commit, highlight }: SectionProps) {
  const hl = useHighlight(highlight);
  const ext = plan.event.ext;
  const [draft, setDraft] = useState({ item: "", price: "", url: "", priority: "med" });
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const formId = useId();
  if (ext.type !== "birthday" && ext.type !== "wedding") return null;
  const registry = ext.type === "wedding";
  const noun = registry ? "registry" : "wishlist";
  const surprise = ext.wishlistSurprise;
  const showClaimers = !surprise || reveal;
  const add = (e: FormEvent) => {
    e.preventDefault();
    const item = draft.item.trim();
    if (!item) { setError("Enter the gift."); return; }
    let rupeesN: number | undefined;
    if (draft.price.trim()) {
      const p = parseInline("rupees", draft.price);
      if (!p.ok) { setError(p.error); return; }
      rupeesN = (p.value as number) / 100;
    }
    const r = commit({ summary: `Add ${item} to the ${noun}`, commands: [{ op: "add_wishlist_item", item, priority: draft.priority as "low" | "med" | "high",
      ...(draft.url.trim() ? { url: draft.url.trim() } : {}), ...(rupeesN !== undefined ? { approxRupees: rupeesN } : {}) }] });
    if (!r.ok) { setError(r.reason); return; }
    setError(null); setDraft({ item: "", price: "", url: "", priority: draft.priority });
  };
  const upd = (id: string, patch: Record<string, unknown>, summary: string) => saveWith(commit, { summary, commands: [{ op: "update_wishlist_item", itemId: id, ...patch }] });
  const removingItem = ext.wishlist.find(w => w.id === removing);
  return (
    <div className="min-w-0" data-testid="wishlist-manager">
      <SubHead icon={<Gift size={16} className="text-brand-700" />} right={<>{ext.wishlist.filter(w => w.claimedByGuestId).length} of {ext.wishlist.length} claimed</>}>{registry ? "Gift registry" : "Gift wishlist"}</SubHead>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button type="button" aria-pressed={surprise} data-testid="wish-surprise"
          onClick={() => { commit({ summary: surprise ? "Surprise mode off" : "Surprise mode on", commands: [{ op: "set_wishlist_surprise", on: !surprise }] }); setReveal(false); }}
          className={`flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium max-md:min-h-11 pointer-coarse:min-h-11 ${surprise ? "border-brand-700 bg-brand-50 text-brand-800" : "border-line-strong bg-surface text-sand-800 hover:bg-sand-100"}`}>
          {surprise ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />} Surprise mode {surprise ? "on" : "off"}
        </button>
        {surprise && (
          <button type="button" aria-pressed={reveal} onClick={() => setReveal(v => !v)} data-testid="wish-reveal"
            className="min-h-9 rounded-lg px-2 text-sm font-medium text-brand-800 underline-offset-2 hover:underline max-md:min-h-11 pointer-coarse:min-h-11">{reveal ? "Hide who claimed" : "Show who claimed"}</button>
        )}
      </div>
      {surprise && <p className="mb-3 text-sm text-ink-muted" data-testid="wish-surprise-note">Surprise mode: the public link doesn&apos;t show which gifts are claimed, and this list hides who claimed them.</p>}
      {ext.wishlist.length === 0 ? <Empty>{registry ? "No gifts on the registry yet." : "No wishes yet."}</Empty> : (
        <ul className="space-y-2">
          {ext.wishlist.map(w => (
            <li key={w.id} id={refAnchor(w.id)} data-testid={`wish-${w.id}`} className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl p-3 ring-1 ring-inset ${w.claimedByGuestId ? "bg-emerald-50/60 ring-emerald-200" : w.priority === "high" ? "ring-amber-300" : "ring-line"} ${hl(w.id)}`}>
              <div className="min-w-0 flex-1 basis-48">
                <InlineEdit label={`gift ${w.item}`} value={w.item} onSave={(item: string) => upd(w.id, { item }, `Rename gift ${w.item}`)}>
                  <p className="break-words text-base font-medium text-ink">{w.item}</p>
                </InlineEdit>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <select value={w.priority} aria-label={`Priority of ${w.item}`} onChange={e => upd(w.id, { priority: e.target.value }, `Priority of ${w.item}`)} className={`${sel} min-h-8`}>
                    <option value="high">High priority</option><option value="med">Medium priority</option><option value="low">Low priority</option>
                  </select>
                  <InlineEdit label={`price of ${w.item}`} kind="rupees" value={w.approxPaise !== undefined ? String(w.approxPaise / 100) : ""} inputSize="w-32"
                    onSave={(paise: number) => upd(w.id, { approxRupees: paise / 100 }, `Price of ${w.item}`)}>
                    {w.approxPaise !== undefined ? <Badge><span className="tabular-nums">~{inr(w.approxPaise)}</span></Badge> : <span className="text-sm text-ink-muted">No price</span>}
                  </InlineEdit>
                  <InlineEdit label={`shop link for ${w.item}`} value={w.url ?? ""} inputSize="w-64" hint="A full https:// link"
                    onSave={(url: string) => upd(w.id, { url }, `Link for ${w.item}`)}>
                    {w.url ? <a href={w.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex min-h-8 items-center gap-1 text-sm font-medium text-brand-800 underline">
                      <ExternalLink size={13} aria-hidden="true" />Shop link<span className="sr-only"> for {w.item} (opens in a new tab)</span></a> : <span className="text-sm text-ink-muted">No link</span>}
                  </InlineEdit>
                </div>
              </div>
              {showClaimers ? (
                <select value={w.claimedByGuestId ?? ""} aria-label={`Who claimed ${w.item}`}
                  onChange={e => commit({ summary: `Wishlist ${w.item}`, commands: [{ op: "claim_wishlist_item", itemId: w.id, guestId: e.target.value || null }] })}
                  className={`${sel} max-w-44 ${w.claimedByGuestId ? "border-emerald-600 bg-emerald-50 text-emerald-900" : ""}`}>
                  <option value="">Unclaimed</option>
                  {plan.guests.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  {/* v8 Part 1c: a claim from the open RSVP link is held by that RSVP. */}
                  {plan.rsvpEntries.filter(e => !e.removedAt && !e.mergedInto).map(e => <option key={e.id} value={e.id}>{e.name} (RSVP)</option>)}
                </select>
              ) : <Badge tone={w.claimedByGuestId ? "success" : "neutral"}>{w.claimedByGuestId ? "Claimed" : "Unclaimed"}</Badge>}
              <IconButton label={`Remove ${w.item}`} onClick={() => setRemoving(w.id)} data-testid={`wish-remove-${w.id}`}><Trash2 size={15} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      {removingItem && (
        <div className="mt-3">
          <ApprovalPreview plan={plan} batch={{ summary: `Remove ${removingItem.item}`, commands: [{ op: "remove_wishlist_item", itemId: removingItem.id }] }} label={`Review: remove ${removingItem.item}`}
            testId="wish-remove-preview" onCancel={() => setRemoving(null)}
            onApprove={() => { commit({ summary: `Remove ${removingItem.item}`, commands: [{ op: "remove_wishlist_item", itemId: removingItem.id }] }); setRemoving(null); }} />
        </div>
      )}
      <form onSubmit={add} noValidate className="mt-3 grid gap-2 rounded-xl border border-dashed border-line-strong p-3 sm:grid-cols-2" aria-labelledby={`${formId}-h`} data-testid="wish-add-form">
        <h4 id={`${formId}-h`} className="text-sm font-semibold text-ink sm:col-span-2">Add a gift</h4>
        <label className="text-sm text-ink-muted sm:col-span-2">Gift
          <input value={draft.item} onChange={e => setDraft({ ...draft, item: e.target.value })} maxLength={120} data-testid="wish-add-item" aria-describedby={error ? `${formId}-err` : undefined} className={field} />
        </label>
        <label className="text-sm text-ink-muted">Approximate price (₹, optional)
          <input value={draft.price} onChange={e => setDraft({ ...draft, price: e.target.value })} inputMode="numeric" data-testid="wish-add-price" className={field} />
        </label>
        <label className="text-sm text-ink-muted">Priority
          <select value={draft.priority} onChange={e => setDraft({ ...draft, priority: e.target.value })} data-testid="wish-add-priority" className={field}>
            <option value="high">High</option><option value="med">Medium</option><option value="low">Low</option>
          </select>
        </label>
        <label className="text-sm text-ink-muted sm:col-span-2">Shop link (https only, optional)
          <input value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} type="url" inputMode="url" placeholder="https://" maxLength={500} data-testid="wish-add-url" className={field} />
        </label>
        {error && <p id={`${formId}-err`} role="alert" className="text-sm font-medium text-danger sm:col-span-2">{error}</p>}
        <button type="submit" data-testid="wish-add-submit" className="flex min-h-10 items-center justify-center gap-1.5 justify-self-start rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary-hover max-md:min-h-11">
          <Plus size={15} aria-hidden="true" /> Add to {noun}
        </button>
      </form>
    </div>
  );
}

const ageLabel = (r: readonly [number, number] | undefined) => (r ? (r[1] >= ACTIVITY_LIMITS.maxAge ? `ages ${r[0]}+` : `ages ${r[0]}–${r[1]}`) : "all ages");
const big = "flex min-h-11 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-semibold";
const square = "grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-line-strong bg-surface text-ink hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Birthday: the party activity run-sheet (v8 Part 1e). The organizer adds, edits (name, minutes, ages, supplies),
 * reorders and removes rows, and sets when the party starts; each row's start and end come from run-sheet.ts (minutes
 * arithmetic in code). Removing a row has a 10 s Undo on its toast. Guests never get these controls.
 */
function ActivityRunSheet({ plan, commit, highlight }: SectionProps) {
  const hl = useHighlight(highlight);
  // Inside the planner the shared state gives the role and the Undo-toast commit; a bare render (tests) is the organizer's.
  const ctx = useContext(PlannerContext);
  const role = ctx?.role ?? "organizer", commitUndoable = ctx?.commitUndoable ?? commit;
  const ext = plan.event.ext;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", minutes: "30", ageMin: "", ageMax: "", supplies: "" });
  const [error, setError] = useState<string | null>(null);
  const [startDraft, setStartDraft] = useState<string | null>(null);
  const [supplyDraft, setSupplyDraft] = useState<Record<string, string>>({});
  const [supplyError, setSupplyError] = useState<Record<string, string>>({});
  const formId = useId();
  if (ext.type !== "birthday") return null;
  const total = runSheetTotal(ext.activities);
  const times = computeRunSheetTimes(ext.partyStart, ext.activities);
  const ends = runSheetEnd(ext.partyStart, ext.activities);
  const editable = role === "organizer";
  const full = ext.activities.length >= ACTIVITY_LIMITS.maxActivities;
  const head = <SubHead icon={<Timer size={16} className="text-peacock-700" />} right={<span data-testid="activity-total">Total run time <b className="text-ink">{total} min</b>{ends && <> · ends <b className="text-ink">{ends}</b></>}</span>}>Party activity run-sheet</SubHead>;

  if (!editable) return (
    <div className="min-w-0">
      {head}
      {ext.activities.length === 0 ? <Empty>No activities yet.</Empty> : (
        <ol className="divide-y divide-line-soft rounded-xl ring-1 ring-inset ring-line">
          {ext.activities.map((a, k) => (
            <li key={a.id} id={refAnchor(a.id)} data-testid="activity-row" className={`px-3 py-2.5 ${hl(a.id)}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-base font-medium text-ink">{a.name}</span>
                <span className="text-sm tabular-nums text-ink-muted">{times && <>{times[k]!.label} · </>}{a.durationMin} min · {ageLabel(a.ageRange)}</span>
              </div>
              {a.supplies.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5"><span className="sr-only">Supplies:</span>{a.supplies.map(x => <Badge key={x}>{x}</Badge>)}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  const upd = (a: { id: string; name: string }, patch: Record<string, unknown>, summary: string) =>
    saveWith(commit, { summary, commands: [{ op: "update_activity", activityId: a.id, ...patch } as never] });
  const move = (a: { id: string; name: string }, direction: "up" | "down") =>
    commit({ summary: `Move ${a.name} ${direction}`, commands: [{ op: "move_activity", activityId: a.id, direction }] });
  const remove = (a: { id: string; name: string }) => commitUndoable({ summary: `Remove ${a.name} from the run-sheet`, commands: [{ op: "remove_activity", activityId: a.id }] });
  const setStart = (value: string) => {
    const time = value.trim() || null;
    setStartDraft(null);
    if (time === ext.partyStart) return;
    commit({ summary: time ? `Party starts at ${time}` : "Remove the party start time", commands: [{ op: "set_party_start", time }] });
  };
  const addSupply = (a: (typeof ext.activities)[number]) => {
    const v = (supplyDraft[a.id] ?? "").trim();
    if (!v) { setSupplyError({ ...supplyError, [a.id]: "Enter a supply." }); return; }
    const err = upd(a, { supplies: [...a.supplies, v] }, `Add ${v} to ${a.name}`);
    setSupplyError({ ...supplyError, [a.id]: err ?? "" });
    if (!err) setSupplyDraft({ ...supplyDraft, [a.id]: "" });
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) { setError("Name the activity."); return; }
    const mins = parseMinutes(draft.minutes);
    if (!mins.ok) { setError(mins.error); return; }
    const age = (v: string) => (v.trim() === "" ? undefined : /^\d{1,3}$/.test(v.trim()) ? Number(v.trim()) : NaN);
    const ageMin = age(draft.ageMin), ageMax = age(draft.ageMax);
    if (Number.isNaN(ageMin) || Number.isNaN(ageMax)) { setError("Ages are whole numbers."); return; }
    const supplies = draft.supplies.split(",").map(x => x.trim()).filter(Boolean);
    const r = commit({ summary: `Add ${name} to the run-sheet`, commands: [{ op: "add_activity", name, durationMin: mins.value,
      ...(ageMin !== undefined ? { ageMin } : {}), ...(ageMax !== undefined ? { ageMax } : {}), ...(supplies.length ? { supplies } : {}) }] });
    if (!r.ok) { setError(r.reason); return; }
    setError(null); setDraft({ name: "", minutes: "30", ageMin: "", ageMax: "", supplies: "" }); setAdding(false);
  };
  const addButton = (
    <button type="button" onClick={() => { setAdding(true); setError(null); }} disabled={full} aria-expanded={adding} aria-controls={adding ? `${formId}-form` : undefined} data-testid="activity-add"
      className={`${big} border border-line-strong bg-surface text-ink hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50`}>
      <Plus size={15} aria-hidden="true" /> Add activity
    </button>
  );

  return (
    <div className="min-w-0" data-testid="activity-run-sheet">
      {head}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="text-sm text-ink-muted">Party starts at
          <input type="time" value={startDraft ?? ext.partyStart ?? ""} onChange={e => setStartDraft(e.target.value)}
            onBlur={e => { if (startDraft !== null) setStart(e.target.value); }}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); setStart(e.currentTarget.value); } }}
            data-testid="party-start" aria-describedby={`${formId}-start-hint`}
            className="mt-1 block min-h-11 rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-ink tabular-nums" />
        </label>
        {ext.partyStart && <button type="button" onClick={() => setStart("")} data-testid="party-start-clear" className={`${big} text-ink-muted underline-offset-2 hover:underline`}>Clear start time</button>}
        <p id={`${formId}-start-hint`} className="basis-full text-xs text-ink-muted">{ext.partyStart ? "Each row's time is worked out from the start time and the minutes above it." : "Optional. Set it to see when each activity starts and ends."}</p>
      </div>
      {ext.activities.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong p-4 text-center" data-testid="activity-empty">
          <p className="mb-3 text-sm text-ink-muted">No activities yet. Add games, the cake cutting and anything else with a time slot.</p>
          {!adding && <div className="flex justify-center">{addButton}</div>}
        </div>
      ) : (
        <ol className="space-y-2" aria-label="Run-sheet activities, in order">
          {ext.activities.map((a, k) => (
            <li key={a.id} id={refAnchor(a.id)} data-testid="activity-row" className={`rounded-xl p-3 ring-1 ring-inset ring-line ${hl(a.id)}`}>
              <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1 basis-48">
                  {times && <p className="text-sm font-semibold tabular-nums text-peacock-800" data-testid="activity-time">{times[k]!.label}</p>}
                  <InlineEdit large label={`activity name ${a.name}`} value={a.name} testId="activity-edit-name"
                    onSave={(name: string) => name.length > ACTIVITY_LIMITS.nameMax ? `Use ${ACTIVITY_LIMITS.nameMax} characters or fewer.` : upd(a, { name }, `Rename ${a.name}`)}>
                    <p className="break-words text-base font-medium text-ink">{a.name}</p>
                  </InlineEdit>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <InlineEdit large label={`minutes for ${a.name}`} value={String(a.durationMin)} inputSize="w-24" hint={`Whole minutes, ${ACTIVITY_LIMITS.minDuration} to ${ACTIVITY_LIMITS.maxDuration}`} testId="activity-edit-minutes"
                      onSave={(raw: string) => { const p = parseMinutes(raw); return p.ok ? upd(a, { durationMin: p.value }, `Minutes for ${a.name}`) : p.error; }}>
                      <span className="text-sm tabular-nums text-ink" data-testid="activity-minutes">{a.durationMin} min</span>
                    </InlineEdit>
                    <InlineEdit large label={`ages for ${a.name}`} value={a.ageRange ? (a.ageRange[1] >= ACTIVITY_LIMITS.maxAge ? `${a.ageRange[0]}+` : `${a.ageRange[0]}-${a.ageRange[1]}`) : "all"} inputSize="w-28"
                      hint="Like 5-12, 8+ or all" testId="activity-edit-ages"
                      onSave={(raw: string) => { const p = parseAges(raw); return p.ok ? upd(a, { ageMin: p.ageMin, ageMax: p.ageMax }, `Ages for ${a.name}`) : p.error; }}>
                      <span className="text-sm text-ink-muted" data-testid="activity-ages">{ageLabel(a.ageRange)}</span>
                    </InlineEdit>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button type="button" className={square} onClick={() => move(a, "up")} disabled={k === 0} aria-label={`Move ${a.name} up`} title={`Move ${a.name} up`} data-testid="activity-up"><ArrowUp size={16} aria-hidden="true" /></button>
                  <button type="button" className={square} onClick={() => move(a, "down")} disabled={k === ext.activities.length - 1} aria-label={`Move ${a.name} down`} title={`Move ${a.name} down`} data-testid="activity-down"><ArrowDown size={16} aria-hidden="true" /></button>
                  <button type="button" className={`${square} text-danger`} onClick={() => remove(a)} aria-label={`Remove ${a.name}`} title={`Remove ${a.name}`} data-testid="activity-remove"><Trash2 size={16} aria-hidden="true" /></button>
                </div>
              </div>
              <div className="mt-2">
                <p className="sr-only">Supplies for {a.name}:</p>
                <ul className="flex flex-wrap items-center gap-1.5" aria-label={`Supplies for ${a.name}`}>
                  {a.supplies.map(x => (
                    <li key={x} className="inline-flex min-h-11 items-center rounded-full bg-surface-muted pl-3 text-sm text-ink ring-1 ring-inset ring-line" data-testid="activity-supply">
                      {x}
                      <button type="button" onClick={() => upd(a, { supplies: a.supplies.filter(s2 => s2 !== x) }, `Remove ${x} from ${a.name}`)} aria-label={`Remove supply ${x} from ${a.name}`} title={`Remove ${x}`}
                        data-testid="activity-edit-supply-remove" className="grid h-11 w-11 place-items-center rounded-full text-ink-muted hover:bg-surface hover:text-ink"><X size={14} aria-hidden="true" /></button>
                    </li>
                  ))}
                  {a.supplies.length < ACTIVITY_LIMITS.maxSupplies && (
                    <li>
                      <form noValidate className="flex items-center gap-1" onSubmit={e => { e.preventDefault(); addSupply(a); }}>
                        <label htmlFor={`${formId}-sup-${a.id}`} className="sr-only">Add a supply to {a.name}</label>
                        <input id={`${formId}-sup-${a.id}`} value={supplyDraft[a.id] ?? ""} onChange={e => setSupplyDraft({ ...supplyDraft, [a.id]: e.target.value })} maxLength={ACTIVITY_LIMITS.supplyMax}
                          placeholder="Add a supply" data-testid="activity-edit-supply-input" aria-invalid={supplyError[a.id] ? true : undefined}
                          aria-describedby={supplyError[a.id] ? `${formId}-sup-err-${a.id}` : undefined}
                          className="h-11 w-36 rounded-full border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-muted" />
                        <button type="submit" aria-label={`Add supply to ${a.name}`} title="Add supply" data-testid="activity-edit-supply-add" className={`${square} rounded-full`}><Plus size={15} aria-hidden="true" /></button>
                      </form>
                    </li>
                  )}
                </ul>
                {supplyError[a.id] && <p id={`${formId}-sup-err-${a.id}`} role="alert" className="mt-1 text-sm font-medium text-danger">{supplyError[a.id]}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {ext.activities.length > 0 && !adding && <div className="mt-3">{addButton}</div>}
      {full && <p className="mt-2 text-sm text-ink-muted">The run-sheet holds up to {ACTIVITY_LIMITS.maxActivities} activities.</p>}
      {adding && (
        <form id={`${formId}-form`} onSubmit={submit} noValidate className="mt-3 grid gap-2 rounded-xl border border-dashed border-line-strong p-3 sm:grid-cols-2" aria-labelledby={`${formId}-h`} data-testid="activity-add-form">
          <h4 id={`${formId}-h`} className="text-sm font-semibold text-ink sm:col-span-2">Add an activity</h4>
          <label className="text-sm text-ink-muted sm:col-span-2">Activity
            <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={ACTIVITY_LIMITS.nameMax} data-testid="activity-add-name" aria-describedby={error ? `${formId}-err` : undefined} className={`${field} min-h-11`} autoFocus />
          </label>
          <label className="text-sm text-ink-muted">Minutes
            <input value={draft.minutes} onChange={e => setDraft({ ...draft, minutes: e.target.value })} inputMode="numeric" data-testid="activity-add-minutes" className={`${field} min-h-11`} />
          </label>
          <label className="text-sm text-ink-muted">Supplies (comma-separated, optional)
            <input value={draft.supplies} onChange={e => setDraft({ ...draft, supplies: e.target.value })} data-testid="activity-add-supplies" className={`${field} min-h-11`} />
          </label>
          <label className="text-sm text-ink-muted">Youngest age (optional)
            <input value={draft.ageMin} onChange={e => setDraft({ ...draft, ageMin: e.target.value })} inputMode="numeric" data-testid="activity-add-age-min" className={`${field} min-h-11`} />
          </label>
          <label className="text-sm text-ink-muted">Oldest age (optional)
            <input value={draft.ageMax} onChange={e => setDraft({ ...draft, ageMax: e.target.value })} inputMode="numeric" data-testid="activity-add-age-max" className={`${field} min-h-11`} />
          </label>
          {error && <p id={`${formId}-err`} role="alert" className="text-sm font-medium text-danger sm:col-span-2">{error}</p>}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <button type="submit" data-testid="activity-add-submit" className={`${big} bg-primary text-white hover:bg-primary-hover`}><Plus size={15} aria-hidden="true" /> Add to run-sheet</button>
            <button type="button" onClick={() => { setAdding(false); setError(null); }} data-testid="activity-add-cancel" className={`${big} border border-line-strong bg-surface text-ink hover:bg-surface-muted`}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

const TIER_TONE: Record<SponsorTier, Tone> = { title: "secondary", gold: "gold", silver: "neutral", in_kind: "info" };

/** Community: sponsors with tier, status, money received, AI pitch drafts and volunteer sign-ups. */
function SponsorPipeline({ plan, commit, highlight, onAsk }: SectionProps) {
  const hl = useHighlight(highlight);
  const ext = plan.event.ext;
  if (ext.type !== "community") return null;
  const pledged = ext.sponsors.reduce((a, s) => a + (s.status === "declined" ? 0 : s.pledgedPaise), 0);
  const received = ext.sponsors.reduce((a, s) => a + s.receivedPaise, 0);
  return (
    <div className="min-w-0">
      <SubHead icon={<Handshake size={16} className="text-brand-700" />} right={<>{inr(received)} received of {inr(pledged)} pledged</>}>Sponsor pipeline</SubHead>
      <ul className="space-y-2">
        {ext.sponsors.map(s => {
          const pct = s.pledgedPaise ? Math.min(100, (s.receivedPaise / s.pledgedPaise) * 100) : s.status === "paid" || s.status === "committed" ? 100 : 0;
          const prog = sponsorProgress(s);
          return (
            <li key={s.id} id={refAnchor(s.id)} className={`rounded-xl p-3 ring-1 ring-inset ring-line ${hl(s.id)}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold text-ink">{s.name}</span>
                <Badge tone={TIER_TONE[s.tier]}>{labelOf(SPONSOR_TIER_OPTIONS, s.tier)}</Badge>
                <span className="ml-auto flex flex-wrap items-center gap-2">
                  <select value={s.status} aria-label={`${s.name} status`}
                    onChange={e => commit({ summary: `${s.name} → ${e.target.value}`, commands: [{ op: "update_sponsor", sponsorId: s.id, status: e.target.value as (typeof SPONSOR_STATUS_OPTIONS)[number]["value"] }] })}
                    className={sel}>
                    {SPONSOR_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  <button type="button" onClick={() => onAsk(`Draft a sponsor pitch email for ${s.name}`)} aria-haspopup="dialog"
                    className="flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-white hover:bg-primary-hover max-md:min-h-11 pointer-coarse:min-h-11"><Sparkles size={15} aria-hidden="true" /> AI pitch<span className="sr-only"> for {s.name}</span></button>
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                {prog
                  ? <div role="progressbar" aria-label={prog.label} aria-valuemin={0} aria-valuemax={prog.valueMax} aria-valuenow={prog.valueNow} aria-valuetext={prog.valueText}
                      className="h-2.5 min-w-24 flex-1 overflow-hidden rounded-full bg-sand-100 ring-1 ring-inset ring-sand-400"><div className="h-full bg-emerald-600" style={{ width: `${pct}%` }} /></div>
                  : <div aria-hidden="true" className="h-2.5 min-w-24 flex-1 overflow-hidden rounded-full bg-sand-100 ring-1 ring-inset ring-sand-400"><div className="h-full bg-emerald-600" style={{ width: `${pct}%` }} /></div>}
                <span className="text-sm tabular-nums text-sand-700">{inr(s.receivedPaise)} / {s.pledgedPaise ? inr(s.pledgedPaise) : "in-kind"}</span>
              </div>
              {s.deliverables.length > 0 && <p className="mt-1.5 text-sm text-ink-muted">{s.deliverables.join(" · ")}</p>}
            </li>
          );
        })}
      </ul>
      {ext.volunteerSignups.length > 0 && (
        <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-200">
          <b>Volunteer sign-ups:</b> {ext.volunteerSignups.map(v => `${v.name}${v.shift ? ` (${v.shift})` : ""}`).join(", ")}
        </p>
      )}
    </div>
  );
}

/** Community: municipal permits with apply-by risk. */
function PermitTracker({ plan, today, commit, highlight }: SectionProps) {
  const hl = useHighlight(highlight);
  const ext = plan.event.ext;
  if (ext.type !== "community") return null;
  return (
    <div className="min-w-0">
      <SubHead icon={<ShieldCheck size={16} className="text-peacock-700" />}
        right={<span className="flex flex-wrap items-center gap-x-2"><span className="flex items-center gap-1"><Users size={14} aria-hidden="true" />{ext.volunteers} volunteers</span><span className="flex items-center gap-1"><Megaphone size={14} aria-hidden="true" />{ext.expectedFootfall.toLocaleString("en-IN")} footfall</span></span>}>Municipal permits</SubHead>
      <ul className="space-y-2">
        {ext.permits.map(p => {
          const d = p.applyBy ? daysBetween(today, p.applyBy) : null;
          const risk = p.status !== "approved" && d !== null && d <= 14;
          const late = d !== null && d < 0 && p.status === "not_started";
          return (
            <li key={p.id} id={refAnchor(p.id)} className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl p-3 ring-1 ring-inset ${p.status === "approved" ? "ring-emerald-300" : late ? "ring-red-300" : risk ? "ring-amber-300" : "ring-line"} ${hl(p.id)}`}>
              <Building2 size={18} aria-hidden="true" className="shrink-0 text-sand-600" />
              <div className="min-w-0 flex-1 basis-44">
                <p className="break-words text-base font-medium text-ink">{p.authority} · {p.kind}</p>
                <p className="text-sm tabular-nums text-ink-muted">
                  {p.applyBy ? <>apply by {longDate(p.applyBy)} <span className={late ? "font-semibold text-red-700" : risk ? "font-semibold text-amber-800" : ""}>({relDays(today, p.applyBy)}{late ? ", late" : risk ? ", soon" : ""})</span></> : "no deadline"}
                  {p.feePaise > 0 && <> · fee {inr(p.feePaise)}</>}{p.referenceNo && <> · ref <b>{p.referenceNo}</b></>}
                </p>
              </div>
              <select value={p.status} aria-label={`${p.authority} status`}
                onChange={e => commit({ summary: `${p.authority} ${p.kind} → ${e.target.value}`, commands: [{ op: "set_permit_status", permitId: p.id, status: e.target.value as (typeof PERMIT_STATUS_OPTIONS)[number]["value"] }] })}
                className={`${sel} ${p.status === "approved" ? "border-emerald-600 bg-emerald-50 text-emerald-900" : ""}`}>
                {PERMIT_STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The component for every section id a template can list. Keyed by the id union, so none can be missing. */
const SECTIONS: Record<OrganizerSectionId, ComponentType<SectionProps>> = {
  "couple-profile": CoupleProfile,
  "diet-summary": DietSummary,
  "wishlist-manager": WishlistManager,
  "activity-run-sheet": ActivityRunSheet,
  "sponsor-pipeline": SponsorPipeline,
  "permit-tracker": PermitTracker,
};

const ICONS: Record<EventTemplate["layout"]["icon"], ReactNode> = {
  heart: <Heart size={18} className="text-maroon-700" />,
  cake: <Cake size={18} className="text-brand-700" />,
  megaphone: <Megaphone size={18} className="text-peacock-700" />,
};
const ARRANGEMENT: Record<EventTemplate["layout"]["arrangement"], string> = {
  // Container queries: the card arranges by its own width (the /event page is full width, a phone is not).
  "main-aside": "grid gap-5 @3xl:grid-cols-[1fr_16rem] @6xl:grid-cols-[1fr_20rem]",
  "two-up": "grid gap-5 @3xl:grid-cols-2",
};

export default function ArchetypeCard({ template, ...props }: Props) {
  const { layout } = template;
  const ext = props.plan.event.ext;
  return (
    <Card id="event" title={formatTokens(layout.heading, templateTokens(props.plan))} icon={ICONS[layout.icon]} right={<Badge tone="secondary">event.ext · {ext.type}</Badge>}
      subtitle="The parts of the plan specific to this kind of event.">
      <div className="@container"><div className={ARRANGEMENT[layout.arrangement]}>
        {layout.columns.map((col, i) => (
          <div key={i} className="min-w-0 space-y-4">
            {col.map(id => { const Section = SECTIONS[id]; return <Section key={id} {...props} />; })}
          </div>
        ))}
      </div></div>
    </Card>
  );
}
