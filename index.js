import { ActivityType, Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
import { config, assertConfig } from './src/config.js';
import { commands, handleAutocomplete, handleCommand, restoreAutoplay } from './src/commands.js';
import { checkFfmpeg, players } from './src/player.js';

assertConfig();
checkFfmpeg();

// Guilds for slash commands, GuildVoiceStates to see who is in which voice
// channel and to join one. Neither is privileged, so there is nothing to
// switch on in the Developer Portal.
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.once(Events.ClientReady, async (c) => {
  console.log(`[music-bot] online as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
  if (config.activity) c.user.setActivity(config.activity, { type: ActivityType.Listening });

  // Global commands: new servers see them within an hour of inviting the bot.
  if (config.registerCommands) {
    try {
      await new REST().setToken(config.token).put(Routes.applicationCommands(c.user.id), { body: commands });
      console.log('[music-bot] slash commands registered');
    } catch (err) {
      console.error('[music-bot] failed to register commands:', err.message);
    }
  }

  await restoreAutoplay(c);
});

// Someone joined, left or moved: autoplay starts for the first listener and
// stops when the last one leaves, so an empty channel costs no bandwidth.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  players.get(newState.guild.id)?.updateListeners();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);
  } catch (err) {
    console.error('[music-bot] interaction error:', err);
    if (interaction.isRepliable()) {
      const reply = { content: 'Something went wrong. Please try again.', flags: MessageFlags.Ephemeral };
      await (interaction.replied || interaction.deferred ? interaction.followUp(reply) : interaction.reply(reply)).catch(() => {});
    }
  }
});

client.login(config.token).catch((error) => {
  if (String(error.code) === 'TokenInvalid' || String(error).includes('TOKEN_INVALID')) {
    console.error('[music-bot] Discord rejected DISCORD_TOKEN. Reset it at discord.com/developers, your app, Bot, Reset Token, paste the new one under Environment variables in the FadeHost panel, and restart.');
  } else {
    console.error(`[music-bot] Could not log in to Discord: ${error.message}`);
  }
  process.exit(1);
});

// The FadeHost runtime sends SIGTERM on stop, restart and redeploy: leave
// the voice channels cleanly so the bot does not linger in them.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[music-bot] ${signal} received, shutting down`);
    for (const player of players.values()) {
      player.autoplayChannel = null;
      player.leave();
    }
    client.destroy();
    process.exit(0);
  });
}
