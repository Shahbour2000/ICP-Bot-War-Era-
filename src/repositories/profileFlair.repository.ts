import { ProfileFlair, ProfileFlairTriggerType } from '@prisma/client';
import { prisma } from '../database';

export type ProfileFlairWithTargets = ProfileFlair & {
  userTargets: { wareraUserId: string }[];
  muTargets: { muId: string }[];
};

export class ProfileFlairRepository {
  /** Always scoped by guildConfigId from the start — never fetched globally and filtered later. */
  async listEnabledByGuildConfig(guildConfigId: string): Promise<ProfileFlairWithTargets[]> {
    const rows = await prisma.profileFlair.findMany({
      where: { guildConfigId, enabled: true },
      orderBy: { priority: 'asc' },
      include: { userTargets: true, muTargets: true },
    });
    return rows as unknown as ProfileFlairWithTargets[];
  }

  async listAllByGuildConfig(guildConfigId: string): Promise<ProfileFlairWithTargets[]> {
    const rows = await prisma.profileFlair.findMany({
      where: { guildConfigId },
      orderBy: { priority: 'asc' },
      include: { userTargets: true, muTargets: true },
    });
    return rows as unknown as ProfileFlairWithTargets[];
  }

  /** Fetches a flair scoped to a specific guildConfigId — a bare flairId is never trusted alone. */
  async getByIdForGuild(guildConfigId: string, flairId: string): Promise<ProfileFlairWithTargets | null> {
    return prisma.profileFlair.findFirst({
      where: { id: flairId, guildConfigId },
      include: { userTargets: true, muTargets: true },
    });
  }

  async create(
    guildConfigId: string,
    data: { name: string; triggerType: ProfileFlairTriggerType; displayText: string; priority?: number },
    targetIds: string[]
  ): Promise<ProfileFlairWithTargets> {
    return prisma.profileFlair.create({
      data: {
        guildConfigId,
        name: data.name,
        triggerType: data.triggerType,
        displayText: data.displayText,
        priority: data.priority ?? 0,
        ...(data.triggerType === 'SPECIFIC_USERS'
          ? { userTargets: { create: targetIds.map((id) => ({ wareraUserId: id })) } }
          : { muTargets: { create: targetIds.map((id) => ({ muId: id })) } }),
      },
      include: { userTargets: true, muTargets: true },
    });
  }

  async update(
    guildConfigId: string,
    flairId: string,
    data: { name?: string; displayText?: string; priority?: number; enabled?: boolean },
    targetIds?: string[]
  ): Promise<ProfileFlairWithTargets | null> {
    // Read first only to know triggerType (needed to pick which target table to
    // touch) — the actual MUTATION below is what must be atomic-and-scoped, and it is.
    const existing = await this.getByIdForGuild(guildConfigId, flairId);
    if (!existing) return null;

    try {
      await prisma.$transaction(async (tx) => {
        // Single atomic statement: UPDATE ... WHERE id = ? AND guildConfigId = ?.
        // If another guild's ID were ever passed in, count would be 0 and we abort
        // the whole transaction — no window where a write could land on the wrong
        // guild's row.
        const result = await tx.profileFlair.updateMany({
          where: { id: flairId, guildConfigId },
          data,
        });
        if (result.count === 0) {
          throw new Error('Flair not found for this guild — aborting transaction');
        }

        if (targetIds) {
          if (existing.triggerType === 'SPECIFIC_USERS') {
            await tx.profileFlairUserTarget.deleteMany({ where: { flairId } });
            await tx.profileFlairUserTarget.createMany({
              data: targetIds.map((id) => ({ flairId, wareraUserId: id })),
            });
          } else {
            await tx.profileFlairMuTarget.deleteMany({ where: { flairId } });
            await tx.profileFlairMuTarget.createMany({ data: targetIds.map((id) => ({ flairId, muId: id })) });
          }
        }
      });
    } catch {
      return null;
    }

    return this.getByIdForGuild(guildConfigId, flairId);
  }

  /**
   * Atomic, guild-scoped delete: a single DELETE ... WHERE id = ? AND
   * guildConfigId = ? statement. No separate existence check beforehand — that
   * would leave a race window between "check" and "delete" where the row could
   * theoretically be reassigned or the check could go stale. deleteMany's
   * compound where clause makes the whole thing one atomic operation, and the
   * cascade (onDelete: Cascade on the target tables) removes the user/MU
   * targets in the same statement.
   */
  async delete(guildConfigId: string, flairId: string): Promise<boolean> {
    const result = await prisma.profileFlair.deleteMany({ where: { id: flairId, guildConfigId } });
    return result.count > 0;
  }
}
