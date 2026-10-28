import { spawn, spawnSync } from 'node:child_process';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import { config, isHttpUrl } from './config.js';
import { PlayError, openStream } from './source.js';

/** One player per Discord server: its voice connection, its queue and what is playing. */
export const players = new Map();

/** A short C-E-G-C chime made by FFmpeg itself, so the test sound needs no link. */
export const CHIME = Object.freeze({ title: 'Test sound', source: { type: 'chime' } });

// When someone joins, give the voice encryption handshake for the new
// listener a moment before the first note, so they hear it from the start.
const LISTENER_DELAY_MS = 1_500;
// The test sound repeats with this pause while someone listens.
const CHIME_GAP_MS = 3_000;

export function trackFromUrl(url, title) {
  return { title: title || titleFromUrl(url), source: { type: 'url', url } };
}

function titleFromUrl(url) {
  const { hostname, pathname } = new URL(url);
  const last = pathname.split('/').filter(Boolean).pop() || '';
  try {
    return decodeURIComponent(last) || hostname;
  } catch {
    return last || hostname;
  }
}

/** "testsound" (or nothing), a station name from RADIO_STATIONS, or a link. Undefined when it is none of those. */
export function resolveSource(value) {
  const text = (value || '').trim();
  if (!text || text.toLowerCase() === 'testsound') return CHIME;
  const station = config.stations.find((s) => s.name.toLowerCase() === text.toLowerCase());
  if (station) return trackFromUrl(station.url, station.name);
  if (isHttpUrl(text)) return trackFromUrl(text);
  return undefined;
}

/** Stop at start-up with a clear line when FFmpeg is missing, instead of failing on the first /play. */
export function checkFfmpeg() {
  const run = spawnSync(config.ffmpegPath, ['-hide_banner', '-version'], { encoding: 'utf8' });
  if (run.error || run.status !== 0) {
    console.error(`[music-bot] FFmpeg was not found (${config.ffmpegPath}). It comes with FadeHost; to run the bot elsewhere, install FFmpeg or set FFMPEG_PATH.`);
    process.exit(1);
  }
  console.log(`[music-bot] ${run.stdout.split('\n')[0].replace(/ Copyright.*$/, '')}`);
}

/**
 * FFmpeg turns the source into Ogg Opus, which @discordjs/voice sends as it
 * is: no Opus encoder in JavaScript, so a stream costs little CPU. A link
 * reaches FFmpeg as bytes on stdin (see source.js), never as a URL.
 */
export function ffmpegArgs(source) {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
  if (source.type === 'chime') {
    args.push(
      '-f', 'lavfi', '-i', 'sine=frequency=523.25:duration=0.3',
      '-f', 'lavfi', '-i', 'sine=frequency=659.25:duration=0.3',
      '-f', 'lavfi', '-i', 'sine=frequency=783.99:duration=0.3',
      '-f', 'lavfi', '-i', 'sine=frequency=1046.5:duration=1.2',
      '-filter_complex', '[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1,afade=t=out:st=1.4:d=0.7,volume=0.3[out]',
      '-map', '[out]',
    );
  } else {
    // stdin only: a playlist in the stream cannot make FFmpeg open anything else.
    args.push('-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-vn');
    if (config.volume !== 100) args.push('-af', `volume=${config.volume / 100}`);
  }
  args.push('-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '96k', '-f', 'ogg', 'pipe:1');
  return args;
}

export function playerFor(guild) {
  let player = players.get(guild.id);
  if (!player) {
    player = new GuildPlayer(guild);
    players.set(guild.id, player);
  }
  return player;
}

class GuildPlayer {
  constructor(guild) {
    this.guild = guild;
    this.queue = [];
    this.current = null;
    this.connection = null;
    this.ffmpeg = null;
    this.download = null;
    this.textChannel = null;
    this.startedAt = 0;
    this.failures = 0;
    this.pausedForEmpty = false;
    this.idleTimer = null;
    this.autoplayTimer = null;
    this.rejoinTimer = null;
    // Autoplay: the channel the bot stays in, and what it plays there while someone listens.
    this.autoplayChannel = null;
    this.autoplay = null;

    this.audio = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.audio.on(AudioPlayerStatus.Idle, () => this.next());
    this.audio.on('error', (err) => {
      console.error(`[music-bot] ${this.guild.name}: playback error: ${err.message}`);
    });
  }

  async join(channel) {
    const known = this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed;
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    if (!known || this.connection !== connection) {
      this.connection = connection;
      connection.subscribe(this.audio);
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        // Moved to another channel or a voice server change: Discord reconnects
        // on its own within seconds. Anything else (kicked, channel deleted) ends it.
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          connection.destroy();
        }
      });
      connection.on(VoiceConnectionStatus.Destroyed, () => this.onDestroyed(connection));
    }

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      connection.destroy();
      throw new Error(`Could not connect to ${channel.name} within 20 seconds. Check that I have the Connect and Speak permissions there.`);
    }
    console.log(`[music-bot] ${this.guild.name}: in voice channel ${channel.name}`);
    return connection;
  }

  /** People in the bot's voice channel. Someone Discord did not send in full counts as a person. */
  listeners() {
    const channelId = this.connection?.joinConfig.channelId;
    if (!channelId) return 0;
    const me = this.guild.client.user.id;
    return this.guild.voiceStates.cache.filter((s) => s.channelId === channelId && s.id !== me && !s.member?.user.bot).size;
  }

  /** Stay in a channel and play this while someone is in it. */
  async setAutoplay(channel, track) {
    clearTimeout(this.rejoinTimer);
    this.autoplayChannel = channel;
    this.autoplay = track;
    // A different autoplay source replaces the one playing now.
    if (this.current && this.current.autoplay) this.stopCurrent();
    await this.join(channel);
    this.updateListeners();
  }

  clearAutoplay() {
    this.autoplayChannel = null;
    this.autoplay = null;
    clearTimeout(this.autoplayTimer);
    clearTimeout(this.rejoinTimer);
    this.queue = [];
    this.leave();
  }

  /**
   * Someone joined or left a voice channel in this server. Play while anyone
   * listens and stream nothing to an empty channel.
   */
  updateListeners() {
    if (!this.connection) return;
    if (this.listeners() > 0) {
      clearTimeout(this.idleTimer);
      if (this.pausedForEmpty) {
        this.pausedForEmpty = false;
        this.audio.unpause();
      } else if (!this.current && this.queue.length === 0 && this.autoplay) {
        this.scheduleAutoplay(LISTENER_DELAY_MS);
      }
      return;
    }
    clearTimeout(this.autoplayTimer);
    if (!this.current) return;
    if (this.current.autoplay) {
      this.stopCurrent();
      return;
    }
    // A requested track pauses and waits for the room to fill again.
    if (!this.pausedForEmpty && this.audio.pause()) {
      this.pausedForEmpty = true;
      this.scheduleIdleLeave();
    }
  }

  /** Queue a track. Returns 0 when it starts now, else its place in the queue. */
  enqueue(track) {
    const entry = { ...track, autoplay: false };
    this.queue.push(entry);
    if (!this.current) {
      this.next();
      return 0;
    }
    if (this.current.autoplay) {
      // A request takes over from autoplay, which comes back when the queue is done.
      this.stopCurrent();
      return 0;
    }
    entry.announce = true;
    return this.queue.length;
  }

  next() {
    this.stopFfmpeg();
    clearTimeout(this.autoplayTimer);
    const finished = this.current;
    this.current = null;
    this.pausedForEmpty = false;

    const track = this.queue.shift();
    if (track) return this.start(track);

    if (this.autoplay && this.connection) {
      if (finished?.autoplay && !finished.stopped) {
        // A link that ends within seconds is failing (dead link, station down): wait
        // longer each time, up to a minute. The test sound just repeats after a pause.
        const ranFor = Date.now() - this.startedAt;
        if (this.autoplay.source.type === 'chime') return this.scheduleAutoplay(CHIME_GAP_MS);
        this.failures = ranFor < 10_000 ? this.failures + 1 : 0;
        return this.scheduleAutoplay(this.failures > 0 ? Math.min(60_000, 5_000 * 2 ** (this.failures - 1)) : 0);
      }
      return this.scheduleAutoplay(0);
    }
    return this.scheduleIdleLeave();
  }

  scheduleAutoplay(delay) {
    clearTimeout(this.autoplayTimer);
    this.autoplayTimer = setTimeout(() => {
      if (!this.current && this.queue.length === 0 && this.autoplay && this.connection && this.listeners() > 0) {
        this.start({ ...this.autoplay, autoplay: true });
      }
    }, delay);
  }

  start(track) {
    clearTimeout(this.idleTimer);
    const fromLink = track.source.type === 'url';
    const ffmpeg = spawn(config.ffmpegPath, ffmpegArgs(track.source), { stdio: [fromLink ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    this.ffmpeg = ffmpeg;
    const download = fromLink ? new AbortController() : null;
    this.download = download;
    // What the member is told when it fails: our own words, never FFmpeg's.
    let problem = 'Check that the link goes straight to an audio file or stream.';
    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    ffmpeg.on('error', (err) => console.error(`[music-bot] could not start FFmpeg: ${err.message}`));
    ffmpeg.on('close', (code, signal) => {
      download?.abort(); // stop downloading the moment nothing reads it
      if (code === 0 || ffmpeg.stoppedOnPurpose) return; // finished, or skip/stop/next track
      const reason = stderr.trim().split('\n').pop() || `FFmpeg exited with ${code ?? signal}`;
      console.error(`[music-bot] ${this.guild.name}: could not play ${track.title}: ${reason}`);
      if (!track.autoplay) this.say(`Could not play **${track.title}**. ${problem}`);
    });

    if (fromLink) {
      ffmpeg.stdin.on('error', () => {}); // FFmpeg stopped before the download did
      openStream(track.source.url, download.signal)
        .then((body) => {
          body.on('error', () => ffmpeg.stdin.destroy());
          body.pipe(ffmpeg.stdin);
        })
        .catch((err) => {
          if (download.signal.aborted) return;
          if (err instanceof PlayError) problem = err.message;
          console.error(`[music-bot] ${this.guild.name}: could not open ${track.title}: ${err.message}`);
          ffmpeg.stdin.destroy(); // FFmpeg gets no input and exits, which ends the track
        });
    }

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus, metadata: track });
    this.current = track;
    this.startedAt = Date.now();
    this.audio.play(resource);
    console.log(`[music-bot] ${this.guild.name}: now playing ${track.title}${track.autoplay ? ' (autoplay)' : ''}`);
    if (track.announce) this.say(`Now playing **${track.title}**`);
  }

  /** End what is playing on purpose; next() then picks what follows. */
  stopCurrent() {
    if (this.current) this.current.stopped = true;
    this.audio.stop(true);
  }

  stopFfmpeg() {
    this.download?.abort();
    this.download = null;
    const ffmpeg = this.ffmpeg;
    this.ffmpeg = null;
    if (ffmpeg && ffmpeg.exitCode === null) {
      ffmpeg.stoppedOnPurpose = true;
      ffmpeg.kill('SIGKILL');
    }
  }

  skip() {
    if (!this.current) return false;
    this.stopCurrent();
    return true;
  }

  /** Clear the queue. With autoplay on, stay in the channel; otherwise leave. */
  stop() {
    this.queue = [];
    if (this.autoplayChannel) {
      this.stopCurrent();
      return;
    }
    this.leave();
  }

  leave() {
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
  }

  /** Nothing left to play, or paused in an empty channel: leave after IDLE_LEAVE_MINUTES. */
  scheduleIdleLeave() {
    clearTimeout(this.idleTimer);
    if (config.idleLeaveMinutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.autoplayChannel) {
        // The autoplay channel is home: drop the paused requests, stay.
        if (this.pausedForEmpty) {
          this.queue = [];
          this.stopCurrent();
        }
        return;
      }
      if (!this.current || this.pausedForEmpty) {
        console.log(`[music-bot] ${this.guild.name}: idle for ${config.idleLeaveMinutes} minute(s), leaving`);
        this.leave();
      }
    }, config.idleLeaveMinutes * 60_000);
  }

  onDestroyed(connection) {
    if (this.connection !== connection) return;
    this.connection = null;
    this.queue = [];
    if (this.current) this.current.stopped = true;
    this.current = null;
    this.pausedForEmpty = false;
    this.stopFfmpeg();
    this.audio.stop(true);
    clearTimeout(this.idleTimer);
    clearTimeout(this.autoplayTimer);
    if (this.autoplayChannel) {
      // Kicked, disconnected or the channel went away: try again in a minute.
      console.log(`[music-bot] ${this.guild.name}: left the voice channel, rejoining in 60 seconds (autoplay)`);
      clearTimeout(this.rejoinTimer);
      this.rejoinTimer = setTimeout(() => this.rejoin(), 60_000);
      return;
    }
    players.delete(this.guild.id);
  }

  async rejoin() {
    if (!this.autoplayChannel) return;
    try {
      await this.join(this.autoplayChannel);
      this.updateListeners();
    } catch (err) {
      console.error(`[music-bot] ${this.guild.name}: ${err.message}`);
      // join() destroyed the attempt, so onDestroyed has scheduled the next one.
    }
  }

  queueText() {
    const lines = [];
    if (this.current) {
      const state = this.audio.state.status === AudioPlayerStatus.Paused ? ' (paused)' : this.current.autoplay ? ' (autoplay)' : '';
      lines.push(`Now playing: **${this.current.title}**${state}`);
    }
    this.queue.slice(0, 10).forEach((track, i) => lines.push(`${i + 1}. ${track.title}`));
    if (this.queue.length > 10) lines.push(`and ${this.queue.length - 10} more`);
    return lines.length > 0 ? lines.join('\n') : 'Nothing is playing and the queue is empty.';
  }

  say(content) {
    this.textChannel?.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
  }
}
