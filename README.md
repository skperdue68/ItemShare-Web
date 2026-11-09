# ItemShare web application

The website half of ItemShare: members of a guild upload the file the in-game addon
writes, and the site publishes what each of them is willing to share. Anyone who
shares a guild with an owner can browse those items, ask for some of a stack, and
send the ask; the owner is emailed what was asked for and which character account to
mail it to in game.

Everything the site needs is in this folder. There is no build step, no bundler and no
front-end toolchain: `server.js` renders the HTML, `public/` adds the stylesheet and
the browser script, and MariaDB holds all the state.

## What is, and is not, in this repository

This repository is the **web application only**.

**Here:**

- the Express site, its routes, its server-rendered views and its Socket.IO live updates
- the parser for `ItemShareSavedVars.lua` - the site has to read that file, so the
  parser ships with it
- the MariaDB schema and its migrations
- the operator scripts: icon backfill, demo seeding, the request simulator, a mail check

**Not here:**

- the ESO addon that writes `ItemShareSavedVars.lua`
- anything that watches the game's `SavedVariables` folder, or that knows where the game
  is installed on any machine
- GuildSync, or any other client that posts to `/ingest`

The site consumes the file; producing it is somebody else's job. It arrives two ways:

| Way | What it is | Talks to |
| --- | --- | --- |
| The upload page | A person drops the file on the site | `POST /upload`, multipart, browser session |
| `POST /ingest` | An HTTP endpoint this site offers to a watcher on the game machine | MariaDB, over HTTP, shared token |

Both are in the web request path and both parse the file with the same code
(`lib/savedVars.js`), so "what a file means" has exactly one implementation. There is no
command line importer and no local file discovery: this repository never looks for a
game installation.

## Requirements

- **Node.js 20 or newer** (`package.json` enforces it)
- **MariaDB** - the site creates and migrates its own database on first boot
- optionally, **a mail server or a Resend account** for request emails, and **Discord
  and/or Google OAuth credentials** for sign-in

## Install and first run

```bash
npm ci                    # from package-lock.json; no global tools needed
cp .env.example .env      # every setting, documented
chmod 600 .env
npm start                 # http://localhost:3000
```

`.env.example` is the full reference: every setting the site reads, its default, what
it does and how to get the value. Nothing *has* to be set to boot on a local
root/no-password MariaDB.

The server reads `.env` from this folder by absolute path, so it is found whatever
directory you start the process from - and a `.env` kept anywhere else is not read.
Startup prints the file it actually read, which settles most "I set it and nothing
changed" questions.

## Settings

Three have no sensible default and are worth setting before anyone else uses the site:

| Variable | Why you want it |
| --- | --- |
| `BASE_URL` | Sign-in redirects and the links in request emails are built from it. Wrong here means people are sent to `localhost` that is not theirs |
| `SESSION_SECRET` | Without it a fresh random secret is made on every boot, so a restart signs everybody out |
| `MARIADB_USER` / `MARIADB_PASSWORD` | The defaults (`root`, no password) are for a throwaway local server only |

Everything else - sign-in providers, email, the `/ingest` token, the hold window,
retry timers - is optional and off when blank. See `.env.example` for each one.

One deliberate oddity: **`MARIADB_DATABASE` is ignored.** ItemShare always uses its
own database (`ITEMSHARE_DATABASE`, default `itemshare`), so it cannot write into
another application's schema even when both share a MariaDB server.

## Startup and migrations

On boot the site:

1. connects to MariaDB without selecting a database, so it can create one;
2. runs `CREATE DATABASE IF NOT EXISTS` for `ITEMSHARE_DATABASE`;
3. applies every `.sql` file in `migrations/` that has not been applied before.

Applied files are recorded in `itemshare_schema_migrations`, so each runs exactly
once. To add a migration, drop a new sortable file in `migrations/`
(`018_something.sql`) and restart: it is applied on that boot and never again.
Recorded migrations are not re-run, so they no longer have to be idempotent, though
`CREATE TABLE IF NOT EXISTS` remains a good habit.

If the database is unreachable at startup the site still boots, logs the reason, and
shows the error on the page instead of crashing. Connections made per request connect
straight to the existing database rather than re-running migrations.

## Signing in

Signing in does one job: it establishes who someone is, so their ESO accounts can be
linked to them and requests can be addressed to a real person. There are three ways in -
an email address with a password, Discord, or Google - and all three end in the same
place: a row in `itemshare_users`.

**Email and a password.** `POST /auth/email` signs in and `POST /auth/email/signup` makes
the account. Both are ordinary forms on the sign-in page, so they work with scripts off
and need nothing in `.env`; the OAuth buttons are the extra rather than the requirement.
Creating the account asks for the password twice, and both copies are compared on the
server as well as in the browser (`passwordConfirmationProblem` in `lib/passwords.js`), so
a form posted with scripting off is held to the same rule. Every password box carries an
eye that shows what was typed, drawn by `/password-toggle.js`, which listens once on the
document and therefore reaches the boxes the request dialog builds after a click.
What the page asks for is the address, because the address is what the site collects: it
is where a request answer is sent, and it is what ties the sign-in to an ESO account. The
password is stored as scrypt with a per-password salt (`lib/passwords.js`), one row per
person in `itemshare_passwords`, and the address itself is the identity
(`provider = 'password'`), so nothing downstream has to know which way somebody came in.

An address typed into a form is stored **unverified** and never merges with an existing
person: merging on an unproven address is how somebody takes over an account, so a
password address can only ever sign in the account it made. Signing in gives the same
answer for a wrong password and for an address nobody has - a real decoy hash costs the
same as a real check - so the form cannot be used to find out who has an account here.

**Discord and Google are optional.** Each provider is independent: configure one and only
that button appears, configure both and there are two. They are not needed for the site to
work, because the email form always is.

**Discord.** Create an application at
<https://discord.com/developers/applications>, add the callback URL under **OAuth2 →
Redirects** (`http://localhost:3000/auth/discord/callback` for local use), and put the
client id and secret in `.env`. Scopes requested are `identify` and `email`.

**Google.** Create an OAuth client of type *Web application* at
<https://console.cloud.google.com/apis/credentials>, add the same shaped callback under
**Authorised redirect URIs**, and put the client id and secret in `.env`. Scopes are
`openid email profile`.

Both providers give a stable opaque subject id, which is what identifies a login.

**One person, either button.** Identities live in `itemshare_user_identities` and point
at a row in `itemshare_users`. When someone signs in with a provider for the first time
and that provider reports a *verified* email already known to another identity, the new
identity joins the existing person instead of creating a second empty one. That way the
ESO accounts linked through Discord stay visible after signing in with Google.
Unverified addresses are never used to merge people.

Provider definitions - endpoints, scopes, and how a profile becomes the site's fields -
live in `lib/providers.js`, as a pure function of the profile, so they can be read
without completing a real OAuth round trip.

**Which ESO account is yours.** Signing in is not the same as saying which ESO account is
theirs, and the site needs the second answer: a request has to name the character to mail.
The first time somebody signs in with no ESO account attached, the *ESO accounts* dialog
opens by itself and asks for the name. It is also where the list lives - every attached
account with its items, guilds and last upload, a **Remove** button at the bottom of each
row, and the box that attaches another under the list. The profile menu reopens it at any
time.

Names typed by hand are normalised the way the addon writes them (`lib/accountNames.js`):
lower case, one `@` in front, spaces dropped, and anything that cannot be in a name
removed. `@Name`, `@name` and ` name ` are therefore one account. Attaching an account
does not require sharing anything, and removing one only unlinks it: its items, guilds and
uploads stay with the account, and attaching it again takes it back.

## Uploading a file

`POST /upload` takes one multipart field named `savedvars`, capped at 12 MB. If any
sign-in provider is configured, the uploader must be signed in; with none configured the
upload is accepted anonymously.

What the file supplies, per shared item: name, item id, icon path, type, quality, trait,
apparel slot, equip type, armour and weapon type, handedness, furniture data id,
location, set name, enchantment, crafting style, required level, champion points and
flavour text. Plus every ESO account in the file, each with its own guild membership and
the server it was written on (`worldName` and `platformRaw`), and the standing offers.
Fields the game does not expose are simply absent rather than being invented.

**Fill in, then prune.** An upload writes every item the file mentions where it already
stands - same row, same id, same first-seen date - and only afterwards deletes the rows
the file no longer mentions. Nothing blinks out of the list between one upload and the
next, and anything pointing at a row (a guild link, an open request) keeps pointing at
it. Un-sharing an item in game and re-uploading still removes it here. The mark the
prune uses is `upload_id`: everything the file mentions is stamped with the new upload,
so a row still holding an older id was not in this file. Every account in the file is
handled inside one transaction, so either all of them are replaced or none are.

Guild membership is replaced in full as well (`itemshare_account_guilds`), so leaving a
guild in game removes that guild's visibility after the next upload.

The first upload from a signed-in person links their identity to the ESO account in
`itemshare_accounts`. If that ESO account is already linked to a different person the
upload is refused rather than silently reassigned.

Item rows keep the account they came from (`itemshare_shared_items.account_name`), so
someone who plays several ESO accounts can see which account holds each item. Which
account that is comes from **where the item sits in the file** - the `["@account"]`
table - and not from the `accountName` the addon copies into the entry. That copy still
names the old account when a saved variables file is copied to a different one, and an
upload that trusted it stored the items under an account the file did not contain, which
is to say it stored none of them. A copy that names another account of the same file is
still honoured, because that is a deliberate move between accounts.

### How guilds are read

The addon writes guild data once, at the top of each account's scope, and items carry no
guild fields at all:

- `guilds` - one registry, keyed by guild id, holding every guild name the account knows.
- `characterGuilds[character]` - that character's `guildIds`, and when they were captured.
- an item's guilds are therefore `entry.characterName` -> `characterGuilds[character]` ->
  its `guildIds` -> `guilds[id]`.

Guild names always come from the registry. Every registered guild is upserted - including
one that no item names - so a name never goes stale and the upload's guild count stays
right. A character the file has no snapshot for falls back to the account's own
membership, so its items are attributed to the whole account rather than to nobody.

Two fields the addon is about to drop are already tolerated: a row with no `itemKey` is
keyed by its `itemLink` plus the `locationKey` it was found in, and a row with no `count`
takes `heldCount` minus `reserve`.

### Which server a guild is on

The addon writes the server it ran on into each account's scope: `worldName` (`NA
Megaserver`, `EU Megaserver`, `PTS`) and `platformRaw`. They are read per account and
stored on the account, on every guild and on every guild link, because a guild id and an
`@handle` are only unique within one megaserver - the same numeric `guild_id` on NA and EU
is two different guilds, and so is the same id on PC and Xbox.

A guild is therefore identified by its id **and** its world, `itemshare_guilds` is keyed
by both, and a share is only visible to an account on the same world as the owner. The
account list shows the server beside each name.

`0` / `''` mean **not known**, never a world of their own. An unknown world matches
whatever it is compared with, the same way the guild rule itself is only applied when
both sides know the answer, so everything recorded before this was captured stays
visible and nothing has to be re-uploaded twice. Two cases have no file behind them:

- a name attached by hand in the **ESO accounts** dialog, or typed by a guest asking for
  the first time, has no world until that account uploads once;
- a file from an addon older than the one that writes the world.

The first upload from that account fills it in, and an ingest from a watcher does the
same. An account scope is recorded even when it holds no items, so somebody who uploads a
file where they share nothing still tells the site which server they play on.

Only this layout is read. An older file - `knownGuilds`, guild fields copied onto every
item, an `ItemShareExport.lua` compatibility copy - still parses, but its guilds are not
read at all, so its items arrive with no guilds and nobody can see them. Re-export with
the current addon instead.

## Automatic uploads

`POST /ingest` accepts the same file from a watcher instead of a browser, so the site
stays current without anyone opening the page.


It is **off unless `INGEST_TOKEN` is set**, and the token is compared in constant time.
It does exactly what an upload does - same parse, same fill-then-prune, same icon
resolution, same live update - because both routes call the same code. The difference
is identity: a watcher has no browser session, so it runs anonymously. It never links
an ESO account to a person and never changes an existing link, so a stolen token can
overwrite item lists but cannot claim somebody's account.

The body is the file's **contents**, not a multipart form:

```bash
curl -X POST https://your-site.example/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: text/plain" \
  -H "X-ItemShare-File: ItemShareSavedVars.lua" \
  --data-binary @ItemShareSavedVars.lua
```

The body is read as bytes and inflated if needed, so the sender does not have to know
the size up front: chunked transfer, no `Content-Length`, gzip or deflate in
`Content-Encoding` (up to 12 MB once inflated), any `Content-Type` or none at all all
land here the same way. Piping off disk works too:

```bash
gzip -c ItemShareSavedVars.lua | curl -X POST https://your-site.example/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Encoding: gzip" \
  --data-binary @-
```

`X-ItemShare-Token` is accepted as an alternative to the `Bearer` header, and
`X-ItemShare-File` names the file for the upload log (it defaults to
`ItemShareSavedVars.lua`).

| Reply | Meaning |
| --- | --- |
| `200` | Accepted and applied. The body is the same summary the upload page gets |
| `400` | The body was empty, or no ESO account was found in it |
| `401` | Missing or wrong token |
| `503` | `INGEST_TOKEN` is blank, so automatic uploads are off |

The token never appears in a reply or in the log. Keep the site behind HTTPS, since the
token travels in a header and the file contents are plain text over the wire.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | The page: tabs, filters, the item table |
| `GET` | `/items` | The item-list region only, as a fragment, for live refresh. `503` means "leave the screen alone" |
| `POST` | `/upload` | Accept a `ItemShareSavedVars.lua` upload |
| `POST` | `/ingest` | Accept the same file from a watcher, token-authenticated |
| `POST` | `/browsing-account` | Choose the ESO account browsing uses; a form post that redirects back to `/` |
| `POST` | `/requests` | Put an item in the basket, or top up its quantity |
| `POST` | `/requests/:id/cancel` | Take a basket row back out |
| `POST` | `/requests/submit` | Send the basket: commit it and email the owners |
| `GET` | `/icons/:file` | Cached item thumbnails, served from the database |
| `GET` | `/item-tip` | The hover card's description and set bonuses, cached |
| `GET` | `/auth/:provider` | Start a sign-in (`discord` or `google`) |
| `GET` | `/auth/:provider/callback` | Finish it |
| `POST` | `/auth/email` | Sign in with an email address and password |
| `POST` | `/auth/email/signup` | Make an account from an address and a password |
| `POST` | `/accounts/add` | Attach an ESO account name to the signed-in person |
| `POST` | `/accounts/remove` | Unlink one of their ESO accounts, leaving what it shared |
| `POST` | `/logout` | Delete the session row and clear the cookie |
| `POST` | `/simulate/nudge` | Token-authenticated "something changed" push, used by `npm run simulate` |
| `GET` | `/requests/fulfill/:token` | The answer form a request email links to; the token in the address is the credential |
| `POST` | `/requests/fulfill/:token` | Records what the owner says they sent: `0` cancels that row, anything else hands it over |
| `GET` | `/owner/requests` | Signed-in list of what is waiting on your own items; with `X-ItemShare-Fragment: 1` it returns just the card the modal shows |
| `POST` | `/owner/requests` | Records an answer given on the site, then redirects back so a refresh cannot answer twice; the fragment request gets the refreshed card instead |

Socket.IO shares the HTTP server under `/socket.io`, so live updates need no second
port and no extra proxy rule.

## Seeing shared items

You browse as **one** of your ESO accounts. When more than one is linked, a *Browsing
as* control above the tabs picks it, and the choice is stored on the person
(`itemshare_users.browsing_eso_account_name`) rather than in the session, so it survives
signing out and follows you to another device. With a single account it is a label
instead of a choice.

The chosen account decides what **Request** shows: only items offered to guilds *that
account* belongs to. **Offering** deliberately spans every linked account and names the
account and character holding each item, so a second account never hides what the first
one shares. **Your requests** covers everything you have asked for, from any account.

Every row shows the owning account, quantity, item type and trait. The character is named
by the `Location` column (`Inventory (Character Name)`), so it is not repeated beside the
account.

Three tabs keep the split obvious, so no row needs a "You" tag: **Request** (other
people's items), **Offering** (your own), and **Your requests**.

Rows sit under their item type, alphabetical inside each group, until you turn that off.
The switch above the table reads **Grouped by type** or **One list** and flips between
the two on a click, without touching the order you chose: grouping decides whether the
headings are drawn, the headings decide the order. With grouping on, the types themselves
always run A-Z and the chosen order applies only inside each type; with it off, it applies
to the whole list. A sort never moves a heading: **Added** newest-first puts the newest
weapon first under Weapons, and Weapons is still where W falls in the alphabet.

The **Item** and **Added** headings sort, cycling through three states on repeated
clicks: ascending, descending, then back to the default. The chosen order is remembered
in the `itemshare_sort` cookie and the grouping in `itemshare_group`, so both survive a
reload without ever appearing in the URL.

`Added` is the day an item first entered its owner's shared list - the day they offered
it - not the day of their latest upload, so re-uploading a long-held item does not make
it look new. An item that leaves the file altogether - unshared, or every copy handed
over - is dropped when that upload arrives, so if the owner offers it again later it
comes back with the day they offered it again rather than the day it first appeared.

`Location` is where the owner's copy was the last time they saved: `Bank`,
`Inventory (Character Name)`, `Furnishing Vault (...)`. An upload rewrites it, so moving
something in game and saving again updates it without anyone touching the site.

A filter bar narrows the list by item type, owner account, how recently it was added
(day / 7 days / 30 days) and item name. Type and owner accept several values at once,
each ticked value becoming a chip on a row underneath; clicking a chip removes just that
value. Filters are ordinary query parameters, repeated once per value
(`/?type=Weapon&type=Armor&owner=@Name&added=7&q=sword`), so a filtered view can be
bookmarked and works with scripts off. The sort order is deliberately not among them:
it is a reading preference kept in a cookie, which keeps links clean and stops one
person's sorting being handed to whoever opens their link.

An owner can keep part of a stack back in game with a *share reserve*. The addon writes
the reserve into `locationReserves` beside the item list rather than inside the item,
keyed by the item link and the location it was set in - `link||locationKey`. That is the
only reserve layout read: holding back 113 of the 400 soul gems in house storage 8 leaves
the 800 in the bag and the 1614 in the bank alone, and the same item in three places is
three rows of which only the one the reserve was set on is short.

The older `reserves` table, keyed by the link alone, is not a fallback for this. A file
carrying only that is a file the addon no longer writes, so its reserve is ignored and no
stack is reduced - exactly as the v2 guild tables are ignored rather than guessed at.

The reserve is applied before storing: `item_count` is what is really being
offered (400 held less 113 kept back is 287 shared), and the reserve itself is kept so it
can be shown as a small amber note under the item name (`keeping 113 back of 400`). A
stack offering 8 does not look like an owner who only has 8.

A reserve never shares anything by itself. It only reduces a stack that is already in the
file's item list, so a reserve for an item that is not being shared is ignored: setting a
reserve creates no offer, no row and no request button.

Visibility joins three tables: the item's guilds (`itemshare_shared_item_guilds`), the
viewer's guilds (`itemshare_account_guilds`) and the guild names (`itemshare_guilds`).
Nothing is readable without a guild overlap, so an account in no guilds sees nothing.

The rule is only applied when both sides are known. A guild rule needs the viewer's
guilds and there is no way to guess them, so when they are unknown the list is
unrestricted instead of empty:

- somebody who has signed in but attached no ESO account has no guilds at all;
- an account typed into the *ESO accounts* dialog has no guild membership either, because
the addon has not been asked yet - only an upload can say which guilds an account is in.

Both see everything that is shared, by anybody. Asking is a separate question, decided by
what the request is made from rather than by what is visible: a visitor is asked for an
ESO account name and an address the first time and that makes them a person, and somebody
signed in without an account is told to attach one - the request route refuses neither in
silence, and `POST /requests` refuses a guest that names no account and no address.

> Upload ItemShareSavedVars.lua so we know who you are - you do not need to share
> anything.

Attaching a name is enough to ask for items - uploading is what tells the site which
guilds that name is in, and with those known the list narrows to the guilds the browsing
account belongs to.

Adding and removing attached names lives in the **Add or remove ESO accounts** dialog: the
avatar menu opens it, every account there has its own **Remove** button, and the box under
the list attaches another. The **Your ESO accounts** card on the page is a summary of the
same list.

A visitor who is not signed in at all sees the same list, under the same hero, and can
ask for any of it. **The first request asks for three things** - the ESO account name it
is made from, an email address to send the answer to, and a password - and the dialog
sends them with the request. The password is what makes it an account rather than a
one-off row: the identity and password it writes are exactly what the sign-up form
writes, so the email sign-in card lets the same person back in later with the same
basket, requests and attached ESO account. The session remembers them in the meantime,
so every later request asks nothing.

A guest's request is **not** held to the guild rule. The account name they typed has no
guild membership on record, they were shown everything that is shared, and a Request
button the server then refuses is worse than a request the owner can decline. The owner's
email names the account and the address, so the decision stays with the owner.

Three things follow from that, and all are deliberate. The address is **unverified**: the
answer email is a link with a token, so an address typed by mistake means the answer is
never read, and an address typed on purpose means somebody else receives it - which is
why an address that already signs in with a password is refused instead of adopted,
rather than letting a stranger type their way into somebody else's requests. An anonymous
first request also creates a person, so new guest people are limited to five an hour per
connection - an in-memory counter, cleared by a restart - because otherwise the form
would be a way to make the site send mail to strangers. And if the named ESO account
already belongs to another sign-in, the request is refused rather than filed under
somebody else's character.

The two tabs that only make sense for somebody with items and requests of their own
(**Offering** and **Your requests**) are not drawn for a visitor, so the page offers the
one list that applies. Nothing is hidden for effect: the list is real, and reading it is
the reason the sign-in card sits above it rather than in front of it.

The overlap is resolved per list: for the account you browse as in *Request*, and across
every linked account in *Offering*.

## Asking for something

Every row in *Request* has a **Request** button that asks one of two things: **Request 1**,
or **Request stack (N)** where N is everything still unclaimed. N is the copies nobody has
claimed plus whatever is already in your own basket, never more than the raw `item_count`,
so two people can never be promised the same five. What is picked there is the total you
want to hold, so the same item stays one row in the basket.

A standing offer has no count behind it, so it always means one copy, one at a time: it is
listed as **Offered 1** until that copy is claimed, and then it leaves the list. It is not
hidden while the owner has nothing in a bag, because the file no longer says: schema 4
keeps an always-shared item out of `sharedItems`, so the offer itself is the only evidence
that the owner wants to hand it out. The server refuses a second request for the same
offer either way, so two people cannot be promised the same handover.

When only one copy can be given, the button sends that request straight away rather than
opening a dialog whose only answer is "one".

The email that reaches the owner says which item, how many, and **where that copy was
believed to be** - the same `Location` the list shows, taken from the owner's own saved
file at the moment the request was made. It is a place to look rather than a promise: an
owner who moves the stack and saves again does not rewrite requests that are already
waiting, and a standing offer carries no location to name.

A request is recorded against the account you are browsing as - that is the character
the owner is told to mail - so the account picker changes where a handover happens, not
just what you can see.

A request is **a reservation, not a delivery**, and it reserves from the moment it is
picked rather than from the moment it is sent:

- The list has three quantity columns, so the arithmetic is visible instead of inferred:
  **OFFERED** is the total the owner presented for claiming, **RESERVED** is how much of it
  a request is standing on, and **AVAILABLE** is what is left to claim - the cap on what
  anyone can ask for. Claimed and available add up to offered, so a row of 8 offered with
  5 reserved and 3 available explains itself. A row with nothing reserved leaves that column
  blank rather than filling it with a dash. When nothing is available the button becomes
  *All Currently Reserved*.
- On your own rows, **N pending requests** says how many asks are waiting on you, one
  per request rather than one per copy, so two people asking for one copy each reads
  "2 pending requests". The number falls as requests are answered, cancelled or time
  out, and vanishes at zero. Hovering it lists who asked and how many they asked for,
  one line per waiting request.
- The request dialog is two buttons - **Request 1** and **Request stack (N)** - and a
  **Cancel**. There is no number to type: the cap was never visible on the row, and a box
  that silently refused larger numbers made the person guess at it. If someone else takes
  a copy while the dialog is open, the stack button follows the new count down and hides
  itself when only one is left.
- Asking puts the item in a **basket** with a clock (`REQUEST_HOLD_MINUTES`). Everything
  picked shares one timer, and adding or removing anything starts it again. *Your
  requests* shows the countdown beside a **Send requests** button; until it is pressed
  nobody has been asked, but the copies are held.
- When the clock runs out the basket is cancelled with the reason shown, and the items
  are free again. That happens **server-side on a timer**
  (`REQUEST_SWEEP_INTERVAL_MS`), so it also happens to somebody who closed the tab.
  Every query also treats a lapsed reservation as free, so the arithmetic is right even
  between two sweeps.
- Each basket row can be removed before sending, which restarts the clock for the rest.
  A removed row stays where it was, marked **Cancelled**, for about five seconds, then
  fades out. It is not added to history, because it was never sent.
- **Asking again tops the row up**: taking 2 of a stack of 5 and then asking for the
  whole stack leaves one basket row holding 5, not two rows holding 7.
- A row that runs out - every copy asked for and sent - also stays for about five
  seconds before fading, then stops appearing. A row that is only being picked stays
  visible with *being picked* beside it, because a basket can lapse and the copy come
  back.
- After every upload the owner's requests are settled oldest first, because they were
  promised first. One whose item has gone, or whose turn the stack no longer reaches, is
  cancelled with a sentence the requester can read: "Ghost Bane now has 2 of Briarheart
  Dagger, which does not cover the 3 you asked for." A row that merely moved is
  re-pointed by `item_key_hash` instead of being cancelled.
- *Your requests* holds the basket and, below it, **Already sent**: only the requests
  that actually stand, newest first. A request that timed out or was cancelled is
  dropped rather than sitting in the list looking live; when a live update brings back a
  cancellation the page still says so in a toast, once.
- A requester can cancel a waiting request. The owner sees "2 asked for" on the row.
- Following a link to **another site** while a basket still holds items raises a styled
  warning ("You have unsubmitted item requests"). Moving between pages of this site does
  not: the basket is held on the server, so it is still there on the way back. The
  wording says so - the items return to everyone only when the clock runs out - and
  **Leave anyway** suppresses the browser's own unload prompt for that navigation, so the
  same warning is never asked twice. Closing the tab, or posting a form, still falls back
  to the browser's prompt.

## Request emails

Sending the basket emails the owner of each item: one message per person, headed **ESO
Item Request**, listing every item with its quantity and naming the ESO account
(`@Name`) the items should be mailed to. Sending happens after the requests are
committed, and a failed send is logged rather than turned into an error - the request
already exists either way.

Each line also carries what tells two copies of a name apart: type, trait and
enchantment, with the name in its quality colour. That is copied onto the request when
it is made (`enchant_name`), because the next upload rewrites the item rows the request
came from. An owner with three Briarheart swords and two Twice-Born rings can see which
one was asked for without opening the site.

Only an owner whose ESO account is linked to a signed-in person has an address at all,
so a request to an unclaimed account sends nothing. With no transport configured the
site works normally and the log says
`Email: N request emails not sent - set EMAIL_FROM ...`.

### Answer emails

When an owner answers - on the site or from the form in the email - the person who asked
is told what happened. The copies arrive in the game's own mailbox and the game says
nothing about them, so without this the only way to find out is to open ESO and look.

One message per person, not per request or per account: somebody who asked from two ESO
accounts has one address and gets one list. The subject says which case it is - *request
was fulfilled*, *request was not fulfilled*, or *requests were answered* when the rows
disagree - and each line carries its own result, so `2 of 3 sent` sits next to `not
fulfilled` rather than behind one bold claim. A partial handover counts as fulfilled: the
point of the message is that there is something to collect. Cancelled rows say the owner
had nothing to send and that nothing is waiting in the mailbox, so nobody signs in and
goes looking for an item that was never mailed.

The address is the asker's own sign-in address (`itemshare_users.email`). A person who
never linked one gets no message and the answer still records itself; with no transport
configured the log says `Email: N answer email(s) not sent - ...`. The answer is committed
before any mail is attempted, and a failure to work out who to tell is caught, so a mail
problem can never undo a handover or turn it into an error page for the owner.

Two settings keep testing out of a guildmate's inbox:

- `EMAIL_OVERRIDE_TO=you@example.com` sends **every** message to that address instead of
the owner's. The message is the real one - what lands in your inbox is what the owner
would have read - with three additions saying where it would have gone: a dashed notice
above it, a `[Test: owner@example.com]` subject prefix, and a first line in the plain-text
copy. A misspelled address sends nothing at all and says so in the log, rather than
falling back to the real owners.
- `EMAIL_TRANSPORT=none` turns mail off entirely. Requests still record, and the owner
still sees them on their own list; the log says `Email: N request emails not sent - mail
is turned off with EMAIL_TRANSPORT=none`. Use it once mail is verified, until the site is
live for people outside the testing.

`npm run email:test -- you@example.com` sends one of these messages through exactly the
configuration the site uses, printing the transport, sender and subject first, then the
result. Add `answer` as a second argument to look at the reply the asker gets instead. It
opens no database connection and changes nothing, so it separates "the mail server works"
from "the site is configured" - if it says the message was handed over and nothing
arrives, the problem is the MTA's queue or DNS, not ItemShare.

## Item icons

Browsers cannot draw the game's DDS textures, so after an upload the site fetches each
*new* icon once from UESP's PNG mirror (`esoicons.uesp.net`) and stores the bytes in
`itemshare_item_icons`. Pages then serve them from `/icons/<key>.png`, so browsing never
contacts UESP and a later upload of the same item fetches nothing.

Fetching is best effort: a failure is logged, that row shows no thumbnail, and it is
retried later. When the file records no icon path at all, the site falls back to the
item id: `esoitem.uesp.net/itemLink.php?itemid=...` first, then
`exportJson.php?table=minedItemSummary&id=...`, which often answers for set items whose
page carries no icon. Whichever answers travels the ordinary cache route, so nothing
downstream knows the difference.

A blank icon never repairs itself, so the same pass also runs on a timer:
`ICON_BACKFILL_INTERVAL_MS` (default 30 minutes, `0` turns it off) sets how often, and
`ICON_BACKFILL_BATCH` (default 20) how many item ids one pass may look up. A pass looks
at ids with no path anywhere *and* at ids whose stored path never produced an image. The
second kind is only rewritten when UESP answers with a different path, so an item UESP
is still refusing stays queued instead of looping on the same answer. `node
backfillIcons.js --dry-run` lists both groups.

## Hovering an item

An item's name opens a card instead of sending the reader to another tab. It starts with
what the row already knows - name in its quality colour, type, trait, enchant, level and
champion points - then adds the game's own description and what the item's **set** does.
That second half comes from UESP's public item database, fetched server-side by
`/item-tip` and cached in `itemshare_item_tips` for a month, so a name is looked up once
however often it is hovered and the browser never talks to UESP.

The cache is an optimisation: with an empty table, no network, or UESP refusing the
request, the card still shows everything the row carries and simply stops there.

The card is placed beside the pointer rather than under it, flips to the other side near
a window edge, opens on keyboard focus as well as hover, and ignores the pointer entirely
so it can never steal the hover that opened it.

The game writes its own colour codes into item text (`|cffffff10|r` for a number in
white, `|r` to go back). They are read rather than printed, so the game's numbers keep
the colour the game gave them, link codes lose their link and keep their label, and a
code too dark to read on the dark panel is lifted towards white.

Item type, quality, trait and icon all come from the uploaded file; only the description
and set bonuses are looked up.

## Staying signed in

Sessions are stored in MariaDB (`itemshare_sessions`) rather than process memory, so a
restart or a redeploy no longer signs everybody out while their cookie still says
otherwise. The cookie lasts `SESSION_TTL_DAYS` (default 30) with rolling renewal, so
somebody who visits now and then never sees a login screen.

The avatar shows the provider's picture when there is one: Google's `picture` claim, or
Discord's avatar hash turned into a CDN URL (animated avatars keep their GIF form). Only
https URLs are stored, and if a picture stops loading the initials underneath show
instead, so the header never depends on a third party.

The only way out is the avatar menu in the header, which holds **Log out**. That posts to
`/logout`, which deletes the session row and clears the cookie. Without JavaScript the
form still submits.

Expired rows are pruned at startup and twice a day. If MariaDB is unreachable the session
layer reports "no session" instead of failing the request, so the page still renders its
database-error card rather than a blank screen.

## Live updates

The item list updates itself when somebody else uploads or a request changes. Socket.IO
runs on the same HTTP server as the site, under `/socket.io`.

The socket deliberately carries **no item data**: it only says "something you can see has
changed". Each open page then re-fetches `/items` - the same query the page was built
from, with its own session cookie - and swaps just that region into the page. Visibility
therefore stays in exactly one place (`lib/store.js`), and a mistake in the push path
cannot show another guild's items.

Uploads broadcast after the rows are committed, and again if new icons were fetched. The
icon backfill announces its own repairs, so a picture missing earlier appears without a
reload.

**Staying where you were.** A redraw that jumps to the top of the table is worse than a
stale row, so every row is marked with its stable `item_key_hash`
(`data-item-key="inv:…"`). Before the swap the page notes which row crosses a line about
a third of the way down the viewport and how far it sits from that line; after the swap
it finds the same row and scrolls by the difference. If that item was removed, the row
that moved up into its slot is used instead. If the change adds or removes an item type
or an owner, the filter controls would be out of date, so the page reloads and restores
the same row from session storage.

**One process.** The broadcast is in-process. Running several Node processes against the
same database needs a shared Socket.IO adapter (`@socket.io/mysql`), because an upload
handled by one process would otherwise never reach sockets held by another.

## Database tables

| Table | Purpose |
| --- | --- |
| `itemshare_schema_migrations` | Which migration files have been applied |
| `itemshare_uploads` | One row per import: account, file, item count, total quantity, person |
| `itemshare_accounts` | ESO account → person link, with the platform and megaserver the file reported |
| `itemshare_account_guilds` | Which guilds each ESO account belongs to, and on which world |
| `itemshare_users` | One row per person: display name, email, verified flag, avatar, and the ESO account they browse as |
| `itemshare_user_identities` | `(provider, provider_user_id)` → person, for Discord, Google and email |
| `itemshare_passwords` | one scrypt hash per person, for email and password sign-in |
| `itemshare_sessions` | Sign-in sessions, so they survive a restart |
| `itemshare_discord_users` | Legacy Discord profile table, superseded by `itemshare_users` |
| `itemshare_guilds` | Guild ID + world → name; a guild id is only unique within one megaserver |
| `itemshare_shared_items` | One row per shared item per character, with its captured details |
| `itemshare_shared_item_guilds` | Which guilds each shared item is offered to |
| `itemshare_always_share` | Standing offers: items the owner hands out whenever they have one |
| `itemshare_always_share_guilds` | Which guilds each standing offer is shown in |
| `itemshare_requests` | Who asked for what, how many, and how it ended |
| `itemshare_request_drafts` | The basket: picked but not yet sent, with its deadline |
| `itemshare_item_icons` | Cached PNG bytes per icon path, fetched once from UESP |
| `itemshare_item_tips` | Cached description and set bonuses per item |

`itemshare_shared_items` and `itemshare_always_share` both carry `held_quantity` and
`reserve_quantity`: what was in the bag and what the owner keeps back. `item_count` stays
what is actually on offer, so every OFFERED/RESERVED/AVAILABLE calculation is unaffected by
a reserve.

A guild id and its world are the stable identity; names are display only, because names
are neither unique nor stable.

Each captured item also keeps the raw scalar results of every getter that answered, in
the `eso_data` JSON column, keyed by getter name:

```json
{"GetItemLinkSetInfo": [true, "Briarheart", 5, 3, 5], "GetItemLinkRequiredLevel": [50]}
```

So detail the site does not render yet is already stored and can be surfaced later
without asking anyone to upload again.

## Email addresses

Discord sign-in requests `identify` and `email`; Google requests `openid email profile`.
Either way the address lands in `itemshare_users.email` with the provider's own verified
flag, refreshed at every sign-in so it stays correct if somebody changes it.

The address is personal data and is only ever read server-side. It is shown back to its
own owner on the page and never included in item lists or any other member's view.
`lib/store.js` is where an address is looked up, and nowhere else reads it:
`getOwnerContacts` maps the ESO accounts named in a basket to the person who owns each of
them, one entry per account, and `getRequesterNotifications` reads the asker's own address
for an answer email.

## Commands

Every command runs from this folder, through the scripts in `package.json`. Flags go
after `--`, because npm would otherwise swallow them:

```bash
npm run simulate -- --rounds 12
```

| Command | Runs | Needs MariaDB | Needs the site running |
| --- | --- | --- | --- |
| `npm start` | `server.js` | boots without it and shows the error | - |
| `npm run backfill` | `backfillIcons.js` | yes | no |
| `npm run seed:demo` | `seedDemo.js` | yes | no |
| `npm run requests:reopen` | `reopenRequests.js` | yes | no |
| `npm run simulate` | `simulate.js` | yes | only for live pushes |
| `npm run email:test` | `testEmail.js` | no | no |

`--help` / `-h` is implemented by `backfillIcons.js` only; the rest print their usage in
the file header and take the flags documented below.

### npm start

No flags. Everything it reads comes from `.env` - see *Settings* and `.env.example`.

### npm run backfill

Retries item icons that an upload could not resolve, running the same pass the site's own
timer runs. Reads `.env` by absolute path exactly like the site, so it works from any
directory.

| Flag | Meaning |
| --- | --- |
| `--dry-run` | List the item ids missing an icon and change nothing |
| `--id <itemId>` | Ask UESP about one item id and print the icon it finds. Opens no database at all |
| `--limit <n>` | Item ids per pass. Default `20`, silently capped at `200` |
| `--passes <n>` | How many batches to run in this invocation. Default `1`, capped at `50` |
| `--help`, `-h` | Print usage and exit |

```bash
node backfillIcons.js --dry-run                 # what lacks an icon, changes nothing
node backfillIcons.js --limit 20 --passes 5     # up to 100 ids in one go
node backfillIcons.js --id 223698               # does UESP know this item?
```

`--limit` is the per-pass ceiling, the same one `ICON_BACKFILL_BATCH` sets for the
timer; `--passes` is how many of those to run back to back. `--id` is the quickest way
to tell a refused lookup from a page that no longer embeds the image, because it touches
neither the database nor the cache.

### npm run seed:demo

Puts a demo guildmate in your guilds, so *Request* has rows before a second person
really uploads. A saved variables file cannot do this: every account in an uploaded file
is linked to whoever uploaded it, so a "second person" from a file would be you.

| Flag | Meaning |
| --- | --- |
| `--account @Name` | Only seed into the guilds that ESO account belongs to |
| `--guild <guildId>` | Only seed into that one numeric guild id |
| `--remove` | Take `@DemoTrader` and everything it shared out again |

```bash
npm run seed:demo                      # into every guild you are in
npm run seed:demo -- --account @Name   # only that account's guilds
npm run seed:demo -- --guild 761817    # only that guild
npm run seed:demo -- --remove          # take the demo rows out again
```

`--account` and `--guild` combine as an AND, so both can be given to narrow further.
Without either, every guild already in the database is used.

`@DemoTrader` is never linked to anybody, which is the point - its items appear under
*Request* for anyone sharing a guild with it, exactly like a real guildmate's would.
It seeds 9 shared items and 3 standing offers, and everything it writes is labelled
`@DemoTrader` and removable.

The command prints the guilds it used, every shared item with set, quality, trait,
quantity and location, and every standing offer, so nothing has to be inferred from the
site afterwards. It exits non-zero with an explanation if there are no guilds to seed
into - upload your own file first, since the demo account shares into guilds that
already exist rather than inventing any.

### npm run requests:reopen

Puts requests whose hold ran out back into the requester's basket. A request starts as a
`draft` that holds part of a stack, and the site's sweeper marks it `expired` when its
deadline passes; that row was never sent, so no owner was ever told about it. By default
reopening it holds the copies again and puts it back under *In your basket*, where **Send
requests** is, and nothing is asked of the owner until they press it. `--pending` files it
as a sent request instead: it counts against the owner's stack and waits in their list
exactly as a submitted basket would, but no email goes out, which is the point when the
owner already knows and the site just needs to catch up.

| Flag | Meaning |
| --- | --- |
| `--all` | Every expired request in the database |
| `--id <n>` | One request id. Repeat it, or comma-separate: `--id 12,13` |
| `--email <address>` | Only that person's requests |
| `--account <@Name>` | Only requests asked from that ESO account |
| `--item <text>` | Only items whose name contains this text |
| `--basket` | Back in the requester's basket, held for `--minutes`. The default |
| `--pending` | Filed as a sent request: waits in the owner's list, no email sent |
| `--minutes <n>` | How long the reopened hold lasts. Default `5`, at most `120` |
| `--limit <n>` | Stop after `n` requests |
| `--dry-run` | Say what would be reopened, write nothing |
| `--help`, `-h` | Print usage and exit |

```bash
npm run requests:reopen -- --dry-run --all                 # what expired, changes nothing
npm run requests:reopen -- --email someone@example.com     # just that person's
npm run requests:reopen -- --account @Ghost --item dagger  # narrower still
npm run requests:reopen -- --id 128,129 --minutes 30       # two rows, half an hour
npm run requests:reopen -- --pending --email someone@example.com   # make it real, quietly
```

`--pending` changes what the owner knows. Without it the row is a basket entry the person
can still drop; with it the request is in the owner's list and counts against their stack
the moment the command runs, and only they can answer it. Neither path emails anybody - the
notification is the site's job when a basket is submitted - so a pending row is found the
next time the owner opens their list.

A run with no scope flag changes nothing and exits `2`, because "everything expired" is a
dangerous thing to type by accident. Every row is measured against what is free *now* - a
stack can come back smaller, or somebody else can hold the copies - so a row that no longer
fits is listed with its reason and left alone, and one that only partly fits comes back
with the copies that are really there. Exit codes: `0` reopened (or a dry run that found
something), `1` nothing matched or everything was skipped, `2` usage.

The command pushes nothing, so an open page shows the new hold on its next refresh - the
basket and the "already asked for" counts are read from the tables each time.

### npm run simulate

Drives three made-up people through the same store code the site uses, so a list with
one real owner has traffic on it. Every scenario a request can go through happens for
real in the database, one at a time:

- **asking** - something a guildmate has spare goes into their basket, on the same clock;
  anybody visible is fair game, the other simulated people included, not just you
- **sending** - the basket is committed, the moment a real person's send would email you;
  the log says who *would* have been emailed instead of sending anything
- **answering** - an ask waiting on a simulated person's own items is sent, part sent or
  refused, through the same code the signed-in list uses, so a requester's history shows
  a handover instead of asking for ever
- **cancelling** - either a request already waiting, or one taken back out of the basket
- **timing out** - the basket's deadline is pushed past, and the site's own sweeper runs
- **re-saving** - items move between bags, bank and furnishing vault, stacks change and
  pending requests are re-settled against the new file; logged as `<name> Inventory
  Refreshed` with where each item landed

| Flag | Meaning |
| --- | --- |
| `--every <ms>` | Fixed pause between actions in milliseconds. Left out, each wait is picked fresh from 5 to 60 seconds. `0` runs with no pause |
| `--rounds <n>` | Stop after `n` actions instead of running until interrupted |
| `--once` | Exactly one action, then exit. Implies no pause |
| `--only <kind>` | Restrict to one kind of action: `requests` (asking, sending, answering, cancelling, timing out) or `items` (just re-saving files) |
| `--reset` | Remove the simulated people and all their data, then exit |
| `--url <address>` | The site to ask for the live push. Defaults to `BASE_URL`, falling back to `http://127.0.0.1:<PORT>`. A missing `http://` is filled in |

```bash
npm run simulate                        # until Ctrl+C, one action every 30s
npm run simulate -- --every 4000        # one action every four seconds
npm run simulate -- --rounds 12         # stop after twelve actions
npm run simulate -- --once              # exactly one action, then exit
npm run simulate -- --only requests     # asking, sending, cancelling, timing out
npm run simulate -- --only items        # just re-saving files
npm run simulate -- --reset             # remove the simulated people and their data
npm run simulate -- --url https://itemshare.example.com   # notify that site instead
```

Without `--rounds` or `--once` it keeps going until Ctrl+C, waiting a random five to sixty
seconds between actions so the traffic does not arrive on a metronome. `--every` fixes that
wait when a run needs a steady beat, and `--once` never pauses at all.

Set `SIMULATE_TOKEN` in `.env` and restart the site to have open pages refresh as it
runs; without it the data still changes and you see it on the next refresh. Either way
the simulator prints only what it did: how many browsers received the push is the site's
detail, because the site is the one holding the connections.

Before the first action the simulator asks the site whether it will accept the token
(`POST /simulate/check`, the same check the nudge uses, pushing nothing) and prints one
line either way. Both processes hash the token with the same function
(`lib/simulateToken.js`), so the two fingerprints can always be compared:

- **`live pushes armed ... the site holds the same one`** - same token, nothing to do.
- **`refused ... this run holds 7229d63d, that site holds 4b1f0e93`** - two different
  tokens (HTTP 403). The site reads `SIMULATE_TOKEN` from its own `.env` when it starts,
  so a token set on the machine running the simulator does nothing unless that same site
  was restarted holding it.
- **`refused ... that site has no SIMULATE_TOKEN at all`** - HTTP 404 with
  `token-not-set`: a different `.env`, or a site started before the token was added.
- **`refused ... (HTTP 404): nothing answers the simulate route there`** - that address is
  not this ItemShare (check `BASE_URL` or `--url`), or the site predates this check.

The site's answer to a refusal is JSON carrying the fingerprint it holds and never the
token, and its own log line names both fingerprints, so the comparison works from either
end. The simulator also catches the quiet case where `dotenv` ignored `.env` because the
variable was already exported in the shell.

The site says the same thing about itself at start-up - which token it holds, when it read
it, and from which file:

```
Live pushes: on - this site holds 4b1f0e93, loaded at 2026-11-05 17:20:31 UTC from /srv/itemshare/.env
Live pushes: off - no SIMULATE_TOKEN in /srv/itemshare/.env when this site started at 2026-11-05 17:20:31 UTC; set one and restart to let npm run simulate refresh open pages
```

If `.env` is edited while the site is running, the next refused nudge says so instead of
leaving you to wonder why the value on disk does not work: *`.env now holds 7229d63d, and
this process loaded 4b1f0e93 at ... - the file changed afterwards, so restart the site`*.
A token exported in the shell is reported as coming from the environment rather than from
the file, because that is where the running value actually came from.

The address it asks is `BASE_URL`, the same value the site builds its own links and
sign-in redirects from, so a reverse proxy, another port or another host needs no extra
setting - and if `BASE_URL` is unset it falls back to `http://127.0.0.1:$PORT`. `BASE_URL`
wins over `PORT`, so a site that moved port must have its `BASE_URL` updated too; the
`Live pushes:` line says which of the two the run is using. Use
`--url` to point one run at a different site, for instance when casing a staging copy.
The three people are identified by a `simulator` identity, so they are the same people on
every run, and `--reset` takes all of them out again.

Their activity appears in the log as a sentence rather than a revision number:

```
[SIMULATE] 19:42:08 @DemoTrader asked @YourAccount for 2 x Soul Gem (still in their basket)
Live: [SIMULATE] @DemoTrader asked @YourAccount for 2 x Soul Gem - 1 open page told to refresh

[SIMULATE] 19:42:38 @NightMarket cancelled their request for 2 x Dwemer Frame before it was sent

[SIMULATE] 19:42:53 @QuietSmith sent 2 x Alinor Bookshelf, Grand to @DemoTrader

[SIMULATE] 19:43:08 @QuietSmith let the basket clock run out, so Alinor Bookshelf, Grand went back to being available

[SIMULATE] 19:43:38 @QuietSmith Inventory Refreshed - 3 items: 2 in Bank, 1 in Furnishing Vault
```

Every line the simulator prints starts with `[SIMULATE]`, and so does anything the site
pushes because of it, so a simulated handover is never mistaken for one that happened. An
action that found nothing to do - no free stock, an empty basket - prints nothing at all
and announces nothing: a line about a no-op made the log look busier than the site was.

The `Live:` line is the site's own and carries the delivery detail - `- 1 open page told
to refresh`, or `- no pages open, so nothing was pushed` - because the site is what holds
the connections. It says nothing about how many people use the site; closing the page
drops it to zero. The simulator does not repeat it: it prints the action and moves on.

The simulator never sends mail - the email module is only reached from the site's own send
route - so a simulated send changes the data and says who would have been emailed.
Handing an item over in game is not recorded, so nothing here moves a request from
*Requested* to *Fulfilled*.

### npm run email:test

Sends one request email through exactly the configuration the site uses - `EMAIL_FROM`,
`EMAIL_TRANSPORT`, `SENDMAIL_PATH`, `RESEND_API_KEY` and `EMAIL_OVERRIDE_TO`. It prints the
transport, sender and subject first - and the redirect, when an override is set, because
the address on the command line is then not where the message goes - then the result, and
it sends a two-item sample message so the quality colours and detail lines can be seen in
a real inbox.

The address is a plain argument, not a flag, and it must contain an `@`:

```bash
npm run email:test -- you@example.com
node testEmail.js you@example.com
```

A second, optional argument picks which message is sent: `request` (the default, what an
owner receives), `fulfilled`, `cancelled`, or `answer` for both outcomes in one message -
the mixed case, with a partial handover beside a refusal:

```bash
npm run email:test -- you@example.com answer
```

It opens no database connection and changes nothing, so it separates "the mail server
works" from "the site is configured": if it says the message was handed over and nothing
arrives, the problem is the MTA's queue or DNS, not ItemShare. It exits `0` when the
message was accepted, `1` when email is not configured or the transport refused it, and
`2` on a missing or malformed address.

`npm run email:preview` renders that same message to files instead of sending it:
`email-preview.html` and `email-preview.txt` (the plain-text part), or whatever name you
give it - `node previewEmail.js out.html`. Open the HTML in a browser to see the layout,
the quality colours and the answer link an owner receives. The link is built from
`BASE_URL`; with that unset the command says so and `itemshare.example` stands in, so the
whole message can still be seen. Nothing is sent, no mail transport is needed and no
database is opened, so a change to the message can be checked on a machine that cannot
send mail at all.

## Deploying on a Linux host

What a real host needs: Node 20 or newer, MariaDB, and optionally a mail server for the
request emails. Nothing else - no build step, no bundler, no front-end toolchain.

**1. Code and dependencies.**

```bash
sudo useradd --system --home /opt/itemshare --shell /usr/sbin/nologin itemshare
sudo mkdir -p /opt/itemshare && sudo chown itemshare: /opt/itemshare
git clone <this repository> /opt/itemshare
cd /opt/itemshare
npm ci
```

**2. The database account.** Run once as root on the MariaDB server. `ALL` on
`itemshare.*` includes the CREATE the first boot needs to make the database itself:

```sql
CREATE USER 'itemshare'@'localhost' IDENTIFIED BY 'a-long-password';
GRANT ALL PRIVILEGES ON itemshare.* TO 'itemshare'@'localhost';
FLUSH PRIVILEGES;
```

**3. Settings.**

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 32        # paste into SESSION_SECRET
```

Then edit it: `MARIADB_USER`, `MARIADB_PASSWORD`, `BASE_URL` (the public https address),
`SESSION_SECRET`, and the provider ids if you want sign-in. Leave the email settings
blank until step 6.

**4. Run it as a service.** `/etc/systemd/system/itemshare.service`:

```ini
[Unit]
Description=ItemShare web application
After=network.target mariadb.service

[Service]
Type=simple
User=itemshare
WorkingDirectory=/opt/itemshare
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now itemshare
journalctl -u itemshare -f
```

Use `command -v node` for `ExecStart`: it is `/usr/bin/node` for a distro package and
something else for nvm or a tarball install. Running from `WorkingDirectory` is enough -
the server finds `.env` and `migrations/` by its own path. On boot the log names the
migrations it applied and then `ItemShare upload site listening on ...`.

Setting `NODE_ENV` changes nothing here; the site does not read it.

**5. Put it behind TLS.** The site speaks plain HTTP on `PORT`; terminate TLS at a proxy.
A minimal nginx site (the single location covers the live-update socket):

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 16m;   # uploads are capped at 12 MB
}
```

Set `BASE_URL` to that https address and restart, or the sign-in redirect URI and the
links in request emails will point at localhost.

**6. Add email when you are ready.** Requests work before this: they are recorded, and
the log says they were not sent. See *Request emails* and `.env.example`. Nothing else
changes - no code, no migrations, no dependency.

**7. Updating.**

```bash
cd /opt/itemshare
git pull
npm ci
sudo systemctl restart itemshare      # applies any new migrations on boot
```

**8. Backups.** Everything is in one database:

```bash
mysqldump itemshare > itemshare-$(date +%F).sql
```

Uploads are never stored on disk - a saved variables file is parsed and the rows are
kept - so a database dump is the whole backup.

**After deploying, check:** the page loads over https, a sign-in round trip completes, an
upload lands, the Request tab shows items, picking one shows the basket clock, sending it
appears in *Your requests* with a send time, and
`SELECT filename FROM itemshare_schema_migrations;` lists migrations through `019`, an owner
answers their request email, and the requester's list says what was handed over.

## Troubleshooting

**A setting is "in there" but has no effect.** Startup prints the `.env` file it actually
read. The usual cause is a file in the wrong place - a `.env` above this folder, or a
Windows editor that saved it as `.env.txt`.

**`SESSION_SECRET is not set ... using an ephemeral secret`** - there is no `.env` here, or
the key is missing from it. Every restart invalidates existing sessions. Make one and
paste the printed line in:

```bash
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

**`Server requests authentication using unknown plugin auth_gssapi_client`** - the MariaDB
account is configured for Kerberos/GSSAPI, which `mysql2` cannot use. On the MariaDB host,
as an administrator, give it an ordinary password login:

```sql
SELECT user, host, plugin FROM mysql.user WHERE user = 'itemshare';
ALTER USER 'itemshare'@'%' IDENTIFIED VIA mysql_native_password USING PASSWORD('the-password-from-.env');
FLUSH PRIVILEGES;
```

Leave the password inside `PASSWORD(...)` as the plain text one from `.env`; MariaDB hashes
it. If `Access denied for user ...` comes back instead, the plugin is fine and the password
or the host grant is wrong - check that the account may connect from this machine's
address, not just `localhost`.

**`Sign-in providers: none`** - `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` (or the
`GOOGLE_*` pair) are empty. Discord also needs the callback registered under
**OAuth2 → Redirects**, and it must be the same URL the browser is sent to.

**People are listed with no items.** Nothing is visible without a guild overlap. Upload
once so the account and its guilds are known; `npm run seed:demo` gives the Request tab
something in it before a second person uploads.

**`Email: N request emails not sent`** - no transport, or mail turned off. `EMAIL_FROM` is
blank, `EMAIL_TRANSPORT=none` is set, or there is neither a `sendmail` on the host nor a
`RESEND_API_KEY`. `npm run email:test -- you@example.com` reports which, including an
`EMAIL_OVERRIDE_TO` that is not an address.

## Answering a request

A request email is a note, not a form: the names asked for, how many of each, the ESO name
to mail them to, and one link at the end. Gmail and several other webmail clients strip
`<form>` elements out of HTML, so a Save button inside the message did nothing when it was
pressed - the answer was lost with no error shown. Nothing in the message is submitted any
more, and no number in it is editable.

The link goes straight to `/requests/fulfill/:token`, the page that answers this message:
no sign-in, no dashboard, nothing to search for. The owner sets a row to what actually
left their bag, saves it, and `0` means nothing was sent from that row - which cancels it.

A message is rarely answered in one go - half a stack today, the rest next week - so each
row is submitted on its own. Saving one row records only that row: the others stay
pending, and the same link answers them later.

- Each row saves on `/requests/fulfill/:token`, one row at a time. The token is
  unguessable, stored only as a SHA-256 hash, and expires after 30 days. It is cleared from
  the rows it answers, so the link keeps working for the rest of the message and stops
  working for a row already recorded - a double click or a link a mail client prefetched
  changes nothing.
- A **Save** button on that page posts that row's `row` and `quantity`. A page opened
  before per-row saving still works: `quantity_<id>` fields are read the same way.
- GET shows the page and POST records a row. A mail client is never trusted with a form,
  so this page is the only way a message gets answered.
- The same answering is **Process Requests**, reachable from the account menu. It opens as
  a modal over the item list rather than replacing it, so answering costs one small
  request and the list underneath is still where it was; Escape, the large white close
  in the corner or a click outside it puts it away. `/owner/requests` is still a whole
  page for a bookmark or a direct visit, and the modal fetches the same card as a
  fragment, so the two cannot drift apart. It lists what is waiting on the person's own
  ESO accounts, oldest ask first, and answers a row before returning the list, so what
  was just answered disappears instead of being answerable twice.
- **One row per item, however many times it was asked for.** Two, then two more, then one
  is a page row reading **Requested 5**, because that is one conversation. The database
  rows stay separate: the number you send is spent on the oldest asks first, so 3 against
  5 closes two of them and leaves the third waiting. Rows with no usable item id are
  never merged.
- The row carries what the requester needs to send the right copy: the item's type, its
  **trait** and its **enchantment** when the shared file has them, under the name.
- The time is when the ask arrived, on the clock of the machine running the site and in
  its own date order; a grouped row shows the oldest ask, and its tooltip names the newest.
- **Fulfilled** (green) records the number in the box as mailed. **Not fulfilled** (red)
  is the same form saved as `0`: nothing was sent, so the request is cancelled with the
  owner's reason on it. Both sit beside the number rather than under it. The page a
  request email links to calls the green button **Save**, because there it is a save of
  that row rather than a claim about the whole stack.
- **Requested** is the total asked for; **Amount Sent** is the number the owner typed.
- The number sent becomes the request's `quantity` and the row is marked `fulfilled`. What
  was asked for stays in `quantity_requested`, so a short handover reads "4 of 10" in the
  requester's history instead of looking complete.
- Free copies are `item_count - outstanding requests - copies mailed since the owner's last
  upload`. That last term is why a handover shows up at once, and why it is not subtracted
  twice: the next upload's own count already leaves those copies out.
- **An upload never rewrites an item that still has an open request on it.** The file was
  written before the owner answered, so its count no longer describes the bag those copies
  will leave; taking it would re-offer what is promised and could cancel a request that is
  answerable. The row keeps the numbers it had, everything else in the file refreshes, and
  the upload says so: *Pending requests for Soul Gem (2), so its inventory was not refreshed.*
  Answer the requests, upload again, and the new count arrives.

`npm run test:fulfillment` walks exactly that sequence against a real database: it runs
every migration, shares ten copies, asks for three, answers "two sent", then uploads eight
and checks the free count at each step. The last stage gives one message two rows of
different items, answers one of them, and checks that the other stays pending and holding
its copy, that saving the answered row again changes nothing, and that the link only stops
working once every row has been answered. Its last stage asks for one item three times,
checks the owner's page lists that as one row of five, sends three of them and checks the
oldest two are closed while the third still waits, then cancels what is left with the Not
fulfilled answer. It drops and rebuilds its database first, so
`ITEMSHARE_DATABASE` has to end in `_test` (`itemshare_test` by default).

It needs a reachable MariaDB; without one it stops before touching anything and says so.

### Demo mode, and what has to happen before anything is shown

The site is readable only after signing in, with any of the three ways in: Discord,
Google, or an email address and a password. `/` answers a signed-out visitor with the
sign-in page and nothing else, and `/items` answers 401, so the list, the filters and the
counts cannot be read before the site can name who is looking.

After signing in, the item list appears once the person has at least one ESO account -
from their own upload, or a name attached by hand in the **ESO accounts** dialog. Until
then the page is the upload box, because there are no guilds to compare against and the
only useful thing is the file that supplies them.

`demo@example.com` with the password `demo` is a sign-in that needs neither. It is a real person row with
`itemshare_users.is_demo = 1`, one ESO account (`@ItemShareDemo`), one guild -
**Alphabet Mafia** on PC / NA Megaserver - and the curated catalogue in
`lib/demoItems.js` shared with it. It is created at startup, and again on a demo sign-in
if it is missing, so a fresh database already has it. The address on it is
`demo@example.com`, on the reserved documentation domain, and creating an ordinary
account with that address is refused, so nobody can take it over.

The demo has its own MariaDB database, `itemshare-demo`, dropped and rebuilt at every
startup from the same migrations as the real one. It is then filled with a copy of the
site's own rows - guilds, accounts, shared items, offers, requests - with every person
anonymised on the way in (`Member 7`, `member7@itemshare.invalid`) and every copied
password and sign-in identity deleted, so nobody can sign in as a real person and no
address can be read. The curated `Alphabet Mafia` guild is seeded on top, so the demo
always has something familiar in it. Its schema cannot drift from the site's, and the next
visitor always gets the curated demo rather than the leftovers of somebody's session - a
restart is also how you reset it. A demo session reads that copy instead of the live
rows, and nothing it does can reach them; signing in as anybody else switches back to
`ITEMSHARE_DATABASE` on the next request. Sessions stay in the real database, because a
session has to be read before the site knows who is asking. The database account needs
CREATE and DROP on `itemshare-demo`, the privilege it already uses to make the real
database.

The demo is a sandbox rather than a preview: reserving, cancelling, sending a basket,
answering a request and adding or removing accounts all really happen, inside the copy,
which is why the counts move for the demo visitor and never for anybody else. Nothing is
announced to other people's open pages. No email is sent from the demo at all - a sent
basket is recorded and the owners are told nothing - and the password cannot be reset:
the reset request is refused before any link is made, and `demo@example.com` can never
receive mail. Uploading stays switched off: the drop zone is still on the page, but
the card says so and the page script shows that sentence instead of sending the file. A
banner says the same on every page.

## Not done yet

**`declined`.** A request the owner cannot fill is recorded as `cancelled` with the
owner's reason on it, so the `declined` status in the enum is still unused. Nothing
depends on it.

**Surfacing stored detail.** The `eso_data` column holds getters the site does not render
yet (required level, champion points, style among them). They are captured and stored,
and nothing shows them.

