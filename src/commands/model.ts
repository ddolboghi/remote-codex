import { 
  SlashCommandBuilder, 
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  MessageFlags,
  ThreadChannel
} from 'discord.js';
import * as dataStore from '../services/dataStore.js';
import type { Command } from './index.js';
import { sanitizeModel } from '../utils/stringUtils.js';
import * as serveManager from '../services/serveManager.js';
import { CodexAppClient } from '../services/codexAppClient.js';

let cachedModels: string[] = [];
let cacheTimestamp = 0;
let refreshInFlight: Promise<string[]> | null = null;
const CACHE_TTL_MS = 30_000;

async function fetchModels(projectPath = process.cwd()): Promise<string[]> {
  const port = await serveManager.spawnServe(projectPath);
  await serveManager.waitForReady(port, 30000, projectPath);

  const client = new CodexAppClient(port);
  try {
    await client.connect();
    return (await client.listModels()).map(sanitizeModel).filter(m => m);
  } finally {
    client.disconnect();
  }
}

export async function getCachedModels(projectPath?: string): Promise<string[]> {
  const now = Date.now();
  if (now - cacheTimestamp > CACHE_TTL_MS || cachedModels.length === 0) {
    if (!refreshInFlight) {
      refreshInFlight = fetchModels(projectPath)
        .then((models) => {
          cachedModels = models;
          cacheTimestamp = Date.now();
          return models;
        })
        .finally(() => {
          refreshInFlight = null;
        });
    }
    return refreshInFlight;
  }
  return cachedModels;
}

function getEffectiveChannelId(interaction: ChatInputCommandInteraction): string {
  const channel = interaction.channel;
  if (channel?.isThread()) {
    return (channel as ThreadChannel).parentId ?? interaction.channelId;
  }
  return interaction.channelId;
}

export const model: Command = {
  data: new SlashCommandBuilder()
    .setName('model')
    .setDescription('Manage AI models for the current channel')
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('List all available models'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Set the model to use in this channel')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('The Codex model name (e.g., gpt-5.5)')
            .setRequired(true)
            .setAutocomplete(true))) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'list') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const channelId = getEffectiveChannelId(interaction);
        const projectPath = dataStore.getChannelProjectPath(channelId);
        const models = await getCachedModels(projectPath);
        
        if (models.length === 0) {
          await interaction.editReply('No models found.');
          return;
        }

        // Group models by provider
        const groups: Record<string, string[]> = {};
        for (const m of models) {
          const provider = m.includes('/') ? m.split('/')[0] : 'codex';
          if (!groups[provider]) groups[provider] = [];
          groups[provider].push(m);
        }

        let response = '### 🤖 Available Models\n\n';
        let isFirstMessage = true;

        for (const [provider, providerModels] of Object.entries(groups)) {
          const providerBlock = `**${provider}**\n` +
            providerModels.map(m => `• \`${m}\``).join('\n') + '\n\n';

          if (response.length + providerBlock.length > 1800 && response.length > 0) {
            if (isFirstMessage) {
              await interaction.editReply(response);
              isFirstMessage = false;
            } else {
              await interaction.followUp({ content: response, flags: MessageFlags.Ephemeral });
            }
            response = '';
          }

          response += providerBlock;
        }

        if (response) {
          if (isFirstMessage) {
            await interaction.editReply(response);
          } else {
            await interaction.followUp({ content: response, flags: MessageFlags.Ephemeral });
          }
        }
      } catch (error) {
        console.error('Failed to list models:', error);
        await interaction.editReply('❌ Failed to retrieve models from Codex app-server.');
      }
    } else if (subcommand === 'set') {
      const modelName = interaction.options.getString('name', true);
      const channelId = getEffectiveChannelId(interaction);
      
      const projectAlias = dataStore.getChannelBinding(channelId);
      if (!projectAlias) {
        await interaction.reply({
          content: '❌ No project bound to this channel. Use `/use <alias>` first.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const availableModels = await getCachedModels(dataStore.getChannelProjectPath(channelId));
        if (availableModels.length > 0 && !availableModels.includes(modelName)) {
          await interaction.editReply(
            `❌ Model \`${modelName}\` not found.\nUse \`/model list\` to see available models.`
          );
          return;
        }
      } catch {
        console.warn('[model] Could not validate model name against Codex app-server models');
      }

      dataStore.setChannelModel(channelId, modelName);
      
      await interaction.editReply(
        `✅ Model for this channel set to \`${modelName}\`.\nSubsequent commands will use this model.`
      );
    }
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const models = await getCachedModels();

    const filtered = models
      .filter(m => m.toLowerCase().includes(focused))
      .slice(0, 25);

    try {
      await interaction.respond(
        filtered.map(m => ({ name: m, value: m }))
      );
    } catch { }
  }
};
