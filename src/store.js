import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Per-server autoplay settings persist to the FadeHost bot's /data volume,
// which survives restarts and redeploys. AUTOJOIN_CHANNEL_ID and AUTOPLAY are
// the defaults; /autoplay's setting wins once it is made.
const DATA_FILE = process.env.CONFIG_PATH || '/data/music-config.json';

let cache = null;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch {
    cache = { guilds: {} };
  }
  cache.guilds ??= {};
  return cache;
}

async function save() {
  try {
    await mkdir(dirname(DATA_FILE), { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[music-bot] could not save settings:', err.message);
  }
}

/** { channelId, source } for a server, false when /autoplay off was used, undefined when never set. */
export async function getAutoplaySetting(guildId) {
  return (await load()).guilds[guildId]?.autoplay;
}

export async function setAutoplaySetting(guildId, setting) {
  const data = await load();
  data.guilds[guildId] = { ...data.guilds[guildId], autoplay: setting };
  await save();
}
