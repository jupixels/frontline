import { describe, expect, it } from 'vitest';
import type { DesyncInfo } from '../src/net/lockstep';
import { compareHashes, TestWorld, type VirtualPeer } from './net-harness';

/** Host + n-1 joiners, all ready, optional AI slots, match started. */
async function startMatch(world: TestWorld, humans: number, ais = 0): Promise<VirtualPeer[]> {
  const host = await world.host('host');
  const code = host.lobby.code;
  const peers = [host];
  for (let i = 1; i < humans; i++) peers.push(await world.join(`p${i}`, code));
  for (let i = 0; i < ais; i++) host.lobby.addAi('normal');
  await world.run(200);
  for (const p of peers.slice(1)) p.lobby.setReady(true);
  await world.run(200);
  expect(host.lobby.canStart()).toEqual({ ok: true });
  await host.lobby.start();
  await world.run(100);
  for (const p of peers) expect(p.session, `${p.name} started`).not.toBeNull();
  return peers;
}

describe('lockstep over loopback', () => {
  it('two peers with latency, jitter and reordering stay in sync', async () => {
    const world = new TestWorld({ latencyMs: 40, jitterMs: 40, ordered: false, seed: 7 });
    const peers = await startMatch(world, 2);
    const desyncs: DesyncInfo[] = [];
    for (const p of peers) p.session!.events.on('desync', (d) => desyncs.push(d));
    await world.run(60_000);

    const [a, b] = peers;
    expect(a.sim!.tick).toBeGreaterThan(1000);
    expect(Math.abs(a.sim!.tick - b.sim!.tick)).toBeLessThan(20);
    expect(a.sim!.world.setup.seed).toBe(b.sim!.world.setup.seed);
    const { common, mismatches } = compareHashes(peers);
    expect(common).toBeGreaterThan(20);
    expect(mismatches).toEqual([]);
    expect(desyncs).toEqual([]);
    // Commands really flowed (otherwise sims would trivially agree).
    expect(a.session!.commandLog().turns.length).toBeGreaterThan(30);
    expect(new Set(a.hashes.values()).size).toBeGreaterThan(10);
    // Delay adapted to ~80 ms one way + jitter: more than the minimum block.
    expect(a.session!.status.inputDelayTicks).toBeGreaterThanOrEqual(2);
    expect(a.session!.status.rtt[1]).toBeGreaterThan(60);
  });

  it('four peers plus an AI stay in sync; AI commands come from the host only', async () => {
    const world = new TestWorld({ latencyMs: 25, jitterMs: 60, ordered: false, seed: 3 });
    const peers = await startMatch(world, 4, 1);
    expect(peers[0].session!.setup.players.length).toBe(5);
    const ai = peers[0].session!.setup.players.find((p) => p.kind === 'ai')!.id;
    expect(peers.map((p) => p.session!.controls(ai))).toEqual([true, false, false, false]);
    await world.run(30_000);
    const { common, mismatches } = compareHashes(peers);
    expect(common).toBeGreaterThan(10);
    expect(mismatches).toEqual([]);
    const aiTurns = peers[1].session!.commandLog().turns.filter((t) => t.commands.some((c) => c.player === ai));
    expect(aiTurns.length).toBeGreaterThan(5);
  });

  it('stalls while a peer is frozen and reports who we wait for', async () => {
    const world = new TestWorld({ latencyMs: 20 });
    const [a, b] = await startMatch(world, 2);
    await world.run(3000);
    b.frozen = true;
    await world.run(2000);
    const stuckAt = a.sim!.tick;
    await world.run(2000);
    expect(a.sim!.tick).toBe(stuckAt);
    const status = a.session!.status;
    expect(status.phase).toBe('waiting');
    expect(status.waitingFor).toEqual([b.session!.localPlayer]);
    expect(status.waitingSince).not.toBeNull();
    b.frozen = false;
    await world.run(2000);
    expect(a.sim!.tick).toBeGreaterThan(stuckAt);
    expect(a.session!.status.phase).toBe('running');
    expect(compareHashes([a, b]).mismatches).toEqual([]);
  });

  it('detects a desync and reports per-player hashes', async () => {
    const world = new TestWorld({ latencyMs: 20 });
    const [a, b] = await startMatch(world, 2);
    const seen: DesyncInfo[] = [];
    a.session!.events.on('desync', (d) => seen.push(d));
    await world.run(2000);
    // Corrupt b's state behind the sim's back.
    const unit = [...b.sim!.world.entities.values()][0];
    unit.pos.x += 1;
    await world.run(5000);
    expect(seen.length).toBeGreaterThan(0);
    const d = seen[0];
    expect(d.hashes[a.session!.localPlayer]).not.toBe(d.hashes[b.session!.localPlayer]);
  });

  it('a leaving player goes idle at the same tick everywhere; the rest continue', async () => {
    const world = new TestWorld({ latencyMs: 30, jitterMs: 20, ordered: false });
    const peers = await startMatch(world, 3);
    const [a, b, c] = peers;
    const left: { peer: string; player: number; tick: number }[] = [];
    for (const p of [a, b]) p.session!.events.on('playerLeft', (e) => left.push({ peer: p.name, ...e }));
    await world.run(5000);
    const cPlayer = c.session!.localPlayer;
    c.lobby.leave();
    world.peers.splice(world.peers.indexOf(c), 1);
    const before = a.sim!.tick;
    await world.run(5000);
    expect(a.sim!.tick).toBeGreaterThan(before + 50);
    expect(left.length).toBe(2);
    expect(left[0].player).toBe(cPlayer);
    expect(left[0].tick).toBe(left[1].tick);
    expect(compareHashes([a, b]).mismatches).toEqual([]);
    // No commands from c after it left.
    const late = a.session!.commandLog().turns.filter((t) => t.tick >= left[0].tick && t.commands.some((x) => x.player === cPlayer));
    expect(late).toEqual([]);
  });

  it('host crash: authority migrates, the AI moves to the new host, the game goes on', async () => {
    const world = new TestWorld({ latencyMs: 30, jitterMs: 30, ordered: false, seed: 11 });
    const peers = await startMatch(world, 3, 1);
    const [host, b, c] = peers;
    const ai = host.session!.setup.players.find((p) => p.kind === 'ai')!.id;
    await world.run(5000);
    world.net.crash(host.transport!);
    world.peers.splice(world.peers.indexOf(host), 1);
    const before = b.sim!.tick;
    await world.run(8000);
    expect(b.sim!.tick).toBeGreaterThan(before + 100);
    expect(b.session!.isAuthority).toBe(true);
    expect(c.session!.isAuthority).toBe(false);
    expect(b.session!.controls(ai)).toBe(true);
    expect(c.session!.controls(ai)).toBe(false);
    expect(b.lobby.isHost).toBe(true);
    expect(compareHashes([b, c]).mismatches).toEqual([]);
    const aiAfter = b.session!.commandLog().turns.filter((t) => t.tick > before + 40 && t.commands.some((x) => x.player === ai));
    expect(aiAfter.length).toBeGreaterThan(0);
  });

  it('a crashed peer rejoins with its ticket, fast-forwards from the log, and plays on', async () => {
    const world = new TestWorld({ latencyMs: 30, jitterMs: 20, ordered: false, seed: 5 });
    const peers = await startMatch(world, 3);
    const [a, b, c] = peers;
    await world.run(10_000);
    const cPlayer = c.session!.localPlayer;
    world.net.crash(c.transport!);
    world.peers.splice(world.peers.indexOf(c), 1);
    await world.run(3000);
    expect(a.sim!.tick).toBeGreaterThan(200);

    // Same tab reloads: the ticket survives in (session) storage.
    const c2 = await world.join('c2', a.lobby.code, { storage: c.storage });
    expect(c2.lobby.match?.rejoined).toBe(true);
    expect(c2.session!.localPlayer).toBe(cPlayer);
    await world.run(6000);
    expect(Math.abs(c2.sim!.tick - a.sim!.tick)).toBeLessThan(30);
    const all = [a, b, c2];
    const { common, mismatches } = compareHashes(all);
    expect(common).toBeGreaterThan(5);
    expect(mismatches).toEqual([]);
    // c2's own commands are accepted again.
    const before = c2.submitted;
    await world.run(5000);
    expect(c2.submitted).toBeGreaterThan(before);
    const tail = a.session!.commandLog().turns.filter((t) => t.commands.some((x) => x.player === cPlayer) && t.tick > c2.sim!.tick - 100);
    expect(tail.length).toBeGreaterThan(0);
    expect(compareHashes(all).mismatches).toEqual([]);
  });

  it('a reload while the old connection still looks alive drops the stale peer first', async () => {
    const world = new TestWorld({ latencyMs: 30 });
    const [a, b] = await startMatch(world, 2);
    await world.run(5000);
    let dropped = false;
    b.session!.events.on('dropped', () => (dropped = true));
    b.frozen = true; // tab hung but its connection is still up
    const b2 = await world.join('b2', a.lobby.code, { storage: b.storage });
    expect(b2.lobby.match?.rejoined).toBe(true);
    await world.run(5000);
    expect(dropped).toBe(true);
    expect(Math.abs(b2.sim!.tick - a.sim!.tick)).toBeLessThan(30);
    expect(compareHashes([a, b2]).mismatches).toEqual([]);
  });

  it('rejects a rejoin with a forged secret', async () => {
    const world = new TestWorld({ latencyMs: 20 });
    const [a, , c] = await startMatch(world, 3);
    await world.run(2000);
    const ticket = { ...c.lobby.ticket!, secret: 'nope' };
    await expect(world.join('evil', a.lobby.code, { rejoin: ticket })).rejects.toMatchObject({ code: 'rejected', reason: 'rejoin-denied' });
  });
});
