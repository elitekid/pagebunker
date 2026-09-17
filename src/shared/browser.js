// globalThis.browser ?? chrome 래퍼(프로미스)

const api = globalThis.browser ?? globalThis.chrome;

export function promisify(fn, context = api) {
  return (...args) =>
    new Promise((resolve, reject) => {
      fn.call(context, ...args, (result) => {
        const err = api.runtime?.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result);
      });
    });
}

export function callOrPromise(fn, context, ...args) {
  const ret = fn.call(context, ...args);
  if (ret && typeof ret.then === 'function') return ret;
  return new Promise((resolve, reject) => {
    const err = api.runtime?.lastError;
    if (err) reject(new Error(err.message));
    else resolve(ret);
  });
}

function promisifyContextMenuCreate(createFn, context) {
  return (props) =>
    new Promise((resolve, reject) => {
      try {
        const ret = createFn.call(context, props, () => {
          const err = api.runtime?.lastError;
          if (err) reject(new Error(err.message));
          else resolve(ret);
        });
        if (typeof ret === 'string' && !api.runtime?.lastError) {
          /* Firefox: id 동기 반환 */
        }
      } catch (e) {
        reject(e);
      }
    });
}

export const browserApi = api;

// offscreen 문서처럼 runtime만 있는 곳에서도 이 모듈을 불러올 수 있도록, 없는 API는 null로 둔다
export const tabs = api.tabs
  ? {
      query: promisify(api.tabs.query, api.tabs),
      create: promisify(api.tabs.create, api.tabs),
      remove: promisify(api.tabs.remove, api.tabs),
      get: promisify(api.tabs.get, api.tabs),
      update: promisify(api.tabs.update, api.tabs),
    }
  : null;

export const windows = api.windows
  ? {
      getLastFocused: promisify(api.windows.getLastFocused, api.windows),
      update: promisify(api.windows.update, api.windows),
    }
  : null;

export const storage = api.storage
  ? {
      local: {
        get: promisify(api.storage.local.get, api.storage.local),
        set: promisify(api.storage.local.set, api.storage.local),
        remove: promisify(api.storage.local.remove, api.storage.local),
      },
    }
  : null;

export const downloads = api.downloads
  ? {
      download: promisify(api.downloads.download, api.downloads),
      search: promisify(api.downloads.search, api.downloads),
      removeFile: promisify(api.downloads.removeFile, api.downloads),
      erase: promisify(api.downloads.erase, api.downloads),
      onChanged: api.downloads.onChanged,
    }
  : null;

export const alarms = api.alarms
  ? {
      create: promisify(api.alarms.create, api.alarms),
      clear: promisify(api.alarms.clear, api.alarms),
      get: promisify(api.alarms.get, api.alarms),
      onAlarm: api.alarms.onAlarm,
    }
  : null;

export const scripting = api.scripting
  ? {
      executeScript: promisify(api.scripting.executeScript, api.scripting),
    }
  : null;

export const offscreen = api.offscreen
  ? {
      createDocument: promisify(api.offscreen.createDocument, api.offscreen),
      closeDocument: promisify(api.offscreen.closeDocument, api.offscreen),
      hasDocument: () => {
        if (typeof api.offscreen.hasDocument === 'function') {
          return callOrPromise(api.offscreen.hasDocument, api.offscreen);
        }
        return Promise.resolve(false);
      },
    }
  : null;

export const action = api.action ?? api.browserAction;

const ctxMenus = api.contextMenus ?? api.menus;

export const contextMenus = ctxMenus
  ? {
      removeAll: promisify(ctxMenus.removeAll, ctxMenus),
      create: promisifyContextMenuCreate(ctxMenus.create, ctxMenus),
      onClicked: ctxMenus.onClicked,
    }
  : null;

export const actionBadge = action
  ? {
      setBadgeText: (opts) => callOrPromise(action.setBadgeText, action, opts),
      setBadgeBackgroundColor: (opts) =>
        callOrPromise(action.setBadgeBackgroundColor, action, opts),
      setTitle: (opts) => callOrPromise(action.setTitle, action, opts),
    }
  : null;
