import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { CommunityType } from '@prisma/client';
import { GuildConfigService } from '../services/guildConfig.service';
import { GuildConfigRepository } from '../repositories/guildConfig.repository';
import { MuRoleService } from '../services/muRole.service';
import { LevelRoleRepository } from '../repositories/levelRole.repository';
import { RoleMappingService, isValidRoleMappingType, ROLE_MAPPING_TYPES } from '../services/roleMapping.service';
import { WarEraService } from '../warera/service';
import { logger } from '../utils/logger';

/**
 * Maps every legacy named /config subcommand to its old GuildConfig column
 * (kept in sync for backward compatibility during the migration window) and
 * its new RoleMapping type (the value RoleSyncService actually reads).
 */
const LEGACY_ROLE_SUBCOMMANDS: Record<string, { field: string; type: string; label: string }> = {
  'citizen-role': { field: 'citizenRoleId', type: 'CITIZEN_GATE', label: '🇪🇬 Citizen Gate' },
  'officer-role': { field: 'officerRoleId', type: 'OFFICER', label: '🛡️ Officer' },
  'president-role': { field: 'presidentRoleId', type: 'PRESIDENT', label: '👑 Country President' },
  'vice-president-role': { field: 'vicePresidentRoleId', type: 'VICE_PRESIDENT', label: '🎖️ Vice President' },
  'congress-role': { field: 'congressRoleId', type: 'CONGRESS', label: '🏛️ Congress Member' },
  'war-role': { field: 'warRoleId', type: 'WAR_SPECIALIST', label: '⚔️ War Specialist' },
  'economy-role': { field: 'economyRoleId', type: 'ECONOMY_SPECIALIST', label: '🏭 Economy Specialist' },
  'hybrid-role': { field: 'hybridRoleId', type: 'HYBRID_SPECIALIST', label: '⚖️ Hybrid Specialist' },
  'trusted-role': { field: 'trustedRoleId', type: 'TRUSTED_GATE', label: '🤝 Trusted Gate' },
  'mu-commander-role': { field: 'muCommanderRoleId', type: 'MU_COMMANDER', label: '🎖️ MU Commander' },
  'mu-owner-role': { field: 'muOwnerRoleId', type: 'MU_OWNER', label: '👑 MU Owner' },
  'no-mu-role': { field: 'noMuRoleId', type: 'NO_MU', label: '⛺ No MU Yet' },
  'party-president-role': { field: 'partyPresidentRoleId', type: 'PARTY_PRESIDENT', label: '👑 Party President' },
  'party-treasurer-role': { field: 'partyTreasurerRoleId', type: 'PARTY_TREASURER', label: '💰 Party Treasurer' },
  'party-council-role': { field: 'partyCouncilRoleId', type: 'PARTY_COUNCIL', label: '🏛️ Party Council' },
  'party-member-role': { field: 'partyMemberRoleId', type: 'PARTY_MEMBER', label: '🎗️ Party Member' },
};

export class ConfigCommands {
  constructor(
    private readonly guildConfigService: GuildConfigService,
    private readonly guildConfigRepo: GuildConfigRepository,
    private readonly muRoleService: MuRoleService,
    private readonly levelRoleRepo: LevelRoleRepository,
    private readonly roleMappingService: RoleMappingService,
    private readonly wareraService: WarEraService
  ) {}

  /**
   * Handler for /config <subcommand>
   */
  async configureRoles(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);
    const guildId = interaction.guildId;

    if (!guildId) {
      await interaction.reply({ content: '❌ This command must be run inside a guild.', ephemeral: true });
      return;
    }

    // --- String-valued subcommands (not a Role option) — each is validated
    // against the live WarEra API before anything is saved. An invalid ID must
    // never overwrite the existing configuration.
    if (subcommand === 'party-id') {
      const partyId = interaction.options.getString('party-id', true).trim();
      logger.info({ guildId, subcommand, partyId }, 'Configuring WarEra Party ID');
      await interaction.deferReply({ ephemeral: true });
      try {
        const party = await this.wareraService.getParty(partyId);
        await this.guildConfigService.updateConfig(guildId, { partyId, partyName: party.name || null });
        await interaction.editReply({
          content: `✅ Successfully configured this server's WarEra Political Party to **${party.name || partyId}** (\`${partyId}\`). Only members of this party will receive party roles on sync.`,
        });
      } catch (error) {
        logger.error({ error: (error as Error).message, guildId, subcommand }, 'Failed to configure party ID — invalid ID, existing configuration left untouched');
        await interaction.editReply({
          content: `❌ Could not find a WarEra party with ID \`${partyId}\`. Your existing configuration was NOT changed. Double-check the ID and try again.`,
        });
      }
      return;
    }

    if (subcommand === 'country-id') {
      const countryId = interaction.options.getString('country-id', true).trim();
      logger.info({ guildId, subcommand, countryId }, 'Configuring WarEra country ID');
      await interaction.deferReply({ ephemeral: true });
      try {
        const country = await this.wareraService.getCountryById(countryId);
        await this.guildConfigService.updateConfig(guildId, { countryId, countryName: country.name || null });
        await interaction.editReply({
          content: `✅ Successfully configured this server's WarEra country to **${country.name}** (\`${countryId}\`). Government roles, citizen verification, and country rankings will now use this country.`,
        });
      } catch (error) {
        logger.error({ error: (error as Error).message, guildId, subcommand }, 'Failed to configure country ID — invalid ID, existing configuration left untouched');
        await interaction.editReply({
          content: `❌ Could not find a WarEra country with ID \`${countryId}\`. Your existing configuration was NOT changed. Double-check the ID and try again.`,
        });
      }
      return;
    }

    if (subcommand === 'mu-id') {
      const muId = interaction.options.getString('mu-id', true).trim();
      logger.info({ guildId, subcommand, muId }, 'Configuring WarEra MU ID');
      await interaction.deferReply({ ephemeral: true });
      try {
        const mu = await this.wareraService.getMu(muId);
        await this.guildConfigService.updateConfig(guildId, { muId, muName: mu.name || null });
        await interaction.editReply({
          content: `✅ Successfully configured this server's WarEra Military Unit to **${mu.name || muId}** (\`${muId}\`).`,
        });
      } catch (error) {
        logger.error({ error: (error as Error).message, guildId, subcommand }, 'Failed to configure MU ID — invalid ID, existing configuration left untouched');
        await interaction.editReply({
          content: `❌ Could not find a WarEra Military Unit with ID \`${muId}\`. Your existing configuration was NOT changed. Double-check the ID and try again.`,
        });
      }
      return;
    }

    if (subcommand === 'community') {
      const communityType = interaction.options.getString('type', true);
      const communityName = interaction.options.getString('name', false);
      logger.info({ guildId, subcommand, communityType, communityName }, 'Configuring community type/name');
      await interaction.deferReply({ ephemeral: true });
      try {
        await this.guildConfigService.updateConfig(guildId, {
          communityType: communityType as CommunityType,
          ...(communityName ? { communityName } : {}),
        });
        await interaction.editReply({
          content: `✅ Community type set to **${communityType}**${communityName ? ` (**${communityName}**)` : ''}.`,
        });
      } catch (error) {
        logger.error({ error: (error as Error).message, guildId, subcommand }, 'Failed to configure community');
        await interaction.editReply({ content: `❌ Configuration failed: ${(error as Error).message}` });
      }
      return;
    }

    if (subcommand === 'branding') {
      const logoUrl = interaction.options.getString('logo-url', false);
      const accentColor = interaction.options.getString('accent-color', false);
      const description = interaction.options.getString('description', false);
      if (!logoUrl && !accentColor && !description) {
        await interaction.reply({ content: '❌ Provide at least one of: logo-url, accent-color, description.', ephemeral: true });
        return;
      }
      logger.info({ guildId, subcommand }, 'Configuring branding');
      await interaction.deferReply({ ephemeral: true });
      try {
        await this.guildConfigService.updateConfig(guildId, {
          ...(logoUrl ? { logoUrl } : {}),
          ...(accentColor ? { accentColor } : {}),
          ...(description ? { description } : {}),
        });
        await interaction.editReply({ content: '✅ Branding updated successfully.' });
      } catch (error) {
        logger.error({ error: (error as Error).message, guildId, subcommand }, 'Failed to configure branding');
        await interaction.editReply({ content: `❌ Configuration failed: ${(error as Error).message}` });
      }
      return;
    }

    if (subcommand === 'role-mapping') {
      const type = interaction.options.getString('type', true);
      const role = interaction.options.getRole('role', true);
      if (!isValidRoleMappingType(type)) {
        await interaction.reply({
          content: `❌ Unknown role mapping type. Valid types: ${ROLE_MAPPING_TYPES.join(', ')}`,
          ephemeral: true,
        });
        return;
      }
      logger.info({ guildId, subcommand, type, roleId: role.id }, 'Configuring generic role mapping');
      await interaction.deferReply({ ephemeral: true });
      try {
        const config = await this.guildConfigRepo.getByGuildId(guildId);
        if (!config) {
          await interaction.editReply({ content: '❌ This guild has no configuration yet.' });
          return;
        }
        await this.roleMappingService.setMapping(config.id, type, role.id);
        await interaction.editReply({
          content: `✅ Successfully mapped **${type}** to <@&${role.id}> for this guild.`,
        });
      } catch (error) {
        logger.error({ error: (error as Error).message, guildId, subcommand }, 'Failed to configure role mapping');
        await interaction.editReply({ content: `❌ Configuration failed: ${(error as Error).message}` });
      }
      return;
    }

    // --- Legacy named role subcommands: dual-write old column + new RoleMapping ---
    const legacy = LEGACY_ROLE_SUBCOMMANDS[subcommand];
    if (!legacy) {
      await interaction.reply({ content: '❌ Invalid configuration field.', ephemeral: true });
      return;
    }

    const role = interaction.options.getRole('role', true);
    logger.info({ guildId, subcommand, roleId: role.id }, 'Configuring role field');
    await interaction.deferReply({ ephemeral: true });

    try {
      const config = await this.guildConfigService.updateConfig(guildId, { [legacy.field]: role.id });
      await this.roleMappingService.setMapping(config.id, legacy.type, role.id);

      await interaction.editReply({
        content: `✅ Successfully configured the **${legacy.label}** role to <@&${role.id}> for this guild.`,
      });
    } catch (error) {
      logger.error({ error: (error as Error).message, guildId, subcommand }, 'Failed in configureRoles');
      await interaction.editReply({
        content: `❌ Configuration failed: ${(error as Error).message}`,
      });
    }
  }

  /**
   * Handler for /mu-role <subcommand>
   */
  async configureMuRoles(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);
    const guildId = interaction.guildId;

    if (!guildId) {
      await interaction.reply({ content: '❌ This command must be run inside a guild.', ephemeral: true });
      return;
    }

    logger.info({ guildId, subcommand }, 'Configuring MU roles');

    if (subcommand === 'list') {
      await interaction.deferReply();
      try {
        const mappings = await this.muRoleService.listMuRoles(guildId);
        if (mappings.length === 0) {
          await interaction.editReply({ content: 'ℹ️ No Military Unit (MU) role mappings configured for this guild.' });
          return;
        }

        const muConfig = await this.guildConfigRepo.getByGuildId(guildId);
        const embed = new EmbedBuilder()
          .setTitle('🎖️ Military Unit (MU) Role Mappings')
          .setColor('#0099FF')
          .setDescription(
            mappings
              .map((m) => `• **${m.muName}** (ID: \`${m.muId}\`) ➡️ <@&${m.discordRoleId}>`)
              .join('\n')
          )
          .setTimestamp()
          .setFooter({ text: `${muConfig?.communityName || 'WarEra'} Roles Bot` });

        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        logger.error({ error: (error as Error).message, guildId }, 'Error listing MU roles');
        await interaction.editReply({ content: '❌ Failed to list MU roles.' });
      }
      return;
    }

    // Add or Remove requires deferReply (ephemeral)
    await interaction.deferReply({ ephemeral: true });

    try {
      const muId = interaction.options.getString('mu-id', true);

      if (subcommand === 'add') {
        const role = interaction.options.getRole('role', true);
        const mapping = await this.muRoleService.addMuRole(guildId, muId, role.id);

        await interaction.editReply({
          content: `✅ Mapped MU **${mapping.muName}** (ID: \`${muId}\`) to <@&${role.id}>.`,
        });
      } else if (subcommand === 'remove') {
        const deleted = await this.muRoleService.removeMuRole(guildId, muId);
        if (deleted) {
          await interaction.editReply({
            content: `✅ Removed MU role mapping for **${deleted.muName}** (ID: \`${muId}\`).`,
          });
        } else {
          await interaction.editReply({
            content: `❌ No MU role mapping found for ID \`${muId}\`.`,
          });
        }
      }
    } catch (error) {
      logger.error({ error: (error as Error).message, guildId, subcommand }, 'Error executing MU command');
      await interaction.editReply({
        content: `❌ MU configuration failed: ${(error as Error).message}`,
      });
    }
  }

  /**
   * Handler for /level-role <subcommand>
   */
  async configureLevelRoles(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand(true);
    const guildId = interaction.guildId;

    if (!guildId) {
      await interaction.reply({ content: '❌ This command must be run inside a guild.', ephemeral: true });
      return;
    }

    logger.info({ guildId, subcommand }, 'Configuring level roles');

    if (subcommand === 'list') {
      await interaction.deferReply();
      try {
        const mappings = await this.levelRoleRepo.listByGuild(guildId);
        if (mappings.length === 0) {
          await interaction.editReply({ content: 'ℹ️ No Level role mappings configured for this guild.' });
          return;
        }

        const levelConfig = await this.guildConfigRepo.getByGuildId(guildId);
        const embed = new EmbedBuilder()
          .setTitle('📈 Level Role Mappings')
          .setColor('#00FF66')
          .setDescription(
            mappings
              .map((m) => `• **Level ${m.minimumLevel}+** ➡️ <@&${m.discordRoleId}>`)
              .join('\n')
          )
          .setTimestamp()
          .setFooter({ text: `${levelConfig?.communityName || 'WarEra'} Roles Bot` });

        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        logger.error({ error: (error as Error).message, guildId }, 'Error listing level roles');
        await interaction.editReply({ content: '❌ Failed to list Level roles.' });
      }
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const minimumLevel = interaction.options.getInteger('minimum-level', true);

      if (subcommand === 'add') {
        const role = interaction.options.getRole('role', true);
        await this.levelRoleRepo.upsertLevelRole(guildId, minimumLevel, role.id);

        await interaction.editReply({
          content: `✅ Mapped Level **${minimumLevel}+** to <@&${role.id}>.`,
        });
      } else if (subcommand === 'remove') {
        const deleted = await this.levelRoleRepo.deleteLevelRole(guildId, minimumLevel);
        if (deleted) {
          await interaction.editReply({
            content: `✅ Removed Level role mapping for Level **${minimumLevel}**+.`,
          });
        } else {
          await interaction.editReply({
            content: `❌ No Level role mapping found for Level **${minimumLevel}**+.`,
          });
        }
      }
    } catch (error) {
      logger.error({ error: (error as Error).message, guildId, subcommand }, 'Error executing Level command');
      await interaction.editReply({
        content: `❌ Level configuration failed: ${(error as Error).message}`,
      });
    }
  }
}
