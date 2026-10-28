// Environment-driven configuration. Every setting is an environment variable
// you can change in the FadeHost panel (your bot, then Environment variables).

/** Whether a value is an http or https link. Nothing else is handed to FFmpeg. */
export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** "Name|link, Name|link" into [{ name, url }]. Entries without both parts are skipped. */
function parseStations(value) {
  const stations = [];
  const skipped = [];
  for (const entry of (value || '').split(/[\n,]/).map((e) => e.trim()).filter(Boolean)) {
    const bar = entry.indexOf('|');
    const name = bar > 0 ? entry.slice(0, bar).trim() : '';
    const url = bar > 0 ? entry.slice(bar + 1).trim() : '';
    if (name && isHttpUrl(url)) stations.push({ name, url });
    else skipped.push(entry);
  }
  return { stations, skipped };
}

function parseNumber(value, fallback, min, max) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const radio = parseStations(process.env.RADIO_STATIONS);

export const config = {
  token: (process.env.DISCORD_TOKEN || '').trim(),

  // Stations for /radio, as Name|link pairs separated by commas.
  stations: radio.stations,
  skippedStations: radio.skipped,

  // Autoplay defaults: stay in this voice channel and play AUTOPLAY while
  // someone is in it. /autoplay set overrides them for its server.
  autojoinChannelId: (process.env.AUTOJOIN_CHANNEL_ID || '').trim(),
  // A link, the name of one of the stations above, or "testsound" (the default).
  autoplay: (process.env.AUTOPLAY || '').trim(),

  // Leave the voice channel after this many minutes with nothing to play (0 = never).
  idleLeaveMinutes: parseNumber(process.env.IDLE_LEAVE_MINUTES, 5, 0, 1440),
  // Playback volume in percent, applied by FFmpeg.
  volume: parseNumber(process.env.VOLUME, 100, 1, 200),
  activity: (process.env.ACTIVITY ?? '/play').trim(),

  // Links to private and local addresses (your own network, the machine the
  // bot runs on) are refused, because anyone in a server can use /play.
  // Set to true only when every member who can use the bot is trusted.
  allowPrivateStreams: (process.env.ALLOW_PRIVATE_STREAMS ?? 'false') === 'true',

  // Set to false when something else manages this bot's slash commands.
  registerCommands: (process.env.REGISTER_COMMANDS ?? 'true') !== 'false',
  // FFmpeg comes with FadeHost. Elsewhere, install it or point this at it.
  ffmpegPath: (process.env.FFMPEG_PATH || 'ffmpeg').trim(),
};

export function assertConfig() {
  if (!config.token) {
    console.error('[music-bot] DISCORD_TOKEN is not set. Add your bot token in the FadeHost panel: your bot, then Environment variables.');
    process.exit(1);
  }
  for (const entry of config.skippedStations) {
    console.warn(`[music-bot] RADIO_STATIONS: skipped "${entry}". Write each station as Name|https://link and separate them with commas.`);
  }
  if (config.autoplay && !config.autojoinChannelId) {
    console.warn('[music-bot] AUTOPLAY is set but AUTOJOIN_CHANNEL_ID is not, so it has no channel to play in. Set both, or use /autoplay set in Discord.');
  }
}
