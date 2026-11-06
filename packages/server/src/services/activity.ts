// Activity log + change feed in one call, inside the caller's transaction.
// Never pass credential values here — names only (SPEC 테스트 계정 "값 없이").
import type { DbOrTx } from '../db/index.js';
import { activity } from '../db/schema.js';
import type { Actor } from './access.js';
import type { ChangeFeed } from './feed.js';

export interface ActivityEntry {
  projectId: string;
  kind: string;
  summary: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  /** Extra data for the change-feed event (default: target + details). */
  feedData?: Record<string, unknown>;
}

export async function record(tx: DbOrTx, feed: ChangeFeed, actor: Actor, e: ActivityEntry): Promise<number> {
  await tx.insert(activity).values({
    projectId: e.projectId,
    actorType: actor.type,
    actorId: actor.id,
    actorLabel: actor.label,
    kind: e.kind,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    summary: e.summary,
    details: e.details ?? {},
  });
  return feed.append(tx, e.projectId, e.kind, actor.id, {
    ...(e.targetType ? { targetType: e.targetType, targetId: e.targetId } : {}),
    ...(e.feedData ?? e.details ?? {}),
  });
}
