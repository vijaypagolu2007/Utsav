// v8 Part 2b: the pure core of useChatSession's transcript updates, kept free of React so it is easy to test.
import type { Role } from "@/commands";
import type { ChatMsg } from "../ChatSidebar";

/**
 * A new record with role `r`'s messages replaced by `f(old)`. It never mutates `prev` and makes no ids, so React
 * Strict Mode's double-invoked updaters give the same result.
 */
export const withTranscript = (prev: Record<Role, ChatMsg[]>, r: Role, f: (m: ChatMsg[]) => ChatMsg[]): Record<Role, ChatMsg[]> =>
  ({ ...prev, [r]: f(prev[r] ?? []) });
