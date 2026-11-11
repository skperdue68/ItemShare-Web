# Changelog

What changed for the people using the site, newest first. Dates are the day a change
landed on `main`.

## Unreleased

### Added

- **`npm run delete:user`** removes a person by the name they sign in with, with everything
  attached to them: their ESO accounts and the items, offers, guild memberships and uploads
  on them, their baskets and requests, the guild codes they made and the redemptions of
  them, and their sign-in rows and sessions. It all happens in one transaction, and it
  counts every known reference afterwards, rolling back rather than committing a
  half-removed person. `--list` prints the email and password logins it can remove, with
  their id and how many ESO accounts each has, and `--dry-run` shows what removal would
  take. Both listing and removing work on logins made on the site with an address and a
  password, not on Discord or Google sign-ins.
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
  gear, so they carry it too.
- **Every shared item shows a level.** The demo and simulated catalogues give the things
  that are not gear - materials, consumables, furnishings and motifs - level 1, which is
  what an item with no requirement carries. They still have no champion points, glyph or
  style, because they have none: the row reads *Level 1* and stops there, rather than
  looking as though its level were simply unknown.

### Fixed

- **A standing offer now offers what its owner actually has.** *Offered* is the copies they
  hold less the amount they keep back, and *Available* is that less whatever a request is
  already standing on. A request button only appears while both are above zero, so an offer
  whose stock is all kept back, or whose copies are all spoken for, is not a row to ask from
  at all. An offer whose file never wrote a count still means the one copy it always did,
  while a file that writes 0 means the owner holds none: the two are stored apart, so an
  emptied bag stops reading as one copy on offer.

- **An item's age is counted from a real UTC instant.** The elapsed time in **Added** came
  from a timestamp MariaDB had already converted into the database host's own time zone,
  which the query then labelled `Z`; on a host six hours behind UTC an item offered a
  minute ago read as six hours old. Connections are now put in UTC and the lists ask for
  `UNIX_TIMESTAMP(first_seen_at)`, so the count starts from the moment itself and each
  reader sees it run in their own clock. Request times, LAST CHANCE and the *Added* windows
  measure from the same instant, exactly as before.

### Changed

- **The tabs say whose list you are reading.** *Request* is **Others Inventory**, *Offering*
  is **My Inventory**, and *Your requests* is **My Requests**. Nothing else moved: the
  columns, the buttons and the counts are the ones each tab already had.

- **Browsing as** is a rounded dark menu now, matching the **Added** menu above the lists
  instead of looking like a form control borrowed from the browser: the same height, card
  colour and small caret, and a dark option list.
- **An upload no longer fails because one ESO account in the file belongs to somebody
  else.** That account is left exactly as it was and the rest of the file is stored, so a
  file copied from another player, or a file on a shared computer, still updates the
  accounts that are yours. The upload message names what was updated and what was not, and
  why. A file holding nothing but somebody else's account stores nothing and says so.
- **The two how-to screenshots** are shown at the size they were captured at, centred in the
  column, rather than stretched to its full width: the narrow right-click menu stays as sharp
  as it was captured instead of being blown up, and a picture wider than the column is still
  held to it rather than making the page scroll sideways.
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
