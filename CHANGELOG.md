# Changelog

What changed for the people using the site, newest first. Dates are the day a change
landed on `main`.

## Unreleased

### Added

- **The guild slot a code opened** is listed on its own under the guilds the game reported,
  labelled *Guild slot from a code*: it is an invitation that was accepted, not a membership
  the character has in game, and mixing the two made the list read as if the game had
  reported it.
- **LAST CHANCE.** An item an owner keeps shared for a fixed number of days is flagged once
  that window has run out. The window is the file's `expireDays` (14 in a typical file),
  measured from the day the item was first shared. The row is only flagged: it is not
  dimmed, it can still be asked for, and its counts do not change. Hovering the pill
  explains the owner's window - *Item has been shared longer than 14 days and is subject to
  being removed from sharing, act quickly!* Files without `expireDays` never show it.
- **Added → LAST CHANCE**, the last choice in the Added menu, which shows only the rows
  past their owner's window.
- **The demo shows LAST CHANCE too.** Its own account and the three demo guildmates keep
  items for 30 days, and the shelves are dated from months old down to a few hours, so a
  demo visit has both states at once: the oldest rows carry the pill and the newest do not,
  and *Added → LAST CHANCE* has rows to show.

- **The demo's gear says what it is.** Every weapon, armour piece and piece of jewellery in
  the demo catalogue now carries the level, the champion point requirement and the glyph it
  is enchanted with - `Level CP160`, *Glyph of Increase Physical Harm* and so on - instead of
  reading as a level 0 item with no enchantment. The simulator's three people share the same
  gear, so they carry it too. Materials, consumables and furnishings have no level to report
  and are unchanged.

### Changed

- **How to use ItemShare** is two sections now: *Been given a guild code?* for anybody who
  was handed one - sign in, choose **Use Guild Code** at the top of the next screen, and that
  guild's offerings are there, with no addon and no file - and *Adding your own items* for
  people who want their own spares on the site, which is the guide as it was. The same two
  sections open from the sign-in card and the upload box. Step 3 of the addon path carries
  the two game screenshots: the item's right-click menu, then the Shared Items window it
  fills.
- The sign-in card no longer says a file has to be uploaded before there is anything to
  compare against. That stopped being true when guild codes arrived: a code opens its
  guild's items to the account, with no addon, no file and no membership in the guild, so
  the line was telling invited guildmates to do a step they do not need.
- The **Add or remove ESO accounts** dialog only reports until a file has been uploaded.
  Attaching a name by hand, removing one, and the platform and server choices wait for the
  first `ItemShareSavedVars.lua`: a name typed by hand carries a platform and a world nobody
  has confirmed, and a sign-in with nothing uploaded has no account to record them against.
  Until then the dialog lists the accounts, their guilds and any code-opened slot, and says
  that an upload is what attaches them.
- **Remove** in that dialog is a red destructive button rather than a quiet one.
- The **Added** filter is a single-choice menu now - Any time, the last day, the last 7
  days, the last 30 days, LAST CHANCE - with the same look and behaviour as Type and
  Offered by instead of a native dropdown.
- **LAST CHANCE** is a pill around those two words rather than a bar as wide as the item
  name under it, and the **Added** menu lists its windows as words alone: one choice at a
  time means no radio dots, with the chosen row filled instead.
- The filter card no longer has its own *Item name* box. Each list's **Search this list**
  field does that job, so the address bar carries no `q` parameter any more.
- **Clear filters** is now **Reset**.
