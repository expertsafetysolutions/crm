/**
 * searchUtils — one matching rule for every search box and picker in the app.
 *
 * The screens each grew their own `field.toLowerCase().includes(q)` chain, which matches a substring
 * anywhere (good) but treats the whole query as ONE token (bad). So "Expert Vadodara" finds nothing
 * in "Expert Safety Solutions Vadodara" — the words are right, the order is right, but they are not
 * adjacent. People type what they remember, in the order they remember it, and the office genuinely
 * searches like that.
 *
 * Splitting on whitespace and requiring every token to appear SOMEWHERE fixes it, and costs nothing:
 * these lists are hundreds of rows, not millions, filtered in memory.
 *
 * Deliberately NOT a fuzzy/edit-distance matcher. On a cylinder number or a GSTIN, "close enough"
 * returns the wrong record, and picking the wrong customer is worse than finding none.
 */

/** Splits a query into lowercase tokens. Empty query -> no tokens -> everything matches. */
export function queryTokens(query) {
  return String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * True when EVERY token appears somewhere across the given fields.
 *
 * Fields are joined before testing, so tokens may span them: searching "Expert Vadodara" matches a
 * record whose name holds "Expert" and whose city holds "Vadodara".
 *
 *   matchesQuery('expert vadodara', [c.Company_Name, c.Address])
 */
export function matchesQuery(query, fields) {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return true;

  const haystack = (Array.isArray(fields) ? fields : [fields])
    .filter(v => v !== null && v !== undefined)
    .join(' ')
    .toLowerCase();

  return tokens.every(t => haystack.includes(t));
}

/**
 * Filters a list with `matchesQuery`. `getFields` returns the searchable values for one row.
 *
 *   filterByQuery(customers, q, c => [c.Company_Name, c.Contact, c.Auth_Person])
 */
export function filterByQuery(rows, query, getFields) {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return Array.isArray(rows) ? rows : [];
  return (Array.isArray(rows) ? rows : []).filter(r => matchesQuery(query, getFields(r)));
}

/**
 * Splits `text` into `{ text, match }` runs so a renderer can highlight what the user typed. Returns
 * segments rather than HTML — building markup here would mean dangerouslySetInnerHTML at every call
 * site, and these strings come from customer records.
 *
 * Longest tokens first, so searching "safe safety" highlights "safety" whole instead of leaving a
 * stray "ty" behind.
 */
export function highlightSegments(text, query) {
  const source = String(text ?? '');
  const tokens = queryTokens(query).sort((a, b) => b.length - a.length);
  if (tokens.length === 0 || !source) return [{ text: source, match: false }];

  const lower = source.toLowerCase();
  const hits = [];
  for (const token of tokens) {
    let from = 0;
    while (from <= lower.length - token.length) {
      const at = lower.indexOf(token, from);
      if (at === -1) break;
      hits.push([at, at + token.length]);
      from = at + token.length;
    }
  }
  if (hits.length === 0) return [{ text: source, match: false }];

  // Merge overlaps so two tokens hitting the same characters produce one run, not nested spans.
  hits.sort((a, b) => a[0] - b[0]);
  const merged = [hits[0]];
  for (const [start, end] of hits.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  const out = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) out.push({ text: source.slice(cursor, start), match: false });
    out.push({ text: source.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < source.length) out.push({ text: source.slice(cursor), match: false });
  return out;
}

/**
 * Ranks matches so the most likely record is first: a prefix hit beats a hit buried mid-string, and
 * a shorter name beats a longer one on an equal hit. Typing "exp" should surface "Expert Safety"
 * above "Fire Extinguisher Experts Pvt Ltd".
 */
export function rankByQuery(rows, query, getPrimary) {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return Array.isArray(rows) ? rows : [];

  return [...(rows || [])]
    .map(row => {
      const primary = String(getPrimary(row) ?? '').toLowerCase();
      const first = tokens[0];
      const at = primary.indexOf(first);
      return {
        row,
        score: at === -1 ? 9999 : at,     // earlier hit wins
        length: primary.length            // shorter name wins a tie
      };
    })
    .sort((a, b) => a.score - b.score || a.length - b.length)
    .map(x => x.row);
}
