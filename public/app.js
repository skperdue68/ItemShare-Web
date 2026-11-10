// ItemShare page behaviour: uploads, the account menu and the live item lists.
//
// Everything here is an enhancement. The logout form posts without scripts and the
// filter form still submits on its own, so a failed script costs convenience only.

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('savedvars');
const fileName = document.getElementById('fileName');
const toast = document.getElementById('toast');

// Filled in by the list code once it can refresh without a page load; until then a
// change has to be shown the only other way there is.
let refreshListsSoon = null;

function refreshAfterChange() {
  if (refreshListsSoon) {
    refreshListsSoon(0);
    return;
  }

  window.location.reload();
}

// ----------------------------------------------------------------- demo presence
// A demo page keeps the sandbox alive: the server lets the demo's other guildmates act
// only while at least one demo page is open, and this is how it knows. Nothing is sent
// from an ordinary page, and a failed ping costs nothing - the activity simply pauses.
if (document.body && document.body.dataset.demo === '1') {
  const pingDemo = () => {
    fetch('/demo/heartbeat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    }).catch(() => {});
  };

  pingDemo();
  window.setInterval(pingDemo, 15000);

  // A tab that was hidden and comes back says so at once, rather than waiting up to
  // fifteen seconds for the next tick.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      pingDemo();
    }
  });
}

// ---------------------------------------------------------------------- toast
// One short lived message, replaced by whatever the next step has to say. The
// upload is the only thing here that takes long enough to need reassuring.
let toastHideTimer = null;

function showToast(message, kind = 'info', { sticky = false } = {}) {
  if (!toast) {
    return;
  }

  toast.textContent = message;
  toast.className = `toast ${kind}`;
  toast.hidden = false;
  window.requestAnimationFrame(() => toast.classList.add('visible'));

  window.clearTimeout(toastHideTimer);

  if (sticky) {
    return;
  }

  toastHideTimer = window.setTimeout(() => {
    toast.classList.remove('visible');
    toastHideTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 220);
  }, kind === 'err' ? 7000 : 4500);
}

// --------------------------------------------------------------------- upload
// Dropping a file or picking one both upload straight away: there is no button to
// press and nothing to confirm first.
async function uploadFile(file) {
  if (!file) {
    return;
  }

  // The card on a demo account says uploading is switched off. Saying so here costs
  // nothing and spares a file being sent to an answer that is already known.
  const restriction = document.getElementById('demoUploadNotice');

  if (restriction) {
    showToast(restriction.textContent.replace(/\s+/g, ' ').trim(), 'err');

    if (fileInput) {
      fileInput.value = '';
    }
    if (fileName) {
      fileName.textContent = 'No file selected';
    }

    return;
  }

  if (fileName) {
    fileName.textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
  }
  if (dropZone) {
    dropZone.classList.add('busy');
  }

  showToast(`Received ${file.name} - uploading and processing...`, 'info', { sticky: true });

  try {
    const body = new FormData();
    body.append('savedvars', file);

    const response = await fetch('/upload', { method: 'POST', body });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.error || `Upload failed with status ${response.status}`);
    }

    const accounts = result.accounts || [];
    const icons = result.iconLookup && result.iconLookup.resolved
      ? `Found ${result.iconLookup.resolved} icon${result.iconLookup.resolved === 1 ? '' : 's'} that were missing.`
      : '';

    showToast(
      [
        `${file.name} has been received.`,
        ...accounts.map(
          (account) =>
            `${account.accountName}: ${account.itemCount} item${account.itemCount === 1 ? '' : 's'}, quantity ${account.totalQuantity}`
        ),
        // An item with requests still open was not refreshed from this file, so the
        // count on screen is the one the requests were made against.
        ...(result.heldBack || []).map(
          (item) =>
            `Pending requests for ${item.itemName} (${item.requests}), so its inventory was not refreshed.`
        ),
        icons,
      ]
        .filter(Boolean)
        .join('\n'),
      'ok'
    );

    refreshAfterChange();
  } catch (error) {
    showToast(error.message, 'err');
  } finally {
    if (dropZone) {
      dropZone.classList.remove('busy');
    }
    // Clearing the input means the same file can be chosen again straight away.
    if (fileInput) {
      fileInput.value = '';
    }
    if (fileName) {
      fileName.textContent = 'No file selected';
    }
  }
}

if (dropZone && fileInput) {
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) {
      uploadFile(file);
    }
  });

  ['dragenter', 'dragover'].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add('dragging');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove('dragging');
    });
  });

  dropZone.addEventListener('drop', (event) => {
    const dropped = event.dataTransfer && event.dataTransfer.files;
    if (dropped && dropped.length > 0) {
      uploadFile(dropped[0]);
    }
  });
}

// The avatar menu and the broken-photo fallback are in /header-menu.js: they are the
// header's own behaviour, and every page needs them, including the ones that do not load
// this file because they have no item list to script.

// Live item lists.
//
// socket.io only ever says "something you can see has changed"; the list itself
// comes back over the ordinary signed-in request, so the server still decides what
// may be on screen and this file never has to know the visibility rules.
//
// Redrawing a long table under someone's eyes and dumping them back at the top is
// worse than a stale row, so every row carries data-item-key. The row crossing a
// line a third of the way down the viewport is remembered before the swap and the
// page is scrolled by the difference afterwards. If that item is gone, the row that
// moved up into its place is used, so the reader drops one item down the list
// instead of losing their spot entirely.

// Match siblings by their server identity, then reconcile only changed leaves.
// Keys are scoped to a parent: the same request can appear in separate tables.
function liveNodeKey(node) {
  if (node.nodeType !== 1) return null;
  for (const name of ['id', 'data-item-key', 'data-request-id', 'data-filter-option', 'data-panel', 'data-tab', 'data-sort', 'data-group-heading']) {
    if (node.hasAttribute(name)) return `${node.tagName}:${name}:${node.getAttribute(name)}`;
  }
  if (node.matches('input[data-filter]')) return `INPUT:${node.name}:${node.type === 'checkbox' ? node.value : ''}`;
  if (node.matches('option')) return `OPTION:${node.value}`;
  return null;
}

function reconcileLiveNode(current, next) {
  if (current.nodeType !== 1) {
    if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
    return;
  }
  // These values belong to this browser, not to the server's initial rendering.
  const localTime = current.matches('time[data-since], time[data-local-time]') &&
    current.getAttribute('datetime') === next.getAttribute('datetime');
  const keepAttribute = (name) =>
    (localTime && name === 'title') ||
    (current.hasAttribute('data-panel') && name === 'hidden') ||
    (current.hasAttribute('data-tab') && ['aria-selected', 'tabindex'].includes(name)) ||
    (current.matches('details') && name === 'open') ||
    (current.matches('.live-pill') && ['hidden', 'data-live'].includes(name));
  for (const attribute of Array.from(current.attributes)) {
    if (!next.hasAttribute(attribute.name) && !keepAttribute(attribute.name)) {
      if (attribute.name === 'class' && current.classList.contains('row-fading')) continue;
      current.removeAttribute(attribute.name);
    }
  }
  for (const attribute of Array.from(next.attributes)) {
    if (keepAttribute(attribute.name)) continue;
    let value = attribute.value;
    if (attribute.name === 'class' && current.classList.contains('row-fading')) {
      value = [...new Set([...value.split(/\s+/).filter(Boolean), 'row-fading'])].join(' ');
    }
    if (current.getAttribute(attribute.name) !== value) current.setAttribute(attribute.name, value);
  }
  if (localTime || current.matches('.live-pill')) return;
  reconcileLiveChildren(current, next);
}

function reconcileLiveChildren(current, next) {
  const oldChildren = Array.from(current.childNodes);
  const keyed = new Map(oldChildren.map(node => [liveNodeKey(node), node]).filter(([key]) => key));
  const used = new Set();
  let cursor = current.firstChild;
  for (const incoming of Array.from(next.childNodes)) {
    // Metadata templates are not visible DOM and do not need to be redrawn.
    if (incoming.nodeType === 1 && incoming.matches('template[data-live-filters]')) {
      const metadata = oldChildren.find(node => node.nodeType === 1 && node.matches('template[data-live-filters]'));
      if (metadata) { used.add(metadata); if (cursor === metadata) cursor = metadata.nextSibling; }
      continue;
    }
    // A dismissed basket row must never be resurrected by a later refresh.
    if (incoming.nodeType === 1 && incoming.matches('[data-basket-row]') &&
        removedRequestRows.has(incoming.dataset.requestId) &&
        !oldChildren.some(node => node.nodeType === 1 && node.dataset.requestId === incoming.dataset.requestId && node.classList.contains('row-fading'))) continue;
    const key = liveNodeKey(incoming);
    const compatible = node => node && node.nodeType === incoming.nodeType &&
      (node.nodeType !== 1 || node.tagName === incoming.tagName);
    let match = key ? keyed.get(key) : null;
    if (!key) {
      match = oldChildren.find(node => !used.has(node) && !liveNodeKey(node) && compatible(node));
    }
    if (!compatible(match) || used.has(match)) match = null;
    if (match) {
      used.add(match);
      reconcileLiveNode(match, incoming);
      if (match !== cursor) current.insertBefore(match, cursor);
      cursor = match.nextSibling;
    } else {
      const inserted = incoming.cloneNode(true);
      current.insertBefore(inserted, cursor);
    }
  }
  for (const node of oldChildren) {
    if (!used.has(node) && !(node.nodeType === 1 && node.matches('[data-basket-row]') &&
        node.dataset.status !== 'draft' && closingRequestRows.has(node.dataset.requestId)) &&
        !(node.nodeType === 1 && node.classList.contains('row-fading'))) node.remove();
  }
}

const listRegion = document.getElementById('itemLists');

if (listRegion) {
  const ANCHOR_LINE_RATIO = 0.35;
  const ANCHOR_LINE_MAX = 280;
  const CHANGE_DELAY_MS = 120;
  const SEARCH_DELAY_MS = 250;
  const RELOAD_ANCHOR_KEY = 'itemshare:scroll-anchor';
  const TAB_KEY = 'itemshare:tab';

  let liveState = 'wait';
  let refreshing = false;
  let queued = false;
  let timer = null;
  let everConnected = false;
  // Discard list responses that started before a successful bag mutation.
  let basketRevision = 0;
  let activeTab = 'request';

  // Which page of Already sent is on screen. It is kept here rather than in the address
  // bar: paging is a view of the same page, so it must not rewrite the URL, count as a
  // navigation, or move the reader to a different tab.
  let liveHistoryPage = Number(new URLSearchParams(window.location.search).get('historyPage')) || null;

  try {
    const stored = window.sessionStorage.getItem(TAB_KEY);
    if (stored === 'request' || stored === 'offer' || stored === 'mine') {
      activeTab = stored;
    }
  } catch (error) {
    // No storage: the request tab is the default, which is also the useful one.
  }

  const anchorLine = () => Math.min(window.innerHeight * ANCHOR_LINE_RATIO, ANCHOR_LINE_MAX);

  function setLiveState(state) {
    liveState = state;
    const labels = { live: 'Live', wait: 'Reconnecting', off: 'Not live' };

    listRegion.querySelectorAll('.live-pill').forEach((pill) => {
      if (pill.hidden) pill.hidden = false;
      if (pill.dataset.live !== state) pill.dataset.live = state;
      const text = labels[state] || state;
      if (pill.textContent !== text) pill.textContent = text;
    });
  }

  // ---------------------------------------------------------------------- tabs
  // Request and Offering are the same data cut two ways, so the tab is a display
  // choice the server does not need to know about. It survives a live refresh (the
  // region is re-rendered from the Request tab) and a page rebuild.
  function setTab(name, { focus = false } = {}) {
    const tabs = Array.from(listRegion.querySelectorAll('[data-tab]'));
    const panels = Array.from(listRegion.querySelectorAll('[data-panel]'));

    if (!tabs.some((tab) => tab.dataset.tab === name)) {
      return;
    }

    activeTab = name;

    tabs.forEach((tab) => {
      const selected = tab.dataset.tab === name;
      if (tab.getAttribute('aria-selected') !== String(selected)) tab.setAttribute('aria-selected', String(selected));
      if (tab.tabIndex !== (selected ? 0 : -1)) tab.tabIndex = selected ? 0 : -1;

      if (selected && focus) {
        tab.focus();
      }
    });

    panels.forEach((panel) => {
      const hidden = panel.dataset.panel !== name;
      if (panel.hidden !== hidden) panel.hidden = hidden;
    });

    try {
      window.sessionStorage.setItem(TAB_KEY, name);
    } catch (error) {
      // Tab choice is a convenience; failing to remember it changes nothing.
    }
  }

  listRegion.addEventListener('click', (event) => {
    const closest = (selector) => (event.target.closest ? event.target.closest(selector) : null);
    const tab = closest('[data-tab]');

    if (tab) {
      event.preventDefault();
      setTab(tab.dataset.tab, { focus: true });
      return;
    }

    const historyPage = closest('a[data-history-page]');
    if (historyPage) {
      // Leave modified clicks to the browser so pages can still open in another tab.
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const url = new URL(historyPage.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      event.preventDefault();
      // Only the list is replaced. The address bar keeps what it had and the tab being
      // read stays selected, so turning a page does not look like a move to another page.
      liveHistoryPage = Number(url.searchParams.get('historyPage')) || 1;
      scheduleRefresh(0);
      return;
    }

    // A column heading is the sort control and it cycles: ascending, descending, then
    // back to the type groups. The order is remembered in a cookie instead of the
    // address bar, so a shared link never carries somebody else's sorting.
    const sortButton = closest('[data-sort]');

    if (sortButton) {
      event.preventDefault();

      const field = sortButton.dataset.sort;
      const current = sortButton.dataset.dir;
      const next = current === 'asc' ? 'desc' : current === 'desc' ? '' : 'asc';

      writeSortCookie(next ? `${field}:${next}` : 'type:asc');
      scheduleRefresh(0);
      return;
    }

    // Grouping is the other half of how the list reads: whether the type headings are
    // drawn at all. It is kept apart from the sort so turning it off leaves the order
    // alone, and turning it on does not throw away the column somebody picked.
    const groupButton = closest('[data-group-toggle]');

    if (groupButton) {
      event.preventDefault();
      writeGroupCookie(groupButton.getAttribute('aria-pressed') === 'true' ? '0' : '1');
      scheduleRefresh(0);
      return;
    }

    const requestButton = closest('[data-request]');

    if (requestButton) {
      event.preventDefault();

      // One copy is not a choice. A stack of one, or the last copy of a bigger stack,
      // leaves exactly one possible answer, so the click sends it instead of opening a
      // dialog whose only option is "one". A standing offer is the same case.
      //
      // Except for somebody the site has not met: the dialog is the only place the ESO
      // account and the address are asked for, so it opens even for one copy. Skipping it
      // sent a request with no person behind it, and the answer was a toast telling them
      // to say things they had never been asked.
      const available = Math.max(1, Number(requestButton.dataset.max) || 1);

      if (available <= 1 && !document.body.dataset.guestRequest) {
        sendRequest({
          kind: requestButton.dataset.kind === 'offer' ? 'offer' : 'inventory',
          id: requestButton.dataset.id,
          quantity: 1,
          name: requestButton.dataset.name || 'that item',
        });
        return;
      }

      openRequestDialog(requestButton);
      return;
    }

    const cancelButton = closest('[data-cancel-request]');

    if (cancelButton) {
      event.preventDefault();
      cancelOwnRequest(cancelButton);
    }
  });

  listRegion.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }

    const tabs = Array.from(listRegion.querySelectorAll('[data-tab]'));
    const index = tabs.findIndex((tab) => tab.dataset.tab === activeTab);

    if (index === -1) {
      return;
    }

    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : tabs.length - 1;
    setTab(tabs[(index + step) % tabs.length].dataset.tab, { focus: true });
  });

  if (new URLSearchParams(window.location.search).has('historyPage')) activeTab = 'mine';
  setTab(activeTab);
  window.addEventListener('popstate', () => {
    liveHistoryPage = Number(new URLSearchParams(window.location.search).get('historyPage')) || null;
    setTab('mine');
    scheduleRefresh(0);
  });

  // ------------------------------------------------------------------- filters
  // Filters apply as soon as they change - there is no button to forget - and the
  // address bar keeps up, so a reload or a live refresh uses the same filters.
  const filterForm = document.querySelector('[data-filters]');

  // The sort order is a reading preference, so it is remembered in a cookie and never
  // written into the address bar. `type:asc` means "no choice": the plain type grouping
  // the server sends anyway, which also clears a choice made on an earlier visit.
  // Its own cookie, for the same reason: a display choice should not be in the URL, and
  // the two choices are independent, so one must not overwrite the other.
  function writeGroupCookie(value) {
    document.cookie = `itemshare_group=${encodeURIComponent(
      value
    )}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }

  function writeSortCookie(value) {
    document.cookie = `itemshare_sort=${encodeURIComponent(
      value
    )}; Path=/; Max-Age=31536000; SameSite=Lax`;
  }

  // A filter can hold several values, and what is switched on is shown as chips
  // under the row, so the controls and the chips are built from one place.
  function chosenValues(name) {
    const values = [];

    filterForm.querySelectorAll(`[data-filter][name="${name}"]`).forEach((field) => {
      if (field.type === 'checkbox') {
        if (field.checked && field.value) {
          values.push(field.value);
        }
        return;
      }

      const value = String(field.value || '').trim();

      if (value) {
        values.push(value);
      }
    });

    return values;
  }

  function renderFilterChips() {
    const row = filterForm.querySelector('[data-filter-chips]');

    if (!row) {
      return;
    }

    row.textContent = '';

    ['type', 'owner'].forEach((name) => {
      chosenValues(name).forEach((value) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'filter-chip';
        chip.dataset.chipFilter = name;
        chip.dataset.chipValue = value;
        chip.title = `Remove the ${value} filter`;
        chip.setAttribute('aria-label', `Remove the ${value} filter`);
        chip.append(document.createTextNode(value));

        const cross = document.createElement('span');
        cross.setAttribute('aria-hidden', 'true');
        cross.textContent = '\u00d7';
        chip.appendChild(cross);
        row.appendChild(chip);
      });
    });
  }

  // Each menu says how many of its values are on, so a closed menu still answers
  // whether it is doing anything.
  function renderFilterMenus() {
    filterForm.querySelectorAll('[data-filter-menu]').forEach((menu) => {
      const checked = Array.from(
        menu.querySelectorAll('input[type="checkbox"][data-filter]')
      ).filter((box) => box.checked);
      const label = menu.querySelector('.filter-select-label');
      const badge = menu.querySelector('.filter-count');
      const allLabel = menu.dataset.allLabel || 'All';

      if (label) {
        label.textContent =
          checked.length === 0
            ? allLabel
            : checked.length === 1
              ? checked[0].value
              : `${checked.length} chosen`;
      }
      if (badge) {
        badge.textContent = String(checked.length);
        badge.hidden = checked.length === 0;
      }
    });
  }

  function applyFilters() {
    if (!filterForm) {
      return;
    }

    const params = new URLSearchParams();

    ['type', 'owner', 'added', 'q'].forEach((name) => {
      chosenValues(name).forEach((value) => params.append(name, value));
    });

    renderFilterChips();
    renderFilterMenus();

    const query = params.toString();

    // A new filter is a new list, so it starts at the first page rather than at whichever
    // page of the previous list happened to be open.
    liveHistoryPage = null;

    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', query ? `/?${query}` : '/');
    }

    scheduleRefresh(0);
  }

  if (filterForm) {
    let searchTimer = null;

    filterForm.addEventListener('change', (event) => {
      if (!event.target.matches('[data-filter]')) {
        return;
      }

      // Picking something in a menu closes it; the chip below shows the result.
      const menu = event.target.closest('details');

      if (menu && event.target.type === 'checkbox') {
        menu.open = false;
      }

      applyFilters();
    });

    // Typing filters as it is typed, just slowly enough not to fetch on every key.
    filterForm.addEventListener('input', (event) => {
      if (!event.target.matches('input[type="search"][data-filter]')) {
        return;
      }

      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(applyFilters, SEARCH_DELAY_MS);
    });

    filterForm.addEventListener('submit', (event) => {
      event.preventDefault();
      applyFilters();
    });

    // A chip removes its own value and leaves the rest of the filters alone.
    filterForm.addEventListener('click', (event) => {
      const chip = event.target.closest ? event.target.closest('[data-chip-filter]') : null;

      if (!chip) {
        return;
      }

      event.preventDefault();
      const name = chip.dataset.chipFilter;
      const value = chip.dataset.chipValue;

      filterForm.querySelectorAll(`[data-filter][name="${name}"]`).forEach((field) => {
        if (field.type === 'checkbox' && field.value === value) {
          field.checked = false;
        } else if (field.tagName === 'SELECT' && field.value === value) {
          field.value = '';
        }
      });

      applyFilters();
    });

    const clearButton = filterForm.querySelector('[data-clear-filters]');

    if (clearButton) {
      clearButton.addEventListener('click', () => {
        filterForm.querySelectorAll('[data-filter]').forEach((field) => {
          if (field.type === 'checkbox') {
            field.checked = false;
          } else {
            field.value = '';
          }
        });
        applyFilters();
      });
    }

    // A click outside a menu closes it, so two open menus never sit over each other
    // while the reader is trying to use the one underneath.
    document.addEventListener('click', (event) => {
      filterForm.querySelectorAll('details[open]').forEach((menu) => {
        if (!menu.contains(event.target)) {
          menu.open = false;
        }
      });
    });

    renderFilterChips();
    renderFilterMenus();
  }

  // -------------------------------------------------------- keeping the place
  // The row the reader is looking at: the first one crossing the anchor line. Null
  // when the list is off screen, because then nothing on it has to hold its place.
  function captureAnchor() {
    const rows = Array.from(listRegion.querySelectorAll('tr[data-item-key]'));

    if (rows.length === 0) {
      return null;
    }

    const line = anchorLine();
    let index = rows.length - 1;

    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].getBoundingClientRect().bottom > line) {
        index = i;
        break;
      }
    }

    const rect = rows[index].getBoundingClientRect();

    if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
      return null;
    }

    return { key: rows[index].dataset.itemKey, index, offset: rect.top - line };
  }

  function restoreAnchor(anchor) {
    if (!anchor) {
      return;
    }

    const rows = Array.from(listRegion.querySelectorAll('tr[data-item-key]'));

    if (rows.length === 0) {
      return;
    }

    const match = rows.find((row) => row.dataset.itemKey === anchor.key);
    // Removed item: the row that moved up into its slot is the next one down.
    const target = match || rows[Math.min(anchor.index, rows.length - 1)];
    const delta = target.getBoundingClientRect().top - anchorLine() - anchor.offset;

    if (Math.abs(delta) >= 1) {
      window.scrollBy(0, delta);
    }
  }

  function rememberAcrossReload(anchor) {
    try {
      window.sessionStorage.setItem(RELOAD_ANCHOR_KEY, JSON.stringify(anchor));
    } catch (error) {
      // Private mode or storage turned off: a rebuild simply starts at the top.
    }
  }

  // The bar is the only part of the header that depends on the basket, so it is the only
  // part that has to be rebuilt when the basket changes. The last item leaving takes it
  // away outright: a clock and a warning about unsent items mean nothing once nothing is
  // waiting, and the next item added brings it back.
  let headerBarFetching = false;
  let headerBasket = null;
  let basketChangeQueue = Promise.resolve();

  // Keep mutation responses in the same order as the clicks that produced them.
  // Otherwise a slower cancellation can restore a snapshot taken before the last one.
  function lockBasketChanges() {
    const ready = basketChangeQueue;
    let release;
    basketChangeQueue = new Promise((resolve) => { release = resolve; });
    return ready.then(() => release);
  }

  async function syncHeaderBar(heldNow, summary = { unique: 0, copies: 0 }, basket = null) {
    if (basket) {
      basket = { ...basket, deadline: Date.now() + Math.max(0, basket.secondsLeft) * 1000 };
    }
    headerBasket = { heldNow, summary, basket };
    if (basket?.holdMinutes) {
      document.body.dataset.holdMinutes = String(basket.holdMinutes);
    }
    const current = document.querySelector('[data-basket]');

    if (!heldNow) {
      if (current) {
        current.remove();
      }
      return;
    }

    // Adds and removals reset the server's clock. Use its new remaining time too.
    if (current) {
      updateHeaderBar(current, summary);
      updateBasketClock(current, basket);
      tickCountdown();
      return;
    }

    if (current || headerBarFetching) {
      return;
    }

    headerBarFetching = true;

    try {
      const response = await fetch(window.location.pathname + window.location.search, {
        credentials: 'same-origin',
        headers: { Accept: 'text/html' },
        cache: 'no-store',
      });

      if (!response.ok) {
        return;
      }

      const template = document.createElement('template');
      template.innerHTML = await response.text();
      const bar = template.content.querySelector('[data-basket]');
      const after = document.querySelector('.top-bar-left');

      // Only if it is still missing: a slower answer must not add a second clock over a
      // bar an earlier one already put back.
      if (bar && after && headerBasket.heldNow && !document.querySelector('[data-basket]')) {
        updateHeaderBar(bar, headerBasket.summary);
        updateBasketClock(bar, headerBasket.basket);
        after.insertAdjacentElement('afterend', bar);
        tickCountdown();
      }
    } catch (error) {
      // Offline. The next refresh asks again.
    } finally {
      headerBarFetching = false;
    }
  }

  function applyRegion(html) {
    const template = document.createElement('template');
    template.innerHTML = html;

    const next = template.content.querySelector('#itemLists');

    if (!next) {
      // The viewer has no list any more, so the page around it has to go too.
      window.location.reload();
      return;
    }

    const anchor = captureAnchor();
    // Prepare newly inserted controls with this browser's state before attachment.
    next.querySelectorAll('[data-tab]').forEach(tab => {
      const selected = tab.dataset.tab === activeTab;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    next.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== activeTab; });
    next.querySelectorAll('.live-pill').forEach(pill => {
      pill.hidden = false;
      pill.dataset.live = liveState;
      pill.textContent = { live: 'Live', wait: 'Reconnecting', off: 'Not live' }[liveState] || liveState;
    });

    // The hold bar sits in the header, outside this region, so a change in what is being
    // held cannot be shown by swapping the list alone. Only that bar is rebuilt: reloading
    // the page instead threw away anything half-typed and asked the browser's own "leave
    // this page?" question, which is how sending a basket used to end.
    // Every refresh reconciles the bar, not only one where its presence differs: the two
    // numbers on it move as items are added, topped up or removed, and an empty bag takes
    // the whole bar away.
    const heldRows = Array.from(next.querySelectorAll('[data-basket-row][data-status="draft"]'));

    syncHeaderBar(heldRows.length > 0, {
      unique: heldRows.length,
      copies: heldRows.reduce(
        (sum, row) => sum + (Number(row.dataset.requestQuantity) || 1),
        0
      ),
    }, {
      secondsLeft: Number(next.dataset.basketSeconds) || 0,
      holdMinutes: Number(next.dataset.holdMinutes) || 5,
    });

    const filterTemplate = next.querySelector('template[data-live-filters]');
    const filters = document.getElementById('itemFilters');
    if (filters && filterTemplate) {
      // Preserve the form itself and its delegated listeners as facets come and go.
      if (filterTemplate.content.childElementCount) {
        reconcileLiveChildren(filters, filterTemplate.content);
        const hidden = filterTemplate.dataset.empty === '1';
        if (filters.hidden !== hidden) filters.hidden = hidden;
      } else if (!filters.hidden) {
        filters.hidden = true;
      }
    }

    const rowTops = captureRowTops(listRegion);
    const panelHeights = Array.from(listRegion.querySelectorAll('[data-panel]')).map((panel) =>
      panel.getBoundingClientRect().height
    );

    reconcileLiveNode(listRegion, next);

    restoreAnchor(anchor);
    animatePanelHeights(listRegion, panelHeights);
    animateRowsInto(listRegion, rowTops);
    localiseTimeLabels(listRegion);
    relativeTick(listRegion);
    noteClosedRequests();
    syncRequestDialog();
  }

  /**
   * Which page of Already sent the list should ask for: the one being read, or the one
   * the address bar arrived with. In one place, so the request and the "are these new
   * cancellations?" check cannot disagree about which page is on screen.
   */
  function listHistoryPage() {
    return (
      liveHistoryPage || Number(new URLSearchParams(window.location.search).get('historyPage')) || 1
    );
  }

  /** The address bar's filters, with the page being read added in. */
  function listQuery() {
    const params = new URLSearchParams(window.location.search);
    const page = listHistoryPage();

    if (page > 1) {
      params.set('historyPage', String(page));
    } else {
      params.delete('historyPage');
    }

    const query = params.toString();

    return query ? `?${query}` : '';
  }

  async function refresh() {
    if (refreshing) {
      queued = true;
      return;
    }

    refreshing = true;
    const revision = basketRevision;
    const query = listQuery();

    try {
      const response = await fetch(`/items${query}`, {
        credentials: 'same-origin',
        headers: { Accept: 'text/html' },
        cache: 'no-store',
      });

      if (response.ok) {
        const html = await response.text();
        if (revision === basketRevision && query === listQuery()) {
          applyRegion(html);
        } else {
          queued = true;
        }
      }
    } catch (error) {
      // Offline, or the server is restarting: the next reconnect refreshes.
    } finally {
      refreshing = false;

      if (queued) {
        queued = false;
        scheduleRefresh();
      }
    }
  }

  function scheduleRefresh(delay = CHANGE_DELAY_MS) {
    if (timer) {
      return;
    }

    timer = window.setTimeout(() => {
      timer = null;
      refresh();
    }, delay);
  }

  refreshListsSoon = (delay = 0) => scheduleRefresh(delay);

  // ---------------------------------------------------------------- requests
  // The button carries how many this person may end up holding, their own basket
  // included, so the dialog can offer the rest of a stack that is partly theirs
  // already: one, or everything they can hold, and the second only when it is more
  // than one - a number nobody could check is not worth asking for.
  let dialog = null;
  let dialogState = null;
  const knownClosed = new Set();
  let requestsPrimed = false;
  let closedHistoryPage = new URLSearchParams(window.location.search).get('historyPage') || '1';

  function escapeText(value) {
    const node = document.createElement('span');
    node.textContent = String(value || '');
    return node.innerHTML;
  }

  function closeRequestDialog() {
    if (dialog) {
      dialog.remove();
      dialog = null;
    }

    dialogState = null;
    document.removeEventListener('keydown', onDialogKey);
  }

  function onDialogKey(event) {
    if (event.key === 'Escape') {
      closeRequestDialog();
    }
  }

  // How many copies this person may still claim on one row: the ones nobody has
  // reserved. Their own basket is not added in, because RESERVED already counts it and
  // asking again adds to that row instead of starting a second one.
  function dialogNumbers(button) {
    if (!button) {
      return { max: 0, stack: 0, held: 0 };
    }

    const stack = Math.max(1, Number(button.dataset.stack) || 1);
    const max = Math.min(stack, Math.max(0, Number(button.dataset.max) || 0));
    const held = Math.max(0, Number(button.dataset.held) || 0);

    return { max, stack, held };
  }

  /**
   * A copy count the controls can actually show: a whole number from 1 to the number
   * left. Typed text that is not a number, a fraction, or more than there is, all come
   * back as something the slider has a position for.
   */
  function clampCopies(value, max) {
    const cap = Math.max(1, Math.trunc(Number(max) || 1));
    const wanted = Math.trunc(Number(value) || 1);

    return Math.min(cap, Math.max(1, wanted));
  }

  function dialogSummary(state) {
    if (state.kind === 'offer') {
      return 'This is a standing offer, so it means one copy.';
    }

    if (state.max < 1) {
      return 'Every copy has just been reserved, so there is nothing left to ask for.';
    }

    return `${state.max}${state.stack > state.max ? ` of the ${state.stack}` : ''} still available${
      state.held > 0
        ? `, and ${state.held} already in your basket - asking for more adds to that row rather than starting another`
        : ''
    }.`;
  }

  // The same password box the page's forms draw (lib/views.js), built here because this
  // dialog is assembled after the page has loaded. `/password-toggle.js` listens on the
  // document rather than on each box, so the eye works on these too.
  function passwordBox({ id, label, name, hint = '' }) {
    return `
          <div class="auth-field">
            <label for="${id}">${escapeText(label)}</label>
            <span class="password-field" data-password-field>
              <input id="${id}" type="password" name="${name}" autocomplete="new-password"
                     minlength="8" maxlength="200" required>
              <button class="password-toggle" type="button" data-reveal-password
                      aria-pressed="false" aria-label="Show the password" title="Show the password">
                <svg class="password-eye" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M1.75 12S5.6 5.5 12 5.5 22.25 12 22.25 12 18.4 18.5 12 18.5 1.75 12 1.75 12Z"
                        fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
                  <circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" stroke-width="1.7"/>
                </svg>
                <svg class="password-eye-off" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M2.5 2.5 21.5 21.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
                  <path d="M9.9 5.9A10.6 10.6 0 0 1 12 5.5c6.4 0 10.25 6.5 10.25 6.5a18.4 18.4 0 0 1-3.9 4.4M6.1 7.7A18 18 0 0 0 1.75 12S5.6 18.5 12 18.5a10.9 10.9 0 0 0 3.9-.7"
                        fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
                </svg>
              </button>
            </span>
            ${hint ? `<span class="auth-hint">${escapeText(hint)}</span>` : ''}
          </div>`;
  }

  function openRequestDialog(button) {
    const kind = button.dataset.kind === 'offer' ? 'offer' : 'inventory';
    const numbers = dialogNumbers(button);
    const name = button.dataset.name || 'that item';
    const choices = kind === 'inventory' && numbers.max > 1;
    const state = { kind, id: button.dataset.id, name, ...numbers };

    closeRequestDialog();

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    // The first request from somebody who has not signed in carries everything a request
    // needs: the ESO account it is made from, an address to answer, and a password so the
    // request can be found again later. Together they make a real account, so the second
    // request asks nothing and the sign-in card lets them back in.
    // Somebody signed in who has not attached an ESO account yet is asked for the one
    // name the request needs, and nothing else: the address and the sign-in already
    // exist, so asking for them again would be asking a question they answered.
    const accountOnlyFields = `
      <div class="guest-fields">
        <label class="auth-field">
          <span>ESO account name</span>
          <input type="text" name="accountName" autocomplete="off" spellcheck="false"
                 maxlength="96" placeholder="@YourAccountName" required>
        </label>
        <p class="auth-hint">The character the request is made from. It is attached to this sign-in, so you are only asked once.</p>
      </div>`;
    const guestFields = document.body.dataset.guestRequest
      ? `
        <div class="guest-fields">
          <label class="auth-field">
            <span>ESO account name</span>
            <input type="text" name="accountName" autocomplete="off" spellcheck="false"
                   maxlength="96" placeholder="@YourAccountName" required>
          </label>
          <label class="auth-field">
            <span>Email address</span>
            <input type="email" name="email" autocomplete="email" spellcheck="false"
                   maxlength="254" placeholder="you@example.com" required>
          </label>
          ${passwordBox({ id: 'guest-password', label: 'Password', name: 'password' })}
          ${passwordBox({ id: 'guest-confirm', label: 'Type it again', name: 'confirm' })}
          <p class="auth-hint dialog-note" data-dialog-note hidden></p>
          <p class="auth-hint">Asked once. These make an account: the request is made from that character, the answer goes to that address, and the password is how you sign back in to see it.</p>
        </div>`
      : document.querySelector('[data-needs-account]')
        ? accountOnlyFields
        : '';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="requestTitle">
        <h2 id="requestTitle">Reserve ${escapeText(name)}</h2>
        <p class="muted" data-dialog-summary>${escapeText(dialogSummary(state))}</p>
        ${guestFields}
        ${
          choices
            ? `<div class="reserve-picker">
          <input class="reserve-slider" type="range" min="1" max="${state.max}" step="1" value="1"
                 data-reserve-slider aria-label="Copies to reserve, 1 to ${state.max}">
          <input class="reserve-amount" type="number" min="1" max="${state.max}" step="1" value="1"
                 inputmode="numeric" data-reserve-amount aria-label="Copies to reserve">
        </div>`
            : ''
        }
        <div class="modal-actions reserve-actions">
          <button class="round-button is-cancel" type="button" data-close-dialog
                  title="Cancel" aria-label="Cancel">&#10005;</button>
          <button class="round-button is-confirm" type="button" data-reserve-confirm
                  title="Reserve" aria-label="Reserve">&#10003;</button>
        </div>
      </div>`;

    document.body.appendChild(backdrop);
    dialog = backdrop;
    dialogState = state;
    document.addEventListener('keydown', onDialogKey);

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop || (event.target.closest && event.target.closest('[data-close-dialog]'))) {
        closeRequestDialog();
      }
    });

    // One answer, and the number in it belongs to the person: a slider from one copy to
    // everything still available, with a box showing the same number that can be typed
    // into. Whole copies only, and never more than are left.
    const ask = () => {
      const amount = backdrop.querySelector('[data-reserve-amount]');
      const accountName = backdrop.querySelector('input[name="accountName"]');
      const email = backdrop.querySelector('input[name="email"]');
      const password = backdrop.querySelector('input[name="password"]');
      const confirm = backdrop.querySelector('input[name="confirm"]');
      const note = backdrop.querySelector('[data-dialog-note]');

      // One sentence in the dialog rather than a silent move of the caret: a password
      // typed twice and disagreed is a typo somebody has to be told about.
      const say = (message, field) => {
        if (note) {
          note.textContent = message;
          note.hidden = false;
        }

        if (field) {
          field.focus();
        }
      };

      if (note) {
        note.hidden = true;
      }

      // Nothing is sent until all of it is there: the request would have no character to
      // come from, no address to be answered at, and no way back in. A 400 after closing
      // the dialog is a worse way to learn that than the caret in the empty box.
      if (accountName && !accountName.value.trim()) {
        accountName.focus();
        return;
      }

      if (email && !email.value.trim()) {
        email.focus();
        return;
      }

      // The browser's minlength only guards a form submit, and this is a button click, so
      // the length the server will insist on is checked here too.
      if (password && password.value.length < 8) {
        say('Use a password of at least 8 characters.', password);
        return;
      }

      // Two boxes, because this makes an account: a typo in the only one would lock the
      // person out of the answers they are being promised an address for.
      if (password && confirm && confirm.value !== password.value) {
        say('Those two passwords are not the same.', confirm);
        return;
      }

      // The row moves while the dialog is open - somebody else claims a copy, the owner
      // uploads a smaller count - so what is left is read again at the moment of asking.
      // A number that no longer fits is clamped to the new top, and once every copy has
      // gone nothing is sent at all: the dialog stays open and says so.
      refreshDialogNumbers();

      if (dialogState.max < 1) {
        syncRequestDialog();
        return;
      }

      const picked = {
        kind,
        id: button.dataset.id,
        quantity: choices ? clampCopies(amount ? amount.value : 1, dialogState.max) : 1,
        name,
        accountName: accountName ? accountName.value.trim() : '',
        email: email ? email.value.trim() : '',
        password: password ? password.value : '',
        confirm: confirm ? confirm.value : '',
      };

      closeRequestDialog();
      sendRequest(picked);
    };

    const confirmButton = backdrop.querySelector('[data-reserve-confirm]');

    if (confirmButton) {
      confirmButton.addEventListener('click', () => ask());
      confirmButton.focus();
    }

    const slider = backdrop.querySelector('[data-reserve-slider]');
    const amountBox = backdrop.querySelector('[data-reserve-amount]');

    if (slider && amountBox) {
      // The two controls are one answer: moving either moves the other, and the box is
      // held to whole copies the slider has a position for rather than being allowed to
      // drift to a number that cannot be chosen.
      const limit = Math.max(1, dialogState ? dialogState.max : 1);
      const setCopies = (value) => {
        const copies = clampCopies(value, limit);
        slider.value = String(copies);

        return copies;
      };

      slider.addEventListener('input', () => {
        amountBox.value = String(setCopies(slider.value));
      });

      amountBox.addEventListener('input', () => {
        const digits = amountBox.value.replace(/[^\d]/g, '');

        if (digits !== amountBox.value) {
          amountBox.value = digits;
        }

        if (digits) {
          slider.value = String(clampCopies(digits, limit));
        }
      });

      // A number the slider cannot hold snaps to the nearest it can on the way out of the
      // box, so what is sent is always one of the slider's own values.
      amountBox.addEventListener('change', () => {
        amountBox.value = String(setCopies(amountBox.value));
      });

      amountBox.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          ask();
        }
      });
    }
  }

  /**
   * Re-reads the row the dialog was opened from. The list under the dialog keeps moving,
   * so the number left comes from the row again rather than from when the dialog opened.
   * A row with nothing left is not in the list at all - "All held" stands where its
   * button was - and that reads here as nothing left.
   */
  function refreshDialogNumbers() {
    if (!dialogState) {
      return null;
    }

    const fresh = document.querySelector(
      `[data-request][data-kind="${dialogState.kind}"][data-id="${dialogState.id}"]`
    );
    const numbers = dialogNumbers(fresh);

    dialogState.max = numbers.max;
    dialogState.stack = numbers.stack;
    dialogState.held = numbers.held;

    return dialogState;
  }

  /**
   * Keeps an open dialog honest while the list under it moves: when somebody else
   * claims a copy, the number left, the top of the slider and the cap on the box all
   * follow it down, without making the person close and reopen the dialog.
   */
  function syncRequestDialog() {
    if (!dialog || !dialogState) {
      return;
    }

    refreshDialogNumbers();

    const summary = dialog.querySelector('[data-dialog-summary]');

    if (summary) {
      summary.textContent = dialogSummary(dialogState);
    }

    const nothingLeft = dialogState.max < 1;
    const cap = String(Math.max(1, dialogState.max));
    const slider = dialog.querySelector('[data-reserve-slider]');
    const amountBox = dialog.querySelector('[data-reserve-amount]');

    // The ceiling can fall while the dialog is open, so both controls follow it and a
    // number that no longer fits snaps to the new top.
    if (slider) {
      slider.max = cap;
      slider.disabled = nothingLeft;
      slider.value = String(clampCopies(slider.value, dialogState.max));
    }

    if (amountBox) {
      amountBox.max = cap;
      amountBox.disabled = nothingLeft;

      if (Number(amountBox.value) > dialogState.max) {
        amountBox.value = cap;
      }
    }

    const confirmButton = dialog.querySelector('[data-reserve-confirm]');

    if (confirmButton) {
      confirmButton.disabled = nothingLeft;
    }
  }

  // A reservation is not a request. The copy leaves everyone else's list the moment it is
  // picked, but no owner is asked until the basket is sent - so the difference is said at
  // the moment the first copy goes into an empty basket. Somebody who reads the click as
  // the request itself walks away, and the hold simply lapses.
  //
  // This used to be once per browser session, tracked in sessionStorage, which is why it
  // could not be seen: any earlier hold in that tab set the flag for good, however long
  // ago it was and whatever had happened to that basket since. Tying it to the empty
  // basket says it at the moment the confusion is actually possible, and only then.

  function holdMinutes() {
    // The bar is drawn from the basket the server just read, so it carries the number the
    // hold really is. The body attribute is the same number on a page with no bar, and 5
    // is only a last resort for a page that predates either.
    const bar = document.querySelector('[data-basket]');
    const fromBar = bar ? Number(bar.dataset.holdMinutes) : 0;

    return Math.max(1, fromBar || Number(document.body.dataset.holdMinutes) || 5);
  }

  /** What the bag holds right now: different items, and copies in all. */
  function basketSummary() {
    if (headerBasket) return headerBasket.summary;
    const bar = document.querySelector('[data-basket]');

    if (bar) {
      return {
        unique: Number(bar.dataset.items) || 0,
        copies: Number(bar.dataset.copies) || Number(bar.dataset.items) || 0,
      };
    }

    const rows = Array.from(document.querySelectorAll('[data-basket-row][data-status="draft"]'));

    return {
      unique: rows.length,
      copies: rows.reduce((sum, row) => sum + (Number(row.dataset.requestQuantity) || 1), 0),
    };
  }

  /** Keeps the bar's two numbers honest when the list changes underneath it. */
  function updateHeaderBar(bar, { unique, copies }) {
    const label = bar.querySelector('.draft-basket-text strong');

    if (label) {
      const text = `${unique} unique item${unique === 1 ? '' : 's'} (${copies} total) reserved`;
      if (label.textContent !== text) label.textContent = text;
    }

    if (bar.dataset.items !== String(unique)) bar.dataset.items = String(unique);
    if (bar.dataset.copies !== String(copies)) bar.dataset.copies = String(copies);
  }

  function updateBasketClock(bar, basket) {
    if (!basket) return;
    bar.dataset.holdMinutes = String(basket.holdMinutes);
    bar.dataset.seconds = String(basket.secondsLeft);
    bar.dataset.deadline = String(basket.deadline || Date.now() + Math.max(0, basket.secondsLeft) * 1000);
    delete bar.dataset.lapsed;
    const label = bar.querySelector('[data-countdown]');
    if (label) label.classList.remove('countdown-fading');
  }

  function explainFirstHold(name, copies) {
    const minutes = holdMinutes();
    const what = copies > 1 ? `${copies} copies of ${name}` : name;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="holdTitle">
        <h2 id="holdTitle" class="modal-title-bar">Reserved - not sent yet</h2>
        <p>${escapeText(what)} ${copies > 1 ? 'have' : 'has'} been reserved, but not sent yet.</p>
        <p class="muted">${copies > 1 ? 'Items' : 'Item'} will not be requested until you submit your request, your reservation will expire in ${minutes} minute${minutes === 1 ? '' : 's'}.</p>
        <div class="modal-actions">
          <button class="primary-button" type="button" data-close-hold>Keep looking</button>
          <button class="primary-button" type="button" data-send-hold>Send Requests</button>
        </div>
      </div>`;

    document.body.appendChild(backdrop);

    function onKey(event) {
      if (event.key === 'Escape') {
        close();
      }
    }

    const close = () => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
    };

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop || event.target.closest('[data-close-hold]')) {
        close();
        return;
      }

      if (event.target.closest('[data-send-hold]')) {
        close();
        const button = document.querySelector('[data-submit-requests]');

        if (button) {
          button.click();
        } else {
          refreshAfterChange();
          showToast('Press Send Requests in the header to ask for it.', 'ok');
        }
      }
    });

    document.addEventListener('keydown', onKey);

    // Keep looking is the default answer: pressing Enter on this notice should not send a
    // request somebody only meant to look at.
    const keepLooking = backdrop.querySelector('[data-close-hold]');

    if (keepLooking) {
      keepLooking.focus();
    }
  }

  async function sendRequest({
    kind,
    id,
    quantity,
    name,
    accountName = '',
    email = '',
    password = '',
    confirm = '',
  }) {
    const release = await lockBasketChanges();
    // Read before the request goes, and read as a count: a bag with nothing in it is the
    // moment the notice is about, whether it has never held anything or was emptied a
    // moment ago. The quantity is settled by the dialog before this runs, so the copy that
    // is about to be added is the one being counted for.
    const basketWasEmpty = basketSummary().unique === 0;

    try {
      const payload = new URLSearchParams({ kind, id, quantity });

      if (accountName) {
        payload.set('accountName', accountName);
      }

      if (email) {
        payload.set('email', email);
      }

      if (password) {
        payload.set('password', password);
      }

      if (confirm) {
        payload.set('confirm', confirm);
      }

      const response = await fetch('/requests', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload,
      });
      const result = await response.json().catch(() => ({}));

      // A demo session is answered with the reason, not with a failure: the click was
      // understood, and nothing was written.
      if (result.demo) {
        showToast(result.error, 'err');
        return;
      }

      if (!response.ok) {
        throw new Error(result.error || `That request failed with status ${response.status}`);
      }

      // The first request made them a person, so the page stops asking: the fields were
      // only ever for somebody the site had never met.
      if (document.body.dataset.guestRequest) {
        delete document.body.dataset.guestRequest;
      }

      // The request attached the account to this sign-in, so the question is answered:
      // the marker goes, and the next refresh draws the region without it.
      document
        .querySelectorAll('[data-needs-account]')
        .forEach((marker) => marker.remove());

      // Asking again for something already in the basket tops that row up, so the
      // number that stuck is the one to report, not the one that was picked.
      const asked = Number(result.quantity) || quantity;

      basketRevision++;
      if (result.basket) {
        syncHeaderBar(result.basket.count > 0, {
          unique: result.basket.count,
          copies: result.basket.quantity,
        }, result.basket);
      }

      if (basketWasEmpty) {
        explainFirstHold(name, asked);
      }

      showToast(
        result.combined
          ? `Your basket now holds ${asked} of ${name}.`
          : asked > 1
            ? `Reserved ${asked} of ${name}.`
            : `Reserved ${name}.`,
        'ok'
      );
      refreshAfterChange();
    } catch (error) {
      showToast(error.message, 'err');
    } finally {
      release();
    }
  }

  async function cancelOwnRequest(button) {
    const release = await lockBasketChanges();
    try {
      const response = await fetch(`/requests/${encodeURIComponent(button.dataset.id)}/cancel`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || 'That request could not be cancelled.');
      }

      basketRevision++;
      const row = button.closest('[data-basket-row]');
      if (row) row.dataset.status = 'cancelled';
      if (result.basket) {
        syncHeaderBar(result.basket.count > 0, {
          unique: result.basket.count,
          copies: result.basket.quantity,
        }, result.basket);
      }
      showToast('Request cancelled.', 'ok');
      refreshAfterChange();
    } catch (error) {
      showToast(error.message, 'err');
    } finally {
      release();
    }
  }

  // A request can be closed by someone else's upload, which arrives as an ordinary
  // list refresh. The first pass only records what is already closed, so opening the
  // page does not announce history; after that, anything newly cancelled is news.
  function noteClosedRequests() {
    const page = String(listHistoryPage());
    const historyChanged = page !== closedHistoryPage;
    closedHistoryPage = page;
    const closed = Array.from(
      listRegion.querySelectorAll('[data-my-request][data-status="cancelled"]')
    );
    const fresh = [];

    for (const row of closed) {
      const id = row.dataset.requestId;

      if (!id || knownClosed.has(id)) {
        continue;
      }

      knownClosed.add(id);

      if (requestsPrimed && !(historyChanged && row.hasAttribute('data-history-row'))) {
        fresh.push(row);
      }
    }

    if (!requestsPrimed) {
      requestsPrimed = true;
      return;
    }

    if (fresh.length > 0) {
      showToast(
        fresh
          .map(
            (row) =>
              `Your request for ${row.dataset.requestName || 'an item'} was cancelled: ${
                row.dataset.requestReason || 'the owner no longer has it.'
              }`
          )
          .join('\n'),
        'err'
      );
    }
  }

  noteClosedRequests();

  // ------------------------------------------------------------------- socket
  const socket = typeof window.io === 'function' ? window.io({ withCredentials: true }) : null;

  if (socket) {
    socket.on('connect', () => {
      setLiveState('live');

      // A reconnect may have missed changes while the tab was asleep or the server
      // was restarting, so the list is fetched once the link is back.
      if (everConnected) {
        scheduleRefresh(0);
      }
      everConnected = true;
    });

    socket.on('disconnect', () => setLiveState('wait'));
    socket.on('connect_error', () => setLiveState('wait'));
    socket.on('items:changed', () => scheduleRefresh());
  } else {
    setLiveState('off');
  }

  // A rebuild for a changed filter list happens in a new page; put the reader back
  // on the row they were on rather than at the top.
  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => {
      let anchor = null;

      try {
        const raw = window.sessionStorage.getItem(RELOAD_ANCHOR_KEY);

        if (raw) {
          window.sessionStorage.removeItem(RELOAD_ANCHOR_KEY);
          anchor = JSON.parse(raw);
        }
      } catch (error) {
        anchor = null;
      }

      if (anchor) {
        restoreAnchor(anchor);
      }
    });
  }
}

// ------------------------------------------------------- unsent request basket
// A request holds its item before it is sent, so the clock matters twice: the person
// needs to see how long they have left, and walking away would strand a reservation
// nobody knows about. Both live here.

function basketHeldItems() {
  const basket = document.querySelector('[data-basket]');
  return basket ? Number(basket.dataset.items) || 0 : 0;
}

// The server sends the seconds left as it renders the page; from then on this counts
// down against the clock, so the number moves without one request per second. A live
// refresh replaces the element, which restarts it from whatever the server now says.
const COUNTDOWN_SOON_SECONDS = 60;
const COUNTDOWN_URGENT_SECONDS = 30;
const COUNTDOWN_FADE_MS = 2000;

function tickCountdown() {
  const basket = document.querySelector('[data-basket]');
  const label = basket ? basket.querySelector('[data-countdown]') : null;

  if (!basket || !label) {
    return;
  }

  if (!basket.dataset.deadline) {
    basket.dataset.deadline = String(Date.now() + (Number(basket.dataset.seconds) || 0) * 1000);
  }

  const remaining = Math.max(0, Math.round((Number(basket.dataset.deadline) - Date.now()) / 1000));
  const minutes = Math.floor(remaining / 60);

  label.textContent = `${minutes}:${String(remaining % 60).padStart(2, '0')}`;

  // Three stages rather than one alarm: yellow says start wrapping up, red says send
  // it now. The number is the same in all three, so colour is only emphasis.
  label.classList.toggle(
    'countdown-soon',
    remaining > COUNTDOWN_URGENT_SECONDS && remaining <= COUNTDOWN_SOON_SECONDS
  );
  label.classList.toggle('countdown-urgent', remaining <= COUNTDOWN_URGENT_SECONDS && remaining > 0);

  // Zero is when the server has already let the items go. Fading the clock out reads
  // as the reservation ending; snapping it away looks like a bug.
  if (remaining === 0 && !basket.dataset.lapsed) {
    basket.dataset.lapsed = '1';
    label.classList.remove('countdown-soon');
    label.classList.add('countdown-urgent', 'countdown-fading');
    showToast(
      'The time to send those requests ran out, so the items went back to being available.',
      'err'
    );
    window.setTimeout(refreshAfterChange, COUNTDOWN_FADE_MS);
  }
}

window.setInterval(tickCountdown, 1000);
tickCountdown();

async function sendBasket(button) {
  button.disabled = true;

  try {
    const response = await fetch('/requests/submit', {
      method: 'POST',
      credentials: 'same-origin',
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.error || 'Those requests could not be sent.');
    }

    const emailed =
      Number(result.emailed) > 0
        ? ` ${result.emailed} owner${result.emailed === 1 ? '' : 's'} emailed.`
        : '';

    showToast(
      `${result.sent === 1 ? 'Request sent.' : `${result.sent} requests sent.`}${emailed}`,
      'ok'
    );
    refreshAfterChange();
  } catch (error) {
    showToast(error.message, 'err');
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('click', (event) => {
  const submit = event.target.closest ? event.target.closest('[data-submit-requests]') : null;

  if (submit) {
    event.preventDefault();
    sendBasket(submit);
  }
});

// ------------------------------------------------- requests waiting on your items
// The answering list used to be a page of its own, so opening it lost the item list and
// coming back was a full reload. It is fetched as a fragment and shown over the list
// instead: one small request to open it, one to answer a row, and the list underneath
// is already the right one to return to.
let ownerRequestsModal = null;

function closeOwnerRequestsModal() {
  if (ownerRequestsModal) {
    ownerRequestsModal.remove();
    ownerRequestsModal = null;
  }

  document.removeEventListener('keydown', onOwnerRequestsKey);
}

function onOwnerRequestsKey(event) {
  if (event.key === 'Escape') {
    closeOwnerRequestsModal();
  }
}

function ownerRequestsCard() {
  return ownerRequestsModal ? ownerRequestsModal.querySelector('[data-owner-requests]') : null;
}

function showOwnerRequestsCard(html) {
  if (!ownerRequestsModal) {
    return;
  }

  const modal = ownerRequestsModal.querySelector('.modal');

  if (!modal) {
    return;
  }

  modal.innerHTML = html;
  // The fragment arrives from the server, which can only write UTC; the reader's own
  // clock is put on it here, the same way the item list's times are done on load.
  localiseTimeLabels(modal);

  const close = modal.querySelector('[data-owner-requests-close]');

  if (close) {
    close.focus();
  }
}

async function fetchOwnerRequests(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'X-ItemShare-Fragment': '1',
      Accept: 'text/html',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error('Your requests could not be loaded. Nothing was changed.');
  }

  return response.text();
}

async function openOwnerRequests() {
  closeOwnerRequestsModal();

  const panel = document.getElementById('accountMenuPanel');
  const panelButton = document.getElementById('accountMenuButton');

  if (panel) {
    panel.hidden = true;
  }

  if (panelButton) {
    panelButton.setAttribute('aria-expanded', 'false');
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal modal-wide owner-modal" role="dialog" aria-modal="true" aria-label="Requests for your items">
      <p class="muted">Loading what is waiting on your items...</p>
    </div>`;
  document.body.appendChild(backdrop);
  ownerRequestsModal = backdrop;
  document.addEventListener('keydown', onOwnerRequestsKey);

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      closeOwnerRequestsModal();
    }
  });

  try {
    showOwnerRequestsCard(await fetchOwnerRequests('/owner/requests'));
  } catch (error) {
    closeOwnerRequestsModal();
    showToast(error.message, 'err');
  }
}

// A row answers itself: the form posts the same fields the page posts, but the reply is
// the list again rather than a redirect, so the modal keeps its place and the answered
// row is simply not in it any more.
async function answerOwnerRequest(form, submitter = null) {
  const buttons = Array.from(form.querySelectorAll('button'));

  buttons.forEach((button) => {
    button.disabled = true;
  });

  // Fulfilled and Not fulfilled are the same form, and which one was pressed is the whole
  // answer: the body carries the button's name and value, because a form on its own leaves
  // the submit button out. It is urlencoded rather than FormData on purpose - the server
  // reads urlencoded bodies, so a multipart one arrives empty and the row looks unanswered.
  const body = new URLSearchParams(new FormData(form));

  if (submitter && submitter.name) {
    body.set(submitter.name, submitter.value);
  }

  try {
    showOwnerRequestsCard(
      await fetchOwnerRequests('/owner/requests', { method: 'POST', body })
    );

    const card = ownerRequestsCard();
    const recorded = card ? card.querySelector('.status.ok') : null;

    if (recorded) {
      showToast(recorded.textContent.trim(), 'ok');
    }

    refreshAfterChange();
  } catch (error) {
    buttons.forEach((button) => {
      button.disabled = false;
    });
    showToast(error.message, 'err');
  }
}

document.addEventListener('click', (event) => {
  if (event.target.closest && event.target.closest('[data-owner-requests-close]')) {
    event.preventDefault();
    closeOwnerRequestsModal();
    return;
  }

  if (event.defaultPrevented || event.button !== 0) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }

  const opener = event.target.closest ? event.target.closest('a[href="/owner/requests"]') : null;

  if (!opener || opener.target === '_blank') {
    return;
  }

  event.preventDefault();
  openOwnerRequests();
});

document.addEventListener('submit', (event) => {
  const form = event.target;

  if (!ownerRequestsModal || !form.closest || !form.closest('[data-owner-requests]')) {
    return;
  }

  if (form.getAttribute('action') !== '/owner/requests') {
    return;
  }

  event.preventDefault();
  answerOwnerRequest(form, event.submitter || null);
});

// ------------------------------------------------------------ leaving the page
// The browser's own beforeunload dialog cannot be styled, so the prompt here is a
// real one and beforeunload is only the last resort for a closed tab or a form post.
let leavePrompt = null;
// Set once the styled prompt has been answered with "Leave anyway", so the browser's own
// unstyled dialog does not ask the same question a second time during that navigation.
let leaveConfirmed = false;
let internalNavigation = false;

// The inline onchange submits directly, which does not fire a submit event.
// Capture the change before it runs: this switch keeps the same server-side bag.
document.addEventListener('change', (event) => {
  if (event.target.matches?.('#browsingAccount') &&
      event.target.form?.getAttribute('action') === '/browsing-account') {
    internalNavigation = true;
  }
}, true);

document.addEventListener('submit', (event) => {
  if (event.target.getAttribute('action') === '/browsing-account') {
    internalNavigation = true;
  }
}, true);

function closeLeavePrompt() {
  if (leavePrompt) {
    leavePrompt.remove();
    leavePrompt = null;
  }

  document.removeEventListener('keydown', onLeavePromptKey);
}

function onLeavePromptKey(event) {
  if (event.key === 'Escape') {
    closeLeavePrompt();
  }
}

function openLeavePrompt(href) {
  const held = basketHeldItems();

  closeLeavePrompt();

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="leaveTitle">
      <h2 id="leaveTitle">You have unsubmitted item requests</h2>
      <p class="muted" data-leave-sentence></p>
      <p class="muted" data-leave-detail></p>
      <div class="leave-actions">
        <button class="filter-clear" type="button" data-stay>Stay on this page</button>
        <button class="primary-button" type="button" data-leave-anyway>Leave anyway</button>
      </div>
    </div>`;

  // Written as text rather than markup: it is a count, but the habit is worth keeping.
  backdrop.querySelector('[data-leave-sentence]').textContent =
    held === 1 ? '1 item is waiting to be sent.' : `${held} items are waiting to be sent.`;

  // The basket lives on the site, not in this tab, so leaving does not throw it away:
  // saying it did would be the lie the old wording told, and the person comes back to
  // the same basket and the same clock.
  const detail = backdrop.querySelector('[data-leave-detail]');

  if (detail) {
    detail.textContent =
      held === 1
        ? 'It is held on the site, not in this tab, so it will still be here when you come back. If you never send it, the item goes back to being available to everyone else when the clock runs out.'
        : 'They are held on the site, not in this tab, so they will still be here when you come back. If you never send them, the items go back to being available to everyone else when the clock runs out.';
  }

  document.body.appendChild(backdrop);
  leavePrompt = backdrop;
  document.addEventListener('keydown', onLeavePromptKey);

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop || (event.target.closest && event.target.closest('[data-stay]'))) {
      closeLeavePrompt();
      return;
    }

    if (event.target.closest && event.target.closest('[data-leave-anyway]')) {
      closeLeavePrompt();
      leaveConfirmed = true;
      window.location.assign(href);
    }
  });

  const stay = backdrop.querySelector('[data-stay]');

  if (stay) {
    stay.focus();
  }
}

document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0) {
    return;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return;
  }
  if (basketHeldItems() === 0) {
    return;
  }

  const link = event.target.closest ? event.target.closest('a[href]') : null;

  if (!link || link.target === '_blank' || link.hasAttribute('download')) {
    return;
  }

  const href = link.getAttribute('href') || '';

  if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
    return;
  }

  // Only another site is worth a warning. A basket is held on the server, so walking from
  // one page of this site to another keeps it, and warning about it there was a question
  // with nothing behind it - the same basket was waiting on the way back.
  if (!leavesThisSite(link)) {
    internalNavigation = true;
    return;
  }

  event.preventDefault();
  openLeavePrompt(href);
});

function leavesThisSite(link) {
  try {
    return new URL(link.href, window.location.href).origin !== window.location.origin;
  } catch (error) {
    return false;
  }
}

window.addEventListener('beforeunload', (event) => {
  if (internalNavigation) {
    internalNavigation = false;
    return undefined;
  }
  // Already answered above: the browser's own dialog would be the same warning twice,
  // unstyled and out of place.
  if (leaveConfirmed || basketHeldItems() === 0) {
    return undefined;
  }

  event.preventDefault();
  event.returnValue = 'You have unsubmitted item requests.';
  return event.returnValue;
});

// ------------------------------------------------------------------ row motion
// Removing a row is a layout change for every row under it, and that jump is what
// makes a filtered or refreshed list feel like it resized. Every removal and every
// refresh measures where the rows were, changes the DOM, then plays the difference
// back as a short slide from the old position to the new one; rows that are new
// fade in. Filters use the same machinery, and a panel's height is animated too, so
// the page below the table does not jump either. Nothing runs when the reader has
// asked for less motion.
const ROW_SLIDE_MS = 340;
const ROW_FADE_MS = 200;

function prefersReducedMotion() {
  return Boolean(
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function motionRowKey(row) {
  if (row.dataset.itemKey) {
    return row.dataset.itemKey;
  }

  return row.dataset.requestId ? `request:${row.dataset.requestId}` : '';
}

function captureRowTops(root) {
  const tops = new Map();

  root.querySelectorAll('tr').forEach((row) => {
    const key = motionRowKey(row);

    if (key) {
      tops.set(key, row.getBoundingClientRect().top);
    }
  });

  return tops;
}

/** Slides rows from where they were to where they now are; fades rows that are new. */
function animateRowsInto(root, tops) {
  if (!tops || tops.size === 0 || prefersReducedMotion()) {
    return;
  }

  root.querySelectorAll('tr').forEach((row) => {
    const key = motionRowKey(row);

    if (!key || typeof row.animate !== 'function') {
      return;
    }

    const before = tops.get(key);

    if (before === undefined) {
      row.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: ROW_FADE_MS,
        easing: 'ease-out',
      });
      return;
    }

    const delta = before - row.getBoundingClientRect().top;

    if (Math.abs(delta) < 1) {
      return;
    }

    row.animate(
      [
        { transform: `translateY(${delta}px)`, opacity: 0.65 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: ROW_SLIDE_MS, easing: 'cubic-bezier(.22,.8,.24,1)' }
    );
  });
}

/** Takes a row out and lets the rows under it slide up into the gap. */
function removeRowWithSlide(row) {
  const table = row.closest('table');
  const tops = table ? captureRowTops(table) : null;

  row.remove();

  if (table) {
    animateRowsInto(table, tops);
  }
}

/** Animates a panel's height so a table that grows or shrinks does not jump. */
function animatePanelHeights(root, heights) {
  if (!heights || prefersReducedMotion()) {
    return;
  }

  Array.from(root.querySelectorAll('[data-panel]')).forEach((panel, index) => {
    const before = heights[index];

    if (!before || panel.hidden || typeof panel.animate !== 'function') {
      return;
    }

    const after = panel.getBoundingClientRect().height;

    if (Math.abs(after - before) < 2) {
      return;
    }

    panel.style.overflow = 'hidden';

    const animation = panel.animate(
      [{ height: `${before}px` }, { height: `${after}px` }],
      { duration: ROW_SLIDE_MS + 60, easing: 'cubic-bezier(.22,.8,.24,1)' }
    );

    animation.addEventListener('finish', () => {
      panel.style.overflow = '';
    });
  });
}

// ------------------------------------------------------- relative times
// The Added column reads as a countdown - "6d 4h 18m 44s" - because a list of shared items
// is read for what is new. The server puts each moment in a `time[data-since]` and prints
// the same moment as UTC inside it; this rewrites that text in the reader's own clock.
//
// Units are counted the way a person counts: years and months first, anchored on the
// original date so a month-end does not skip a month, then days, hours, minutes, seconds.
// A unit that is zero is left out, because zero is not news: "12s", "08m 41s",
// "01y 04mo 19d 07h 33m 05s". Every unit that is shown keeps two digits, so a column
// right-aligns and the older rows never shift sideways as a count goes from one digit to
// two. One timer drives every cell on the page, and a cell whose text has not changed is
// not written to, so a long list costs only the arithmetic per tick.
const RELATIVE_TICK_MS = 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function relativeUnits(from, to) {
  // A device clock a few seconds ahead of the server would otherwise count backwards into a
  // negative month and read as "1mo 30d ...". Nothing is younger than now.
  if (to <= from) {
    return { years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
  }

  const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();
  const anchorFor = (years, months) => {
    const anchor = new Date(from.getTime());
    anchor.setDate(1);
    anchor.setFullYear(from.getFullYear() + years);
    anchor.setMonth(from.getMonth() + months);
    // A day-of-month that does not exist in the target month (31 February) clamps to its
    // last day rather than spilling into the next month.
    anchor.setDate(Math.min(from.getDate(), daysInMonth(anchor.getFullYear(), anchor.getMonth())));
    return anchor;
  };

  let years = to.getFullYear() - from.getFullYear();
  let months = to.getMonth() - from.getMonth();

  if (months < 0) {
    years -= 1;
    months += 12;
  }

  let anchor = anchorFor(years, months);

  // The birthday has not arrived yet this year, or the month is not over: step back until the
  // anchor is in the past, which is what keeps "1 month" from appearing a day early.
  while (anchor > to) {
    months -= 1;

    if (months < 0) {
      months += 12;
      years -= 1;
    }

    anchor = anchorFor(years, months);
  }

  let rest = Math.max(0, to - anchor);
  const days = Math.floor(rest / DAY_MS);
  rest -= days * DAY_MS;
  const hours = Math.floor(rest / HOUR_MS);
  rest -= hours * HOUR_MS;
  const minutes = Math.floor(rest / MINUTE_MS);
  rest -= minutes * MINUTE_MS;
  const seconds = Math.floor(rest / 1000);

  return { years, months, days, hours, minutes, seconds };
}

/**
 * "01y 04mo 19d 07h 33m 05s", skipping the units that are zero, and "just now" at zero.
 *
 * Each unit is two digits wide for the same reason a clock is: the countdown is read as a
 * column, and "1m" growing to "10m" must not push the rest of the row along with it.
 */
function relativeText(from, to) {
  const units = relativeUnits(from, to);
  const parts = [];
  const pad = (value) => String(value).padStart(2, '0');

  if (units.years) parts.push(`${pad(units.years)}y`);
  if (units.months) parts.push(`${pad(units.months)}mo`);
  if (units.days) parts.push(`${pad(units.days)}d`);
  if (units.hours) parts.push(`${pad(units.hours)}h`);
  if (units.minutes) parts.push(`${pad(units.minutes)}m`);
  if (units.seconds) parts.push(`${pad(units.seconds)}s`);

  return parts.length > 0 ? parts.join(' ') : 'just now';
}

/** Rewrites every countdown under `root`, and puts the exact local time in its tooltip. */
function relativeTick(root, to = new Date()) {
  if (!root || typeof root.querySelectorAll !== 'function') {
    return;
  }

  root.querySelectorAll('time[data-since]').forEach((element) => {
    const iso = element.getAttribute('datetime');
    const from = iso ? new Date(iso) : null;

    if (!from || Number.isNaN(from.getTime())) {
      return;
    }

    const text = relativeText(from, to);

    if (element.textContent !== text) {
      element.textContent = text;
    }

    const title = `First shared ${from.toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })}`;

    if (element.title !== title) {
      element.title = title;
    }
  });
}
// ------------------------------------------------------- end relative times

/** Request times arrive as UTC ISO stamps and are shown in the reader's clock. */
function localiseTimeLabels(root) {
  if (!root || typeof root.querySelectorAll !== 'function') {
    return;
  }

  root.querySelectorAll('time[data-local-time]').forEach((element) => {
    const iso = element.getAttribute('datetime');
    const date = iso ? new Date(iso) : null;

    if (!date || Number.isNaN(date.getTime())) {
      return;
    }

    const text = date.toLocaleString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    if (element.textContent !== text) element.textContent = text;
    // A note the server wrote about the moment (how many asks stand behind the row) is
    // carried in an attribute so rewriting the title does not throw it away.
    const note = element.getAttribute('data-local-note');
    const title = `Kept in UTC as ${iso.replace('T', ' ').replace('Z', '').trim()} UTC${
      note ? ` - ${note}` : ''
    }`;
    if (element.title !== title) element.title = title;
  });
}

localiseTimeLabels(document);
relativeTick(document);
// One timer for the whole page: every countdown on it is rewritten together.
window.setInterval(() => relativeTick(document), RELATIVE_TICK_MS);

// ------------------------------------------------------- removed basket rows
// Taking something out of the basket leaves the row where it was, marked cancelled,
// for five seconds, so the removal is visible instead of the row just vanishing.
// Then it fades and the rows under it close the gap on their own, because they are
// table rows rather than absolutely placed boxes.
//
// Only basket rows do this. A sent request stays in the history for good - that list
// is the record of what was asked for, newest first.
const CLOSED_ROW_LINGER_MS = 5000;
// Long enough to read as a fade rather than a blink: the row dims and then goes.
const CLOSED_ROW_FADE_MS = 1200;
const REMOVED_ROW_KEY = 'itemshare.dismissed-requests';

// Dismissals outlive a reload. Otherwise a refresh rebuilds the table, the request
// this browser has already seen out comes back, and its few seconds start again.
const removedRequestRows = new Set(readDismissedRows());
// The deadline belongs to the request, not to the element: a live refresh replaces
// the row while the clock is still running, and the new element has to inherit the
// same deadline rather than start a new one (or be skipped because the old element
// already had its timer).
const closingRequestRows = new Map();

function readDismissedRows() {
  try {
    const raw = window.sessionStorage.getItem(REMOVED_ROW_KEY);
    const stored = raw ? JSON.parse(raw) : [];

    // Ids are compared against `data-` attributes, which are strings whatever the
    // stored JSON happens to say.
    return Array.isArray(stored) ? stored.map(String) : [];
  } catch (error) {
    return [];
  }
}

function rememberDismissedRow(id) {
  removedRequestRows.add(id);

  try {
    window.sessionStorage.setItem(REMOVED_ROW_KEY, JSON.stringify([...removedRequestRows]));
  } catch (error) {
    // Storage can be full or blocked; the dismissal still holds for this page.
  }
}

function sweepClosedRequestRows() {
  const region = document.getElementById('itemLists');

  if (!region) {
    return;
  }

  const now = Date.now();

  region.querySelectorAll('[data-basket-row]').forEach((row) => {
    const status = row.dataset.status;
    const id = row.dataset.requestId;

    if (!id || status === 'draft') {
      return;
    }

    // A live refresh rebuilds this table from the database, so a row this browser has
    // already seen out must not come back and sit here again.
    if (removedRequestRows.has(id)) {
      if (row.classList.contains('row-fading')) return;
      removeRowWithSlide(row);
      return;
    }

    let deadline = closingRequestRows.get(id);

    if (!deadline) {
      deadline = now + CLOSED_ROW_LINGER_MS;
      closingRequestRows.set(id, deadline);
    }

    if (now < deadline || row.classList.contains('row-fading')) {
      return;
    }

    closingRequestRows.delete(id);
    rememberDismissedRow(id);
    row.classList.add('row-fading');
    window.setTimeout(() => removeRowWithSlide(row), CLOSED_ROW_FADE_MS);
  });
}

const rowRegion = document.getElementById('itemLists');

if (rowRegion) {
  // The table is replaced wholesale on a live update, so new rows are picked up from
  // the mutation instead of from one pass at load.
  new MutationObserver(() => {
    sweepClosedRequestRows();
    sweepExhaustedRows();
  }).observe(rowRegion, {
    childList: true,
    subtree: true,
  });

  sweepClosedRequestRows();

  // Timers armed against an element are lost when a live update replaces it, so the
  // row is checked on a short tick instead: the deadline lives under the request id
  // and whichever element is on screen when it passes gets faded and dropped.
  window.setInterval(sweepClosedRequestRows, 500);
}

// ------------------------------------------------------------ rows that ran out
// A row whose every copy was asked for and sent has nothing left to offer. It stays
// just long enough to be seen going, then fades and the rows under it close up. The
// server keeps sending it for the same few seconds and then stops (EXHAUSTED_ROW_
// LINGER_MS in lib/store.js), so a refresh cannot bring it back.
const exhaustedRowKeys = new Set();
const exhaustedRowElements = new WeakSet();

function sweepExhaustedRows() {
  const region = document.getElementById('itemLists');

  if (!region) {
    return;
  }

  region.querySelectorAll('[data-exhausted]').forEach((row) => {
    const key = row.dataset.itemKey || '';

    if (!key) {
      return;
    }

    if (exhaustedRowElements.has(row)) return;
    exhaustedRowElements.add(row);

    // A refresh in the last seconds of the fade rebuilds the row; the one this page
    // has already seen out must not come back for another turn.
    if (exhaustedRowKeys.has(key)) {
      removeRowWithSlide(row);
      return;
    }

    exhaustedRowKeys.add(key);
    const wait = Math.max(0, Number(row.dataset.exhausted) || 5000);

    window.setTimeout(() => {
      if (!row.isConnected) {
        return;
      }

      row.classList.add('row-fading');
      window.setTimeout(() => removeRowWithSlide(row), CLOSED_ROW_FADE_MS);
    }, wait);
  });
}

if (rowRegion) {
  sweepExhaustedRows();
}

// ------------------------------------------------------------- ESO accounts
// Which accounts are linked is reference material: it lives behind the profile menu,
// in the modal the page already rendered, rather than above the item list.
const accountsModal = document.getElementById('accountsModal');

function closeAccountsModal() {
  if (!accountsModal || accountsModal.hidden) {
    return;
  }

  accountsModal.hidden = true;

  const opener = document.querySelector('[data-open-accounts]');

  if (opener) {
    opener.focus();
  }
}

function openAccountsModal() {
  if (!accountsModal) {
    return;
  }

  accountsModal.hidden = false;

  // The account name box is the reason the dialog opened, so it takes the caret. On a
  // visit that only looks at what is attached, the close button does.
  const field = accountsModal.querySelector('input[name="accountName"]');
  const close = accountsModal.querySelector('[data-close-accounts]');

  if (field) {
    field.focus();
  } else if (close) {
    close.focus();
  }
}

// Somebody who has signed in and attached no ESO account lands with the dialog already
// open: attaching one is what turns the shared list into a list they can ask from. It is
// drawn open without a script, so this only puts the caret where the work is.
if (accountsModal && accountsModal.hasAttribute('data-accounts-auto') && !accountsModal.hidden) {
  openAccountsModal();
}

document.addEventListener('click', (event) => {
  const closest = event.target.closest ? event.target.closest.bind(event.target) : () => null;

  if (!accountsModal) {
    return;
  }

  if (closest('[data-open-accounts]')) {
    event.preventDefault();
    openAccountsModal();
    return;
  }

  if (closest('[data-close-accounts]')) {
    event.preventDefault();
    closeAccountsModal();
    return;
  }

  // The backdrop is the modal's own parent, so a click on it is a click outside.
  if (!accountsModal.hidden && event.target === accountsModal) {
    closeAccountsModal();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && accountsModal && !accountsModal.hidden) {
    closeAccountsModal();
  }
});

// -------------------------------------------------------------- item tooltips
// A name says what the item is without leaving the page. The card starts with what
// the row already knows (name, type, trait, level), then /item-tip adds the game's
// description and what the item's set does - fetched from UESP once and cached
// server-side, so hovering the same name again costs nothing.
const tipCard = document.createElement('div');
tipCard.className = 'item-tip-card';
tipCard.hidden = true;
document.body.appendChild(tipCard);

const tipCache = new Map();
let tipTrigger = null;
let tipTicket = 0;
let tipPoint = { x: 0, y: 0 };

function tipElement(tag, className, text) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }

  return element;
}

// Beside the pointer, never under it: the name being read stays visible, and the
// card flips to the other side near an edge rather than hanging off the window.
function placeTipCard() {
  if (tipCard.hidden) {
    return;
  }

  const width = tipCard.offsetWidth;
  const height = tipCard.offsetHeight;
  const gap = 22;
  let left = tipPoint.x + gap;
  let top = tipPoint.y + 18;

  if (left + width > window.innerWidth - 12) {
    left = tipPoint.x - width - gap;
  }
  if (left < 12) {
    left = 12;
  }
  if (top + height > window.innerHeight - 12) {
    top = Math.max(12, tipPoint.y - height - 18);
  }

  tipCard.style.left = `${Math.round(left)}px`;
  tipCard.style.top = `${Math.round(top)}px`;
}

// ESO item text carries the game's own colour codes: |cRRGGBB switches colour and
// |r returns to it, and |H...|h wraps a link nobody can follow from a card. They are
// read here, after escaping, so a number arrives as a coloured number rather than
// as "|cffffff10|r". Codes too dark for the card's panel are lifted towards white.
function esoColour(hex) {
  const value = parseInt(hex, 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  const luminance =
    (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;

  if (luminance >= 0.3) {
    return `#${hex}`;
  }

  return `#${channels
    .map((channel) =>
      Math.round(channel + (255 - channel) * 0.7)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

function esoMarkup(text) {
  const escaped = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  let open = 0;

  const coloured = escaped.replace(/\|c([0-9a-fA-F]{6})/g, (match, hex) => {
    open += 1;
    return `<span style="color:${esoColour(hex)}">`;
  });

  const closed = coloured.replace(/\|r/g, () => {
    if (open <= 0) {
      return '';
    }

    open -= 1;
    return '</span>';
  });

  return (
    closed
      // |H1:item:123|hLabel|h: keep the label and drop the link around it.
      .replace(/\|H[^|]*\|h/g, '')
      .replace(/\|h/g, '')
      // Whatever else starts with a pipe is a code the game understands, not text.
      .replace(/\|[A-Za-z]/g, '') + '</span>'.repeat(Math.max(0, open))
  );
}

function tipText(tag, className, value) {
  const element = tipElement(tag, className);
  element.innerHTML = esoMarkup(value);
  return element;
}

function renderTipCard(trigger, detail) {
  tipCard.textContent = '';

  const head = tipElement('div', 'item-tip-head');
  const name = tipElement('strong', 'item-tip-name', trigger.dataset.tipName || 'Item');

  name.style.color = trigger.dataset.tipColor || '';
  head.appendChild(name);

  if (detail && detail.unique) {
    head.appendChild(tipElement('span', 'item-tip-tag', 'Unique'));
  }

  tipCard.appendChild(head);

  const meta = trigger.dataset.tipMeta || '';

  if (meta) {
    tipCard.appendChild(tipElement('div', 'item-tip-meta', meta));
  }
  if (detail && detail.description) {
    tipCard.appendChild(tipText('p', 'item-tip-text', detail.description));
  }
  if (detail && detail.traitDesc) {
    tipCard.appendChild(tipText('p', 'item-tip-text', detail.traitDesc));
  }

  if (detail && detail.set && detail.set.name) {
    const block = tipElement('div', 'item-tip-set');

    block.appendChild(tipElement('div', 'item-tip-set-name', detail.set.name));

    if (Array.isArray(detail.set.bonuses) && detail.set.bonuses.length > 0) {
      const list = document.createElement('ul');

      detail.set.bonuses.forEach((bonus) => list.appendChild(tipText('li', '', bonus)));
      block.appendChild(list);
    }

    tipCard.appendChild(block);
  }

  if (detail && detail.fromUesp) {
    tipCard.appendChild(tipElement('span', 'item-tip-source', 'Details from UESP'));
  }

  tipCard.hidden = false;
  placeTipCard();
}

async function fillTipCard(trigger) {
  const item = Number(trigger.dataset.tipItem) || 0;
  const set = trigger.dataset.tipSet || '';

  if (item <= 0 && !set) {
    return;
  }

  const key = `${item}|${set.toLowerCase()}`;
  const ticket = tipTicket;

  if (tipCache.has(key)) {
    renderTipCard(trigger, tipCache.get(key));
    return;
  }

  const params = new URLSearchParams();

  if (item > 0) {
    params.set('item', String(item));
  }
  if (set) {
    params.set('set', set);
  }

  try {
    const response = await fetch(`/item-tip?${params.toString()}`, {
      credentials: 'same-origin',
    });

    if (!response.ok) {
      return;
    }

    const detail = await response.json();

    if (!detail || detail.available === false) {
      return;
    }

    tipCache.set(key, detail);

    // Only write it into the card if the pointer is still on this name and this is
    // still the newest lookup; a fast reader must not get a slow answer for the
    // row above.
    if (tipTrigger === trigger && ticket === tipTicket) {
      renderTipCard(trigger, detail);
    }
  } catch (error) {
    // The card keeps the details the page already carries.
  }
}

function showTipCard(trigger, point) {
  tipTrigger = trigger;
  tipTicket += 1;
  tipPoint = point;
  renderTipCard(trigger, null);
  fillTipCard(trigger);
}

function hideTipCard() {
  tipTrigger = null;
  tipTicket += 1;
  tipCard.hidden = true;
}

document.addEventListener('mouseover', (event) => {
  const trigger = event.target.closest ? event.target.closest('[data-item-tip]') : null;

  if (!trigger) {
    hideTipCard();
    return;
  }

  if (trigger !== tipTrigger) {
    showTipCard(trigger, { x: event.clientX, y: event.clientY });
  }
});

document.addEventListener('mousemove', (event) => {
  if (tipCard.hidden) {
    return;
  }

  tipPoint = { x: event.clientX, y: event.clientY };
  placeTipCard();
});

document.addEventListener('mouseout', (event) => {
  const trigger = event.target.closest ? event.target.closest('[data-item-tip]') : null;

  if (trigger && !trigger.contains(event.relatedTarget)) {
    hideTipCard();
  }
});

// Keyboard readers get the same card: tabbing onto a name opens it, tabbing on
// closes it, and it is anchored to the name rather than to a pointer that is not
// there.
document.addEventListener('focusin', (event) => {
  const trigger = event.target.closest ? event.target.closest('[data-item-tip]') : null;

  if (!trigger) {
    return;
  }

  const rect = trigger.getBoundingClientRect();
  showTipCard(trigger, { x: rect.right, y: rect.top });
});

document.addEventListener('focusout', (event) => {
  if (event.target.closest && event.target.closest('[data-item-tip]')) {
    hideTipCard();
  }
});

window.addEventListener('scroll', hideTipCard, { passive: true });
window.addEventListener('resize', hideTipCard);
