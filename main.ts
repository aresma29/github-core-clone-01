// main.ts — the entrypoint: one process, one store, one HTTP server.
// It binds an ephemeral port (port 0 on 0.0.0.0), tells the trial
// environment which port it chose, then long-polls the environment's /done
// endpoint and exits 0 the moment the environment says the trial is over.
// A trial still running at its wall scores 0 on every column, so this file
// never exits early and never hangs past the signal: registration retries
// until it lands, and /done polling retries through transient errors.

import { createApp } from './server.ts';
import { Store } from './store.ts';

const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  if (envBase === '') {
    console.error(`[forge] no MAKEFUN_ENV_URL; serving on ${port} without registration`);
    return;
  }
  let delay = 250;
  for (;;) {
    try {
      const res = await fetch(`${envBase}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.ok) {
        console.error(`[forge] registered port ${port}`);
        return;
      }
      console.error(`[forge] register answered ${res.status}; retrying`);
    } catch (err) {
      console.error(`[forge] register failed (${err instanceof Error ? err.message : 'unknown'}); retrying`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5000);
  }
}

async function waitForDone(): Promise<void> {
  if (envBase === '') {
    // No trial environment: stay up until told otherwise.
    await new Promise<void>(() => undefined);
    return;
  }
  let delay = 500;
  for (;;) {
    try {
      const res = await fetch(`${envBase}/done`, { method: 'GET' });
      if (res.ok) {
        const body = (await res.json()) as { done?: boolean };
        if (body.done === true) return;
      }
      delay = 500;
    } catch (err) {
      console.error(`[forge] /done poll failed (${err instanceof Error ? err.message : 'unknown'}); retrying`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5000);
  }
}

async function main(): Promise<void> {
  // A stray rejection must never kill the trial silently: log it and exit
  // loudly instead of hanging past the wall budget.
  process.on('unhandledRejection', (reason: unknown) => {
    console.error(`[forge] unhandled rejection: ${reason instanceof Error ? reason.message : 'unknown'}`);
    process.exit(1);
  });
  const store = new Store();
  const server = createApp(store, token);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  console.log(`[forge] listening on 0.0.0.0:${port}`);
  let exiting = false;
  const shutdown = (): void => {
    if (exiting) return;
    exiting = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await register(port);
  await waitForDone();
  console.error('[forge] trial done; exiting 0');
  shutdown();
}

main().catch((err: unknown) => {
  console.error(`[forge] fatal: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exit(1);
});
