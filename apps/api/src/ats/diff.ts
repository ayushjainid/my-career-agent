// Compares a fresh board fetch with what is stored, so ingestion writes only what changed.

import type { NormalizedJob } from "@my-career-agent/core";

export interface StoredJobKey {
  atsJobId: string;
  status: "open" | "closed" | "stale";
  firstSeenAt: string;
}

export interface BoardDiff {
  added: NormalizedJob[];
  stillOpen: NormalizedJob[];
  reopened: NormalizedJob[];
  closedIds: string[];
  staleIds: string[];
}

/** Jobs open longer than this are flagged stale (possible ghost or evergreen postings). */
export const STALE_AFTER_DAYS = 60;

export function diffBoard(fresh: NormalizedJob[], stored: StoredJobKey[], now: Date = new Date()): BoardDiff {
  const byId = new Map(stored.map((s) => [s.atsJobId, s]));
  const freshIds = new Set<string>();
  const out: BoardDiff = { added: [], stillOpen: [], reopened: [], closedIds: [], staleIds: [] };

  for (const job of fresh) {
    if (freshIds.has(job.atsJobId)) continue; // dedupe within one response
    freshIds.add(job.atsJobId);
    const prev = byId.get(job.atsJobId);
    if (!prev) out.added.push(job);
    else if (prev.status === "closed") out.reopened.push(job);
    else {
      out.stillOpen.push(job);
      const ageDays = (now.getTime() - Date.parse(prev.firstSeenAt)) / 86_400_000;
      if (prev.status === "open" && ageDays > STALE_AFTER_DAYS) out.staleIds.push(job.atsJobId);
    }
  }
  for (const s of stored) if (s.status !== "closed" && !freshIds.has(s.atsJobId)) out.closedIds.push(s.atsJobId);
  return out;
}
