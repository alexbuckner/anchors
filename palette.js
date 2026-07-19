// Deterministic fuzzy filtering for the Command Palette. UI actions stay in
// panel.js; this module only ranks searchable labels and keywords.

function normalized(value) {
  return String(value || '').toLocaleLowerCase().trim().replace(/\s+/g, ' ');
}

function score(item, query) {
  const label = normalized(item.label);
  const detail = normalized(item.detail);
  const haystack = normalized([item.label, item.detail, item.keywords].filter(Boolean).join(' '));
  const tokens = normalized(query).split(' ').filter(Boolean);
  if (!tokens.every(token => haystack.includes(token))) return -1;

  let value = Number(item.priority || 0);
  for (const token of tokens) {
    if (label === token) value += 120;
    else if (label.startsWith(token)) value += 80;
    else if (label.split(/\s+/).some(word => word.startsWith(token))) value += 50;
    else if (label.includes(token)) value += 30;
    else if (detail.includes(token)) value += 10;
    else value += 4;
  }
  return value;
}

export function filterPalette(items, query, limit = 12) {
  return (items || [])
    .map((item, index) => ({ item, index, score: score(item, query) }))
    .filter(entry => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(entry => entry.item);
}
