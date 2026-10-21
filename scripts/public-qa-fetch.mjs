import { setTimeout as delay } from 'node:timers/promises';

// Retry only transient public GET failures, within the acceptance job's deadline.
export async function publicBytes(url, deadline, { fetcher = fetch, now = Date.now,
  sleep = delay, onRetry = () => {} } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`Public GET deadline reached: ${url}`);
    let response, failure;
    try {
      response = await fetcher(url, { redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.timeout(Math.min(15000, remaining)) });
      if (response.status === 200) {
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.length >= 8 * 1024 * 1024) throw new Error(`Public resource too large: ${url}`);
        return data;
      }
      failure = new Error(`Public GET HTTP ${response.status}: ${url} (attempt ${attempt})`);
    } catch (error) {
      if (response) throw error; // Body/size failures are not transient HTTP failures.
      failure = new Error(`Public GET failed: ${url} (attempt ${attempt}): ${error.message}`);
    }
    await response?.body?.cancel();
    if (attempt === 3 || (response && ![502, 503, 504].includes(response.status))) throw failure;
    const pause = attempt * 1000;
    if (now() + pause >= deadline) throw failure;
    onRetry({ url, attempt, status: response?.status ?? null });
    await sleep(pause);
  }
}
