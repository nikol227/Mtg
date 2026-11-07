// CSV parsing + mapping scanner-app exports (ManaBox first, others auto-detected)
// into Scryfall /cards/collection identifiers.

/** RFC 4180-ish CSV parser: quoted fields, escaped quotes, CRLF, embedded newlines. */
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function detectDelimiter(text) {
  const nl = text.search(/\r?\n/);
  const first = nl < 0 ? text : text.slice(0, nl);
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const ch of first) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ',';
}

const COLUMN_ALIASES = {
  name: ['name', 'card name', 'card', 'cardname', 'card_name'],
  qty: ['quantity', 'qty', 'count', 'amount', 'number owned', 'have', 'total quantity'],
  setCode: ['set code', 'setcode', 'set_code', 'edition code', 'set'],
  setName: ['set name', 'edition', 'edition name', 'expansion'],
  cn: ['collector number', 'collector_number', 'collectornumber', 'card number', 'number', 'cn', 'collector #'],
  scryfallId: ['scryfall id', 'scryfall_id', 'scryfallid', 'scryfall uuid'],
  foil: ['foil', 'printing', 'finish'],
};

function findColumn(headers, aliases) {
  for (const a of aliases) {
    const i = headers.indexOf(a);
    if (i >= 0) return i;
  }
  return -1;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Turn CSV text into import rows.
 * Returns { format, rows: [{ identifier, qty, foil, label, line }], errors: [{ line, message }] }
 */
export function csvToImportRows(text) {
  const table = parseCSV(text);
  if (!table.length) return { format: 'empty', rows: [], errors: [{ line: 0, message: 'The file is empty.' }] };
  const headers = table[0].map((h) => h.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(COLUMN_ALIASES).map(([k, a]) => [k, findColumn(headers, a)]));

  // "Set" might hold a set *name* (TCGplayer); only use it as a code if it looks like one.
  if (col.setCode >= 0 && col.setName === col.setCode) col.setName = -1;

  const format = headers.includes('manabox id') ? 'ManaBox'
    : headers.includes('scryfall id') ? 'Scryfall-ID CSV'
      : col.name >= 0 ? 'Generic CSV' : 'unknown';

  const errors = [];
  if (col.name < 0 && col.scryfallId < 0) {
    return { format, rows: [], errors: [{ line: 1, message: 'Could not find a "Name" or "Scryfall ID" column in the header row.' }] };
  }

  const rows = [];
  for (let r = 1; r < table.length; r++) {
    const cells = table[r];
    const get = (k) => (col[k] >= 0 ? (cells[col[k]] || '').trim() : '');
    const name = get('name');
    const id = get('scryfallId');
    const set = get('setCode').toLowerCase();
    const cn = get('cn');
    let qty = col.qty >= 0 ? parseInt(get('qty'), 10) : 1;
    if (Number.isNaN(qty)) qty = 1;
    if (qty <= 0) continue;
    const foilRaw = get('foil').toLowerCase();
    const foil = foilRaw === 'foil' || foilRaw === 'etched' || foilRaw === 'true' || foilRaw === 'yes';

    let identifier = null;
    const setLooksLikeCode = /^[a-z0-9]{2,6}$/.test(set);
    if (UUID_RE.test(id)) identifier = { id: id.toLowerCase() };
    else if (setLooksLikeCode && cn) identifier = { set, collector_number: cn };
    else if (name && setLooksLikeCode) identifier = { name, set };
    else if (name) identifier = { name };
    if (!identifier) {
      errors.push({ line: r + 1, message: 'Row has no card name or Scryfall ID.' });
      continue;
    }
    rows.push({ identifier, qty, foil, label: name || id, line: r + 1 });
  }
  return { format, rows, errors };
}

/** Key used to merge duplicate rows before hitting the API. */
export function identifierKey(idf) {
  if (idf.id) return `id:${idf.id}`;
  if (idf.collector_number) return `sc:${idf.set}:${idf.collector_number}`;
  if (idf.set) return `ns:${idf.name.toLowerCase()}:${idf.set}`;
  return `n:${idf.name.toLowerCase()}`;
}

export function mergeRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const k = identifierKey(r.identifier);
    const prev = map.get(k);
    if (prev) { prev.qty += r.qty; prev.foilQty += r.foil ? r.qty : 0; }
    else map.set(k, { ...r, foilQty: r.foil ? r.qty : 0 });
  }
  return [...map.values()];
}
