import { MessageTemplate } from '@prisma/client';
import { prisma } from '../database';

export class MessageTemplateRepository {
  async listByGuildConfig(guildConfigId: string): Promise<MessageTemplate[]> {
    return prisma.messageTemplate.findMany({ where: { guildConfigId } });
  }

  async getByKey(guildConfigId: string, key: string): Promise<MessageTemplate | null> {
    return prisma.messageTemplate.findUnique({
      where: { guildConfigId_key: { guildConfigId, key } },
    });
  }

  async upsert(guildConfigId: string, key: string, content: string | null): Promise<MessageTemplate | null> {
    if (!content) {
      return prisma.messageTemplate
        .delete({ where: { guildConfigId_key: { guildConfigId, key } } })
        .catch(() => null);
    }
    return prisma.messageTemplate.upsert({
      where: { guildConfigId_key: { guildConfigId, key } },
      update: { content },
      create: { guildConfigId, key, content },
    });
  }
}
