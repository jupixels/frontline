import { describe, expect, it } from 'vitest';
import { getTurnServers, parseIceServers } from '../src/net/turn';

describe('TURN config', () => {
  it('accepts the shapes TURN providers return', () => {
    const s = { urls: 'turns:relay.example:443?transport=tcp', username: 'u', credential: 'c' };
    expect(parseIceServers([s])).toEqual([s]);
    expect(parseIceServers({ iceServers: [s] })).toEqual([s]);
    expect(parseIceServers(s)).toEqual([s]);
    expect(parseIceServers([{ nope: 1 }, null, 'x'])).toEqual([]);
  });

  it('reads a pasted JSON list and turns off when empty', async () => {
    expect(await getTurnServers('')).toEqual([]);
    const list = await getTurnServers('[{"urls":"turn:relay.example:80"}]');
    expect(list).toEqual([{ urls: 'turn:relay.example:80' }]);
  });
});
