#!/usr/bin/env node
// What an open reserve dialog shows - and what it sends - when the number left changes
// under it.
//
// The dialog takes its ceiling from the row it was opened from, and that row keeps moving:
// somebody else reserves a copy, or the owner uploads a smaller stack. This drives the real
// open/sync/ask code out of public/app.js against a stand-in dialog - no browser, no
// database - and checks three things: the words under the title, the state of the slider
// and the box, and what a press of the tick actually posts. The source checks around the
// slider prove the wiring exists; this proves what a person reads and what the server hears.
//
//   npm run test:reserve-dialog

import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');

/** The text between two anchors, failing loudly when either has moved. */
function between(start, end) {
  const from = source.indexOf(start);

  if (from < 0) {
    throw new Error(`MISSING ANCHOR in public/app.js: ${start}`);
  }

  const to = source.indexOf(end, from);

  if (to < 0) {
    throw new Error(`MISSING ANCHOR in public/app.js: ${end}`);
  }

  return source.slice(from, to);
}

// Only the parts that can run without a browser: the count maths, the sentence under the
// title, the dialog itself, and the function that re-reads the row and moves the controls.
// Everything the dialog would reach for outside its own body is handed in below.
const parts = [
  'var dialog = null; var dialogState = null;',
  'var onDialogKey = function () {};',
  between('  function dialogNumbers(button) {', '  function openRequestDialog(button) {'),
  between(
    '  function openRequestDialog(button) {',
    '  /**\n   * Re-reads the row the dialog was opened from.'
  ),
  between('  function refreshDialogNumbers() {', '  // A reservation is not a request.'),
  // The notice that a copy is held rather than asked for. It runs off the document and
  // needs no fetch, so the words it shows can be checked for real.
  between('  // A reservation is not a request.', '  async function sendRequest({'),
  'return {',
  '  dialogNumbers,',
  '  holdMinutes,',
  '  explainFirstHold,',
  '  dialogSummary,',
  '  clampCopies,',
  '  refreshDialogNumbers,',
  '  syncRequestDialog,',
  '  openRequestDialog,',
  '  open: (nextDialog, nextState) => { dialog = nextDialog; dialogState = nextState; },',
  '  state: () => dialogState,',
  '};',
].join('\n');

const makePage = new Function('document', 'escapeText', 'closeRequestDialog', 'sendRequest', parts);

const escape = (value) => String(value == null ? '' : value);
const noop = () => {};

/** Enough of an element for the dialog to wire itself to, and for a test to fire at. */
function control(extra = {}) {
  const listeners = new Map();

  return {
    max: '',
    value: '',
    disabled: false,
    textContent: '',
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    fire(type, event = {}) {
      const fn = listeners.get(type);

      return fn ? fn(event) : undefined;
    },
    focus() {},
    ...extra,
  };
}

/** A row in the list, as the page would render it: what is left, of how many, in your basket. */
const row = (max, stack = '5', held = '0') => ({
  dataset: { max: String(max), stack: String(stack), held: String(held) },
});

/** A dialog holding the named count, and a row that now says something else. */
function openDialog({ showed, now, state = {}, withSlider = true }) {
  const summary = control();
  const slider = control({ value: String(showed) });
  const amount = control({ value: String(showed) });
  const confirm = control();
  const bySelector = new Map([
    ['[data-dialog-summary]', summary],
    ['[data-reserve-slider]', withSlider ? slider : null],
    ['[data-reserve-amount]', withSlider ? amount : null],
    ['[data-reserve-confirm]', confirm],
  ]);
  const dialog = { querySelector: (selector) => bySelector.get(selector) || null };
  let lookups = 0;
  const fakeDocument = {
    querySelector: () => {
      lookups += 1;

      return now;
    },
  };
  const page = makePage(fakeDocument, escape, noop, noop);

  page.open(dialog, { kind: 'inventory', id: '7', name: 'Briarheart Dagger', held: 0, ...state });

  return {
    page,
    summary,
    slider,
    amount,
    confirm,
    lookups: () => lookups,
    sync: () => page.syncRequestDialog(),
  };
}

/** A whole dialog, with the controls the real markup would have built. */
function makeDialog({ withSlider = true } = {}) {
  const summary = control();
  const slider = control({ value: '1' });
  const amount = control({ value: '1' });
  const confirm = control();
  const bySelector = new Map([
    ['[data-dialog-summary]', summary],
    ['[data-reserve-slider]', withSlider ? slider : null],
    ['[data-reserve-amount]', withSlider ? amount : null],
    ['[data-reserve-confirm]', confirm],
    ['input[name="accountName"]', null],
    ['input[name="email"]', null],
    ['input[name="password"]', null],
  ]);
  const onDialog = [];

  return {
    className: '',
    innerHTML: '',
    summary,
    slider,
    amount,
    confirm,
    addEventListener(type, fn) {
      onDialog.push({ type, fn });
    },
    querySelector: (selector) => bySelector.get(selector) || null,
    fire(type, event = {}) {
      for (const hit of onDialog.filter((each) => each.type === type)) {
        hit.fn(event);
      }
    },
    remove: noop,
  };
}

/**
 * Opens a dialog on a row offering `opened` copies, sets the box to `shown`, moves the row
 * to `now`, then presses the green tick. Returns what the page posted and whether it closed
 * itself, so a check can tell "sent the right thing" from "sent nothing at all".
 */
function pressTick({ opened, shown, now, withSlider = true, kind = 'inventory' }) {
  const sent = [];
  const closes = { count: 0 };
  const created = [];
  let liveRow = row(opened, opened);

  const fakeDocument = {
    body: { dataset: {}, appendChild: noop },
    createElement() {
      const next = makeDialog({ withSlider });
      created.push(next);

      return next;
    },
    addEventListener: noop,
    querySelector: (selector) => (selector.startsWith('[data-request]') ? liveRow : null),
  };
  const page = makePage(
    fakeDocument,
    escape,
    () => {
      closes.count += 1;
    },
    (request) => sent.push(request)
  );

  page.openRequestDialog({
    dataset: {
      kind,
      id: '7',
      max: String(opened),
      stack: String(opened),
      held: '0',
      name: 'Briarheart Dagger',
    },
  });

  const dialog = created[created.length - 1];
  const closesAfterOpen = closes.count;

  if (withSlider) {
    dialog.amount.value = String(shown);
  }

  if (now !== undefined) {
    liveRow = now;
  }

  dialog.confirm.fire('click');

  return { sent, closes, closesAfterOpen, dialog, page };
}

const CLAIMED = 'Every copy has just been reserved, so there is nothing left to ask for.';

let total = 0;
let failures = 0;

function t(label, run) {
  total += 1;

  try {
    run();
    console.log('ok   ' + label);
  } catch (error) {
    failures += 1;
    console.log('FAIL ' + label + '\n     ' + error.message);
  }
}

// --------------------------------------------------------------- the last copy goes

t('the last copy going says so, and both controls go dead', () => {
  const ui = openDialog({ showed: 4, now: null, state: { max: 5, stack: 5 } });

  ui.sync();

  assert.equal(ui.summary.textContent, CLAIMED);
  assert.equal(ui.slider.max, '1', 'the slider backs off to a single position, never to zero');
  assert.equal(ui.slider.value, '1', 'the four already chosen is no longer offered');
  assert.equal(ui.slider.disabled, true);
  assert.equal(ui.amount.max, '1');
  assert.equal(ui.amount.value, '1');
  assert.equal(ui.amount.disabled, true);
  assert.equal(ui.confirm.disabled, true, 'nothing can be sent while nothing is left');
  assert.equal(ui.page.state().max, 0);
});

t('the last copy going wins over a note about your own basket', () => {
  const ui = openDialog({ showed: 3, now: null, state: { max: 5, stack: 5, held: 1 } });

  ui.sync();

  assert.equal(ui.summary.textContent, CLAIMED);
  assert.equal(ui.confirm.disabled, true);
});

t('a copy taken elsewhere does not take the last one with it', () => {
  const ui = openDialog({ showed: 1, now: row(1), state: { max: 2, stack: 5 } });

  ui.sync();

  assert.equal(ui.summary.textContent, '1 of the 5 still available.');
  assert.equal(ui.confirm.disabled, false, 'one copy left is still one copy to ask for');
  assert.equal(ui.slider.max, '1');
  assert.equal(ui.slider.value, '1');
});

// --------------------------------------------------- somebody reserves while you look

t('a copy going elsewhere lowers the top and pulls the chosen count down with it', () => {
  const ui = openDialog({ showed: 5, now: row(2), state: { max: 5, stack: 5 } });

  ui.sync();

  assert.equal(ui.summary.textContent, '2 of the 5 still available.');
  assert.equal(ui.slider.max, '2');
  assert.equal(ui.slider.value, '2', 'a count that is no longer available becomes the new top');
  assert.equal(ui.amount.max, '2');
  assert.equal(ui.amount.value, '2', 'the box cannot keep showing a number the slider cannot hold');
  assert.equal(ui.slider.disabled, false);
  assert.equal(ui.amount.disabled, false);
  assert.equal(ui.confirm.disabled, false);
});

t('a copy in your own basket is still named in the sentence', () => {
  const ui = openDialog({ showed: 5, now: row(2, '5', '1'), state: { max: 5, stack: 5 } });

  ui.sync();

  assert.equal(
    ui.summary.textContent,
    '2 of the 5 still available, and 1 already in your basket - asking for more adds to that row rather than starting another.'
  );
});

// ------------------------------------------------------- the owner re-uploads fewer

t('the owner uploading fewer copies moves the ceiling and the sentence', () => {
  const ui = openDialog({ showed: 4, now: row(3, '3'), state: { max: 5, stack: 5 } });

  ui.sync();

  assert.equal(ui.summary.textContent, '3 still available.', 'no "of the 5" once the stack itself is three');
  assert.equal(ui.slider.max, '3');
  assert.equal(ui.slider.value, '3');
  assert.equal(ui.amount.value, '3');
  assert.equal(ui.page.state().stack, 3, 'the old stack size is forgotten with it');
});

t('a re-upload leaving one copy keeps the dialog usable for that one', () => {
  const ui = openDialog({ showed: 3, now: row(1, '1'), state: { max: 5, stack: 5 } });

  ui.sync();

  assert.equal(ui.summary.textContent, '1 still available.');
  assert.equal(ui.slider.max, '1');
  assert.equal(ui.slider.value, '1');
  assert.equal(ui.amount.value, '1');
  assert.equal(ui.confirm.disabled, false, 'one copy left is still one copy to ask for');
});

t('a re-upload with nothing left to offer disables the tick', () => {
  const ui = openDialog({ showed: 2, now: row(0, '0'), state: { max: 2, stack: 2 } });

  ui.sync();

  assert.equal(ui.summary.textContent, CLAIMED);
  assert.equal(ui.confirm.disabled, true);
  assert.equal(ui.slider.disabled, true);
  assert.equal(ui.amount.disabled, true);
});

// ------------------------------------------------------------------- the quiet cases

t('with no dialog open nothing is read or written', () => {
  const ui = openDialog({ showed: 1, now: row(5), state: { max: 5, stack: 5 } });

  ui.page.open(null, null);
  ui.sync();

  assert.equal(ui.lookups(), 0, 'no row is looked up for a dialog that is not there');
  assert.equal(ui.summary.textContent, '');
});

t('a standing offer is untouched by the slider', () => {
  const ui = openDialog({
    showed: 1,
    now: row(1, '1'),
    state: { kind: 'offer', max: 1, stack: 1 },
    withSlider: false,
  });

  ui.sync();

  assert.equal(ui.summary.textContent, 'This is a standing offer, so it means one copy.');
  assert.equal(ui.slider.max, '', 'an offer dialog has no slider to move');
  assert.equal(ui.confirm.disabled, false, 'the one copy is still there to ask for');
});

// -------------------------------------------------------------- pressing the tick

t('pressing the tick once the last copy has gone posts nothing', () => {
  const run = pressTick({ opened: 5, shown: 4, now: null });

  assert.equal(run.sent.length, 0, 'no request reaches the server');
  assert.equal(run.closes.count, run.closesAfterOpen, 'the dialog stays open to explain');
  assert.equal(run.dialog.summary.textContent, CLAIMED);
  assert.equal(run.dialog.confirm.disabled, true);
  assert.equal(run.dialog.slider.value, '1', 'the four that was chosen is not left showing');
  assert.equal(run.dialog.amount.value, '1');
});

t('pressing it again while nothing is left still posts nothing', () => {
  const run = pressTick({ opened: 5, shown: 2, now: null });

  run.dialog.confirm.fire('click');

  assert.equal(run.sent.length, 0);
  assert.equal(run.closes.count, run.closesAfterOpen);
});

t('a single-copy dialog whose copy goes posts nothing either', () => {
  const run = pressTick({ opened: 1, shown: 1, now: null, withSlider: false });

  assert.equal(run.sent.length, 0, 'the guard does not depend on a slider being drawn');
  assert.equal(run.dialog.summary.textContent, CLAIMED);
  assert.equal(run.dialog.confirm.disabled, true);
});

t('a count larger than what is left is clamped before it is posted', () => {
  const run = pressTick({ opened: 5, shown: 5, now: row(2) });

  assert.equal(run.sent.length, 1);
  assert.equal(run.sent[0].quantity, 2, 'five becomes the two that are actually there');
});

t('an ordinary press posts the chosen count, kind, id and name', () => {
  const run = pressTick({ opened: 5, shown: 3 });

  assert.equal(run.sent.length, 1);
  assert.deepEqual(run.sent[0], {
    kind: 'inventory',
    id: '7',
    quantity: 3,
    name: 'Briarheart Dagger',
    accountName: '',
    email: '',
    password: '',
  });
  assert.equal(run.closes.count, run.closesAfterOpen + 1, 'a sent request closes the dialog');
});

t('a standing offer still posts its one copy', () => {
  const run = pressTick({ opened: 1, shown: 1, withSlider: false, kind: 'offer' });

  assert.equal(run.sent.length, 1);
  assert.equal(run.sent[0].quantity, 1);
});

// ------------------------------------------------------ held, but not asked for

/**
 * The notice on its own. The stand-in document remembers what was appended to it, so the
 * words somebody actually reads can be checked without a browser.
 */
function holdNotice({ copies = 1, minutes = 0 } = {}) {
  const created = [];
  const listeners = [];
  const fakeDocument = {
    body: {
      dataset: minutes ? { holdMinutes: String(minutes) } : {},
      appendChild: noop,
    },
    createElement() {
      const notice = {
        className: '',
        innerHTML: '',
        addEventListener: noop,
        remove: noop,
        querySelector: () => null,
      };

      created.push(notice);

      return notice;
    },
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: noop,
    querySelector: () => null,
  };
  const page = makePage(fakeDocument, escape, noop, noop);

  page.explainFirstHold('Briarheart Dagger', copies);

  return { created, notice: created[0], listeners };
}

t('the first copy is put on the page and says it is held, not asked for', () => {
  const run = holdNotice();

  assert.equal(run.created.length, 1, 'a dialog is put on the page');
  assert.match(run.notice.innerHTML, /Reserved - not sent yet/);
  assert.match(run.notice.innerHTML, /Briarheart Dagger is held for you/);
  assert.match(
    run.notice.innerHTML,
    /Nothing has been asked for until you press <strong>Send requests<\/strong>/,
    'the difference between reserved and requested is the whole point of it'
  );
  assert.match(run.notice.innerHTML, /data-send-hold/, 'with the button that does send it');
  assert.match(run.notice.innerHTML, /data-close-hold/, 'and a way to keep looking');
});

t('it names the number of copies when there is more than one', () => {
  const run = holdNotice({ copies: 3 });

  assert.match(run.notice.innerHTML, /3 copies of Briarheart Dagger are held/);
  assert.match(run.notice.innerHTML, /then the copies go back/);
});

t('it names the hold the page was built with', () => {
  assert.match(holdNotice().notice.innerHTML, /ends in 5 minutes/, 'the default');
  assert.match(holdNotice({ minutes: 12 }).notice.innerHTML, /ends in 12 minutes/);
});

t('escape closes it rather than trapping anybody', () => {
  const run = holdNotice();

  assert.equal(run.listeners.length, 1, 'one listener, for the keyboard');
  assert.equal(run.listeners[0].type, 'keydown');
});

t('it is said for the first copy in an empty basket, and only then', () => {
  assert.match(
    source,
    /const basketWasEmpty =\s*!document\.querySelector\('\[data-basket\]'\) && !document\.querySelector\('\[data-basket-row\]'\)/,
    'both marks of a basket already on the page are read before the request goes'
  );
  assert.match(source, /if \(basketWasEmpty\) \{\s*explainFirstHold\(name, asked\);/, 'and it gates the notice');
  assert.equal(source.includes('HOLD_NOTICE_KEY'), false, 'nothing remembers that it was shown');

  // The one thing that hid it: a flag in sessionStorage, which an earlier hold in the
  // same tab set for good. Nothing in the notice reaches for storage now.
  const noticeSource = between('  // A reservation is not a request.', '  async function sendRequest({');

  assert.equal(/sessionStorage\s*\./.test(noticeSource), false, 'nothing is read or written there');
});

console.log(`\n${total - failures}/${total} passed`);

process.exit(failures ? 1 : 0);
