"use client";
// v8 Part 0c / 0d: deleting an event, Recently deleted (30 days), Restore and Delete forever, and what the planner does
// when another device deleted or restored an event. Moved out of PlannerApp in v8 Part 2, unchanged apart from writing
// storage right away (setStore(…, true)) whenever an event leaves or comes back, instead of after the save debounce.
import { useEffect, useRef, useState, type RefObject } from "react";
import type { useRouter } from "next/navigation";
import type { AgentState } from "@/schema";
import { type Store, historyOf } from "@/persistence";
import { isTemplateId, type TemplateId } from "@/config/event-templates";
import { isPristineSample, type FirstChoice } from "@/my-events";
import { loadSyncBase } from "@/cloud-sync";
import { isSetupPath, SETUP_PATH } from "@/routes";
import { afterDeleteTarget, canDelete, isSampleSlot, loadTrash, moveToTrash, purgeExpired, restoreFromTrash, saveTrash, TRASH_RETENTION_DAYS, type TrashItem } from "@/trash";
import type { useSharedEvent } from "../useSharedEvent";
import type { useCloudSync } from "../useCloudSync";
import type { ToastFn } from "./useToasts";

export type DeletionBridge = { onRemoteDelete: (k: string, at: number) => void; onRestoreFromCloud: (k: string, p: AgentState) => boolean };
type TrashDeps = {
  storeRef: RefObject<Store>;
  setStore: (s: Store, now?: boolean) => void;
  shared: Pick<ReturnType<typeof useSharedEvent>, "detach" | "attach">;
  cloud: Pick<ReturnType<typeof useCloudSync>, "markDeleted" | "markRestored" | "deleteForever">;
  account: string | null;
  firstChoice: FirstChoice | null;
  flash: (ids: string[]) => void;
  toast: ToastFn;
  dismissAction: (testId: string) => void;
  router: ReturnType<typeof useRouter>;
  pathRef: RefObject<string>;
  deletionRef: RefObject<DeletionBridge>;
};

export function useEventTrash({ storeRef, setStore, shared, cloud, account, firstChoice, flash, toast, dismissAction, router, pathRef, deletionRef }: TrashDeps) {
  // Items older than 30 days are purged when the planner opens; their cloud tombstones are removed once signed in.
  const [trashInit] = useState(() => purgeExpired(loadTrash(), Date.now()));
  const [trash, setTrashState] = useState<TrashItem[]>(trashInit.kept);
  const trashRef = useRef(trash);
  const setTrash = (items: TrashItem[]) => { trashRef.current = items; setTrashState(items); saveTrash(items); };
  useEffect(() => { if (trashInit.purged.length) saveTrash(trashInit.kept); }, [trashInit]);
  const purgedSent = useRef(false);
  const cloudDeleteForever = cloud.deleteForever;
  useEffect(() => {
    if (!account || purgedSent.current || !trashInit.purged.length) return;
    purgedSent.current = true;
    for (const i of trashInit.purged) if (!i.localOnly) void cloudDeleteForever(i.slot, i.eventId);
  }, [account, trashInit, cloudDeleteForever]);
  /** The decision on screen: delete one event, or delete a trashed one forever. `after` hears whether it was confirmed. */
  const [confirmState, setConfirm] = useState<{ kind: "delete"; slot: TemplateId; title: string; after?: (ok: boolean) => void } | { kind: "forever"; id: string; title: string } | null>(null);

  /**
   * Leave a slot whose event just went to the trash: another own event; after deleting a sample, the next sample still
   * listed; the setup form when the last own event went; and the setup form (which offers "Restore samples") when
   * nothing at all is left. v8 Part 0d: never a blank screen.
   */
  const afterRemoval = (s: Store, slot: TemplateId, wasSample: boolean): Store => {
    const target = afterDeleteTarget(s, slot, wasSample);
    if (target.kind !== "switch") {
      if (!isSetupPath(pathRef.current)) router.push(SETUP_PATH);
      // The active slot stays; when it was the deleted one it now holds its untouched sample, or (a deleted sample) a
      // placeholder that is never listed, shown or synced.
      return { ...s, byType: { ...s.byType, [s.active]: historyOf(s) } };
    }
    if (s.active !== slot) return s;
    const byType = { ...s.byType };
    delete byType[slot];
    return { ...s, active: target.slot, byType: { ...byType, [target.slot]: historyOf(s, target.slot) } };
  };
  const removeSlot = (slot: TemplateId, deletedAt: number, localOnly = false): TrashItem | null => {
    const s = storeRef.current;
    const h = historyOf(s, slot);
    const deleted = h.snaps[h.idx]!.plan;
    if (!canDelete(slot, deleted, s)) return null;
    const share = shared.detach(slot);
    const res = moveToTrash(s, slot, deletedAt, share);
    if (!res) return null;
    setStore(afterRemoval(res.store, slot, isSampleSlot(slot, deleted)), true);
    const item: TrashItem = localOnly ? { ...res.item, localOnly: true } : res.item;
    setTrash([item, ...trashRef.current.filter(i => i.id !== item.id)]);
    flash([]);
    return res.item;
  };
  const restoreEvent = (id: string): boolean => {
    const r = restoreFromTrash(storeRef.current, trashRef.current, id);
    if (!r.ok) { toast("rose", r.message); return false; }
    setStore(r.store, true);
    setTrash(r.items);
    if (r.item.share) shared.attach(r.item.slot, r.item.share);
    if (!r.item.localOnly) cloud.markRestored(r.item.slot, r.item.history.snaps[r.item.history.idx]!.plan);
    flash([]);
    toast("emerald", `Restored ${r.item.title}`);
    if (isSetupPath(pathRef.current)) router.push("/");
    return true;
  };
  /** Confirmed: the event moves to Recently deleted, the planner moves on, and a toast offers Undo for 10 s. */
  const deleteEvent = (slot: TemplateId) => {
    const s = storeRef.current;
    const h = historyOf(s, slot);
    const deleted = h.snaps[h.idx]!.plan;
    // v8 Part 0d: an untouched sample that never went to the account (no cloud copy known here, samples not loaded) is
    // only hidden on this device: no cloud write. Anything else, samples included, takes the Part 0c tombstone path.
    const localOnly = isPristineSample(slot, deleted) && !(account && (firstChoice === "samples" || loadSyncBase(account, slot)));
    const item = removeSlot(slot, Date.now(), localOnly);
    if (!item) { toast("rose", "That event is already deleted."); return; }
    if (!localOnly) cloud.markDeleted(slot, deleted);
    toast("slate", `Deleted ${item.title}. Restore it from Recently deleted in the event menu for ${TRASH_RETENTION_DAYS} days.`, undefined,
      { label: "Undo", onClick: () => { dismissAction(`undo-${item.id}`); restoreEvent(item.id); }, testId: `undo-${item.id}` });
  };
  const requestDelete = (slot: TemplateId, after?: (ok: boolean) => void) => {
    const h = historyOf(storeRef.current, slot);
    const p = h.snaps[h.idx]!.plan;
    if (!canDelete(slot, p, storeRef.current)) { after?.(false); toast("rose", "There is no event here to delete."); return; }
    setConfirm({ kind: "delete", slot, title: p.event.title, after });
  };
  const requestDeleteForever = (id: string) => {
    const item = trashRef.current.find(i => i.id === id);
    if (item) setConfirm({ kind: "forever", id, title: item.title });
  };
  const deleteForever = (id: string) => {
    const item = trashRef.current.find(i => i.id === id);
    if (!item) return;
    setTrash(trashRef.current.filter(i => i.id !== id));
    if (!item.localOnly) void cloud.deleteForever(item.slot, item.eventId);
    toast("slate", `${item.title} was deleted forever`);
  };
  const deletion: typeof deletionRef.current = {
    onRemoteDelete: (k, at) => {
      if (!isTemplateId(k)) return;
      const item = removeSlot(k, at);
      if (item) toast("slate", `${item.title} was deleted on another device. Restore it from Recently deleted in the event menu.`);
    },
    onRestoreFromCloud: (k, p) => {
      if (!isTemplateId(k)) return false;
      const item = trashRef.current.find(i => i.slot === k && i.eventId === p.event.id);
      const withCloud: TrashItem = item ? { ...item, history: { snaps: [...item.history.snaps, { plan: p, label: "Restored with the other device's edits" }], idx: item.history.snaps.length } }
        : { id: `${p.event.id}@cloud`, slot: k, eventId: p.event.id, title: p.event.title, eventType: p.event.eventType, deletedAt: Date.now(), history: { snaps: [{ plan: p, label: "Restored from the cloud" }], idx: 0 }, share: null };
      const items = [withCloud, ...trashRef.current.filter(i => i.id !== withCloud.id)];
      const r = restoreFromTrash(storeRef.current, items, withCloud.id);
      if (!r.ok) { toast("rose", r.message); return false; }
      setStore(r.store, true);
      setTrash(r.items);
      if (r.item.share) shared.attach(r.item.slot, r.item.share);
      toast("emerald", `Restored ${r.item.title} with the other device's edits`);
      return true;
    },
  };
  useEffect(() => { deletionRef.current = deletion; });
  return { trash, confirmState, setConfirm, requestDelete, requestDeleteForever, deleteForever, deleteEvent, restoreEvent };
}
