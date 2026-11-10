# Changelog

What changed for the people using the site, newest first. Dates are the day a change
landed on `main`.

## Unreleased

### Added

- **LAST CHANCE.** An item an owner keeps shared for a fixed number of days is flagged once
  that window has run out. The window is the file's `expireDays` (14 in a typical file),
  measured from the day the item was first shared. The row is only flagged: it is not
  dimmed, it can still be asked for, and its counts do not change. Hovering the pill
  explains the owner's window - *Item has been shared longer than 14 days and is subject to
  being removed from sharing, act quickly!* Files without `expireDays` never show it.
- **Added → LAST CHANCE**, the last choice in the Added menu, which shows only the rows
  past their owner's window.

### Changed

- The **Added** filter is a single-choice menu now - Any time, the last day, the last 7
  days, the last 30 days, LAST CHANCE - with the same look and behaviour as Type and
  Offered by instead of a native dropdown.
- The filter card no longer has its own *Item name* box. Each list's **Search this list**
  field does that job, so the address bar carries no `q` parameter any more.
- **Clear filters** is now **Reset**.
