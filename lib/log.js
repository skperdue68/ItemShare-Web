// Timestamps for everything the running site prints.
//
// A site left running for a day produces lines that interleave with the simulator's and
// with each other, and without a time on each one there is no way to tell a refusal from
// this morning out of last night's. Every line the server prints goes through here.

/** Local time, second precision, in the order it reads: 2026-11-09 05:12:03. */
export function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function logLine(...args) {
  console.log(`[${stamp()}]`, ...args);
}

export function warnLine(...args) {
  console.warn(`[${stamp()}]`, ...args);
}

export function errorLine(...args) {
  console.error(`[${stamp()}]`, ...args);
}
