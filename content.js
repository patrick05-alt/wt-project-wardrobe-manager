// Content script for Vinted wardrobe and item pages: inject a 'Relist as draft' button next to 'Bump'

(function () {
  const ORIGIN = location.origin; // e.g., https://www.vinted.de
  const ITEM_CARD_SELECTOR = '[data-testid^="product-item-id-"]';
  const BOOST_BUTTON_SELECTOR = 'button[data-testid="bump-button"]';

  function log(...args) { console.debug('[Vinted Cloner]', ...args); }

  let activeLogRenderer = null;

  function addOperationLog(type, details, level = 'info') {
    const entry = { time: new Date().toISOString(), type, details, level };
    operationLogs.unshift(entry);
    operationLogs = operationLogs.slice(0, 300);
    try { chrome.storage.local.set({ vinted_operation_log: operationLogs }); } catch (_) {}
    if (typeof activeLogRenderer === 'function') activeLogRenderer();
    log(type, details);
    return entry;
  }

  function renderOperationLog(container) {
    container.textContent = '';
    if (!operationLogs.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No operations have been logged yet.';
      container.appendChild(empty);
      return;
    }
    for (const entry of operationLogs) {
      const row = document.createElement('div');
      row.className = 'vinted-wardrobe-log__row';
      const time = document.createElement('span');
      time.className = 'vinted-wardrobe-log__time';
      time.textContent = new Date(entry.time).toLocaleString();
      const type = document.createElement('span');
      type.className = 'vinted-wardrobe-log__type';
      type.textContent = String(entry.type || 'Operation');
      const details = document.createElement('span');
      details.textContent = String(entry.details || '');
      row.append(time, type, details);
      container.appendChild(row);
    }
  }

  function itemTitle(item) {
    const title = item && (
      item.title
      || (item.item && item.item.title)
      || (item.item && item.item.name)
      || item.item_title
      || item.name
    );
    return title ? String(title) : '';
  }

  function getDraftCompletion(item) {
    if (!item) return 0;
    let progress = 0;
    const hasTitle = !!itemTitle(item);
    const description = item && (item.description || item.description_text || item.description_html || item.item_description || item.long_description || item.summary);
    const size = item && (item.size || item.size_name || item.size_title || item.sizeLabel || item.size_label || (Array.isArray(item.sizes) ? item.sizes[0] : '') || (item.item && (item.item.size || item.item.size_name || item.item.size_title)));
    const colour = item && (item.colour || item.color || item.colour_name || item.color_name || item.main_colour || item.main_color || (Array.isArray(item.colors) ? item.colors[0] : '') || (Array.isArray(item.colours) ? item.colours[0] : '') || (item.item && (item.item.colour || item.item.color)));
    const priceValue = itemPrice(item);
    const parcel = item && (item.parcel_size || item.package_size || item.shipping_package || item.package || item.parcel || (item.item && (item.item.parcel_size || item.item.package_size)));

    if (hasTitle) progress = 20;
    if (description && String(description).trim().length > 0) progress = Math.max(progress, 40);
    if (size && String(size).trim().length > 0) progress = Math.max(progress, 60);
    if (colour && String(colour).trim().length > 0) progress = Math.max(progress, 70);
    if (priceValue != null && Number(priceValue) > 0) progress = Math.max(progress, 80);
    if (parcel && String(parcel).trim().length > 0) progress = Math.max(progress, 100);
    return progress;
  }

  async function loadOperationLogs() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get({ vinted_operation_log: [] }, data => {
          operationLogs = Array.isArray(data && data.vinted_operation_log) ? data.vinted_operation_log : [];
          resolve(operationLogs);
        });
      } catch (_) {
        resolve(operationLogs);
      }
    });
  }

  async function loadAnalyticsSnapshots() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get({ vinted_analytics_snapshots: [] }, data => {
          analyticsSnapshots = Array.isArray(data && data.vinted_analytics_snapshots)
            ? data.vinted_analytics_snapshots
            : [];
          resolve(analyticsSnapshots);
        });
      } catch (_) {
        resolve(analyticsSnapshots);
      }
    });
  }

  function saveAnalyticsSnapshot(snapshot) {
    const latest = analyticsSnapshots[analyticsSnapshots.length - 1];
    if (latest
      && latest.time.slice(0, 16) === snapshot.time.slice(0, 16)
      && latest.views === snapshot.views
      && latest.favourites === snapshot.favourites
      && latest.inventoryValue === snapshot.inventoryValue) {
      return;
    }
    analyticsSnapshots = [...analyticsSnapshots, snapshot].slice(-366);
    try { chrome.storage.local.set({ vinted_analytics_snapshots: analyticsSnapshots }); } catch (_) {}
  }

  // Cache created-at labels per item id to avoid repeated fetch/inserts
  const createdAtCache = new Map();
  // Cache of full wardrobe items returned via our own fetch
  const wardrobeItemMap = new Map();
  const wardrobeItemStatus = new Map();
  const wardrobeBackups = new Map();
  let wardrobeFetched = false;
  let wardrobeFetchPromise = null;
  let missingItemFetchInFlight = false;
  let injectionScheduled = false;
  let activeWardrobeManagerRenderer = null;
  let lastFetchedPage = 0;
  let totalPages = null;
  let wardrobeSyncStartedAt = 0;
  const selectedWardrobeIds = new Set();
  const relistQueue = [];
  let wardrobeManagerOpen = false;
  let operationLogs = [];
  let analyticsSnapshots = [];
  const WARDROBE_BACKUPS_KEY = 'vinted_wardrobe_item_backups';
  const DEFAULT_OPERATION_SETTINGS = {
    delayMode: 'fixed',
    fixedDelaySeconds: 5,
    randomMinSeconds: 6,
    randomMaxSeconds: 12,
  };
  const LAUNCHER_POSITION_KEY = 'vinted_wardrobe_launcher_position';
  const LAUNCHER_EDGE_GAP = 20;

  const RELIST_PHOTO_DELAY_MIN_MS = 1000;
  const RELIST_PHOTO_DELAY_MAX_MS = 1500;

  function itemPublishedAt(item) {
    const value = item && (
      item.published_at
      || item.first_published_at
      || item.item_published_at
      || item.created_at
      || (item.item && (item.item.published_at || item.item.created_at))
    );
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function itemBackupFingerprint(item) {
    if (!item) return '';
    const relevant = {
      id: item.id,
      title: item.title,
      description: item.description,
      price: item.price,
      price_numeric: item.price_numeric,
      price_currency: item.price_currency,
      status: item.status,
      item_status: item.item_status,
      state: item.state,
      visibility: item.visibility,
      photos: (item.photos || []).map(photo => ({
        id: photo && photo.id,
        url: photo && (photo.full_size_url || photo.url),
      })),
      size_id: item.size_id,
      catalog_id: item.catalog_id,
      package_size_id: item.package_size_id,
      color_ids: item.color_ids,
      updated_at: item.updated_at,
    };
    return JSON.stringify(relevant);
  }

  async function loadWardrobeBackups() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get({ [WARDROBE_BACKUPS_KEY]: [] }, data => {
          const records = Array.isArray(data && data[WARDROBE_BACKUPS_KEY]) ? data[WARDROBE_BACKUPS_KEY] : [];
          wardrobeBackups.clear();
          records.forEach(record => {
            if (record && record.id && record.item) wardrobeBackups.set(String(record.id), record);
          });
          resolve(wardrobeBackups);
        });
      } catch (error) {
        log('Could not load local wardrobe backups:', error);
        resolve(wardrobeBackups);
      }
    });
  }

  function saveWardrobeBackups() {
    const records = Array.from(wardrobeBackups.values()).slice(-2000);
    try {
      chrome.storage.local.set({ [WARDROBE_BACKUPS_KEY]: records });
    } catch (error) {
      log('Could not save local wardrobe backups:', error);
    }
  }

  function syncItemBackup(item, options = {}) {
    if (!item || !item.id) return { changed: false, record: null };
    const id = String(item.id);
    const fingerprint = itemBackupFingerprint(item);
    const previous = wardrobeBackups.get(id);
    if (!options.relisted && !options.initial && !previous) {
      return { changed: false, record: null };
    }
    const changed = !previous || previous.fingerprint !== fingerprint;
    const record = {
      id,
      item,
      fingerprint,
      backedUpAt: previous && previous.backedUpAt ? previous.backedUpAt : new Date().toISOString(),
      lastSyncedAt: new Date().toISOString(),
      lastRelistedAt: previous && previous.lastRelistedAt ? previous.lastRelistedAt : null,
      relistCount: previous && Number(previous.relistCount) || 0,
    };
    if (options.relisted) {
      record.lastRelistedAt = new Date().toISOString();
      record.relistCount += 1;
    }
    wardrobeBackups.set(id, record);
    if (changed || options.relisted) saveWardrobeBackups();
    return { changed, record };
  }

  function removeInactiveBackups() {
    let removed = 0;
    for (const [id] of wardrobeBackups) {
      const status = wardrobeItemStatus.get(id);
      if (status && status !== 'published') {
        wardrobeBackups.delete(id);
        removed++;
      }
    }
    if (removed) saveWardrobeBackups();
    return removed;
  }

  function isRecentlyBackedUpActive(itemOrId) {
    const id = typeof itemOrId === 'object' ? itemOrId && itemOrId.id : itemOrId;
    const item = typeof itemOrId === 'object' ? itemOrId : wardrobeItemMap.get(String(id));
    if (!id || !item || getItemStatus(item) !== 'published') return false;
    const backup = wardrobeBackups.get(String(id));
    if (!backup || !backup.lastRelistedAt) return false;
    if (!backup.lastSyncedAt) return true;
    return !wardrobeSyncStartedAt || new Date(backup.lastSyncedAt).getTime() >= wardrobeSyncStartedAt;
  }

  function isOnSale(item) {
    return Boolean(item) && getItemStatus(item) === 'published';
  }

  function getRelistPhotoDelay() {
    return RELIST_PHOTO_DELAY_MIN_MS
      + Math.random() * (RELIST_PHOTO_DELAY_MAX_MS - RELIST_PHOTO_DELAY_MIN_MS);
  }

  function clampLauncherPosition(left, top, launcher) {
    const margin = LAUNCHER_EDGE_GAP;
    const maxLeft = Math.max(margin, window.innerWidth - launcher.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - launcher.offsetHeight - margin);
    return {
      left: Math.min(Math.max(margin, left), maxLeft),
      top: Math.min(Math.max(margin, top), maxTop),
    };
  }

  function setLauncherPosition(launcher, left, top, persist = true, docked = persist) {
    const position = clampLauncherPosition(left, top, launcher);
    launcher.style.left = `${position.left}px`;
    launcher.style.top = `${position.top}px`;
    launcher.style.right = 'auto';
    launcher.style.bottom = 'auto';
    if (docked) {
      launcher.classList.toggle('is-left', position.left <= LAUNCHER_EDGE_GAP);
      launcher.classList.toggle('is-right', position.left >= window.innerWidth - launcher.offsetWidth - LAUNCHER_EDGE_GAP);
    } else {
      launcher.classList.remove('is-left', 'is-right');
    }
    if (persist) {
      try { chrome.storage.local.set({ [LAUNCHER_POSITION_KEY]: position }); } catch (_) {}
    }
  }

  function restoreLauncherPosition(launcher) {
    try {
      chrome.storage.local.get({ [LAUNCHER_POSITION_KEY]: null }, data => {
        const position = data && data[LAUNCHER_POSITION_KEY];
        if (position && Number.isFinite(Number(position.left)) && Number.isFinite(Number(position.top))) {
          setLauncherPosition(launcher, Number(position.left), Number(position.top), false, true);
        }
      });
    } catch (_) {}
  }

  function makeLauncherMovable(launcher) {
    let drag = null;
    launcher.addEventListener('pointerdown', event => {
      if (event.button !== 0 || launcher.disabled) return;
      const rect = launcher.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        left: rect.left,
        top: rect.top,
        moved: false,
      };
      launcher.setPointerCapture(event.pointerId);
    });
    launcher.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(deltaX, deltaY) < 5) return;
      drag.moved = true;
      setLauncherPosition(launcher, drag.left + deltaX, drag.top + deltaY, false, false);
    });
    const finishDrag = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (launcher.hasPointerCapture(event.pointerId)) launcher.releasePointerCapture(event.pointerId);
      if (drag.moved) {
        const rect = launcher.getBoundingClientRect();
        const edge = rect.left + rect.width / 2 < window.innerWidth / 2
          ? LAUNCHER_EDGE_GAP
          : window.innerWidth - rect.width - LAUNCHER_EDGE_GAP;
        setLauncherPosition(launcher, edge, rect.top);
        launcher.dataset.dragged = 'true';
        setTimeout(() => { delete launcher.dataset.dragged; }, 0);
      }
      drag = null;
    };
    launcher.addEventListener('pointerup', finishDrag);
    launcher.addEventListener('pointercancel', finishDrag);
    window.addEventListener('resize', () => {
      const rect = launcher.getBoundingClientRect();
      if (launcher.style.left) setLauncherPosition(launcher, rect.left, rect.top);
    });
  }

  function reportRelistActivity(message) {
    showNotice(message, 'success', true);
    addOperationLog('Relist activity', message);
  }
  const WARDROBE_PAGE_DELAY_MIN_MS = 200;
  const WARDROBE_PAGE_DELAY_MAX_MS = 500;
  const WARDROBE_RETRY_DELAYS_MS = [3000, 8000, 15000];

  function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function getWardrobePageDelay() {
    return WARDROBE_PAGE_DELAY_MIN_MS
      + Math.random() * (WARDROBE_PAGE_DELAY_MAX_MS - WARDROBE_PAGE_DELAY_MIN_MS);
  }

  function ensureStyles() {
    // wardrobe-manager.css is loaded by the content_scripts manifest entry.
  }
  function showNotice(message, type = 'success', isActivity = false) {
    // Toast popup appended to body (fixed position)
    let el = document.getElementById('vinted-relist-notice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'vinted-relist-notice';
      el.className = 'vinted-relist-notice vinted-relist-toast';
      document.body.appendChild(el);
    }

    el.classList.remove('is-success', 'is-error', 'is-activity');
    el.classList.add(type === 'error' ? 'is-error' : 'is-success');
    if (isActivity) el.classList.add('is-activity');
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    el.textContent = message;
    // Auto-hide after a few seconds for non-error; keep errors visible longer
    if (type !== 'error') {
      clearTimeout(el._hideTimer);
      el._hideTimer = setTimeout(() => { if (el && el.parentElement) el.parentElement.removeChild(el); }, 6000);
    }

  }

  async function withTimeout(promise, milliseconds, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function showManagerDialog({ title, message, input, confirmLabel = 'Continue', danger = false }) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'vinted-manager-modal';
      const dialog = document.createElement('div');
      dialog.className = 'vinted-manager-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      const heading = document.createElement('h2');
      heading.textContent = title;
      const description = document.createElement('p');
      description.textContent = message;
      dialog.append(heading, description);
      let field = null;
      if (input) {
        field = document.createElement(input.type === 'select' ? 'select' : 'input');
        if (input.type !== 'select') field.type = input.type === 'number' ? 'number' : 'text';
        field.value = input.value || '';
        field.placeholder = input.placeholder || '';
        field.setAttribute('aria-label', input.label || 'Value');
        if (input.min != null) field.min = String(input.min);
        if (input.step != null) field.step = String(input.step);
        if (input.type === 'select') {
          input.options.forEach(option => {
            const optionEl = document.createElement('option');
            optionEl.value = option.value;
            optionEl.textContent = option.label;
            field.appendChild(optionEl);
          });
        }
        const label = document.createElement('label');
        label.textContent = input.label || 'Value';
        label.appendChild(field);
        dialog.appendChild(label);
      }
      const actions = document.createElement('div');
      actions.className = 'vinted-manager-dialog__actions';
      const cancel = makePanelButton('Cancel');
      const confirm = makePanelButton(confirmLabel, `is-primary${danger ? ' is-danger' : ''}`);
      actions.append(cancel, confirm);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      const finish = value => {
        document.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        resolve(value);
      };
      const onKeyDown = event => { if (event.key === 'Escape') finish(null); };
      cancel.addEventListener('click', () => finish(null));
      overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
      confirm.addEventListener('click', () => finish(field ? field.value : true));
      document.addEventListener('keydown', onKeyDown);
      (field || confirm).focus();
    });
  }

  function getRelistOptions(itemId) {
      return new Promise(resolve => {
        const existing = document.getElementById('vinted-relist-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'vinted-relist-modal';
        overlay.className = 'vinted-relist-modal';
        overlay.setAttribute('role', 'presentation');

        const dialog = document.createElement('div');
        dialog.className = 'vinted-relist-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'vinted-relist-title');

        const title = document.createElement('h2');
        title.id = 'vinted-relist-title';
        title.textContent = 'Relist as draft';
        const intro = document.createElement('p');
        intro.textContent = `Copy item ${itemId} to your Vinted drafts with the existing photos and details.`;

        const warning = document.createElement('p');
        warning.className = 'vinted-relist-dialog__warning';
        warning.textContent = 'Deleting the old listing cannot be undone. It will happen only after the draft has been created successfully.';

        const deleteLabel = document.createElement('label');
        deleteLabel.className = 'vinted-relist-dialog__option';
        const deleteInput = document.createElement('input');
        deleteInput.type = 'checkbox';
        deleteInput.checked = true;
        const deleteText = document.createElement('span');
        deleteText.textContent = 'Delete the old listing after the draft is created';
        deleteLabel.append(deleteInput, deleteText);

        const refreshLabel = document.createElement('label');
        refreshLabel.className = 'vinted-relist-dialog__option';
        const refreshInput = document.createElement('input');
        refreshInput.type = 'checkbox';
        const refreshText = document.createElement('span');
        refreshText.textContent = 'Refresh this page when finished';
        refreshLabel.append(refreshInput, refreshText);

        const actions = document.createElement('div');
        actions.className = 'vinted-relist-dialog__actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'vinted-relist-dialog__cancel';
        cancel.textContent = 'Cancel';
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'vinted-relist-dialog__confirm';
        confirm.textContent = 'Create draft';
        actions.append(cancel, confirm);
        dialog.append(title, intro, warning, deleteLabel, refreshLabel, actions);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const finish = options => {
          document.removeEventListener('keydown', onKeyDown);
          overlay.remove();
          resolve(options);
        };
        const onKeyDown = event => {
          if (event.key === 'Escape') finish(null);
        };
        cancel.addEventListener('click', () => finish(null));
        overlay.addEventListener('click', event => {
          if (event.target === overlay) finish(null);
        });
        confirm.addEventListener('click', () => finish({
          deleteOriginal: deleteInput.checked,
          refresh: refreshInput.checked,
        }));
        document.addEventListener('keydown', onKeyDown);
        confirm.focus();
      });
  }

  function findClosestItemId(el) {
    const directId = el && el.getAttribute && el.getAttribute('data-item-id');
    if (directId && /^\d+$/.test(directId)) return directId;
    // Walk up to find an ancestor with data-testid like product-item-id-<id>--*
    let cur = el;
    while (cur && cur !== document.body) {
      const testid = cur.getAttribute && cur.getAttribute('data-testid');
      if (testid && testid.startsWith('product-item-id-')) {
        const m = testid.match(/^product-item-id-(\d+)/);
        if (m) return m[1];
      }
      cur = cur.parentElement;
    }
    // Fallback: try nearest descendant
    const node = el.closest ? el.closest(ITEM_CARD_SELECTOR) : null;
    if (node) {
      const tid = node.getAttribute('data-testid') || '';
      const m = tid.match(/^product-item-id-(\d+)/);
      if (m) return m[1];
    }
    const fromUrl = getItemIdFromUrl();
    if (fromUrl) return fromUrl;
    return null;
  }

  function makeButton(label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'web_ui__Button__button web_ui__Button__outlined web_ui__Button__small web_ui__Button__primary web_ui__Button__truncated';
    const span1 = document.createElement('span');
    span1.className = 'web_ui__Button__content';
    const span2 = document.createElement('span');
    span2.className = 'web_ui__Button__label';
    span2.textContent = label;
    span1.appendChild(span2);
    btn.appendChild(span1);
    return btn;
  }

  async function fetchJson(url, opts = {}) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status}: ${txt}`);
    }
    return res.json();
  }

  function getCsrfFromHtml(html) {
    const m = html.match(/"CSRF_TOKEN"\s*:\s*"([^"]+)"/);
    return m ? m[1] : null;
  }

  function getCookie(name) {
    try {
      const parts = document.cookie.split(';').map(s => s.trim());
      // If duplicates exist, prefer the last occurrence
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (!p) continue;
        const eq = p.indexOf('=');
        if (eq > 0) {
          const k = decodeURIComponent(p.slice(0, eq).trim());
          if (k === name) return decodeURIComponent(p.slice(eq + 1));
        }
      }
    } catch (e) {}
    return null;
  }

  function getCsrfFromDOM() {
    try {
      const html = document.documentElement && document.documentElement.innerHTML;
      if (!html) return null;
      return getCsrfFromHtml(html);
    } catch (e) {
      return null;
    }
  }

  async function getTokensFromBg() {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'vinted:getTokens' }, res => {
          resolve(res || {});
        });
      } catch (e) {
        resolve({});
      }

    });
  }

  async function getOperationSettings() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get({ vinted_operation_settings: DEFAULT_OPERATION_SETTINGS }, data => {
          const value = data && data.vinted_operation_settings;
          resolve({ ...DEFAULT_OPERATION_SETTINGS, ...(value || {}) });
        });
      } catch (_) {
        resolve({ ...DEFAULT_OPERATION_SETTINGS });
      }
    });
  }

  function saveOperationSettings(settings) {
    try {
      chrome.storage.local.set({ vinted_operation_settings: settings });
    } catch (_) {}
  }

  async function waitBetweenOperations(onTick = null) {
    const settings = await getOperationSettings();
    let seconds = Number(settings.fixedDelaySeconds);
    const mode = settings.delayMode === 'random' ? 'Random delay' : 'Fixed delay';
    if (settings.delayMode === 'random') {
      const min = Math.max(6, Number(settings.randomMinSeconds));
      const max = Math.max(min, Number(settings.randomMaxSeconds));
      seconds = min + Math.random() * (max - min);
    }
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const totalMilliseconds = Math.ceil(seconds * 1000);
    const startedAt = Date.now();
    const tick = () => {
      const remainingMilliseconds = Math.max(0, totalMilliseconds - (Date.now() - startedAt));
      if (typeof onTick === 'function') {
        onTick({
          remainingSeconds: Math.ceil(remainingMilliseconds / 1000),
          totalSeconds: Math.ceil(totalMilliseconds / 1000),
          mode,
        });
      }
      return remainingMilliseconds;
    };
    tick();
    await new Promise(resolve => {
      const interval = setInterval(() => {
        if (tick() <= 0) {
          clearInterval(interval);
          resolve();
        }
      }, 250);
    });
  }

  // Extract member id from URL or cookie
  function getMemberId() {
    try {
      const m = (location.pathname || '').match(/\/member\/(\d+)/);
      if (m) return m[1];
    } catch (_) {}
    const vuid = getCookie('v_uid');
    return vuid && /^(\d+)$/.test(vuid) ? vuid : null;
  }

  function isMemberWardrobePage() {
    return /\/member\/\d+(?:\/|$)/.test(location.pathname || '');
  }

  function isItemDetailPage() {
    return /\/items\/\d+(?:[-/]|$)/.test(location.pathname || '');
  }

  function getItemStatus(item) {
    if (!item) return 'published';

    const flattenStatusValues = value => {
      if (value == null) return [];
      if (Array.isArray(value)) return value.flatMap(flattenStatusValues);
      if (typeof value === 'object') {
        return Object.values(value).flatMap(flattenStatusValues);
      }
      return [String(value)];
    };
    const rawValues = [
      item.status,
      item.item_status,
      item.state,
      item.visibility,
      item.type,
      item.current_status,
      item.listing_status,
      item.sale_status,
      item.active,
      item.is_active,
      item.status_code,
      item.status_value,
      item.reason,
    ].flatMap(flattenStatusValues);
    const raw = rawValues.map(value => String(value || '').trim().toLowerCase()).join(' ');

    if (item.is_draft || item.draft === true || item.isDraft) return 'draft';
    if (
      item.is_sold
      || item.sold === true
      || item.isSold
      || item.sold_item
      || item.is_sold_out
      || item.sold_at
      || item.is_closed
      || item.closed === true
      || item.closed_at
      || item.sale_id
      || item.sale
      || item.sold_price
      || item.buyer_id
      || item.buyer
      || item.transaction_id
      || item.transaction
      || item.order_id
      || (item.order && (item.order.id || item.order.status))
    ) return 'sold';
    if (item.is_hidden || item.hidden === true || item.isHidden) return 'hidden';
    if (item.active === false || item.is_active === false) return 'hidden';
    if (raw.includes('draft')) return 'draft';
    if (raw.includes('sold') || raw.includes('sold_out') || raw.includes('sold out') || raw.includes('completed') || raw.includes('transaction') || raw.includes('paid')) return 'sold';
    if (raw.includes('hidden') || raw.includes('inactive') || raw.includes('unpublished') || raw.includes('archived')) return 'hidden';
    if (raw.includes('not_active') || raw.includes('not active') || raw.includes('disabled')) return 'hidden';
    return 'published';
  }

  function getItemIdFromUrl() {
    const m = (location.pathname || '').match(/\/items\/(\d+)(?:[-/]|$)/);
    return m ? m[1] : null;
  }

  function findItemPageBumpButton() {
    const direct = document.querySelector(BOOST_BUTTON_SELECTOR);
    if (direct) return direct;

    const buttons = Array.from(document.querySelectorAll('button'));
    for (const button of buttons) {
      const text = `${button.textContent || ''} ${button.getAttribute('aria-label') || ''}`.toLowerCase();
      if (/\bbump\b|\bboost\b/.test(text)) return button;
    }
    return null;
  }

  async function fetchWardrobePage(pageNum = 1) {
    const memberId = getMemberId();
    if (!memberId) return null;
    
    let csrf = null;
    try { csrf = await getCsrf(); } catch (_) { csrf = null; }
    let anonId = getCookie('anon_id');
    if (!anonId) {
      try { const bg = await getTokensFromBg(); anonId = (bg && bg.anonId) || null; } catch (_) {}
    }
    
    const params = new URLSearchParams({ page: String(pageNum), per_page: '100', order: 'relevance' }).toString();
    try {
      const res = await fetch(`${ORIGIN}/api/v2/wardrobe/${memberId}/items?${params}`, {
        credentials: 'include',
        headers: {
          'accept': 'application/json, text/plain, */*',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
          ...(anonId ? { 'x-anon-id': anonId } : {}),
          'referer': location.href,
        },
      });
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch (_) {}
        return { error: true, status: res.status, body };
      }
      const j = await res.json().catch(() => null);
      if (!j) return { error: true, status: res.status, body: 'Invalid JSON response' };
      
      // Update pagination info
      const pagination = j.pagination || {};
      if (pagination.total_pages) {
        totalPages = pagination.total_pages;
      }
      
      const items = j.items || [];
      // Cache the items and their creation labels
      for (const it of items) {
        const item = it && it.id ? it : (it && it.item ? it.item : it);
        const id = item && item.id; if (!id) continue;
        wardrobeItemMap.set(String(id), item);
        wardrobeItemStatus.set(String(id), getItemStatus(item));
        if (getItemStatus(item) === 'published') syncItemBackup(item);
        const comp = computeDaysFromPhotos(item);
        if (!comp) continue;
        const label = formatDaysFr(comp.days);
        createdAtCache.set(String(id), label);
      }
      
      return { items, pagination };
    } catch (error) {
      return { error: true, status: 0, body: error && error.message ? error.message : String(error) };
    }
  }

  async function fetchWardrobeAndAnnotate() {
    if (wardrobeFetched) return { items: Array.from(wardrobeItemMap.values()) };
    if (wardrobeFetchPromise) return wardrobeFetchPromise;
    wardrobeFetchPromise = (async () => {
      const result = await fetchWardrobePage(1);
      if (result && !result.error) {
        wardrobeFetched = true;
        lastFetchedPage = 1;
        applyCreatedLabels();
      }
      return result;
    })();
    try {
      return await wardrobeFetchPromise;
    } finally {
      wardrobeFetchPromise = null;
    }
  }

  async function getEditableItemDetails(itemId, csrf) {
    const { anonId } = await getTokensFromBg();
    const res = await fetch(`${ORIGIN}/api/v2/item_upload/items/${itemId}`, {
      credentials: 'include',
      headers: {
        'x-csrf-token': csrf,
        'x-enable-multiple-size-groups': 'true',
        ...(anonId ? { 'x-anon-id': anonId } : {}),
        accept: 'application/json, text/plain, */*',
      },
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (_) {}
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    const data = await res.json();
    return data.item || data || {};
  }

  async function verifyWardrobeBackups() {
    const candidates = Array.from(wardrobeItemMap.entries())
      .filter(([id, item]) => wardrobeItemStatus.get(id) === 'published' && !wardrobeBackups.has(id) && item);
    if (!candidates.length) return;

    let csrf;
    try {
      csrf = await getCsrf();
    } catch (error) {
      log('Could not verify wardrobe item backups:', error);
      return;
    }

    let nextCandidate = 0;
    const verifyNext = async () => {
      while (nextCandidate < candidates.length) {
        const [id, summary] = candidates[nextCandidate++];
        try {
          const details = await withTimeout(
            getEditableItemDetails(id, csrf),
            8000,
            `Checking item ${id}`,
          );
          const item = { ...summary, ...details, id: summary.id || details.id || id };
          wardrobeItemMap.set(id, item);
          const status = getItemStatus(item);
          wardrobeItemStatus.set(id, status);
          if (status === 'published') syncItemBackup(item, { initial: true });
        } catch (error) {
          wardrobeItemStatus.set(id, 'sold');
          wardrobeItemMap.set(id, { ...summary, id, is_sold: true });
          log(`Could not back up item ${id}; marking it as sold:`, error);
        }
        if (typeof activeWardrobeManagerRenderer === 'function') activeWardrobeManagerRenderer();
      }
    };
    await Promise.all([verifyNext(), verifyNext(), verifyNext(), verifyNext()]);
    applyCreatedLabels();
  }

  async function fetchAllWardrobeItems(onProgress = () => {}) {
    wardrobeSyncStartedAt = Date.now();
    if (!wardrobeFetched) {
      wardrobeItemMap.clear();
      wardrobeItemStatus.clear();
      lastFetchedPage = 0;
      totalPages = null;
      let firstPage = await fetchWardrobeAndAnnotate();
      for (let retry = 0; (!firstPage || firstPage.error) && retry < WARDROBE_RETRY_DELAYS_MS.length; retry++) {
        onProgress(1, totalPages, 'Retrying the first wardrobe page after a temporary response...');
        await wait(WARDROBE_RETRY_DELAYS_MS[retry]);
        wardrobeFetched = false;
        firstPage = await fetchWardrobeAndAnnotate();
      }
      if (!firstPage || firstPage.error) throw new Error('Could not fetch the first wardrobe page');
    }
    let nextPage = Math.max(2, lastFetchedPage + 1);
    let attempts = 100;
    while (attempts-- > 0 && (totalPages === null || nextPage <= totalPages)) {
      onProgress(nextPage, totalPages);
      const idsBeforePage = new Set(wardrobeItemMap.keys());
      let result = null;
      let lastError = null;
      for (let retry = 0; retry <= WARDROBE_RETRY_DELAYS_MS.length; retry++) {
        result = await fetchWardrobePage(nextPage);
        if (result && !result.error) break;
        lastError = result;
        if (retry < WARDROBE_RETRY_DELAYS_MS.length) {
          onProgress(nextPage, totalPages, `Retrying page ${nextPage} after a temporary response...`);
          await wait(WARDROBE_RETRY_DELAYS_MS[retry]);
        }
      }
      if (!result || result.error) {
        const status = lastError && lastError.status ? ` (HTTP ${lastError.status})` : '';
        throw new Error(`Could not fetch wardrobe page ${nextPage}${status} after retries`);
      }
      if (!result.items || result.items.length === 0) break;
      const pageIds = new Set(result.items.map(item => String(item && (item.id || (item.item && item.item.id) || ''))).filter(Boolean));
      const hasNewItem = Array.from(pageIds).some(id => !idsBeforePage.has(id));
      if (!hasNewItem && pageIds.size > 0 && totalPages === null) break;
      lastFetchedPage = nextPage;
      nextPage++;
      await wait(getWardrobePageDelay());
    }
    if (totalPages !== null && lastFetchedPage < totalPages) {
      throw new Error(`Wardrobe loading stopped at page ${lastFetchedPage} of ${totalPages}`);
    }
    removeInactiveBackups();
  }

  async function fetchDraftItems() {
    const csrf = await getCsrf().catch(() => null);
    const { anonId } = await getTokensFromBg();
    const drafts = [];
    for (let page = 1; page <= 100; page++) {
      const params = new URLSearchParams({ page: String(page), per_page: '100' });
      let response;
      try {
        response = await fetch(`${ORIGIN}/api/v2/item_upload/drafts?${params}`, {
          credentials: 'include',
          headers: {
            accept: 'application/json, text/plain, */*',
            ...(csrf ? { 'x-csrf-token': csrf } : {}),
            ...(anonId ? { 'x-anon-id': anonId } : {}),
          },
        });
      } catch (_) {
        break;
      }
      if (!response.ok) break;
      const data = await response.json().catch(() => null);
      const items = data && (data.items || data.drafts || (data.draft ? [data.draft] : []));
      if (!Array.isArray(items) || !items.length) break;
      for (const item of items) {
        if (!item || !item.id) continue;
        const id = String(item.id);
        wardrobeItemMap.set(id, { ...item, is_draft: true });
        wardrobeItemStatus.set(id, 'draft');
        drafts.push(id);
      }
      const pages = data && data.pagination && data.pagination.total_pages;
      if ((pages && page >= pages) || items.length < 100) break;
      await wait(getWardrobePageDelay());
    }
    return drafts;
  }

  async function hydrateMissingItemTitles() {
    const missing = Array.from(wardrobeItemMap.entries())
      .filter(([, item]) => !itemTitle(item));
    if (!missing.length) return;

    let csrf;
    try {
      csrf = await getCsrf();
    } catch (error) {
      log('Could not load item titles:', error);
      return;
    }
    for (const [id, item] of missing) {
      try {
        const details = await getItemDetails(id, csrf);
        const title = itemTitle(details);
        if (title) wardrobeItemMap.set(id, { ...item, ...details, id: item.id || details.id });
      } catch (error) {
        log(`Could not load title for item ${id}:`, error);
      }
    }
  }

  function getDescriptionContainerById(id) {
    // Primary selector (as per provided HTML): data-testid="product-item-id-<id>--description--content"
    const exact = document.querySelector(`[data-testid="product-item-id-${id}--description--content"]`);
    if (exact) return exact;
    // Fallback older layout
    const compat = document.querySelector(`[data-testid="product-item-id-${id}--description"] .web_ui__Cell__body`);
    if (compat) return compat;
    return null;
  }

  function computeDaysFromPhotos(item) {
    const photos = (item && item.photos) || [];
    let ts = null;
    for (const p of photos) {
      const hr = p && p.high_resolution;
      let t = hr && hr.timestamp;
      if (t != null) {
        const num = typeof t === 'number' ? t : parseInt(String(t), 10);
        if (!Number.isNaN(num)) {
          ts = ts == null ? num : Math.min(ts, num);
        }
      }
    }
    if (ts == null) return null;
  // Timestamps appear to be epoch seconds in examples
  const created = new Date(ts * 1000);
  // Use calendar-day difference (local) so "yesterday" shows as 1 even if < 24h
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const createdStart = new Date(created.getFullYear(), created.getMonth(), created.getDate());
  const days = Math.max(0, Math.round((todayStart - createdStart) / 86400000));
  return { days, created };
  }

  function formatDaysFr(days) {
    if (days <= 0) return "Created today";
    return `Created ${days} days ago`;
  }

  function insertCreatedAtLine(container, label) {
    if (!container) return;
    if (container.querySelector('.vinted-created-at')) return; // avoid duplicates
    const wrap = document.createElement('div');
    wrap.className = 'new-item-box__description vinted-created-at';
    const p = document.createElement('p');
    p.className = 'web_ui__Text__text web_ui__Text__caption web_ui__Text__left web_ui__Text__truncated';
    p.textContent = label;
    wrap.appendChild(p);
    container.appendChild(wrap);
  }

  function insertItemStatusLine(container, id, status) {
    if (!container || !status) return;
    let wrap = container.querySelector(`[data-vinted-item-status="${id}"]`);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'new-item-box__description vinted-item-status-label';
      wrap.dataset.vintedItemStatus = id;
      container.appendChild(wrap);
    }
    wrap.textContent = status === 'sold' ? 'Sold - not available for relisting' : 'On sale - available for relisting';
    wrap.classList.toggle('is-sold', status === 'sold');
  }

  function getVisibleItemIds() {
    const itemElements = document.querySelectorAll(ITEM_CARD_SELECTOR);
    const itemIds = [];
    for (const el of itemElements) {
      const testid = el.getAttribute('data-testid') || '';
      const m = testid.match(/^product-item-id-(\d+)/);
      if (m) {
        itemIds.push(m[1]);
      }
    }
    return itemIds;
  }

  async function fetchMissingItemDataInternal() {
    // Get all visible item IDs
    const visibleIds = getVisibleItemIds();
    const missingIds = visibleIds.filter(id => !wardrobeItemMap.has(id));
    
    if (missingIds.length === 0) {
      return; // No missing items
    }

    function itemPrice(item) {
      const price = item && item.price;
      const value = item && (item.price_numeric || (price && price.amount) || price);
      const parsed = Number.parseFloat(String(value == null ? '' : value));
      return Number.isFinite(parsed) ? parsed : null;
    }

    function itemViews(item) {
      const stats = item && (item.statistics || item.stats || item.item_statistics || item.analytics || {});
      return Number(item && (item.views_count ?? item.view_count ?? stats.views_count ?? stats.views ?? 0)) || 0;
    }

    function itemFavourites(item) {
      const stats = item && (item.statistics || item.stats || item.item_statistics || item.analytics || {});
      return Number(item && (item.favourite_count ?? item.favorites_count ?? item.favourites_count ?? stats.favourite_count ?? stats.favourites ?? stats.favorites ?? 0)) || 0;
    }

    function itemTimestamp(item) {
      const photos = (item && item.photos) || [];
      const timestamps = photos
        .map(photo => photo && photo.high_resolution && Number(photo.high_resolution.timestamp))
        .filter(value => Number.isFinite(value));
      return timestamps.length ? Math.min(...timestamps) * 1000 : 0;
    }

    function itemPhotoUrl(item) {
      const photo = item && item.photos && item.photos[0];
      return photo && (photo.full_size_url || photo.url || (photo.thumbnails && photo.thumbnails[0] && photo.thumbnails[0].url));
    }

    function sortedWardrobeItems(search, sort) {
      const query = String(search || '').trim().toLowerCase();
      const items = Array.from(wardrobeItemMap.values()).filter(item => {
        if (!query) return true;
        return itemTitle(item).toLowerCase().includes(query);
      });
      const direction = sort.endsWith('-desc') ? -1 : 1;
      const key = sort.replace(/-(asc|desc)$/, '');
      items.sort((a, b) => {
        let left;
        let right;
        if (key === 'title') {
          left = itemTitle(a).toLowerCase();
          right = itemTitle(b).toLowerCase();
        } else if (key === 'price') {
          left = itemPrice(a);
          right = itemPrice(b);
        } else if (key === 'views') {
          left = itemViews(a);
          right = itemViews(b);
        } else if (key === 'favourites') {
          left = itemFavourites(a);
          right = itemFavourites(b);
        } else {
          left = itemTimestamp(a);
          right = itemTimestamp(b);
        }
        if (left == null || !Number.isFinite(left)) return 1;
        if (right == null || !Number.isFinite(right)) return -1;
        return (left < right ? -1 : left > right ? 1 : 0) * direction;
      });
      return items;
    }

    function makePanelButton(label, className = '') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (className) button.className = className;
      return button;
    }

    function renderWardrobeManagerItems(container, searchInput, sortSelect, countLabel) {
      const items = sortedWardrobeItems(searchInput.value, sortSelect.value);
      container.textContent = '';
      countLabel.textContent = `${items.length} shown - ${selectedWardrobeIds.size} selected`;
      for (const item of items) {
        const id = String(item.id);
          const status = wardrobeItemStatus.get(id) || getItemStatus(item);
          const row = document.createElement('div');
          row.className = 'vinted-wardrobe-item';
          row.classList.add(`vinted-wardrobe-item--${status}`);
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = selectedWardrobeIds.has(id);
          checkbox.addEventListener('change', () => {
            if (checkbox.checked) selectedWardrobeIds.add(id);
            else selectedWardrobeIds.delete(id);
            renderWardrobeManagerItems(container, searchInput, sortSelect, countLabel);
          });
          const image = document.createElement('img');
          const imageUrl = itemPhotoUrl(item);
          if (imageUrl) image.src = imageUrl;
          image.alt = '';
          const details = document.createElement('div');
          const title = document.createElement('div');
          title.className = 'vinted-wardrobe-item__title';
          title.textContent = itemTitle(item) || `Item ${id}`;
          const meta = document.createElement('div');
          meta.className = 'vinted-wardrobe-item__meta';
          const price = itemPrice(item);
          const views = item.views_count ?? item.view_count;
          const favourites = item.favourite_count ?? item.favorites_count ?? item.favourites_count;
          const label = (status === 'published' ? 'On sale' : status === 'hidden' ? 'Hidden' : status === 'draft' ? 'Draft' : status === 'sold' ? 'Sold' : 'On sale');
          const published = itemPublishedAt(item);
          meta.textContent = `${label} - ${price == null ? '-' : price.toFixed(2)} ${item.price_currency || ''} - ${views == null ? '-' : views} views - ${favourites == null ? '-' : favourites} favourites`;
          const publishing = document.createElement('div');
          publishing.className = 'vinted-wardrobe-item__meta';
          publishing.textContent = published
            ? `Published ${published.toLocaleDateString()} ${published.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : (createdAtCache.get(id) || 'Publishing date unavailable');
          const backup = wardrobeBackups.get(id);
          if (backup) {
            const backupBadge = document.createElement('span');
            backupBadge.className = 'vinted-wardrobe-item__backup';
            backupBadge.textContent = backup.lastRelistedAt ? `Backed up · relisted ${new Date(backup.lastRelistedAt).toLocaleDateString()}` : 'Backed up';
            details.append(title, meta, publishing, backupBadge);
          } else {
            details.append(title, meta, publishing);
          }
          const open = makePanelButton('Open');
          open.addEventListener('click', () => window.open(`${ORIGIN}/items/${id}`, '_blank', 'noopener'));
          const statusBadge = document.createElement('span');
          statusBadge.className = `vinted-item-status vinted-item-status--${status}`;
          statusBadge.textContent = status === 'published' ? 'On sale' : status === 'hidden' ? 'Hidden' : status === 'sold' ? 'Sold' : 'Draft';
          row.append(checkbox, image, details, statusBadge, open);
          container.appendChild(row);
        }
      }

    async function runBulkAction(ids, action, onDelay = null) {
      const csrf = await getCsrf();
      const results = { succeeded: [], failed: [] };
      for (let index = 0; index < ids.length; index++) {
        const id = ids[index];
        try {
          await action(id, csrf);
          results.succeeded.push(id);
        } catch (error) {
          results.failed.push({ id, error: error && error.message ? error.message : String(error) });
        }
        if (index < ids.length - 1) {
          await waitBetweenOperations(timing => {
            if (typeof onDelay === 'function') onDelay(ids[index + 1], timing);
          });
        }
      }
      return results;
    }

    log(`Found ${missingIds.length} missing items:`, missingIds.join(', '));

    // If we don't know the total pages yet, or we haven't fetched all pages yet, try to fetch more
    if (totalPages === null || lastFetchedPage < totalPages) {
      // Fetch additional pages until we have all the missing items or run out of pages
      let nextPage = lastFetchedPage + 1;
      let maxAttempts = 10; // Prevent infinite loops
      
      while (missingIds.some(id => !wardrobeItemMap.has(id)) && maxAttempts > 0) {
        if (totalPages !== null && nextPage > totalPages) {
          break; // No more pages to fetch
        }
        
        log(`Fetching wardrobe page ${nextPage} for missing items...`);
        const result = await fetchWardrobePage(nextPage);
        if (!result || !result.items || result.items.length === 0) {
          log(`No more data available at page ${nextPage}`);
          break; // No more data
        }
        
        log(`Fetched ${result.items.length} items from page ${nextPage}`);
        lastFetchedPage = nextPage;
        nextPage++;
        maxAttempts--;
        
        // Small delay to avoid overwhelming the API
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Apply labels after fetching new data
      applyCreatedLabels();
    }
  }

  async function fetchMissingItemData() {
    if (missingItemFetchInFlight) return;
    missingItemFetchInFlight = true;
    try {
      await fetchMissingItemDataInternal();
    } finally {
      missingItemFetchInFlight = false;
    }
  }

  function itemPrice(item) {
    const price = item && item.price;
    const value = item && (item.price_numeric || (price && price.amount) || price);
    const parsed = Number.parseFloat(String(value == null ? '' : value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function itemTimestamp(item) {
    const timestamps = ((item && item.photos) || [])
      .map(photo => photo && photo.high_resolution && Number(photo.high_resolution.timestamp))
      .filter(value => Number.isFinite(value));
    return timestamps.length ? Math.min(...timestamps) * 1000 : 0;
  }

  function itemPhotoUrl(item) {
    const photo = item && item.photos && item.photos[0];
    return photo && (photo.full_size_url || photo.url || (photo.thumbnails && photo.thumbnails[0] && photo.thumbnails[0].url));
  }

  function createRelistPacer(maxDelayMs = 5000) {
    let elapsed = 0;
    return async (minimum, maximum) => {
      const available = Math.max(0, maxDelayMs - elapsed);
      const delay = Math.min(
        available,
        Math.round(minimum + Math.random() * Math.max(0, maximum - minimum))
      );
      if (!delay) return;
      elapsed += delay;
      await wait(delay);
    };
  }

  function sortedWardrobeItems(search, sort, status = 'all') {
    const query = String(search || '').trim().toLowerCase();
    const items = Array.from(wardrobeItemMap.values()).filter(item =>
      (!query || itemTitle(item).toLowerCase().includes(query)) &&
      (status === 'all'
        || (status === 'published'
          ? isOnSale(item)
          : wardrobeItemStatus.get(String(item.id)) === status))
    );
    const direction = sort.endsWith('-desc') ? -1 : 1;
    const key = sort.replace(/-(asc|desc)$/, '');
    items.sort((a, b) => {
      let left;
      let right;
      if (key === 'title') {
        left = itemTitle(a).toLowerCase();
        right = itemTitle(b).toLowerCase();
      } else if (key === 'price') {
        left = itemPrice(a);
        right = itemPrice(b);
      } else if (key === 'views') {
        left = itemViews(a);
        right = itemViews(b);
      } else if (key === 'favourites') {
        left = itemFavourites(a);
        right = itemFavourites(b);
      } else {
        left = itemTimestamp(a);
        right = itemTimestamp(b);
      }
      if (left == null || !Number.isFinite(left)) return 1;
      if (right == null || !Number.isFinite(right)) return -1;
      return (left < right ? -1 : left > right ? 1 : 0) * direction;
    });
    return items;
  }

  function makePanelButton(label, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (className) button.className = className;
    return button;
  }

  function createBulkRelistProgress(ids) {
    const overlay = document.createElement('div');
    overlay.className = 'vinted-bulk-relist-progress';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const dialog = document.createElement('div');
    dialog.className = 'vinted-bulk-relist-progress__dialog';
    const header = document.createElement('header');
    header.className = 'vinted-bulk-relist-progress__header';
    const heading = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = `Drafts created - ${ids.length} item${ids.length === 1 ? '' : 's'}`;
    const subtitle = document.createElement('p');
    subtitle.textContent = "Task running - don't close the page.";
    heading.append(title, subtitle);
    const counter = document.createElement('strong');
    counter.className = 'vinted-bulk-relist-progress__counter';
    header.append(heading, counter);
    const track = document.createElement('div');
    track.className = 'vinted-bulk-relist-progress__track';
    const bar = document.createElement('div');
    bar.className = 'vinted-bulk-relist-progress__bar';
    track.appendChild(bar);
    const list = document.createElement('div');
    list.className = 'vinted-bulk-relist-progress__list';
    const rows = new Map();
    const states = new Map(ids.map(id => [String(id), { status: 'pending', message: 'Pending' }]));
    ids.forEach(id => {
      const item = wardrobeItemMap.get(String(id));
      const row = document.createElement('div');
      row.className = 'vinted-bulk-relist-progress__item';
      const icon = document.createElement('span');
      icon.className = 'vinted-bulk-relist-progress__icon is-pending';
      const image = document.createElement('img');
      image.alt = '';
      const imageUrl = itemPhotoUrl(item);
      if (imageUrl) image.src = imageUrl;
      const details = document.createElement('div');
      details.className = 'vinted-bulk-relist-progress__details';
      const itemName = document.createElement('strong');
      itemName.textContent = itemTitle(item) || `Item ${id}`;
      const status = document.createElement('span');
      status.textContent = 'Pending';
      details.append(itemName, status);
      row.append(icon, image, details);
      list.appendChild(row);
      rows.set(String(id), { icon, status });
    });
    const footer = document.createElement('footer');
    footer.className = 'vinted-bulk-relist-progress__footer';
    const summary = document.createElement('span');
    const close = makePanelButton('Close');
    close.className = 'vinted-bulk-relist-progress__close';
    close.hidden = true;
    close.addEventListener('click', () => overlay.remove());
    footer.append(summary, close);
    dialog.append(header, track, list, footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const render = () => {
      let done = 0;
      let failed = 0;
      states.forEach((entry, id) => {
        const row = rows.get(id);
        row.icon.className = `vinted-bulk-relist-progress__icon is-${entry.status}`;
        row.status.textContent = entry.message;
        if (entry.status === 'completed') done++;
        if (entry.status === 'failed') failed++;
      });
      const finished = done + failed;
      counter.textContent = `${finished}/${ids.length}`;
      bar.style.width = `${ids.length ? finished / ids.length * 100 : 0}%`;
      summary.textContent = failed ? `${done} done - ${failed} failed` : `${done} done`;
      if (finished === ids.length) {
        subtitle.textContent = failed ? 'Task finished with errors.' : 'Task completed.';
        close.hidden = false;
      }
    };
    const update = (id, status, message) => {
      const key = String(id);
      if (!states.has(key)) return;
      states.set(key, { status, message });
      render();
    };
    render();
    return { update };
  }

  function renderWardrobeManagerItems(container, searchInput, sortSelect, statusSelect, countLabel) {
    const items = sortedWardrobeItems(searchInput.value, sortSelect.value, statusSelect.value);
    container.textContent = '';
    const published = Array.from(wardrobeItemMap.values()).filter(item => isOnSale(item)).length;
    const drafts = Array.from(wardrobeItemStatus.values()).filter(status => status === 'draft').length;
    const hidden = Array.from(wardrobeItemStatus.values()).filter(status => status === 'hidden').length;
    const sold = Array.from(wardrobeItemStatus.values()).filter(status => status === 'sold').length;
    countLabel.textContent = `${items.length} shown - ${selectedWardrobeIds.size} selected - ${published} on sale - ${hidden} hidden - ${sold} sold - ${drafts} drafts`;
    for (const item of items) {
      const id = String(item.id);
      const row = document.createElement('div');
      row.className = 'vinted-wardrobe-item';
      row.classList.add(`vinted-wardrobe-item--${wardrobeItemStatus.get(id) || getItemStatus(item)}`);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedWardrobeIds.has(id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedWardrobeIds.add(id);
        else selectedWardrobeIds.delete(id);
        renderWardrobeManagerItems(container, searchInput, sortSelect, statusSelect, countLabel);
      });
      const image = document.createElement('img');
      const imageUrl = itemPhotoUrl(item);
      if (imageUrl) image.src = imageUrl;
      image.alt = '';
      const details = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'vinted-wardrobe-item__title';
      title.textContent = itemTitle(item) || `Item ${id}`;
      const meta = document.createElement('div');
      meta.className = 'vinted-wardrobe-item__meta';
      const price = itemPrice(item);
      const views = item.views_count ?? item.view_count;
      const favourites = item.favourite_count ?? item.favorites_count ?? item.favourites_count;
      const status = wardrobeItemStatus.get(id) || getItemStatus(item);
      const statusLabel = status === 'published' ? 'On sale' : status === 'hidden' ? 'Hidden' : status === 'draft' ? 'Draft' : status === 'sold' ? 'Sold' : 'On sale';
      const published = itemPublishedAt(item);
      meta.textContent = `${statusLabel} - ${price == null ? '-' : price.toFixed(2)} ${item.price_currency || ''} - ${views == null ? '-' : views} views - ${favourites == null ? '-' : favourites} favourites`;
      const publishing = document.createElement('div');
      publishing.className = 'vinted-wardrobe-item__meta';
      publishing.textContent = published
        ? `Published ${published.toLocaleDateString()} ${published.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : (createdAtCache.get(id) || 'Publishing date unavailable');
      const backup = wardrobeBackups.get(id);
      if (backup) {
        const backupBadge = document.createElement('span');
        backupBadge.className = 'vinted-wardrobe-item__backup';
        backupBadge.textContent = backup.lastRelistedAt ? `Backed up - relisted ${new Date(backup.lastRelistedAt).toLocaleDateString()}` : 'Backed up';
        details.append(title, meta, publishing, backupBadge);
      } else {
        details.append(title, meta, publishing);
      }
      const open = makePanelButton(wardrobeItemStatus.get(id) === 'draft' ? 'Edit draft' : 'Open');
      open.addEventListener('click', () => window.open(
        wardrobeItemStatus.get(id) === 'draft' ? `${ORIGIN}/items/${id}/edit` : `${ORIGIN}/items/${id}`,
        '_blank',
        'noopener'
      ));
      const statusBadge = document.createElement('span');
      statusBadge.className = `vinted-item-status vinted-item-status--${status}`;
      statusBadge.textContent = status === 'published' ? 'On sale' : status === 'hidden' ? 'Hidden' : status === 'sold' ? 'Sold' : 'Draft';
      row.append(checkbox, image, details, statusBadge, open);
      container.appendChild(row);
    }
  }

  async function runBulkAction(ids, action, onDelay = null) {
    const csrf = await getCsrf();
    const results = { succeeded: [], failed: [] };
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      try {
        await action(id, csrf);
        results.succeeded.push(id);
      } catch (error) {
        results.failed.push({ id, error: error && error.message ? error.message : String(error) });
      }
      if (index < ids.length - 1) {
        await waitBetweenOperations(timing => {
          if (typeof onDelay === 'function') onDelay(ids[index + 1], timing);
        });
      }
    }
    return results;
  }

  function applyCreatedLabels() {
    const ids = new Set([...createdAtCache.keys(), ...wardrobeItemStatus.keys()]);
    for (const id of ids) {
      const desc = getDescriptionContainerById(id);
      if (!desc) continue;
      const label = createdAtCache.get(id);
      if (label) insertCreatedAtLine(desc, label);
      insertItemStatusLine(desc, id, wardrobeItemStatus.get(id));
    }
  }

  async function getCsrf() {
    // 1) Try to parse CSRF directly from current member page DOM
    const fromDom = getCsrfFromDOM();
    if (fromDom) return fromDom;
    // 2) Try to reuse CSRF captured from other requests (background)
    const fromBg = await getTokensFromBg();
    if (fromBg && fromBg.csrf) return fromBg.csrf;
    // 3) Fallback: load items/new and parse token from HTML
  const res = await fetch(`${ORIGIN}/items/new`, { credentials: 'include' });
  const html = await res.text();
  const token = getCsrfFromHtml(html);
  if (!token) throw new Error('Could not extract CSRF token. Please refresh the page and try again.');
    return token;
  }

  async function getItemDetails(itemId, csrf) {
    const { anonId } = await getTokensFromBg();
    // Try editor endpoint first (richer, expects CSRF)
    try {
  const res = await fetch(`${ORIGIN}/api/v2/item_upload/items/${itemId}`, {
        credentials: 'include',
        headers: {
          'x-csrf-token': csrf,
          'x-enable-multiple-size-groups': 'true',
          ...(anonId ? { 'x-anon-id': anonId } : {}),
          'accept': 'application/json, text/plain, */*'
        },
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt}`);
      }
      const j = await res.json();
      return j.item || j || {};
    } catch (e) {
      // Fallback to public item endpoint, still pass CSRF/anon when available
  const res = await fetch(`${ORIGIN}/api/v2/items/${itemId}`, {
        credentials: 'include',
        headers: {
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
          ...(anonId ? { 'x-anon-id': anonId } : {}),
          'accept': 'application/json, text/plain, */*'
        },
      });
      if (!res.ok) {
        const txt = await res.text();
        // Surface Cloudflare/DataDome challenge clearly
        if (res.status === 403 && /__cf_chl|cf_chl/.test(txt || '')) {
          throw new Error('Blocked by Cloudflare/DataDome (403). Logout and Login then try again');
        }
        throw new Error(`HTTP ${res.status}: ${txt}`);
      }
      const j = await res.json();
      return j.item || {};
    }
  }

  function resolveSizeId(item) {
    const candidates = [
      item && item.size_id,
      item && item.size && item.size.id,
      item && item.size && item.size.size_id,
      item && item.size_dto && item.size_dto.id,
      item && item.size_dto && item.size_dto.size_id,
      item && item.sizeDto && item.sizeDto.id,
      item && item.size_info && item.size_info.id,
      // sizes array (some endpoints return an array)
      item && Array.isArray(item.sizes) && item.sizes.length > 0 && item.sizes[0].id,
      item && Array.isArray(item.sizes) && item.sizes.length > 0 && item.sizes[0].size_id,
    ];

    for (const candidate of candidates) {
      const parsed = parseInt(String(candidate), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    const attrs = Array.isArray(item && item.item_attributes) ? item.item_attributes : [];
    for (const attr of attrs) {
      const key = String(attr && (attr.code || attr.type || attr.name || attr.title || '')).toLowerCase();
      if (key === 'size' || key.includes('size')) {
        const valueCandidate = attr && (attr.value_id || attr.selected_value_id || attr.id || attr.value);
        const parsed = parseInt(String(valueCandidate), 10);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
      }
    }

    return null;
  }

  function resolveSizeGroupId(item) {
    // size_group_id is required by Vinted's multi-size-group API for some categories
    const candidates = [
      item && item.size_group_id,
      item && item.catalog_size_group_id,
      item && item.size_group && item.size_group.id,
      item && item.size_dto && item.size_dto.size_group_id,
      item && item.size_dto && item.size_dto.group_id,
      item && item.sizeDto && item.sizeDto.size_group_id,
      item && item.size && item.size.size_group_id,
      item && item.size && item.size.group_id,
    ];
    for (const candidate of candidates) {
      const parsed = parseInt(String(candidate), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
  }

  function pickPhotos(src) {
    const out = [];
    const photos = src.photos || [];
    for (const p of photos) {
      const u = p.full_size_url || p.url || (p.thumbnails && p.thumbnails[0] && p.thumbnails[0].url);
      if (u) out.push(u);
    }
    return out;
  }

  async function downloadAsBlob(url) {
    // Try without credentials first; CDN images are public but CORS may block with include
    try {
      const res = await fetch(url, { credentials: 'omit', mode: 'cors' });
      if (res.ok) return res.blob();
      // fallthrough to background fetch
    } catch (_) {}
    // Use background service worker to fetch as ArrayBuffer and reconstruct Blob
    const bgRes = await new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: 'vinted:fetchArrayBuffer', url }, resolve);
      } catch (e) {
        resolve({ ok: false, error: e && e.message });
      }
    });
    if (!bgRes || !bgRes.ok || !bgRes.buffer) {
      throw new Error(`Failed to download via background: ${url} ${bgRes && (bgRes.status || bgRes.error) || ''}`);
    }
    try {
      const buf = bgRes.buffer;
      // In MV3, structured cloning supports ArrayBuffer transfer
      const contentType = bgRes.contentType || 'image/jpeg';
      return new Blob([buf], { type: contentType });
    } catch (e) {
      // Fallback: force JPEG
      return new Blob([bgRes.buffer], { type: 'image/jpeg' });
    }
  }

  async function uploadPhoto(csrf, file, tempUuid) {
    const fd = new FormData();
    fd.append('photo[type]', 'item');
    fd.append('photo[temp_uuid]', tempUuid);
    fd.append('photo[file]', file, 'photo.jpg');
    let anonId = getCookie('anon_id');
    if (!anonId) {
      const bg = await getTokensFromBg();
      anonId = (bg && bg.anonId) || null;
    }
  const res = await fetch(`${ORIGIN}/api/v2/photos`, {
      method: 'POST',
      body: fd,
      credentials: 'include',
      headers: {
        'x-csrf-token': csrf,
        'x-enable-multiple-size-groups': 'true',
        ...(anonId ? { 'x-anon-id': anonId } : {}),
      },
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    return res.json();
  }

  async function createDraft(csrf, payload) {
    let anonId = getCookie('anon_id');
    if (!anonId) {
      const bg = await getTokensFromBg();
      anonId = (bg && bg.anonId) || null;
    }

  const res = await fetch(`${ORIGIN}/api/v2/item_upload/drafts`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'x-enable-multiple-size-groups': 'true',
        'x-upload-form': 'true',
        ...(anonId ? { 'x-anon-id': anonId } : {}),
        'origin': location.origin,
        'referer': location.href,
      },
      body: JSON.stringify({
        draft: payload.item,
        parcel: payload.parcel,
        upload_session_id: payload.upload_session_id,
      }),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (_) {}
      if (res.status === 403 && /captcha-delivery|__cf_chl|cf_chl|datadome/i.test(body || '')) {
        throw new Error('Blocked by anti-bot (DataDome/Cloudflare). Logout and Login then try again');
      }
      throw new Error(`Draft creation failed: ${res.status} ${body}`);
    }
    return res.json();
  }

  async function deleteItem(csrf, itemId) {
    let anonId = getCookie('anon_id');
    if (!anonId) {
      const bg = await getTokensFromBg();
      anonId = (bg && bg.anonId) || null;
    }

    async function setItemVisibility(csrf, itemId, visible) {
      let anonId = getCookie('anon_id');
      if (!anonId) {
        const bg = await getTokensFromBg();
        anonId = (bg && bg.anonId) || null;
      }
      const action = visible ? 'unhide' : 'hide';
      const res = await fetch(`${ORIGIN}/api/v2/items/${itemId}/${action}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json, text/plain, */*',
          'x-csrf-token': csrf,
          ...(anonId ? { 'x-anon-id': anonId } : {}),
        },
      });
      if (!res.ok) {
        let body = '';
        try { body = await res.text(); } catch (_) {}
        throw new Error(`${action} failed: ${res.status} ${body}`);
      }
    }
    const res = await fetch(`${ORIGIN}/api/v2/items/${itemId}/delete`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'x-csrf-token': csrf,
        ...(anonId ? { 'x-anon-id': anonId } : {}),
        accept: 'application/json, text/plain, */*',
      },
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (_) {}
      throw new Error(`Delete failed: ${res.status} ${body}`);
    }
  }

  async function updateItemPrice(csrf, itemId, newPrice) {
    const detail = await getItemDetails(itemId, csrf);
    const photos = (detail.photos || []).map(photo => ({
      id: photo.id,
      orientation: (photo.high_resolution && photo.high_resolution.orientation) || 0,
    })).filter(photo => photo.id);
    const colorIds = detail.color_ids || [detail.color1_id, detail.color2_id].filter(Boolean);
    const draft = {
      id: Number(itemId),
      title: detail.title || '',
      currency: detail.currency || detail.price_currency || 'EUR',
      description: detail.description || '',
      brand_id: detail.brand_id || null,
      size_id: resolveSizeId(detail),
      size_group_id: resolveSizeGroupId(detail),
      catalog_id: detail.catalog_id || null,
      status_id: detail.status_id || 1,
      price: newPrice,
      package_size_id: detail.package_size_id || 1,
      shipment_prices: detail.shipment_prices || { domestic: null, international: null },
      color_ids: colorIds || [],
      assigned_photos: photos,
      item_attributes: detail.item_attributes || [],
      measurement_length: detail.measurement_length ?? null,
      measurement_width: detail.measurement_width ?? null,
      measurement_unit: detail.measurement_unit ?? null,
      is_unisex: Boolean(detail.is_unisex),
      model: detail.model || null,
      isbn: detail.isbn || null,
      author: detail.author || null,
      book_title: detail.book_title || null,
      video_game_rating_id: detail.video_game_rating_id || null,
    };
    let anonId = getCookie('anon_id');
    if (!anonId) {
      const bg = await getTokensFromBg();
      anonId = (bg && bg.anonId) || null;
    }
    const res = await fetch(`${ORIGIN}/api/v2/item_upload/drafts/${itemId}/completion`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'x-enable-multiple-size-groups': 'true',
        ...(anonId ? { 'x-anon-id': anonId } : {}),
      },
      body: JSON.stringify({
        draft,
        feedback_id: null,
        parcel: detail.parcel || null,
        push_up: false,
        upload_session_id: uuidv4(),
      }),
    });
    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch (_) {}
      throw new Error(`Price update failed: ${res.status} ${body}`);
    }
  }

  async function openWardrobeManager() {
    if (wardrobeManagerOpen) return;
    wardrobeManagerOpen = true;
    ensureStyles();
    const loading = document.createElement('div');
    loading.className = 'vinted-manager-loading';
    loading.setAttribute('role', 'status');
    loading.setAttribute('aria-live', 'polite');
    const loadingCard = document.createElement('div');
    loadingCard.className = 'vinted-manager-loading__card';
    const spinner = document.createElement('div');
    spinner.className = 'vinted-manager-loading__spinner';
    const loadingHeading = document.createElement('h2');
    loadingHeading.textContent = 'Preparing wardrobe manager';
    const loadingMessage = document.createElement('p');
    loadingMessage.textContent = 'Fetching all member items... This may take a little while.';
    loadingCard.append(spinner, loadingHeading, loadingMessage);
    loading.appendChild(loadingCard);
    document.body.appendChild(loading);
    try {
      await withTimeout(loadOperationLogs(), 3000, 'Loading operation log');
      await withTimeout(loadAnalyticsSnapshots(), 3000, 'Loading analytics snapshots');
      await withTimeout(loadWardrobeBackups(), 3000, 'Loading local wardrobe backups');
      loadingMessage.textContent = 'Fetching all member items... Please keep this tab open.';
      await fetchAllWardrobeItems((page, total, detail) => {
        const progress = total ? ` (page ${page} of ${total})` : ` (page ${page})`;
        loadingMessage.textContent = `${detail || 'Fetching all member items...'}${progress}`;
      });
      verifyWardrobeBackups().catch(error => {
        log('Wardrobe availability verification failed:', error);
      });
      loadingMessage.textContent = 'Fetching drafts and preparing the manager...';
      await fetchDraftItems();
      loadingMessage.textContent = 'Loading item names...';
      await hydrateMissingItemTitles();
    } catch (error) {
      loading.remove();
      wardrobeManagerOpen = false;
      log('Wardrobe manager data loading failed:', error);
      addOperationLog('Error', error && error.message ? error.message : String(error), 'error');
      throw error;
    }
    loading.remove();
    const panel = document.createElement('section');
    panel.id = 'vinted-wardrobe-panel';
    panel.className = 'vinted-wardrobe-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Wardrobe manager');
    const header = document.createElement('header');
    header.className = 'vinted-wardrobe-panel__header';
    const heading = document.createElement('h2');
    heading.textContent = 'Wardrobe manager';
    const close = makePanelButton('Close', 'vinted-wardrobe-panel__close');
    close.setAttribute('aria-label', 'Close wardrobe manager');
    close.addEventListener('click', () => {
      activeWardrobeManagerRenderer = null;
      panel.remove();
      activeLogRenderer = null;
      wardrobeManagerOpen = false;
    });
    header.append(heading, close);
    const body = document.createElement('div');
    body.className = 'vinted-wardrobe-panel__body vinted-wardrobe-panel__view';
    const layout = document.createElement('div');
    layout.className = 'vinted-wardrobe-panel__layout';
    const sidebar = document.createElement('aside');
    sidebar.className = 'vinted-wardrobe-panel__sidebar';
    const nav = document.createElement('nav');
    nav.className = 'vinted-wardrobe-panel__nav';
    const content = document.createElement('div');
    content.className = 'vinted-wardrobe-panel__content';
    const logView = document.createElement('section');
    logView.className = 'vinted-wardrobe-panel__view';
    logView.hidden = true;
    const logHeading = document.createElement('h3');
    logHeading.textContent = 'Operation log';
    const logTools = document.createElement('div');
    logTools.className = 'vinted-wardrobe-panel__actions';
    const clearLog = makePanelButton('Clear log');
    const logRows = document.createElement('div');
    logRows.className = 'vinted-wardrobe-log';
    clearLog.addEventListener('click', () => {
      operationLogs = [];
      try { chrome.storage.local.set({ vinted_operation_log: [] }); } catch (_) {}
      renderOperationLog(logRows);
    });
    const exportLog = makePanelButton('Export log');
    exportLog.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(operationLogs, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `vinted-wardrobe-log-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    logTools.append(clearLog, exportLog);
    logView.append(logHeading, logTools, logRows);
    const infoViews = {};
    const createInfoView = (key, headingText, descriptionText) => {
      const view = document.createElement('section');
      view.className = 'vinted-wardrobe-panel__view';
      view.hidden = true;
      const heading = document.createElement('h3');
      heading.textContent = headingText;
      const description = document.createElement('p');
      description.textContent = descriptionText;
      const rows = document.createElement('div');
      rows.className = 'vinted-wardrobe-log';
      view.append(heading, description, rows);
      infoViews[key] = { view, rows };
      content.appendChild(view);
      return view;
    };
    createInfoView('finance', 'Finance', 'Review inventory value and account-linked financial data without exposing credentials to the extension.');
    createInfoView('drafts', 'Drafts', 'Drafts are kept separate from published listings because they use a different Vinted editor workflow.');
    createInfoView('analytics', 'Analytics', 'Track cached wardrobe performance over time. Historical charts begin accumulating when the Analytics page is opened.');
    createInfoView('settings', 'Settings', 'Operation timing and relisting safety options are configured from the Items view.');
    const views = { items: body, log: logView, ...Object.fromEntries(Object.entries(infoViews).map(([key, value]) => [key, value.view])) };
    let analyticsPeriod = '30';
    let analyticsMetric = 'views';
    const createAnalyticsChart = (title, points, valueLabel, formatValue) => {
      const section = document.createElement('section');
      section.className = 'vinted-analytics__chart';
      const header = document.createElement('div');
      header.className = 'vinted-analytics__section-header';
      const heading = document.createElement('strong');
      heading.textContent = title;
      const label = document.createElement('span');
      label.className = 'vinted-analytics__muted';
      label.textContent = valueLabel;
      header.append(heading, label);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 760 210');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', title);
      const values = points.map(point => Number(point.value) || 0);
      const max = Math.max(...values, 1);
      [45, 100, 155].forEach(y => {
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', '42'); line.setAttribute('x2', '750');
        line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
        svg.appendChild(line);
      });
      if (points.length > 1) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const coords = points.map((point, index) => {
          const x = 42 + (708 * index / (points.length - 1));
          const y = 180 - (Number(point.value) || 0) / max * 145;
          return `${index ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`;
        }).join(' ');
        path.setAttribute('d', coords);
        svg.appendChild(path);
      }
      const last = points[points.length - 1];
      const value = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      value.setAttribute('x', '44'); value.setAttribute('y', '202');
      value.textContent = last ? formatValue(last.value) : 'No history yet';
      svg.appendChild(value);
      if (points.length > 0) {
        const start = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        start.setAttribute('x', '650'); start.setAttribute('y', '202');
        start.textContent = new Date(points[points.length - 1].time).toLocaleDateString();
        svg.appendChild(start);
      }
      section.append(header, svg);
      return section;
    };
    const renderAnalytics = () => {
      const target = infoViews.analytics;
      target.rows.textContent = '';
      target.rows.className = 'vinted-analytics';
      const toolbar = document.createElement('div');
      toolbar.className = 'vinted-analytics__toolbar';
      const period = document.createElement('select');
      [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 3 months'], ['365', 'Last year'], ['all', 'All history']]
        .forEach(([value, label]) => {
          const option = document.createElement('option');
          option.value = value; option.textContent = label; period.appendChild(option);
        });
      period.value = analyticsPeriod;
      const metric = document.createElement('select');
      [['views', 'Profile views'], ['favourites', 'Favourites'], ['value', 'Inventory value']]
        .forEach(([value, label]) => {
          const option = document.createElement('option');
          option.value = value; option.textContent = label; metric.appendChild(option);
        });
      metric.value = analyticsMetric;
      const refresh = makePanelButton('Refresh snapshot');
      const snapshotNote = document.createElement('span');
      snapshotNote.className = 'vinted-analytics__muted';
      toolbar.append(period, metric, refresh, snapshotNote);
      target.rows.appendChild(toolbar);
      const active = Array.from(wardrobeItemStatus.entries())
        .filter(([id, status]) => status === 'published' && isOnSale(wardrobeItemMap.get(id)))
        .map(([id]) => wardrobeItemMap.get(id))
        .filter(Boolean);
      const viewsTotal = active.reduce((sum, item) => sum + itemViews(item), 0);
      const favouritesTotal = active.reduce((sum, item) => sum + itemFavourites(item), 0);
      const inventoryValue = active.reduce((sum, item) => sum + (itemPrice(item) || 0), 0);
      saveAnalyticsSnapshot({
        time: new Date().toISOString(),
        views: viewsTotal,
        favourites: favouritesTotal,
        inventoryValue: Math.round(inventoryValue * 100) / 100,
      });
      const cards = document.createElement('div');
      cards.className = 'vinted-analytics__cards';
      [['On sale listings', active.length], ['Profile views', viewsTotal], ['Favourites', favouritesTotal], ['Inventory value', `${inventoryValue.toFixed(2)} ${active[0] && (active[0].price_currency || '')}`]]
        .forEach(([label, value]) => {
          const card = document.createElement('div');
          card.className = 'vinted-analytics__card';
          card.textContent = label;
          const strong = document.createElement('strong');
          strong.textContent = String(value);
          card.appendChild(strong);
          cards.appendChild(card);
        });
      target.rows.appendChild(cards);
      const balanceNotice = document.createElement('div');
      balanceNotice.className = 'vinted-analytics__notice';
      balanceNotice.textContent = 'Balance history is unavailable because Vinted does not expose the wallet balance to this page. If you want balance and sales data here, you will need to log in to Vinted through this extension so it can access the authenticated wallet and transaction responses. No balance value is being guessed.';
      target.rows.appendChild(balanceNotice);
      const days = period.value === 'all' ? Infinity : Number(period.value);
      const points = analyticsSnapshots.filter(point => Date.now() - new Date(point.time).getTime() <= days * 86400000);
      const metricKey = metric.value === 'value' ? 'inventoryValue' : metric.value;
      const chart = createAnalyticsChart(metric.options[metric.selectedIndex].textContent, points.map(point => ({ time: point.time, value: point[metricKey] })), 'Current snapshot', value => metric.value === 'value' ? Number(value).toFixed(2) : String(Math.round(Number(value) || 0)));
      const comparisonKey = metric.value === 'views' ? 'favourites' : 'views';
      const comparisonLabel = comparisonKey === 'views' ? 'Profile views' : 'Favourites';
      target.rows.appendChild(chart);
      target.rows.appendChild(createAnalyticsChart(`${comparisonLabel} comparison`, points.map(point => ({ time: point.time, value: point[comparisonKey] })), 'Same selected period', value => String(Math.round(Number(value) || 0))));
      const sales = document.createElement('section');
      sales.className = 'vinted-analytics__notice';
      const relists = operationLogs.filter(entry => entry.type === 'Relist').length;
      sales.textContent = `Sales impact: Vinted sales and order revenue are not available in the current page data. ${relists ? `${relists} relist operation${relists === 1 ? '' : 's'} are recorded locally, but they are not treated as sales.` : 'No relist operations are recorded yet.'}`;
      target.rows.appendChild(sales);
      const potential = document.createElement('section');
      potential.className = 'vinted-analytics__table';
      const potentialHeading = document.createElement('div');
      potentialHeading.className = 'vinted-analytics__section-header';
      potentialHeading.innerHTML = '<strong>Items with selling potential</strong><span class="vinted-analytics__muted">Favourites and engagement, not a sales guarantee</span>';
      potential.appendChild(potentialHeading);
      const ranked = [...active].sort((a, b) => {
        const score = item => itemFavourites(item) * 3 + itemViews(item);
        return score(b) - score(a);
      }).slice(0, 8);
      const potentialRows = document.createElement('div');
      potentialRows.className = 'vinted-analytics__potential';
      ranked.forEach(item => {
        const row = document.createElement('div');
        row.className = 'vinted-analytics__potential-row';
        const image = document.createElement('img');
        image.src = itemPhotoUrl(item) || '';
        image.alt = '';
        image.loading = 'lazy';
        const title = document.createElement('span');
        title.textContent = itemTitle(item) || `Item ${item.id}`;
        const views = document.createElement('span');
        views.textContent = `${itemViews(item)} views`;
        const favourites = document.createElement('span');
        favourites.textContent = `${itemFavourites(item)} favourites`;
        const open = makePanelButton('Open');
        open.addEventListener('click', () => window.open(`${ORIGIN}/items/${item.id}`, '_blank', 'noopener'));
        row.append(image, title, views, favourites, open);
        potentialRows.appendChild(row);
      });
      potential.appendChild(potentialRows);
      target.rows.appendChild(potential);
      snapshotNote.textContent = `${analyticsSnapshots.length} local snapshot${analyticsSnapshots.length === 1 ? '' : 's'} stored`;
      const rerender = () => renderAnalytics();
      period.addEventListener('change', () => { analyticsPeriod = period.value; renderAnalytics(); });
      metric.addEventListener('change', () => { analyticsMetric = metric.value; renderAnalytics(); });
      refresh.addEventListener('click', rerender);
    };
    const renderFinance = () => {
      const target = infoViews.finance;
      target.rows.textContent = '';
      target.rows.className = 'vinted-finance';
      const loginCard = document.createElement('section');
      loginCard.className = 'vinted-finance__card vinted-finance__login';
      const loginHeading = document.createElement('strong');
      loginHeading.textContent = 'Connect Vinted account';
      const loginText = document.createElement('p');
      loginText.textContent = 'Sign in through Vinted in a separate tab, then return here and refresh Finance. The extension never asks for or stores your password.';
      const login = makePanelButton('Open Vinted login', 'is-primary');
      login.addEventListener('click', () => window.open(`${ORIGIN}/login`, '_blank', 'noopener'));
      loginCard.append(loginHeading, loginText, login);
      const active = Array.from(wardrobeItemStatus.entries())
        .filter(([id, status]) => status === 'published' && isOnSale(wardrobeItemMap.get(id)))
        .map(([id]) => wardrobeItemMap.get(id))
        .filter(Boolean);
      const inventoryValue = active.reduce((sum, item) => sum + (itemPrice(item) || 0), 0);
      const valueCard = document.createElement('section');
      valueCard.className = 'vinted-finance__card';
      valueCard.innerHTML = `<span>On-sale inventory value</span><strong>${inventoryValue.toFixed(2)} ${active[0] && (active[0].price_currency || '')}</strong><small>${active.length} eligible on-sale listings</small>`;
      const balanceCard = document.createElement('section');
      balanceCard.className = 'vinted-finance__card vinted-finance__notice';
      balanceCard.textContent = 'Balance and historical sales remain unavailable until Vinted exposes authenticated wallet or transaction data to this page. After signing in, use Refresh to check again; no values are invented.';
      const refresh = makePanelButton('Refresh account data');
      refresh.addEventListener('click', () => {
        addOperationLog('Finance', 'Account data refresh requested.');
        renderFinance();
      });
      target.rows.append(loginCard, valueCard, balanceCard, refresh);
    };
    const renderInfoView = key => {
      const target = infoViews[key];
      if (!target) return;
      target.rows.textContent = '';
      if (key === 'queue') {
        if (!relistQueue.length) {
          const empty = document.createElement('div');
          empty.className = 'vinted-wardrobe-log__row';
          empty.textContent = 'No queued relist jobs yet.';
          target.rows.appendChild(empty);
          return;
        }
        for (const entry of relistQueue) {
          const row = document.createElement('div');
          row.className = 'vinted-wardrobe-log__row';
          const time = document.createElement('span');
          time.className = 'vinted-wardrobe-log__time';
          time.textContent = new Date(entry.addedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const status = document.createElement('span');
          status.className = 'vinted-wardrobe-log__type';
          status.textContent = entry.status;
          const details = document.createElement('span');
          details.textContent = `${entry.id}${entry.error ? ` - ${entry.error}` : ''}`;
          row.append(time, status, details);
          target.rows.appendChild(row);
        }
      } else if (key === 'drafts') {
        const drafts = Array.from(wardrobeItemMap.values()).filter(item => wardrobeItemStatus.get(String(item.id)) === 'draft');
        if (!drafts.length) {
          const empty = document.createElement('div');
          empty.className = 'vinted-wardrobe-log__row';
          empty.textContent = 'No drafts found yet.';
          target.rows.appendChild(empty);
          return;
        }

        const grid = document.createElement('div');
        grid.className = 'vinted-drafts-grid';
        drafts.forEach(item => {
          const card = document.createElement('article');
          card.className = 'vinted-draft-card';
          const image = document.createElement('img');
          image.src = itemPhotoUrl(item) || '';
          image.alt = itemTitle(item) || `Draft ${item.id}`;
          image.loading = 'lazy';
          const body = document.createElement('div');
          body.className = 'vinted-draft-card__body';
          const title = document.createElement('strong');
          title.textContent = itemTitle(item) || `Draft ${item.id}`;
          const meta = document.createElement('span');
          meta.className = 'vinted-draft-card__meta';
          meta.textContent = `${itemPrice(item) == null ? 'No price set' : `${itemPrice(item).toFixed(2)} ${item.price_currency || ''}`}`;
          const completion = getDraftCompletion(item);
          const bar = document.createElement('div');
          bar.className = 'vinted-draft-card__bar';
          const fill = document.createElement('span');
          fill.style.width = `${completion}%`;
          fill.className = 'vinted-draft-card__fill';
          const completionText = document.createElement('small');
          completionText.textContent = `${completion}% complete`;
          bar.appendChild(fill);
          const actionRow = document.createElement('div');
          actionRow.className = 'vinted-draft-card__actions';
          const open = makePanelButton('Open draft');
          open.addEventListener('click', () => window.open(`${ORIGIN}/items/${item.id}/edit`, '_blank', 'noopener'));
          actionRow.appendChild(open);
          body.append(title, meta, bar, completionText, actionRow);
          card.append(image, body);
          grid.appendChild(card);
        });
        target.rows.appendChild(grid);
      } else if (key === 'analytics') {
        const published = Array.from(wardrobeItemStatus.entries())
          .filter(([id, value]) => value === 'published' && isOnSale(wardrobeItemMap.get(id)))
          .map(([id]) => wardrobeItemMap.get(id));
        const viewsTotal = published.reduce((sum, item) => sum + itemViews(item), 0);
        const favouritesTotal = published.reduce((sum, item) => sum + itemFavourites(item), 0);
        const row = document.createElement('div');
        row.className = 'vinted-wardrobe-log__row';
        row.textContent = `${published.length} on-sale listings - ${viewsTotal} views - ${favouritesTotal} favourites`;
        target.rows.appendChild(row);
      } else if (key === 'finance') {
        renderFinance();
      } else if (key === 'settings') {
        const cards = [
          { title: 'Safety', value: 'Draft-first relist flow with optional deletion after successful draft creation' },
          { title: 'Timing', value: 'Progressive pacing to reduce the chance of aggressive automation detection' },
          { title: 'Queue', value: 'Bulk relist, price, hide and hide/unhide actions are run sequentially with status updates' },
          { title: 'Vinted access', value: 'Analytics and balance data only work when Vinted exposes authenticated session data to the page' },
        ];
        const grid = document.createElement('div');
        grid.className = 'vinted-settings-grid';
        cards.forEach(cardData => {
          const card = document.createElement('div');
          card.className = 'vinted-settings-card';
          const heading = document.createElement('strong');
          heading.textContent = cardData.title;
          const body = document.createElement('p');
          body.textContent = cardData.value;
          card.append(heading, body);
          grid.appendChild(card);
        });
        target.rows.appendChild(grid);
      }
    };
    const navItems = [
      ['items', 'Items'],
      ['finance', 'Finance'],
      ['drafts', 'Drafts'],
      ['analytics', 'Analytics'],
      ['log', 'Log'],
      ['settings', 'Settings'],
    ];
    navItems.forEach(([key, label], index) => {
      const navButton = makePanelButton(label, index === 0 ? 'is-active' : '');
      navButton.addEventListener('click', () => {
        nav.querySelectorAll('button').forEach(button => button.classList.remove('is-active'));
        navButton.classList.add('is-active');
        Object.values(views).forEach(view => { view.hidden = true; });
        views[key].hidden = false;
        if (key === 'log') renderOperationLog(logRows);
        else if (key === 'analytics') renderAnalytics();
        else if (key === 'finance') renderFinance();
        else if (infoViews[key]) renderInfoView(key);
      });
      nav.appendChild(navButton);
    });
    sidebar.appendChild(nav);
    activeLogRenderer = () => renderOperationLog(logRows);
    content.append(body, logView);
    layout.append(sidebar, content);
    const toolbar = document.createElement('div');
    toolbar.className = 'vinted-wardrobe-panel__toolbar';
    const search = document.createElement('input');
    search.className = 'vinted-wardrobe-panel__search';
    search.type = 'search';
    search.placeholder = 'Search titles...';
    const status = document.createElement('select');
    [
      ['all', 'All items'],
      ['published', 'On sale (safe to relist)'],
      ['hidden', 'Hidden'],
      ['draft', 'Drafts'],
      ['sold', 'Sold (do not relist)'],
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      status.appendChild(option);
    });
    status.value = 'published';
    status.title = 'The manager starts with on-sale listings only. Sold items are excluded from relisting.';
    const sort = document.createElement('select');
    [
      ['date-desc', 'Date published: newest'],
      ['date-asc', 'Date published: oldest'],
      ['title-asc', 'Title: A-Z'],
      ['title-desc', 'Title: Z-A'],
      ['price-asc', 'Price: low to high'],
      ['price-desc', 'Price: high to low'],
      ['views-desc', 'Views: high to low'],
      ['views-asc', 'Views: low to high'],
      ['favourites-desc', 'Favourites: high to low'],
      ['favourites-asc', 'Favourites: low to high'],
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      sort.appendChild(option);
    });
    const count = document.createElement('span');
    const items = document.createElement('div');
    items.className = 'vinted-wardrobe-panel__items';
    toolbar.append(search, status, sort, count);
    const settings = document.createElement('div');
    settings.className = 'vinted-wardrobe-panel__settings';
    const hideWarning = document.createElement('div');
    hideWarning.className = 'vinted-wardrobe-warning';
    hideWarning.textContent = 'Hide/unhide uses an unpublished Vinted endpoint. Treat it as experimental and verify one item manually before using it in bulk.';
    const deleteAfter = document.createElement('label');
    const deleteCheckbox = document.createElement('input');
    deleteCheckbox.type = 'checkbox';
    deleteCheckbox.checked = true;
    deleteAfter.append(deleteCheckbox, document.createTextNode('Delete original after draft'));
    const refreshAfter = document.createElement('label');
    const refreshCheckbox = document.createElement('input');
    refreshCheckbox.type = 'checkbox';
    refreshAfter.append(refreshCheckbox, document.createTextNode('Refresh after queue'));
    const delayMode = document.createElement('select');
    delayMode.innerHTML = '<option value="fixed">Fixed delay</option><option value="random">Random delay</option>';
    const fixedDelay = document.createElement('input');
    fixedDelay.type = 'number';
    fixedDelay.min = '0';
    fixedDelay.step = '1';
    fixedDelay.value = String(DEFAULT_OPERATION_SETTINGS.fixedDelaySeconds);
    fixedDelay.title = 'Fixed delay in seconds';
    const randomMin = document.createElement('input');
    randomMin.type = 'number';
    randomMin.min = '6';
    randomMin.step = '1';
    randomMin.value = String(DEFAULT_OPERATION_SETTINGS.randomMinSeconds);
    randomMin.title = 'Random minimum seconds (at least 6)';
    const randomMax = document.createElement('input');
    randomMax.type = 'number';
    randomMax.min = '6';
    randomMax.step = '1';
    randomMax.value = String(DEFAULT_OPERATION_SETTINGS.randomMaxSeconds);
    randomMax.title = 'Random maximum seconds';
    const fixedDelayField = document.createElement('label');
    fixedDelayField.className = 'vinted-delay-field';
    fixedDelayField.textContent = 'Delay (sec)';
    fixedDelayField.appendChild(fixedDelay);
    const randomMinField = document.createElement('label');
    randomMinField.className = 'vinted-delay-field';
    randomMinField.textContent = 'Minimum (sec)';
    randomMinField.appendChild(randomMin);
    const randomMaxField = document.createElement('label');
    randomMaxField.className = 'vinted-delay-field';
    randomMaxField.textContent = 'Maximum (sec)';
    randomMaxField.appendChild(randomMax);
    const delayHelp = document.createElement('span');
    delayHelp.className = 'vinted-wardrobe-panel__meta';
    delayHelp.textContent = 'Wait time between items in a bulk relist or update. Random mode chooses a value between minimum and maximum.';
    const updateDelayFields = () => {
      const random = delayMode.value === 'random';
      fixedDelayField.hidden = random;
      randomMinField.hidden = !random;
      randomMaxField.hidden = !random;
    };
    settings.append(hideWarning, deleteAfter, refreshAfter, delayMode, fixedDelayField, randomMinField, randomMaxField, delayHelp);
    const actions = document.createElement('div');
    actions.className = 'vinted-wardrobe-panel__actions';
    const selectAll = makePanelButton('Select visible');
    const clear = makePanelButton('Clear selection');
    const relist = makePanelButton('Relist selected as drafts', 'is-primary');
    const price = makePanelButton('Change price');
    const hide = makePanelButton('Hide selected');
    const unhide = makePanelButton('Unhide selected');
    const remove = makePanelButton('Delete selected', 'is-danger');
    actions.append(selectAll, clear, relist, price, hide, unhide, remove);
    body.append(toolbar, settings, actions, items);
    panel.append(header, layout);
    document.body.appendChild(panel);
    const rerender = () => renderWardrobeManagerItems(items, search, sort, status, count);
    activeWardrobeManagerRenderer = rerender;
    search.addEventListener('input', rerender);
    status.addEventListener('change', rerender);
    sort.addEventListener('change', rerender);
    const selectedIdsFor = allowed => Array.from(selectedWardrobeIds)
      .filter(id => allowed.includes(wardrobeItemStatus.get(id)));
    const explainSkippedDrafts = (ids, action) => {
      if (ids.length !== selectedWardrobeIds.size) {
        showNotice(`Only on-sale or hidden listings can be used for ${action}; sold and draft items were skipped.`, 'error');
      }
      return ids;
    };
    selectAll.addEventListener('click', () => {
      sortedWardrobeItems(search.value, sort.value, status.value).forEach(item => selectedWardrobeIds.add(String(item.id)));
      rerender();
    });
    clear.addEventListener('click', () => { selectedWardrobeIds.clear(); rerender(); });
    const persistDelaySettings = () => saveOperationSettings({
      delayMode: delayMode.value,
      fixedDelaySeconds: Math.max(0, Number(fixedDelay.value) || 0),
      randomMinSeconds: Math.max(6, Number(randomMin.value) || 6),
      randomMaxSeconds: Math.max(6, Number(randomMax.value) || 6),
    });
    [delayMode, fixedDelay, randomMin, randomMax].forEach(control => control.addEventListener('change', persistDelaySettings));
    delayMode.addEventListener('change', updateDelayFields);
    relist.addEventListener('click', async () => {
      const ids = explainSkippedDrafts(selectedIdsFor(['published']), 'relisting');
      if (!ids.length) return showNotice('Select at least one item first.', 'error');
      relist.disabled = true;
      relistQueue.push(...ids.map(id => ({ id, status: 'queued', addedAt: new Date().toISOString() })));
      const options = { deleteOriginal: deleteCheckbox.checked, refresh: false };
      const progress = createBulkRelistProgress(ids);
      let results;
      try {
        results = await runBulkAction(ids, async id => {
          const queueEntry = relistQueue.find(entry => entry.id === id && entry.status === 'queued');
          if (queueEntry) queueEntry.status = 'running';
          progress.update(id, 'running', 'Starting...');
          const button = document.createElement('button');
          button.setAttribute('data-item-id', id);
          try {
            const succeeded = await relistAsDraftFromButton(button, options, (message, status = 'running') => {
              progress.update(id, status, message);
            });
            if (!succeeded) throw new Error('Relist did not complete');
            if (queueEntry) queueEntry.status = 'completed';
            progress.update(id, 'completed', 'Done');
          } catch (error) {
            const message = error && error.message ? error.message : String(error);
            if (queueEntry) {
              queueEntry.status = 'failed';
              queueEntry.error = message;
            }
            progress.update(id, 'failed', `Failed: ${message}`);
            throw error;
          }
        }, (nextId, timing) => {
          progress.update(nextId, 'waiting', `${timing.mode}: next relist in ${timing.remainingSeconds}s`);
        });
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        addOperationLog('Relist', `Queue could not start: ${message}`, 'error');
        ids.forEach(id => {
          const entry = relistQueue.find(item => item.id === id && item.status === 'queued');
          if (entry) {
            entry.status = 'failed';
            entry.error = message;
            progress.update(id, 'failed', `Failed: ${message}`);
          }
        });
        results = { succeeded: [], failed: ids.map(id => ({ id, error: message })) };
      } finally {
        relist.disabled = false;
      }
      addOperationLog('Relist', `${results.succeeded.length} succeeded, ${results.failed.length} failed`, results.failed.length ? 'error' : 'info');
      showNotice(
        `Relist queue finished: ${results.succeeded.length} succeeded, ${results.failed.length} failed.`,
        results.failed.length ? 'error' : 'success'
      );
      if (refreshCheckbox.checked && results.succeeded.length) {
        setTimeout(() => window.location.reload(), 1200);
      }
    });
    price.addEventListener('click', async () => {
      const ids = explainSkippedDrafts(selectedIdsFor(['published', 'hidden']), 'price changes');
      if (!ids.length) return showNotice('Select at least one item first.', 'error');
      const mode = await showManagerDialog({
        title: `Change price - ${ids.length} item${ids.length === 1 ? '' : 's'}`,
        message: 'Apply a fixed amount, percentage, or exact price to the selected published listings.',
        input: {
          type: 'text',
          label: 'Price change',
          placeholder: '+2, -1.50, +10%, -15%, or =12.00',
        },
        confirmLabel: 'Preview and apply',
      });
      if (!mode) return;
      const match = mode.trim().match(/^([+-])(\d+(?:\.\d+)?)%?$|^=(\d+(?:\.\d+)?)$/);
      if (!match) return showNotice('Use +2, -1.50, +10%, -15%, or =12.00.', 'error');
      const results = await runBulkAction(ids, async id => {
        const current = itemPrice(wardrobeItemMap.get(id));
        if (current == null) throw new Error('Current price is unavailable');
        let next = match[3] ? Number(match[3]) : current + (match[1] === '+' ? 1 : -1) * Number(match[2]) * (mode.includes('%') ? current / 100 : 1);
        next = Math.round(next * 100) / 100;
        if (!Number.isFinite(next) || next <= 0) throw new Error('Resulting price must be greater than zero');
        await updateItemPrice(await getCsrf(), id, next);
        const cached = wardrobeItemMap.get(id);
        if (cached) cached.price_numeric = next;
      });
      addOperationLog('Price update', `${results.succeeded.length} succeeded, ${results.failed.length} failed`, results.failed.length ? 'error' : 'info');
      showNotice(`Price update finished: ${results.succeeded.length} succeeded, ${results.failed.length} failed.`, results.failed.length ? 'error' : 'success');
      rerender();
    });
    const runVisibilityAction = async visible => {
      const ids = explainSkippedDrafts(selectedIdsFor(['published', 'hidden']), visible ? 'unhiding' : 'hiding');
      if (!ids.length) return showNotice('Select at least one item first.', 'error');
      const confirmed = await showManagerDialog({
        title: `${visible ? 'Unhide' : 'Hide'} ${ids.length} item${ids.length === 1 ? '' : 's'}?`,
        message: 'This uses an unpublished Vinted endpoint. Verify one low-risk item first; the operation cannot be reliably rolled back by the extension.',
        confirmLabel: visible ? 'Unhide items' : 'Hide items',
        danger: !visible,
      });
      if (!confirmed) return;
      const results = await runBulkAction(ids, (id, csrf) => setItemVisibility(csrf, id, visible));
      addOperationLog(visible ? 'Unhide' : 'Hide', `${results.succeeded.length} succeeded, ${results.failed.length} failed`, results.failed.length ? 'error' : 'info');
      showNotice(`${visible ? 'Unhide' : 'Hide'} finished: ${results.succeeded.length} succeeded, ${results.failed.length} failed.`, results.failed.length ? 'error' : 'success');
    };
    hide.addEventListener('click', () => runVisibilityAction(false));
    unhide.addEventListener('click', () => runVisibilityAction(true));
    remove.addEventListener('click', async () => {
      const ids = explainSkippedDrafts(selectedIdsFor(['published', 'hidden']), 'deletion');
      if (!ids.length) return showNotice('Select at least one item first.', 'error');
      const confirmed = await showManagerDialog({
        title: `Delete ${ids.length} listing${ids.length === 1 ? '' : 's'}?`,
        message: 'Deletion cannot be undone. Drafts are excluded from this action; select published or hidden items only.',
        confirmLabel: 'Delete permanently',
        danger: true,
      });
      if (!confirmed) return;
      const results = await runBulkAction(ids, deleteItem);
      addOperationLog('Delete', `${results.succeeded.length} succeeded, ${results.failed.length} failed`, results.failed.length ? 'error' : 'info');
      results.succeeded.forEach(id => { wardrobeItemMap.delete(id); selectedWardrobeIds.delete(id); });
      showNotice(`Delete finished: ${results.succeeded.length} succeeded, ${results.failed.length} failed.`, results.failed.length ? 'error' : 'success');
      rerender();
    });
    const settingsValue = await getOperationSettings();
    delayMode.value = settingsValue.delayMode;
    fixedDelay.value = String(settingsValue.fixedDelaySeconds);
    randomMin.value = String(settingsValue.randomMinSeconds);
    randomMax.value = String(settingsValue.randomMaxSeconds);
    updateDelayFields();
    rerender();
    wardrobeManagerOpen = true;
  }

  function uuidv4() {
    // RFC4122-ish using crypto.getRandomValues
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
  }

  async function relistAsDraftFromButton(btn, presetOptions = null, onProgress = null) {
    const updateProgress = (message, status = 'running') => {
      if (typeof onProgress === 'function') onProgress(message, status);
    };
    const itemId = findClosestItemId(btn);
    if (!itemId) {
      showNotice('Could not determine item id', 'error');
      return false;
    }
    const options = presetOptions || await getRelistOptions(itemId);
    if (!options) return false;
    try {
      btn.disabled = true;
      btn.classList.add('is-loading');
      btn.textContent = 'Creating draft...';
      updateProgress('Loading item details...');
      reportRelistActivity(`Relist started for "${itemId}".`);
      const paceRelist = createRelistPacer(5000);
      const csrf = await getCsrf();
      const base = await getItemDetails(itemId, csrf);
      if (getItemStatus(base) !== 'published') {
        throw new Error('Only on-sale listings can be relisted.');
      }
      const backupSync = syncItemBackup(base);
      if (backupSync.changed && backupSync.record && backupSync.record.lastRelistedAt) {
        addOperationLog('Backup sync', `${base.title || itemId}: local backup updated before relisting.`);
      } else if (backupSync.changed) {
        addOperationLog('Backup sync', `${base.title || itemId}: local backup synchronized from Vinted before relisting.`);
      }
      const photoUrls = pickPhotos(base);
      updateProgress('Copying title and description...');
      reportRelistActivity(`Loaded item details for "${base.title || itemId}". Copying the old description...`);
  await paceRelist(120, 260);
  const sizeId = resolveSizeId(base);
  const sizeGroupId = resolveSizeGroupId(base);
  if (!sizeId) {
    log('WARNING: Could not resolve size_id for item', itemId, '- raw item data:', JSON.stringify(base));
  }
  const tempUuid = uuidv4();
      const assigned = [];
      for (let photoIndex = 0; photoIndex < photoUrls.length; photoIndex++) {
        const u = photoUrls[photoIndex];
        try {
          updateProgress(`Downloading photo ${photoIndex + 1}/${photoUrls.length}...`);
          reportRelistActivity(`Downloading photo ${photoIndex + 1} of ${photoUrls.length}...`);
          const blob = await downloadAsBlob(u);
          await wait(getRelistPhotoDelay());
          updateProgress(`Uploading photo ${photoIndex + 1}/${photoUrls.length}...`);
          reportRelistActivity(`Uploading photo ${photoIndex + 1} of ${photoUrls.length}...`);
          const up = await uploadPhoto(csrf, blob, tempUuid);
          if (up && up.id) assigned.push({ id: up.id, orientation: up.orientation || 0 });
          updateProgress(`Uploaded photo ${photoIndex + 1}/${photoUrls.length}.`);
          reportRelistActivity(`Photo ${photoIndex + 1} of ${photoUrls.length} uploaded.`);
          if (u !== photoUrls[photoUrls.length - 1]) await wait(getRelistPhotoDelay());
        } catch (e) {
          const message = e && e.message ? e.message : String(e);
          updateProgress(`Photo ${photoIndex + 1}/${photoUrls.length} failed; continuing...`);
          addOperationLog('Relist activity', `Photo ${photoIndex + 1} failed: ${message}`, 'error');
          log('photo upload failed', e);
        }
      }
    await paceRelist(120, 260);
    const priceObj = base.price || {};
    const priceNum = base.price_numeric || parseFloat(priceObj.amount || '0') || 0;
    const currency = base.price_currency || priceObj.currency_code || base.currency || 'EUR';
  const colorIds = base.color_ids || [base.color1_id, base.color2_id].filter(Boolean);
  const brandTitleRaw = base.brand_title || base.brand || (base.brand_dto && base.brand_dto.title) || null;
  const brandTitle = (brandTitleRaw && String(brandTitleRaw).trim()) ? brandTitleRaw : null;
      const payload = {
        item: {
          id: null,
          currency,
          temp_uuid: tempUuid,
          title: base.title || '',
          description: base.description || '',
          brand_id: base.brand_id || null,
      brand: brandTitle,
            size_id: sizeId,
          catalog_id: base.catalog_id || null,
          size_group_id: sizeGroupId || null,
      // optional book/media fields
      isbn: base.isbn || null,
      author: base.author || null,
      book_title: base.book_title || null,
      model: base.model || null,
      video_game_rating_id: base.video_game_rating_id || null,
          is_unisex: Boolean(base.is_unisex),
          status_id: base.status_id || 1,
          price: priceNum,
          package_size_id: base.package_size_id || 1,
          shipment_prices: { domestic: null, international: null },
      color_ids: colorIds || [],
          assigned_photos: assigned,
          item_attributes: base.item_attributes || [],
          manufacturer: base.manufacturer || null,
          manufacturer_labelling: base.manufacturer_labelling || null,
      // measurements if present
      measurement_length: base.measurement_length != null ? base.measurement_length : null,
      measurement_width: base.measurement_width != null ? base.measurement_width : null,
    measurement_unit: base.measurement_unit != null ? base.measurement_unit : null,
        },
        feedback_id: null,
        push_up: false,
        parcel: null,
        upload_session_id: tempUuid,
      };
  reportRelistActivity('Old description and item details copied. Creating the draft...');
  updateProgress('Creating draft...');
  if (!assigned.length) {
        throw new Error('No photos could be uploaded; draft was not created.');
      }
  await paceRelist(180, 360);
  const created = await createDraft(csrf, payload);
  const draftId = (created && (created.id || (created.draft && created.draft.id) || (created.item && created.item.id))) || 'unknown';
  syncItemBackup(base, { relisted: true });
  let deleted = false;
  if (options.deleteOriginal) {
    updateProgress('Deleting old listing...');
    reportRelistActivity('Draft created. Deleting the old listing...');
    btn.textContent = 'Deleting old listing...';
    await deleteItem(csrf, itemId);
    deleted = true;
  }
  log('Created draft', draftId, deleted ? 'and deleted the original item' : 'without changing the original item');
  addOperationLog('Relist', `${base.title || itemId}: draft ${deleted ? 'created and original deleted' : 'created'}`);
  showNotice(
    deleted ? 'Draft created and old listing deleted.' : 'Draft created. The original item was not changed.',
    'success'
  );
  updateProgress(options.deleteOriginal ? 'Draft created and old listing deleted.' : 'Draft created.', 'completed');
  if (options.refresh) {
    reportRelistActivity('Relist complete. Refreshing the page...');
    setTimeout(() => {
      try { window.location.reload(); } catch (error) { log('page refresh failed', error); }
    }, 1200);
  }
  return true;
    } catch (e) {
      console.error(e);
  updateProgress('Failed: ' + (e && e.message ? e.message : e), 'failed');
  addOperationLog('Error', e && e.message ? e.message : String(e), 'error');
  showNotice(
    options.deleteOriginal && /Delete failed:/.test(e && e.message ? e.message : '')
      ? `Draft created, but the old listing was not deleted: ${e.message}`
      : 'Failed to relist: ' + (e && e.message ? e.message : e),
    'error'
  );
  return false;
    } finally {
  btn.disabled = false; btn.classList.remove('is-loading'); btn.textContent = 'Relist as draft';
    }
  }

  function injectButtons() {
  ensureStyles();
  const memberPage = isMemberWardrobePage();
  const itemPage = isItemDetailPage();

  if (memberPage) {
    if (!document.getElementById('vinted-wardrobe-launcher')) {
      const launcher = makePanelButton('Wardrobe manager');
      launcher.id = 'vinted-wardrobe-launcher';
      launcher.className = 'vinted-wardrobe-launcher';
      makeLauncherMovable(launcher);
      restoreLauncherPosition(launcher);
      launcher.addEventListener('click', async () => {
        if (launcher.dataset.dragged === 'true') return;
        launcher.disabled = true;
        launcher.textContent = 'Loading manager...';
        try {
          await openWardrobeManager();
        } catch (error) {
          wardrobeManagerOpen = false;
          log('Failed to open wardrobe manager:', error);
          showNotice(`Could not open wardrobe manager: ${error && error.message ? error.message : String(error)}`, 'error');
        } finally {
          launcher.disabled = false;
          launcher.textContent = 'Wardrobe manager';
        }
      });
      document.body.appendChild(launcher);
    }
    // Fetch the wardrobe page once to annotate items without per-item calls
    fetchWardrobeAndAnnotate();
  }

    const bumped = memberPage
      ? document.querySelectorAll(BOOST_BUTTON_SELECTOR)
      : itemPage
        ? [findItemPageBumpButton()].filter(Boolean)
        : [];
    let count = 0;
    for (const b of bumped) {
      // Avoid duplicate injection
      if (b.parentElement && b.parentElement.querySelector('.vinted-republish-btn')) continue;
      const btn = makeButton('Relist as draft');
      btn.classList.add('vinted-republish-btn');
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        relistAsDraftFromButton(btn);
      });
      // Insert next to Booster button
      if (b.parentElement) {
        // Add an extra line/spacing between Booster and Relist
        const spacer = document.createElement('div');
        spacer.style.height = '8px';
        spacer.style.width = '100%';
        b.insertAdjacentElement('afterend', spacer);
        spacer.insertAdjacentElement('afterend', btn);
        count++;
      }
      // Try to render any known labels for visible items
      applyCreatedLabels();
    }
  if (count > 0) log('Injected', count, 'relist buttons');
    // Final pass in case new nodes appeared
    applyCreatedLabels();
  }

  // Initial and dynamic updates
  const obs = new MutationObserver(() => {
    if (injectionScheduled) return;
    injectionScheduled = true;
    setTimeout(() => {
      injectionScheduled = false;
      injectButtons();
    }, 100);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  chrome.runtime.onMessage.addListener(message => {
    if (message && message.type === 'vinted:openWardrobeManager') {
      openWardrobeManager().catch(error => {
        wardrobeManagerOpen = false;
        log('Failed to open wardrobe manager from popup:', error);
        showNotice(`Could not open wardrobe manager: ${error && error.message ? error.message : String(error)}`, 'error');
      });
    }
  });
  injectButtons();
})();
