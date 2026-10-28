import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { config, isHttpUrl } from './config.js';
import { CHIME, playerFor, players, resolveSource, trackFromUrl } from './player.js';
import { getAutoplaySetting, setAutoplaySetting } from './store.js';

const command = (name, description) =>
  new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);

export const commands = [
  command('play', 'Play an audio link or radio stream in your voice channel.')
    .addStringOption((o) => o.setName('url').setDescription('A direct http or https link to an audio file or stream').setRequired(true)),
  command('radio', 'Play one of the radio stations set for this bot.')
    .addStringOption((o) => o.setName('station').setDescription('The station').setRequired(true).setAutocomplete(true)),
  command('testsound', 'Play a short chime to check that voice works.'),
  command('skip', 'Skip to the next track.'),
  command('pause', 'Pause playback.'),
  command('resume', 'Resume playback.'),
  command('stop', 'Stop, clear the queue and leave the voice channel.'),
  command('queue', 'Show what is playing and what is next.'),
  command('autoplay', 'Stay in a voice channel and play as soon as someone joins it.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('set')
        .setDescription('Pick the voice channel and what plays there while someone is in it.')
        .addChannelOption((o) => o.setName('channel').setDescription('The voice channel to stay in').addChannelTypes(ChannelType.GuildVoice).setRequired(true))
        .addStringOption((o) => o.setName('source').setDescription('A link or a station; leave empty for the test sound').setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('off').setDescription('Turn autoplay off and leave the channel.'))
    .addSubcommand((s) => s.setName('show').setDescription('Show where autoplay is on and what it plays.')),
].map((c) => c.toJSON());

const ephemeral = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

export async function handleAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const typed = String(focused.value).toLowerCase();
  const options = config.stations.map((s) => ({ name: s.name, value: s.name }));
  if (focused.name === 'source') options.unshift({ name: 'Test sound', value: 'testsound' });
  return interaction.respond(
    options
      .filter((o) => o.name.toLowerCase().includes(typed))
      .slice(0, 25)
      .map((o) => ({ name: o.name.slice(0, 100), value: o.value.slice(0, 100) })),
  );
}

export async function handleCommand(interaction) {
  const { commandName } = interaction;
  if (commandName === 'play' || commandName === 'radio' || commandName === 'testsound') return enqueue(interaction);
  if (commandName === 'autoplay') return autoplay(interaction);

  const player = players.get(interaction.guildId);
  if (!player?.connection) return ephemeral(interaction, 'I am not in a voice channel. Use /play to start.');

  switch (commandName) {
    case 'skip':
      return player.skip() ? interaction.reply('Skipped.') : ephemeral(interaction, 'Nothing is playing.');
    case 'pause':
      player.pausedForEmpty = false;
      return player.audio.pause() ? interaction.reply('Paused. Use /resume to carry on.') : ephemeral(interaction, 'Nothing is playing.');
    case 'resume':
      return player.audio.unpause() ? interaction.reply('Resumed.') : ephemeral(interaction, 'Nothing is paused.');
    case 'stop':
      player.stop();
      return interaction.reply(player.autoplayChannel ? 'Stopped and cleared the queue. Autoplay carries on while someone is in the channel.' : 'Stopped, cleared the queue and left the channel.');
    case 'queue':
      return interaction.reply({ content: player.queueText(), allowedMentions: { parse: [] } });
    default:
      return ephemeral(interaction, 'Unknown command.');
  }
}

/** /play, /radio and /testsound: find the track, join the member's channel, queue it. */
async function enqueue(interaction) {
  const channel = interaction.member?.voice?.channel;
  if (!channel) return ephemeral(interaction, 'Join a voice channel first, then try again.');

  const existing = players.get(interaction.guildId);
  if (existing?.autoplayChannel && existing.autoplayChannel.id !== channel.id) {
    return ephemeral(interaction, `Autoplay keeps me in ${existing.autoplayChannel}. Join that channel to queue something, or turn autoplay off with /autoplay off.`);
  }

  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
    return ephemeral(interaction, `I need the Connect and Speak permissions in ${channel} to play there.`);
  }

  let track = CHIME;
  if (interaction.commandName === 'play') {
    const url = interaction.options.getString('url', true).trim();
    if (!isHttpUrl(url)) return ephemeral(interaction, 'That is not a link I can play. Use a direct http or https link to an audio file or stream.');
    track = trackFromUrl(url);
  } else if (interaction.commandName === 'radio') {
    const name = interaction.options.getString('station', true).trim();
    const station = config.stations.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!station) {
      return ephemeral(
        interaction,
        config.stations.length > 0
          ? `There is no station called ${name}. Pick one from the list.`
          : 'No radio stations are set yet. Add them as RADIO_STATIONS in the FadeHost panel, for example: Lofi|https://example.com/stream.mp3',
      );
    }
    track = trackFromUrl(station.url, station.name);
  }

  await interaction.deferReply();
  const player = playerFor(interaction.guild);
  player.textChannel = interaction.channel;
  try {
    await player.join(channel);
  } catch (err) {
    return interaction.editReply(err.message);
  }
  const place = player.enqueue(track);
  return interaction.editReply({
    content: place === 0 ? `Playing **${track.title}** in ${channel}.` : `Queued **${track.title}**, number ${place} in the queue.`,
    allowedMentions: { parse: [] },
  });
}

/** /autoplay set, off and show. Settings are saved, so they survive restarts and redeploys. */
async function autoplay(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'show') {
    const player = players.get(interaction.guildId);
    if (!player?.autoplayChannel) return ephemeral(interaction, 'Autoplay is off. Turn it on with /autoplay set.');
    return ephemeral(interaction, `Autoplay is on in ${player.autoplayChannel}: **${player.autoplay.title}** plays while someone is in the channel, and nothing streams when it is empty.`);
  }

  if (sub === 'off') {
    await setAutoplaySetting(interaction.guildId, false);
    players.get(interaction.guildId)?.clearAutoplay();
    return ephemeral(interaction, 'Autoplay is off and I left the channel.');
  }

  const channel = interaction.options.getChannel('channel', true);
  const source = interaction.options.getString('source') ?? '';
  const track = resolveSource(source);
  if (!track) {
    return ephemeral(interaction, 'The source has to be a direct http or https link, the name of a station from /radio, or empty for the test sound.');
  }
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
    return ephemeral(interaction, `I need the View Channel, Connect and Speak permissions in ${channel}.`);
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await setAutoplaySetting(interaction.guildId, { channelId: channel.id, source });
  const player = playerFor(interaction.guild);
  try {
    await player.setAutoplay(channel, track);
  } catch (err) {
    return interaction.editReply(`Saved, but I could not join ${channel} yet: ${err.message} I will keep trying.`);
  }
  return interaction.editReply({
    content: `Autoplay is on. I stay in ${channel} and play **${track.title}** as soon as someone joins. When the channel is empty, nothing streams.`,
    allowedMentions: { parse: [] },
  });
}

/** On start: autoplay where /autoplay set it, else where AUTOJOIN_CHANNEL_ID points. */
export async function restoreAutoplay(client) {
  for (const guild of client.guilds.cache.values()) {
    const saved = await getAutoplaySetting(guild.id);
    if (saved === false) continue; // turned off with /autoplay off
    let channelId = saved?.channelId;
    let source = saved?.source;
    if (!saved && config.autojoinChannelId && guild.channels.cache.has(config.autojoinChannelId)) {
      channelId = config.autojoinChannelId;
      source = config.autoplay;
    }
    if (!channelId) continue;

    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) {
      console.error(`[music-bot] ${guild.name}: the autoplay channel ${channelId} is not a voice channel I can see. Set it again with /autoplay set.`);
      continue;
    }
    let track = resolveSource(source);
    if (!track) {
      console.error(`[music-bot] ${guild.name}: autoplay source "${source}" is not a link, a station from RADIO_STATIONS or testsound. Using the test sound.`);
      track = CHIME;
    }
    await playerFor(guild)
      .setAutoplay(channel, track)
      .catch((err) => console.error(`[music-bot] ${guild.name}: ${err.message}`));
  }
}
