# FadeHost Music Bot

A Discord music bot that plays audio links and internet radio in your voice channels. It keeps a queue, skips and pauses, and it can wait in a voice channel and start playing the moment someone joins. It runs on Discord's current voice stack, including the end-to-end encryption (DAVE) Discord has required for voice since March 2026.

It plays direct links to audio files and streams: MP3, OGG, AAC, FLAC, Icecast and Shoutcast radio, HLS. It does not play YouTube or Spotify, because their terms do not allow bots to stream from them.

## Setup on FadeHost
1. Create a bot at https://discord.com/developers/applications: **New Application**, then **Bot**, then **Reset Token**.
2. Invite it with the `bot` and `applications.commands` scopes and the **Connect** and **Speak** permissions.
3. In the FadeHost panel, deploy the **Music Bot** template and paste the token as `DISCORD_TOKEN`.
4. In Discord, join a voice channel and run `/testsound`. You hear a short chime.

For a quick demo, run `/autoplay set` with your voice channel. The bot waits there and plays as soon as anyone joins, and it streams nothing while the channel is empty.

## Commands
| Command | What it does |
|---|---|
| `/play url` | Plays a direct link to an audio file or stream, or adds it to the queue. |
| `/radio station` | Plays one of the stations in `RADIO_STATIONS`. |
| `/testsound` | Plays a short chime, to check that voice works. |
| `/skip` | Skips to the next track. |
| `/pause`, `/resume` | Pauses and resumes. |
| `/stop` | Clears the queue and leaves the channel. With autoplay on, the bot stays. |
| `/queue` | Shows what is playing and what is next. |
| `/autoplay set channel source` | Stays in a voice channel and plays `source` while someone is in it. Server managers only. |
| `/autoplay off`, `/autoplay show` | Turns autoplay off, or shows where it is on. |

When everyone leaves the channel, the bot pauses and leaves after `IDLE_LEAVE_MINUTES`. With autoplay on, it stops the stream and waits for the next listener.

## Environment variables
| Variable | Default | What it does |
|---|---|---|
| `DISCORD_TOKEN` | | **Required.** Your bot token. |
| `RADIO_STATIONS` | | Stations for `/radio`, as `Name\|https://link` pairs separated by commas. |
| `AUTOJOIN_CHANNEL_ID` | | Autoplay without the command: the voice channel to stay in. `/autoplay set` wins over it. |
| `AUTOPLAY` | `testsound` | What autoplay plays: a link, a station name or `testsound`. |
| `IDLE_LEAVE_MINUTES` | `5` | Minutes with nothing to play, or nobody listening, before the bot leaves. `0` means it stays. |
| `VOLUME` | `100` | Playback volume in percent, from 1 to 200. |
| `ACTIVITY` | `/play` | The bot's "Listening to" status. Leave it empty for none. |
| `REGISTER_COMMANDS` | `true` | Set to `false` if something else manages this bot's slash commands. |
| `FFMPEG_PATH` | `ffmpeg` | Where FFmpeg is. FadeHost has it built in. |
| `CONFIG_PATH` | `/data/music-config.json` | Where the `/autoplay` settings are saved. |

On FadeHost's free plan, streams have to be on the usual web ports (80, 443, 8080 or 8443). Paid plans reach any port.

## Running it somewhere else
You need Node.js 22.12 or newer and FFmpeg with libopus. Run `npm install`, set `DISCORD_TOKEN` and `CONFIG_PATH=./data/music-config.json`, then `npm start`.

Built and maintained by [FadeHost](https://fadehost.com). MIT licensed.
