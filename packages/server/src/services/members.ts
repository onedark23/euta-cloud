// Membership changes shared by invite / role change (PUT members), access-request approval, transfer
// and admin owner assignment. "A project keeps at least one owner" is checked here, under a row lock.
import type { ProjectRole } from '@euta-cloud/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { projectMembers } from '../db/schema.js';
import { AppError } from '../http.js';

export const lockProject = (tx: Tx, projectId: string) => tx.execute(sql`select id from projects where id = ${projectId} for update`);

/**
 * Active owners other than `exceptUserId`. Deactivated owners don't count: demoting or removing the
 * last active owner would leave the project ownerless (SPEC "소유자는 최소 1명").
 */
export async function otherActiveOwners(tx: Tx, projectId: string, exceptUserId: string): Promise<number> {
  const res = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from project_members m join users u on u.id = m.user_id
        where m.project_id = ${projectId} and m.role = 'owner' and u.status = 'active' and m.user_id <> ${exceptUserId}`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

const lastOwner = () => new AppError(409, 'LAST_OWNER', 'a project needs at least one owner — transfer ownership first');

export async function currentRole(tx: Tx, projectId: string, userId: string): Promise<ProjectRole | null> {
  const [cur] = await tx.select({ role: projectMembers.role }).from(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return (cur?.role as ProjectRole | undefined) ?? null;
}

/**
 * Insert or change a member's role (caller holds `lockProject`). Refuses to demote the last owner.
 * Returns the previous role (null = newly added).
 */
export async function setMemberRole(tx: Tx, projectId: string, userId: string, role: ProjectRole, addedBy: string | null): Promise<ProjectRole | null> {
  const prev = await currentRole(tx, projectId, userId);
  if (prev === 'owner' && role !== 'owner' && (await otherActiveOwners(tx, projectId, userId)) < 1) throw lastOwner();
  await tx
    .insert(projectMembers)
    .values({ projectId, userId, role, addedBy })
    .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { role } });
  return prev;
}

/** Remove a member (caller holds `lockProject`). Refuses to remove the last owner. Returns the removed role. */
export async function removeMember(tx: Tx, projectId: string, userId: string): Promise<ProjectRole | null> {
  const prev = await currentRole(tx, projectId, userId);
  if (!prev) return null;
  if (prev === 'owner' && (await otherActiveOwners(tx, projectId, userId)) < 1) throw lastOwner();
  await tx.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return prev;
}
