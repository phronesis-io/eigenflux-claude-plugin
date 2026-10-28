import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { AuthNotificationGate } from './auth-notification-gate.js';

let clock: ReturnType<typeof spyOn>;
beforeEach(() => { clock = spyOn(Date, 'now'); });
afterEach(() => clock.mockRestore());

test('successful sends have a bounded cooldown and successful checks reset it', async () => {
  clock.mockReturnValue(0);
  const gate = new AuthNotificationGate();
  let sent = 0;
  const send = async () => { sent += 1; };
  await gate.deliver(send);
  await gate.deliver(send);
  expect(sent).toBe(1);
  clock.mockReturnValue(5 * 60 * 1000);
  await gate.deliver(send);
  expect(sent).toBe(2);
  gate.reset();
  await gate.deliver(send);
  expect(sent).toBe(3);
});

test('failed sends remain retryable and concurrent sources share one in-flight send', async () => {
  clock.mockReturnValue(1);
  const gate = new AuthNotificationGate();
  await expect(gate.deliver(async () => { throw new Error('channel unavailable'); })).rejects.toThrow('channel unavailable');
  let finish!: () => void;
  let sent = 0;
  const pending = gate.deliver(async () => {
    sent += 1;
    await new Promise<void>((resolve) => { finish = resolve; });
  });
  await gate.deliver(async () => { sent += 1; });
  expect(sent).toBe(1);
  finish();
  await pending;
});
