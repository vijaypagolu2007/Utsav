// v8 Part 1: the links and prefilled WhatsApp text the organizer shares. Pure string building: the app never sends a
// message. A wa.me click-to-chat link opens WhatsApp with the text filled in, and the organizer taps send.
import type { AgentState } from "./schema";
import { waDigits } from "./phone";

/**
 * A guest link: the event's RSVP link (v8 Part 1c) or a Part 1 household link (it opens the same RSVP form); the server
 * tells them apart by the token. The token sits after "#", so browsers never send it to the server or in a Referer.
 */
export const privateLink = (origin: string, eventId: string, token: string) => `${origin}/guest/${encodeURIComponent(eventId)}#k=${token}`;
/** The group join link the organizer posts in a WhatsApp group. Anyone with it can only ask to be added. */
export const joinLink = (origin: string, eventId: string, token: string) => `${origin}/join/${encodeURIComponent(eventId)}?t=${token}`;

/** https://wa.me/<digits>?text=… for a known number, https://wa.me/?text=… (pick the chat in WhatsApp) otherwise. */
export function waLink(e164: string, text: string): string {
  const digits = e164 ? waDigits(e164) : "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

function hostsOf(plan: AgentState): string {
  const x = plan.event.ext;
  return x.type === "wedding" ? x.partners.filter(Boolean).join(" & ") : x.type === "birthday" ? x.honoree : x.organizer;
}

/** The invitation a household received with its own link (v8 Part 1; v8 Part 1b shares one RSVP link instead). */
export function inviteMessage(plan: AgentState, householdLabel: string, link: string): string {
  const hosts = hostsOf(plan);
  return `Namaste ${householdLabel}! You're invited to ${plan.event.title}${hosts ? ` (${hosts})` : ""}. ` +
    `Please RSVP for your household on your personal link: ${link}\nThis link is just for your household, so please don't forward it.`;
}

/**
 * v8 Part 1c: the message that goes with the event's one RSVP link (a WhatsApp group, a printed card): open it, fill in
 * the form for your family. Answers stay private.
 */
export function rsvpMessage(plan: AgentState, link: string): string {
  const hosts = hostsOf(plan);
  return `You're invited to ${plan.event.title}${hosts ? ` (${hosts})` : ""}! Please RSVP for your family here: ${link}\n` +
    `It takes a minute: your name, how many of you are coming, which functions and your meal. Only the hosts see your answers.`;
}

/** The message posted in a WhatsApp group with the join link. */
export function joinMessage(plan: AgentState, link: string): string {
  return `You're invited to ${plan.event.title}! Tap this link to add your name and household to the guest list: ${link}\n` +
    `Once the hosts approve it, they will share the RSVP link with you.`;
}
