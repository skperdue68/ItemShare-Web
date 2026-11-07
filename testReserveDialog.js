#!/usr/bin/env node
// What an open reserve dialog shows when the number left changes under it.
//
// The dialog takes its ceiling from the row it was opened from, and that row keeps moving:
// somebody else reserves a copy, or the owner uploads a smaller stack. This drives the real
// sync function out of public/app.js against a stand-in dialog - no browser, no database -
// and checks the words under the title, the top of the slider, the number in the box and
// which controls go dead. The source checks around the slider prove the wiring exists; this
// proves what a person actually reads at the moment it fires.
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
// title, and the function that re-reads the row and moves the controls.
const parts = [
  'var dialog = null; var dialogState = null;',
  between('  function dialogNumbers(button) {', '  function openRequestDialog(button) {'),
  between('  function refreshDialogNumbers() {', '  // A reservation is not a request.'),
  'return {',
  '  dialogNumbers,',
  '  dialogSummary,',
  '  clampCopies,',
  '  refreshDialogNumbers,',
  '  syncRequestDialog,',
  '  open: (nextDialog, nextState) => { dialog = nextDialog; dialogState = nextState; },',
  '  state: () => dialogState,',
  '};',
].join('\n');

const makePage = new Function('document', parts);

const control = (extra = {}) => ({ max: '', value: '', disabled: false, textContent: '', ...extra });

/** A row in the list, as the page would render it: what is left, of how many, in your basket. */
const row = (max, stack = '5', held = '0') => ({
  dataset: { max: String(max), stack: String(stack), held: String(held) },
});

/**
 * A dialog that opened showing `showed` copies, with a row that now says something else.
 * A null row is a row with nothing left to offer, which is how the list renders once every
 * copy is held: the button is replaced by "All held" and this lookup finds nothing.
 */
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
  const page = makePage(fakeDocument);

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

const CLAIMED = 'Every copy has just been claimed, so there is nothing left to ask for.';

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

  assert.equal(ui.summary.textContent, '1 of the 5 still unclaimed.');
  assert.equal(ui.confirm.disabled, false, 'one copy left is still one copy to ask for');
  assert.equal(ui.slider.max, '1');
  assert.equal(ui.slider.value, '1');
});

// --------------------------------------------------- somebody reserves while you look

t('a copy going elsewhere lowers the top and pulls the chosen count down with it', () => {
  const ui = openDialog({ showed: 5, now: row(2), state: { max: 5, stack: 5 } });

  ui.sync();

  assert.equal(ui.summary.textContent, '2 of the 5 still unclaimed.');
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
    '2 of the 5 still unclaimed, and 1 already in your basket - asking for more adds to that row rather than starting another.'
  );
});

// ------------------------------------------------------- the owner re-uploads fewer

t('the owner uploading fewer copies moves the ceiling and the sentence', () => {
  const ui = openDialog({ showed: 4, now: row(3, '3'), state: { max: 5, stack: 5 } });

  ui.sync();

  assert.equal(ui.summary.textContent, '3 still unclaimed.', 'no "of the 5" once the stack itself is three');
  assert.equal(ui.slider.max, '3');
  assert.equal(ui.slider.value, '3');
  assert.equal(ui.amount.value, '3');
  assert.equal(ui.page.state().stack, 3, 'the old stack size is forgotten with it');
});

t('a re-upload leaving one copy keeps the dialog usable for that one', () => {
  const ui = openDialog({ showed: 3, now: row(1, '1'), state: { max: 5, stack: 5 } });

  ui.sync();

  assert.equal(ui.summary.textContent, '1 still unclaimed.');
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

console.log(`\n${total - failures}/${total} passed`);

process.exit(failures ? 1 : 0);
