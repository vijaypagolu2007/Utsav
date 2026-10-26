"use client";
// The event-type card: a generic frame that renders the sections the active template's layout lists
// (config/event-templates.ts). Each section is an ordinary component keyed by its id; configuration only picks and
// arranges them, so a new template reuses these instead of needing a fourth hand-built layout.
import { useId, useRef, useState, type ComponentType, type FormEvent, type ReactNode } from "react";
import { Building2, Cake, Check, ChevronDown, CircleHelp, ExternalLink, Eye, EyeOff, Gift, Handshake, Heart, Megaphone, Plus, ShieldCheck, Sparkles, Timer, Trash2, Users, X } from "lucide-react";
import ApprovalPreview from "./ApprovalPreview";
import type { AgentState, SponsorTier } from "@/schema";
import { daysBetween } from "@/commands";
import type { Commit, Highlight } from "./PlannerApp";
import { refAnchor } from "@/routes";
import { Badge, Card, Empty, IconButton, InlineEdit, inr, longDate, parseInline, relDays, saveWith, useElementWidth, useHighlight, type Tone } from "./ui";
import { sponsorProgress } from "@/budget-a11y";
import { formatTokens, templateTokens, type EventTemplate, type OrganizerSectionId } from "@/config/event-templates";
import { GUEST_RSVP_ANSWERS, labelOf, PERMIT_STATUS_OPTIONS, RSVP_CYCLE, RSVP_LABELS, SPONSOR_STATUS_OPTIONS, SPONSOR_TIER_OPTIONS } from "@/config/planner-options";

type SectionProps = { plan: AgentState; today: string; commit: Commit; highlight: Highlight; onAsk: (text: string) => void };
type Props = SectionProps & { template: EventTemplate };
const RSVP_STYLE: Record<string, string> = {
  yes: "bg-emerald-700 text-white", no: "bg-red-100 text-red-800 ring-1 ring-inset ring-red-300", maybe: "bg-amber-100 text-amber-900 ring-1 ring-inset ring-amber-300", invited: "bg-sand-100 text-sand-700 ring-1 ring-inset ring-sand-400",
};
// Each answer has an icon as well as a colour and a word.
const RSVP_ICON: Record<string, ReactNode> = { yes: <Check size={13} />, no: <X size={13} />, maybe: <CircleHelp size={13} />, invited: null };
const ANSWER_ON: Record<string, string> = { yes: "bg-emerald-700 text-white ring-emerald-700", maybe: "bg-amber-700 text-white ring-amber-700", no: "bg-red-700 text-white ring-red-700" };
/** The matrix needs about this much room; narrower containers (phones, the 1280px side column) get household cards. */
const MATRIX_MIN_PX = 600;

/**
 * Per-guest, per-sub-event RSVPs with tallies. Reads only guests and sub-events, so any event type can use it.
 * Wide containers get the matrix (one click cycles an answer); narrow ones get one collapsible card per household
 * with 44px Yes / Maybe / No buttons. Only one variant is rendered at a time; both send the same set_rsvp command.
 */
type Commit_ = SectionProps["commit"];
const renameGuest = (commit: Commit_, g: { id: string; name: string }) => (name: string) =>
  saveWith(commit, { summary: `Rename guest ${g.name}`, commands: [{ op: "rename_entity", kind: "guest", id: g.id, name }] });
const renameHousehold = (commit: Commit_, h: { id: string; label: string }) => (name: string) =>
  saveWith(commit, { summary: `Rename household ${h.label}`, commands: [{ op: "rename_entity", kind: "household", id: h.id, name }] });

function RsvpMatrix(props: SectionProps) {
  const { plan } = props;
  const box = useRef<HTMLDivElement>(null);
  const width = useElementWidth(box);
  const subs = plan.subEvents.filter(s => s.collectsRsvp).sort((a, b) => a.date.localeCompare(b.date));
  return (
    <div ref={box} className="min-w-0">
      {plan.guests.length === 0 ? <Empty>No guests yet. The plan is sized for {plan.event.guestCount} guests.</Empty>
        : width !== null && width < MATRIX_MIN_PX ? <RsvpHouseholds {...props} subs={subs} /> : <RsvpTable {...props} subs={subs} />}
    </div>
  );
}

type Sub = AgentState["subEvents"][number];
const tally = (plan: AgentState, sid: string, v: string) => plan.guests.filter(g => g.rsvp[sid] === v).length;

function RsvpTable({ plan, commit, highlight, subs }: SectionProps & { subs: Sub[] }) {
  const hl = useHighlight(highlight);
  const label = (v: keyof typeof RSVP_LABELS) => RSVP_LABELS[v];
  return (
    /* relative: absolutely-positioned sr-only text inside must be clipped by this scroller, not widen the page. */
    <div className="relative min-w-0 overflow-x-auto">
      <table className="w-full min-w-[36rem] border-separate border-spacing-y-1 text-sm">
        <thead>
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-ink-muted">
            <th scope="col" className="py-1 pr-2">Household · guest</th>
            {subs.map(s => <th scope="col" key={s.id} className="px-1 py-1 text-center">{s.name}</th>)}
          </tr>
        </thead>
        <tbody>
          {plan.households.map(h => {
            const gs = plan.guests.filter(g => g.householdId === h.id);
            if (!gs.length) return null;
            return [
              <tr key={h.id}><td colSpan={subs.length + 1} className="pt-3 text-sm font-semibold text-ink">
                <InlineEdit label={`household name ${h.label}`} value={h.label} onSave={renameHousehold(commit, h)}>
                  <span>{h.label} <span className="font-normal text-ink-muted">· {h.side}</span></span>
                </InlineEdit>
              </td></tr>,
              ...gs.map(g => (
                <tr key={g.id} id={refAnchor(g.id)} className={hl(g.id)}>
                  <th scope="row" className="py-0.5 pr-2 text-left font-normal text-sand-800">
                    <InlineEdit label={`guest name ${g.name}`} value={g.name} inputSize="w-44" onSave={renameGuest(commit, g)}>
                      <span>{g.name}{g.ageGroup !== "adult" && <span className="text-ink-muted"> ({g.ageGroup})</span>}{g.diet.length > 0 && <span className="ml-1 text-xs text-ink-muted">{g.diet.join(", ")}</span>}</span>
                    </InlineEdit>
                  </th>
                  {subs.map(s => {
                    const v = g.rsvp[s.id];
                    return (
                      <td key={s.id} className="px-1 py-0.5 text-center">
                        {v ? (
                          <button type="button" onClick={() => commit({ summary: `${g.name} · ${s.name}: ${RSVP_CYCLE[v]}`, commands: [{ op: "set_rsvp", guestId: g.id, subEvent: s.slug, answer: RSVP_CYCLE[v] }] })}
                            title={`Click to change to ${label(RSVP_CYCLE[v])}`}
                            className={`inline-flex min-h-8 w-20 items-center justify-center gap-1 rounded-md px-1 text-xs font-semibold capitalize ${RSVP_STYLE[v]}`}><span aria-hidden="true">{RSVP_ICON[v]}</span>{label(v)}<span className="sr-only">: {g.name}, {s.name}. Activate to change to {label(RSVP_CYCLE[v])}</span></button>
                        ) : <><span aria-hidden="true" className="text-ink-muted">—</span><span className="sr-only">not invited</span></>}
                      </td>
                    );
                  })}
                </tr>
              )),
            ];
          })}
        </tbody>
        <tfoot>
          <tr className="text-xs text-ink-muted">
            <th scope="row" className="pt-3 text-left font-semibold">Yes / No / Maybe / Pending</th>
            {subs.map(s => <td key={s.id} className="pt-3 text-center tabular-nums"><span className="font-semibold text-emerald-800">{tally(plan, s.id, "yes")}</span>/{tally(plan, s.id, "no")}/{tally(plan, s.id, "maybe")}/{tally(plan, s.id, "invited")}</td>)}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function RsvpHouseholds({ plan, commit, highlight, subs }: SectionProps & { subs: Sub[] }) {
  const hl = useHighlight(highlight);
  return (
    <div className="space-y-3">
      <ul aria-label="RSVP totals" className="grid gap-1.5 text-sm tabular-nums">
        {subs.map(s => (
          <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-lg bg-surface-muted px-3 py-1.5">
            <span className="font-medium text-ink">{s.name}</span>
            <span className="text-ink-muted"><span className="font-semibold text-emerald-800">{tally(plan, s.id, "yes")} yes</span> · {tally(plan, s.id, "no")} no · {tally(plan, s.id, "maybe")} maybe · {tally(plan, s.id, "invited")} pending</span>
          </li>
        ))}
      </ul>
      {plan.households.map(h => {
        const gs = plan.guests.filter(g => g.householdId === h.id);
        if (!gs.length) return null;
        const pending = gs.reduce((n, g) => n + subs.filter(s => g.rsvp[s.id] === "invited" || g.rsvp[s.id] === "maybe").length, 0);
        return (
          <details key={h.id} className="group rounded-xl border border-line">
            <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 hover:bg-sand-50 [&::-webkit-details-marker]:hidden">
              <ChevronDown size={18} aria-hidden="true" className="shrink-0 text-sand-600 transition-transform group-open:rotate-180" />
              <span className="min-w-0 flex-1"><span className="block text-base font-semibold text-ink">{h.label}</span>
                <span className="block text-sm text-ink-muted">{h.side} · {gs.length} guest{gs.length > 1 ? "s" : ""}</span></span>
              {pending > 0 ? <Badge tone="warning">{pending} to confirm</Badge> : <Badge tone="success"><Check size={12} aria-hidden="true" />All answered</Badge>}
            </summary>
            <div className="space-y-4 border-t border-line-soft px-3 py-3">
              {/* Controls can't live inside <summary>, so the household's rename sits at the top of its panel. */}
              <InlineEdit label={`household name ${h.label}`} value={h.label} onSave={renameHousehold(commit, h)}>
                <span className="text-sm text-ink-muted">Household: <span className="font-medium text-ink">{h.label}</span></span>
              </InlineEdit>
              {gs.map(g => (
                <div key={g.id} id={refAnchor(g.id)} className={hl(g.id)}>
                  <InlineEdit label={`guest name ${g.name}`} value={g.name} onSave={renameGuest(commit, g)}>
                    <p className="text-base font-medium text-ink">{g.name}{g.ageGroup !== "adult" && <span className="font-normal text-ink-muted"> ({g.ageGroup})</span>}</p>
                  </InlineEdit>
                  {g.diet.length > 0 && <p className="text-sm text-ink-muted">{g.diet.join(", ")}</p>}
                  <ul className="mt-2 space-y-2">
                    {subs.filter(s => g.rsvp[s.id]).map(s => {
                      const v = g.rsvp[s.id]!;
                      return (
                        <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                          <span className="text-sm text-sand-800">{s.name}{v === "invited" && <span className="text-ink-muted"> · pending</span>}</span>
                          <span role="group" aria-label={`${g.name}, ${s.name}`} className="flex gap-1.5">
                            {GUEST_RSVP_ANSWERS.map(a => (
                              <button key={a} type="button" aria-pressed={v === a}
                                onClick={() => commit({ summary: `${g.name} · ${s.name}: ${a}`, commands: [{ op: "set_rsvp", guestId: g.id, subEvent: s.slug, answer: a }] })}
                                className={`flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-lg px-2.5 text-sm font-semibold capitalize ring-1 ring-inset ${v === a ? ANSWER_ON[a] : "bg-surface text-sand-800 ring-sand-400 hover:bg-sand-100"}`}>
                                {v === a && <Check size={14} aria-hidden="true" />}{RSVP_LABELS[a]}
                              </button>
                            ))}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </details>
        );
      })}
    </div>
  );
}

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

/** Birthday: the timed party activity run-sheet. */
function ActivityRunSheet({ plan, highlight }: SectionProps) {
  const hl = useHighlight(highlight);
  const ext = plan.event.ext;
  if (ext.type !== "birthday") return null;
  return (
    <div className="min-w-0">
      <SubHead icon={<Timer size={16} className="text-peacock-700" />} right={<>Total run time <b className="text-ink">{ext.activities.reduce((x, a) => x + a.durationMin, 0)} min</b></>}>Party activity run-sheet</SubHead>
      {ext.activities.length === 0 ? <Empty>No activities yet.</Empty> : (
        <ul className="divide-y divide-line-soft rounded-xl ring-1 ring-inset ring-line">
          {ext.activities.map(a => (
            <li key={a.id} id={refAnchor(a.id)} className={`px-3 py-2.5 ${hl(a.id)}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-base font-medium text-ink">{a.name}</span>
                <span className="text-sm tabular-nums text-ink-muted">{a.durationMin} min · ages {a.ageRange ? `${a.ageRange[0]}–${a.ageRange[1]}` : "all"}</span>
              </div>
              {a.supplies.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1.5"><span className="sr-only">Supplies:</span>{a.supplies.map(x => <Badge key={x}>{x}</Badge>)}</div>}
            </li>
          ))}
        </ul>
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
  "rsvp-matrix": RsvpMatrix,
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
