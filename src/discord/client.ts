import { Client, GatewayIntentBits, Events, REST, Routes, Interaction } from 'discord.js';
import { config } from '../config';
import { logger } from '../utils/logger';

// Repositories
import { GuildConfigRepository } from '../repositories/guildConfig.repository';
import { MuRoleRepository } from '../repositories/muRole.repository';
import { LevelRoleRepository } from '../repositories/levelRole.repository';
import { UserLinkRepository } from '../repositories/userLink.repository';
import { RoleMappingRepository } from '../repositories/roleMapping.repository';
import { MessageTemplateRepository } from '../repositories/messageTemplate.repository';
import { ProfileFlairRepository } from '../repositories/profileFlair.repository';

// Services
import { WarEraClient } from '../warera/client';
import { WarEraService } from '../warera/service';
import { GuildConfigService } from '../services/guildConfig.service';
import { MuRoleService } from '../services/muRole.service';
import { RoleSyncService } from '../services/roleSync.service';
import { VerificationService } from '../services/verification.service';
import { RecruitmentService } from '../services/recruitment.service';
import { OperationService } from '../services/operation.service';
import { ReadinessService } from '../services/readiness.service';
import { VerificationManagementService } from '../services/verificationManagement.service';
import { RoleMappingService } from '../services/roleMapping.service';
import { MessageTemplateService } from '../services/messageTemplate.service';
import { ProfileFlairService } from '../services/profileFlair.service';

// Commands
import { UserCommands } from '../commands/user.commands';
import { AdminCommands } from '../commands/admin.commands';
import { ConfigCommands } from '../commands/config.commands';
import { RecruitmentCommands } from '../commands/recruitment.commands';
import { OperationCommands } from '../commands/operation.commands';
import { ReadinessCommands } from '../commands/readiness.commands';
import { VerificationManagementCommands } from '../commands/verificationManagement.commands';
import { AuditCommands } from '../commands/audit.commands';
import { OptimizeCommands } from '../commands/optimize.commands';
import { CommandRouter, getSlashCommandsDefinition } from '../commands';

// Jobs
import { startSyncJob } from '../jobs/sync.job';
import { startRecruitmentReminderJob } from '../jobs/recruitmentReminder.job';

export async function initDiscordBot(): Promise<Client> {
  logger.info('Initializing Discord bot client with MoD extensions...');

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
    ],
  });

  // 1. Dependency Injection Setup
  // Every service below is a SINGLE shared instance for the whole process — this is
  // correct multi-tenant design, not an anti-pattern: none of them hold any
  // guild-specific state in memory. Every method takes a guildId/guild/guildConfigId
  // parameter and reads that guild's own config/data fresh from the database on each
  // call, so Guild A's data can never leak into a call made for Guild B.
  const wareraClient = new WarEraClient();
  const wareraService = new WarEraService(wareraClient);

  const guildConfigRepo = new GuildConfigRepository();
  const muRoleRepo = new MuRoleRepository();
  const levelRoleRepo = new LevelRoleRepository();
  const userLinkRepo = new UserLinkRepository();
  const roleMappingRepo = new RoleMappingRepository();
  const messageTemplateRepo = new MessageTemplateRepository();
  const profileFlairRepo = new ProfileFlairRepository();

  const guildConfigService = new GuildConfigService(guildConfigRepo);
  const muRoleService = new MuRoleService(muRoleRepo, wareraService);
  const roleMappingService = new RoleMappingService(roleMappingRepo);
  const messageTemplateService = new MessageTemplateService(messageTemplateRepo);
  const profileFlairService = new ProfileFlairService(profileFlairRepo);

  const roleSyncService = new RoleSyncService(
    guildConfigRepo,
    muRoleRepo,
    levelRoleRepo,
    userLinkRepo,
    wareraService,
    roleMappingService,
    messageTemplateService
  );
  const verificationService = new VerificationService(userLinkRepo, wareraService);

  // New MoD Services
  const recruitmentService = new RecruitmentService(wareraService, roleMappingService);
  const operationService = new OperationService(wareraService, roleMappingService, messageTemplateService);
  const readinessService = new ReadinessService(wareraService, recruitmentService, roleMappingService);
  const verificationManagementService = new VerificationManagementService(guildConfigRepo, wareraService);

  // Command handlers
  const userCommands = new UserCommands(
    verificationService,
    roleSyncService,
    wareraService,
    guildConfigRepo,
    profileFlairService,
    messageTemplateService
  );
  const adminCommands = new AdminCommands(
    verificationService,
    roleSyncService,
    userLinkRepo,
    guildConfigRepo,
    muRoleRepo,
    levelRoleRepo,
    roleMappingService
  );
  const configCommands = new ConfigCommands(
    guildConfigService,
    guildConfigRepo,
    muRoleService,
    levelRoleRepo,
    roleMappingService,
    wareraService
  );

  // New MoD Command handlers
  const recruitmentCommands = new RecruitmentCommands(recruitmentService, guildConfigRepo, roleMappingService);
  const operationCommands = new OperationCommands(operationService, guildConfigRepo, roleMappingService);
  const readinessCommands = new ReadinessCommands(readinessService, guildConfigRepo, messageTemplateService, roleMappingService);
  const verificationManagementCommands = new VerificationManagementCommands(
    verificationManagementService,
    guildConfigRepo,
    roleMappingService
  );
  const auditCommands = new AuditCommands(muRoleRepo, guildConfigRepo, wareraService);
  const optimizeCommands = new OptimizeCommands();

  const commandRouter = new CommandRouter(
    userCommands,
    adminCommands,
    configCommands,
    recruitmentCommands,
    operationCommands,
    readinessCommands,
    verificationManagementCommands,
    auditCommands,
    optimizeCommands
  );

  // 2. Events Setup
  client.once(Events.ClientReady, async (readyClient) => {
    logger.info({ tag: readyClient.user.tag }, 'Discord Bot is logged in and ready');

    // Register slash commands
    try {
      const rest = new REST({ version: '10' }).setToken(config.discordToken);
      const commandsBody = getSlashCommandsDefinition();
      
      logger.info(`Registering ${commandsBody.length} application (/) commands...`);

      // Temporarily register commands per-guild during development for instant updates
      // Global commands (Routes.applicationCommands) take up to 1 hour to propagate to all servers.
      const guilds = readyClient.guilds.cache;
      for (const [guildId, guild] of guilds) {
        logger.info(`Registering commands instantly for guild: ${guild.name} (${guildId})`);
        await rest.put(
          Routes.applicationGuildCommands(config.discordClientId, guildId),
          { body: commandsBody }
        );
      }
      
      logger.info(`Successfully registered ${commandsBody.length} commands across ${guilds.size} guild(s).`);
    } catch (err) {
      logger.error({ error: (err as Error).message }, 'Failed to register slash commands');
    }

    // Start sync cron job (6-hourly)
    startSyncJob(readyClient, roleSyncService, userLinkRepo);

    // Start recruitment reminders cron job (daily)
    startRecruitmentReminderJob(readyClient, wareraService, recruitmentService, roleMappingService, messageTemplateService);
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    // Check for button interactions (Operation Available/Unavailable answers)
    if (interaction.isButton()) {
      const customId = interaction.customId;
      if (customId.startsWith('op_avail_') || customId.startsWith('op_unavail_')) {
        try {
          const operationId = customId.split('_').pop()!;
          const responseType = customId.startsWith('op_avail_') ? 'available' : 'unavailable';
          
          await operationService.recordResponse(operationId, interaction.user.id, responseType);
          await interaction.reply({
            content: `✅ Your availability has been recorded as **${responseType === 'available' ? 'Available' : 'Unavailable'}**. Thank you!`,
            ephemeral: true,
          });
        } catch (err) {
          logger.error({ error: (err as Error).message }, 'Failed to record operation response');
          await interaction.reply({
            content: '❌ Failed to save your response. Please try again.',
            ephemeral: true,
          }).catch(() => null);
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    try {
      await commandRouter.handleInteraction(interaction);
    } catch (err) {
      logger.error(
        {
          error: (err as Error).message,
          commandName: interaction.commandName,
          userId: interaction.user.id,
        },
        'Unhandled error in command router'
      );
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: '❌ An unexpected error occurred.', ephemeral: true }).catch(() => null);
      } else {
        await interaction.reply({ content: '❌ An unexpected error occurred.', ephemeral: true }).catch(() => null);
      }
    }
  });

  // Login
  try {
    await client.login(config.discordToken);
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to login to Discord');
    throw error;
  }

  return client;
}
