// 고정 머리 아래 알림 줄 (3초)

const DEFAULT_MS = 3000;

/**
 * @param {HTMLElement} el
 * @param {string} text
 * @param {number} [ms]
 * @returns {() => void}
 */
export function showToast(el, text, ms = DEFAULT_MS) {
  if (!el) return () => {};
  clearTimeout(showToast._timer);
  el.textContent = text || '';
  if (!text) {
    el.classList.add('hidden');
    return () => {};
  }
  el.classList.remove('hidden');
  showToast._timer = setTimeout(() => {
    el.classList.add('hidden');
    el.textContent = '';
  }, ms);
  return () => {
    clearTimeout(showToast._timer);
    el.classList.add('hidden');
    el.textContent = '';
  };
}
