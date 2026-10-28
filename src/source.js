import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { config } from './config.js';

/** A problem with a link that is safe and useful to tell the member who asked for it. */
export class PlayError extends Error {}

const PRIVATE = 'That link points to a private or local address, so I will not open it.';

// Loopback, private, link-local, carrier-grade NAT, multicast and reserved
// ranges. Anyone in a server can hand /play a link; without this, a link could
// make the bot reach the machine it runs on or the network around it.
const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) blocked.addSubnet(address, prefix, 'ipv4');
// No ::ffff:0:0/96 rule: BlockList checks IPv4 addresses against IPv4-mapped
// IPv6 rules, so that one line would refuse every IPv4 address. Mapped
// addresses are matched against the IPv4 rules instead.
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(address, prefix, 'ipv6');

export function isPrivateAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
}

/**
 * The DNS lookup the connection itself uses, so the address that is checked
 * is the address that is dialed: a name cannot pass the check and then
 * resolve to somewhere else.
 */
function checkedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!config.allowPrivateStreams && addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error(`${hostname} resolves to a private address`), { code: 'EPRIVATE' }));
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * Open a link and resolve with the response body, following up to five
 * redirects and checking every one. The bot downloads the audio itself and
 * hands FFmpeg only the bytes, so FFmpeg never opens a link of its own.
 */
export function openStream(link, signal, hops = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(link);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new PlayError('Only http and https links can be played.'));
      return;
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateAddress(host) && !config.allowPrivateStreams) {
      reject(new PlayError(PRIVATE));
      return;
    }

    const request = (url.protocol === 'https:' ? https : http).get(
      url,
      {
        lookup: checkedLookup,
        signal,
        timeout: 15_000,
        headers: { 'user-agent': 'FadeHostMusicBot/1.0 (+https://github.com/FadeHost/discord-music-bot)', accept: 'audio/*, */*;q=0.5' },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          if (hops >= 5) {
            reject(new PlayError('That link redirects too many times.'));
            return;
          }
          openStream(new URL(response.headers.location, url).toString(), signal, hops + 1).then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new PlayError(`The link answered with HTTP ${status}.`));
          return;
        }
        // Streaming from here: a paused player stops reading, which must not end the stream.
        request.setTimeout(0);
        resolve(response);
      },
    );
    request.on('timeout', () => request.destroy(new PlayError('The link did not answer within 15 seconds.')));
    request.on('error', (err) => reject(err.code === 'EPRIVATE' ? new PlayError(PRIVATE) : err));
  });
}
