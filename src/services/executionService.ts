import { 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  Message,
  TextBasedChannel,
  EmbedBuilder
} from 'discord.js';
import * as dataStore from './dataStore.js';
import * as sessionManager from './sessionManager.js';
import * as serveManager from './serveManager.js';
import * as worktreeManager from './worktreeManager.js';
import { formatOutput, formatOutputForMobile, buildContextHeader } from '../utils/messageFormatter.js';
import { processNextInQueue } from './queueManager.js';

export async function runPrompt(
  channel: TextBasedChannel, 
  threadId: string, 
  prompt: string, 
  parentChannelId: string
): Promise<void> {
  const projectPath = dataStore.getChannelProjectPath(parentChannelId);
  if (!projectPath) {
    await (channel as any).send('❌ No project bound to parent channel.');
    return;
  }
  
  let worktreeMapping = dataStore.getWorktreeMapping(threadId);
  
  // Auto-create worktree if enabled and no mapping exists for this thread
  if (!worktreeMapping) {
    const projectAlias = dataStore.getChannelBinding(parentChannelId);
    if (projectAlias && dataStore.getProjectAutoWorktree(projectAlias)) {
      try {
        const branchName = worktreeManager.sanitizeBranchName(
          `auto/${threadId.slice(0, 8)}-${Date.now()}`
        );
        const worktreePath = await worktreeManager.createWorktree(projectPath, branchName);
        
        const newMapping = {
          threadId,
          branchName,
          worktreePath,
          projectPath,
          description: prompt.slice(0, 50) + (prompt.length > 50 ? '...' : ''),
          createdAt: Date.now()
        };
        dataStore.setWorktreeMapping(newMapping);
        worktreeMapping = newMapping;
        
        const embed = new EmbedBuilder()
          .setTitle(`🌳 Auto-Worktree: ${branchName}`)
          .setDescription('Automatically created for this session')
          .addFields(
            { name: 'Branch', value: branchName, inline: true },
            { name: 'Path', value: worktreePath, inline: true }
          )
          .setColor(0x2ecc71);
        
        const worktreeButtons = new ActionRowBuilder<ButtonBuilder>()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`delete_${threadId}`)
              .setLabel('Delete')
              .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
              .setCustomId(`pr_${threadId}`)
              .setLabel('Create PR')
              .setStyle(ButtonStyle.Primary)
          );
        
        await (channel as any).send({ embeds: [embed], components: [worktreeButtons] });
      } catch (error) {
        console.error('Auto-worktree creation failed:', error);
      }
    }
  }
  
  const effectivePath = worktreeMapping?.worktreePath ?? projectPath;
  const preferredModel = dataStore.getChannelModel(parentChannelId);
  const modelDisplay = preferredModel ? `${preferredModel}` : 'default';
  
  const branchName = worktreeMapping?.branchName ?? await worktreeManager.getCurrentBranch(effectivePath) ?? 'main';
  const contextHeader = buildContextHeader(branchName, modelDisplay);
  
  const buttons = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`interrupt_${threadId}`)
        .setLabel('⏸️ Interrupt')
        .setStyle(ButtonStyle.Secondary)
    );
  
  let streamMessage: Message;
  try {
    streamMessage = await (channel as any).send({
      content: `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n🚀 Starting Codex app-server...`,
      components: [buttons]
    });
  } catch {
    return;
  }
  
  let port: number;
  let sessionId: string;
  let turnId: string | undefined;
  let updateInterval: NodeJS.Timeout | null = null;
  let accumulatedText = '';
  let lastContent = '';
  let tick = 0;
  let promptSent = false;
  let hasSessionError = false;
  let finished = false;
  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  
  const updateStreamMessage = async (content: string, components: ActionRowBuilder<ButtonBuilder>[]): Promise<boolean> => {
    try {
      await streamMessage.edit({ content, components });
      return true;
    } catch (error) {
      console.error('Failed to edit stream message:', error instanceof Error ? error.message : error);
      return false;
    }
  };

  const safeSend = async (content: string): Promise<boolean> => {
    try {
      await (channel as any).send({ content });
      return true;
    } catch (error) {
      console.error('Failed to send message:', error instanceof Error ? error.message : error);
      return false;
    }
  };
  
  try {
    port = await serveManager.spawnServe(effectivePath, preferredModel);
    
    await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n⏳ Waiting for Codex app-server...`, [buttons]);
    await serveManager.waitForReady(port, 30000, effectivePath, preferredModel);
    
    const settings = dataStore.getQueueSettings(threadId);
    
    // If fresh context is enabled, we always clear the session before starting
    if (settings.freshContext) {
      sessionManager.clearSessionForThread(threadId);
    }

    sessionId = await sessionManager.ensureSessionForThread(threadId, effectivePath, port, preferredModel);
    const codexClient = sessionManager.getCodexClient(threadId);
    if (!codexClient) {
      throw new Error('Codex app-server client was not initialized');
    }

    codexClient.onTextDelta((deltaThreadId, text, deltaTurnId) => {
      if (deltaThreadId !== sessionId) return;
      if (turnId && deltaTurnId !== turnId) return;
      accumulatedText += text;
    });
    
    codexClient.onTurnCompleted((completedThreadId, completedTurnId, turnError) => {
      if (completedThreadId !== sessionId) return;
      if (turnId && completedTurnId !== turnId) return;
      if (!promptSent) return;
      if (finished) return;
      finished = true;
      
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }
      
      (async () => {
        try {
          const disabledButtons = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(`interrupt_${threadId}`)
                .setLabel('⏸️ Interrupt')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
            );

          if (turnError) {
            hasSessionError = true;
            const edited = await updateStreamMessage(
              `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n❌ **Error**: ${turnError.message}`,
              [disabledButtons]
            );
            if (!edited) {
              await safeSend(`❌ **Error**: ${turnError.message}`);
            }
          } else if (!accumulatedText.trim()) {
            const edited = await updateStreamMessage(
              `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n⚠️ No output received — the model may have encountered an issue.`,
              [disabledButtons]
            );
            if (!edited) {
              await safeSend('⚠️ No output received — the model may have encountered an issue.');
            }
            await safeSend('⚠️ Done (no output received)');
          } else {
            const result = formatOutputForMobile(accumulatedText);
            
            const editSuccess = await updateStreamMessage(
              `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n${result.chunks[0]}`,
              [disabledButtons]
            );
            
            // If edit failed (e.g., content exceeds Discord's 2000-char limit), send all chunks as new messages
            const startIndex = editSuccess ? 1 : 0;
            for (let i = startIndex; i < result.chunks.length; i++) {
              await safeSend(result.chunks[i]);
            }
            
            await safeSend('✅ Done');
          }
          
          codexClient.disconnect();
          sessionManager.clearCodexClient(threadId);
          sessionManager.clearActiveTurn(threadId);
          
          if (turnError) {
            const settings = dataStore.getQueueSettings(threadId);
            if (settings.continueOnFailure) {
              await processNextInQueue(channel, threadId, parentChannelId);
            } else {
              dataStore.clearQueue(threadId);
              await safeSend('❌ Execution failed. Queue cleared. Use `/queue settings` to change this behavior.');
            }
          } else {
            await processNextInQueue(channel, threadId, parentChannelId);
          }
        } catch (error) {
          console.error('Error in onSessionIdle:', error);
          await safeSend('❌ An unexpected error occurred while processing the response.');
        }
      })();
    });
    
    codexClient.onError((error) => {
      if (finished) return;
      finished = true;
      if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
      }
      
      (async () => {
        try {
          const edited = await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n❌ Connection error: ${error.message}`, []);
          if (!edited) {
            await safeSend(`❌ Connection error: ${error.message}`);
          }
          
          codexClient.disconnect();
          sessionManager.clearCodexClient(threadId);
          sessionManager.clearActiveTurn(threadId);
          
          const settings = dataStore.getQueueSettings(threadId);
          if (settings.continueOnFailure) {
            await processNextInQueue(channel, threadId, parentChannelId);
          } else {
            dataStore.clearQueue(threadId);
            await safeSend('❌ Execution failed. Queue cleared. Use `/queue settings` to change this behavior.');
          }
        } catch (handlerError) {
          console.error('Error in Codex app-server error handler:', handlerError);
          await safeSend('❌ An unexpected connection error occurred.');
        }
      })();
    });
    
    updateInterval = setInterval(async () => {
      tick++;
      try {
        const formatted = formatOutput(accumulatedText);
        const spinnerChar = spinner[tick % spinner.length];
        const newContent = formatted || 'Processing...';
        
        if (newContent !== lastContent || tick % 2 === 0) {
          lastContent = newContent;
          await updateStreamMessage(
            `${contextHeader}\n📌 **Prompt**: ${prompt}\n\n${spinnerChar} **Running...**\n${newContent}`,
            [buttons]
          );
        }
      } catch (error) {
        console.error('Error in stream update interval:', error instanceof Error ? error.message : error);
      }
    }, 1000);
    
    await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n📝 Sending prompt...`, [buttons]);
    turnId = await sessionManager.sendPrompt(port, sessionId, prompt, preferredModel);
    sessionManager.setActiveTurn(threadId, turnId);
    promptSent = true;
    
  } catch (error) {
    if (updateInterval) {
      clearInterval(updateInterval);
    }
    
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const edited = await updateStreamMessage(`${contextHeader}\n📌 **Prompt**: ${prompt}\n\n❌ Codex execution failed: ${errorMessage}`, []);
    if (!edited) {
      await safeSend(`❌ Codex execution failed: ${errorMessage}`);
    }
    
    const client = sessionManager.getCodexClient(threadId);
    if (client) {
      client.disconnect();
      sessionManager.clearCodexClient(threadId);
    }
    sessionManager.clearActiveTurn(threadId);
    
    const settings = dataStore.getQueueSettings(threadId);
    if (settings.continueOnFailure) {
      await processNextInQueue(channel, threadId, parentChannelId);
    } else {
      dataStore.clearQueue(threadId);
      await safeSend('❌ Execution failed. Queue cleared.');
    }
  }
}
