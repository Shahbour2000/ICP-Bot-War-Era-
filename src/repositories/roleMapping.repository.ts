import { RoleMapping } from '@prisma/client';
import { prisma } from '../database';

export class RoleMappingRepository {
  async listByGuildConfig(guildConfigId: string): Promise<RoleMapping[]> {
    return prisma.roleMapping.findMany({ where: { guildConfigId } });
  }

  async listEnabledByGuildConfig(guildConfigId: string): Promise<RoleMapping[]> {
    return prisma.roleMapping.findMany({ where: { guildConfigId, enabled: true } });
  }

  async getByType(guildConfigId: string, type: string): Promise<RoleMapping | null> {
    return prisma.roleMapping.findUnique({
      where: { guildConfigId_type: { guildConfigId, type } },
    });
  }

  async upsert(guildConfigId: string, type: string, discordRoleId: string | null): Promise<RoleMapping | null> {
    if (!discordRoleId) {
      return prisma.roleMapping
        .delete({ where: { guildConfigId_type: { guildConfigId, type } } })
        .catch(() => null);
    }
    return prisma.roleMapping.upsert({
      where: { guildConfigId_type: { guildConfigId, type } },
      update: { discordRoleId, enabled: true },
      create: { guildConfigId, type, discordRoleId },
    });
  }

  async setEnabled(guildConfigId: string, type: string, enabled: boolean): Promise<RoleMapping | null> {
    return prisma.roleMapping
      .update({ where: { guildConfigId_type: { guildConfigId, type } }, data: { enabled } })
      .catch(() => null);
  }
}
