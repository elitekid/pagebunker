// 검색 Worker (plan 4-4, T4.1)

import { searchArticles } from '../shared/search-core.js';

/** @type {number} */
let currentGen = 0;

self.onmessage = (ev) => {
  const { type, gen, query, items, offset = 0, limit = 100 } = ev.data || {};

  if (type === 'cancel') {
    currentGen = gen;
    return;
  }

  if (type !== 'search') return;

  const myGen = gen;
  const all = searchArticles(items, query);
  const slice = all.slice(offset, offset + limit);
  const batch = [];

  for (let i = 0; i < slice.length; i++) {
    if (myGen !== currentGen) {
      self.postMessage({ type: 'cancelled', gen: myGen });
      return;
    }
    batch.push(slice[i]);
    if (batch.length >= 50 && i < slice.length - 1) {
      if (myGen !== currentGen) {
        self.postMessage({ type: 'cancelled', gen: myGen });
        return;
      }
    }
  }

  if (myGen !== currentGen) {
    self.postMessage({ type: 'cancelled', gen: myGen });
    return;
  }

  self.postMessage({
    type: 'results',
    gen: myGen,
    results: slice,
    total: all.length,
  });
};
