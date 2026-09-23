import { createMockServer } from './server.ts';

/** `npm run mock` - env: MOCK_PORT (5080), MOCK_HOST (0.0.0.0), MOCK_SIMULATE_SECONDS (25, 0=off),
 *  MOCK_REVERB_PORT (optional extra Pusher-socket port, e.g. 8080), MOCK_STATIC_DIR (dist). */
const env = process.env;
const reverbPort = env.MOCK_REVERB_PORT;
const server = await createMockServer({
  port: Number(env.MOCK_PORT ?? 5080),
  host: env.MOCK_HOST ?? '0.0.0.0',
  simulateEverySeconds: Number(env.MOCK_SIMULATE_SECONDS ?? 25),
  reverbPort: reverbPort === undefined ? null : Number(reverbPort),
  staticDir: env.MOCK_STATIC_DIR ?? 'dist',
  log: (line) => {
    console.warn(`[mock] ${line}`);
  },
});

console.warn(`[mock] API + Pusher socket on ${server.url}  (Reverb key: ${server.reverbKey})`);
console.warn(
  '[mock] device registration code KDS-1234; logins: PIN 1234 (can bump) / PIN 5678 (view only) / NFC 04A1B2C3 / password kds:kds-pass',
);
console.warn(
  '[mock] admin: POST /mock/tickets | /mock/drop-sockets | /mock/outage?seconds=15 | /mock/expire-tokens | /mock/device-command | /mock/reset',
);
