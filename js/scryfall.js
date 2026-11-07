// Scryfall API client. Uses /cards/collection (75 identifiers per request)
// and respects Scryfall's rate-limit guidance (~10 requests/second max).

const API = 'https://api.scryfall.com';
const BATCH = 75;
const DELAY_MS = 110;

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
    if (e.name === 'AbortError' || attempt >= 4) throw e;
    await sleep(1000 * 2 ** attempt);
    return postWithRetry(url, body, fetchImpl, signal, attempt + 1);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new Error(`Scryfall returned ${res.status} after several retries.`);
    await sleep(1000 * 2 ** attempt);
    return postWithRetry(url, body, fetchImpl, signal, attempt + 1);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).details || ''; } catch { /* ignore */ }
    throw new Error(`Scryfall error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}
