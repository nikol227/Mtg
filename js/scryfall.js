// Scryfall API client. Uses /cards/collection (75 identifiers per request)
// Scryfall limits this endpoint to about 2 requests/second, so batches are spaced out,
// and 429 responses are retried after the server's Retry-After delay.

const API = 'https://api.scryfall.com';
const BATCH = 75;
const DELAY_MS = 550;
const MAX_TRIES = 7;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Look up many cards. identifiers: Scryfall identifier objects.
 * onProgress(done, total) is called after each batch.
 * Returns { cards: [scryfallCard...], notFound: [identifier...] } — cards are in no guaranteed order.
 */
export async function fetchCollection(identifiers, { onProgress, fetchImpl = fetch, signal } = {}) {
  const cards = [];
  const notFound = [];
  const total = identifiers.length;
  for (let i = 0; i < total; i += BATCH) {
    if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
    const batch = identifiers.slice(i, i + BATCH);
    const json = await postWithRetry(`${API}/cards/collection`, { identifiers: batch }, fetchImpl, signal);
    cards.push(...(json.data || []));
    notFound.push(...(json.not_found || []));
    onProgress?.(Math.min(i + BATCH, total), total);
    if (i + BATCH < total) await sleep(DELAY_MS);
  }
  return { cards, notFound };
}

async function postWithRetry(url, body, fetchImpl, signal, attempt = 0) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError' || attempt >= MAX_TRIES - 1) throw e;
    await sleep(1000 * 2 ** attempt);
    return postWithRetry(url, body, fetchImpl, signal, attempt + 1);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= MAX_TRIES - 1) {
      throw new Error(res.status === 429
        ? 'Scryfall is limiting requests right now (too many in a short time). Wait a minute and import again; cards already looked up are cached.'
        : `Scryfall returned ${res.status} after several retries.`);
    }
    const retryAfter = Number(res.headers?.get?.('Retry-After'));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 1500 * 2 ** attempt));
    return postWithRetry(url, body, fetchImpl, signal, attempt + 1);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).details || ''; } catch { /* ignore */ }
    throw new Error(`Scryfall error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}
