# ItemShare database and upload site

This folder turns `ItemShareSavedVars.lua` into rows in MariaDB, either from the
website or from the command line.

ItemShare always uses its own database (`itemshare` by default). It never reads
`MARIADB_DATABASE`, so it cannot write into the GuildSync schema even though both
live on the same MariaDB server.

## Setup

```bash
cd Database
npm install
cp .env.example .env      # MariaDB credentials, session secret, Discord app
npm start                 # http://localhost:3000
```

## Startup and migrations

On startup the site:

1. connects to MariaDB using the settings below (the database itself is **not**
   selected yet, so it can be created);
2. runs `CREATE DATABASE IF NOT EXISTS` for `ITEMSHARE_DATABASE`;
3. applies every `.sql` file in `migrations/` that has not been applied before.

Applied files are recorded in `itemshare_schema_migrations`, so each one runs
exactly once. To add a migration later, drop a new file in `migrations/` with a
sortable name (`004_add_requests.sql`) and restart: it will be applied on the
next boot and never again. Recorded migrations are not re-run, so they no longer
need to be idempotent, though `CREATE TABLE IF NOT EXISTS` is still a good habit.

If the database is unreachable at startup the site still boots, logs the reason,
and shows the error on the page instead of crashing. Connections made per request
connect directly to the existing database rather than re-running migrations.

## Settings

All of these live in `Database/.env` (see `.env.example`); every one has a
default, so the site runs without a `.env` on a local root/no-password server.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MARIADB_HOST` | `127.0.0.1` | MariaDB host |
| `MARIADB_PORT` | `3306` | MariaDB port |
| `MARIADB_USER` | `root` | Account used for connections |
| `MARIADB_PASSWORD` | empty | Password for that account |
| `ITEMSHARE_DATABASE` | `itemshare` | **ItemShare's own database**, created if missing. `MARIADB_DATABASE` is deliberately ignored so the GuildSync schema can never be touched |
| `PORT` | `3000` | Web port |
| `SESSION_SECRET` | random per boot | Signs the session cookie; set it so logins survive a restart |
| `DISCORD_CLIENT_ID` | empty | Discord application ID |
| `DISCORD_CLIENT_SECRET` | empty | Discord application secret |
| `DISCORD_REDIRECT_URI` | `$BASE_URL/auth/discord/callback` | Must match the Discord app's redirect |
| `GOOGLE_CLIENT_ID` | empty | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | empty | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | `$BASE_URL/auth/google/callback` | Must match the Google client's redirect URI |
| `BASE_URL` | `http://localhost:$PORT` | Public address used to build the default redirect URIs and the email's site link |
| `SESSION_TTL_DAYS` | `30` | How long a sign-in lasts |
| `REQUEST_HOLD_MINUTES` | `5` | How long a picked item is held before it goes back |
| `REQUEST_SWEEP_INTERVAL_MS` | `10000` | How often lapsed baskets are released |
| `SIMULATE_TOKEN` | empty | Lets `npm run simulate` push live updates to open pages |
| `INGEST_TOKEN` | empty | Shared token a watched saved-variables file is posted with; blank keeps automatic uploads off |
| `EMAIL_FROM` | empty | Sender address for request emails; blank disables sending |
| `EMAIL_TRANSPORT` | automatic | `sendmail`, `resend` or `none` |
| `SENDMAIL_PATH` | automatic | Where the host's `sendmail` is |
| `RESEND_API_KEY` | empty | Only for hosts without a local mail server |
| `ICON_BACKFILL_INTERVAL_MS` | `1800000` | How often missing icons are retried |
| `ICON_BACKFILL_BATCH` | `20` | How many item ids one retry pass may look up |

The MariaDB account needs CREATE privileges on first run (to create the database
and `itemshare_*` tables). After that, ordinary read/write is enough.

## Deploying it on a Linux host

What a real host needs: Node 20 or newer, MariaDB, and (later, if you want the
request emails) a mail server. Nothing else - no build step, no bundler, no
front-end toolchain.

**1. Get the code and dependencies.**

```bash
sudo useradd --system --home /opt/itemshare --shell /usr/sbin/nologin itemshare
sudo mkdir -p /opt/itemshare && sudo chown itemshare: /opt/itemshare
git clone https://github.com/skperdue68/ItemShare.git /opt/itemshare
cd /opt/itemshare/Database
npm ci                      # from package-lock.json; no global tools needed
```

**2. Make the database account.** Run this once as root on the MariaDB server;
`ALL` on `itemshare.*` includes the CREATE the first boot needs to make the
database itself:

```sql
CREATE USER 'itemshare'@'localhost' IDENTIFIED BY 'a-long-password';
GRANT ALL PRIVILEGES ON itemshare.* TO 'itemshare'@'localhost';
FLUSH PRIVILEGES;
```

**3. Write `.env`.**

```bash
cd /opt/itemshare/Database
cp .env.example .env
chmod 600 .env
openssl rand -hex 32        # paste into SESSION_SECRET
```

Then edit it: `MARIADB_USER`, `MARIADB_PASSWORD`, `BASE_URL` (the public https
address), `SESSION_SECRET`, and the provider ids if you want sign-in. Leave the
email settings blank for now - see step 6.

**4. Run it as a service.** `/etc/systemd/system/itemshare.service`:

```ini
[Unit]
Description=ItemShare upload site
After=network.target mariadb.service

[Service]
Type=simple
User=itemshare
WorkingDirectory=/opt/itemshare/Database
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now itemshare
journalctl -u itemshare -f
```

Use `command -v node` for `ExecStart`; it is `/usr/bin/node` for a distro package
and something else for nvm or a tarball install. On boot the log should name the
migrations it applied (`013_itemshare_request_details.sql`, `014_itemshare_item_tips.sql`,
`015_itemshare_request_enchant.sql`) and then `ItemShare upload site listening on ...`.

**5. Put it behind TLS.** The site speaks plain HTTP on `PORT`; terminate TLS at a
proxy. A minimal nginx site (the single location covers the live-update socket):

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

Set `BASE_URL` to that https address and restart, or the sign-in redirect URI and
the email's link will point at localhost.

**6. Add the email when you are ready.** Requests work before this: they are
recorded, and the log says `Email: N request emails not sent - set EMAIL_FROM ...`.
On the host, give the machine a mail server (`sudo apt install postfix`, or `msmtp`
configured to relay), check it with
`echo test | sendmail -t you@example.com`, then set `EMAIL_FROM` to an address that
server may send as and `sudo systemctl restart itemshare`. Nothing else changes: no
code, no migrations, no dependency. If the host cannot send mail directly (port 25
blocked, or this is Windows), set `RESEND_API_KEY` and an `EMAIL_FROM` on a domain
verified in Resend instead, optionally with `EMAIL_TRANSPORT=resend`.

**7. Optional companions.**

- `npm run simulate` in a second terminal (or another unit) keeps a few fake people
  browsing; set `SIMULATE_TOKEN` first so open pages refresh live.
- `npm run seed:demo` puts a demo guildmate in the list without a second upload.
- `npm run backfill` retries item icons by hand; the site does it on a timer too.

**8. Updating.**

```bash
cd /opt/itemshare
git pull
cd Database && npm ci
sudo systemctl restart itemshare      # applies any new migrations on boot
```

**9. Backups.** Everything is in one database: `mysqldump itemshare > itemshare-$(date +%F).sql`.
Uploads themselves are not stored on disk - a saved variables file is parsed and
the rows are kept, so the database dump is the whole backup.

**After deploying, check:** the page loads over https, a sign-in round trip
completes, an upload lands, the Request tab shows items, picking one shows the
basket clock, sending it appears in *Your requests* with a send time, and
`SELECT filename FROM itemshare_schema_migrations;` lists migrations through `015`.

### Sign-in providers (optional, either or both)

**Discord**

1. Create an application at <https://discord.com/developers/applications>.
2. Under **OAuth2**, add the redirect URL `http://localhost:3000/auth/discord/callback`
   (change the host/port if you run the site elsewhere).
3. Copy the Client ID and Client Secret into `.env` as `DISCORD_CLIENT_ID` and
   `DISCORD_CLIENT_SECRET`, and set `DISCORD_REDIRECT_URI` to the same URL.

**Google**

1. Create an OAuth client at <https://console.cloud.google.com/apis/credentials>
   (type *Web application*).
2. Add `http://localhost:3000/auth/google/callback` under **Authorised redirect
   URIs**.
3. Copy the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`, and set `GOOGLE_REDIRECT_URI` to the same URL.

Google returns the person's name, email address and whether that address is
verified, so it supplies everything the site stores for Discord. Both providers
give a stable numeric/opaque subject id, which is what identifies the login.

Each provider is independent: configuring one shows only that button, configuring
both shows two. With neither, the site still accepts uploads, but nothing is
linked to a person and uploads are anonymous.

**One person, either button.** Identities live in `itemshare_user_identities` and
point at a row in `itemshare_users`. When someone signs in with a provider for the
first time and that provider reports a *verified* email already known to another
identity, the new identity joins the existing person instead of creating a second
empty one. That way the ESO accounts linked through Discord stay visible after
signing in with Google. Unverified addresses are never used to merge people.

## How an upload behaves

- The ESO account names are read from the file itself, so there is nothing to type.
  Every account in the file is imported: all of them are linked to the same Discord
  user, and each one keeps its own item list and guild membership. Either every
  account is replaced or, if anything fails, none of them are.
- Item rows keep the account they came from (`itemshare_shared_items.account_name`),
  so a member who plays several ESO accounts can see which account holds each item.
- ItemShare 1.4.0 also saves the item id and the game's icon path for each entry,
  which is what feeds the thumbnails and the UESP links. Files from older versions
  import fine; those rows simply carry no icon until they are uploaded again.
- An upload **fills in, then prunes**. Every item in the file is written where it
  already stands - same row, same id, same first-seen date - and only afterwards are
  the rows the file no longer mentions deleted. Nothing blinks out of the list
  between one upload and the next, and anything pointing at a row (a guild link, an
  open request) keeps pointing at it. Un-sharing an item in game and re-uploading
  still removes it here. The mark the prune uses is `upload_id`: everything the file
  mentions is stamped with the new upload, so a row still holding an older id was
  not in this file. All of it happens in one transaction.
- Quantity is stored per item in `item_count`, and the upload total in
  `itemshare_uploads.total_quantity`.
- The first upload from a signed-in person links their identity to the ESO
  account in `itemshare_accounts`. If the ESO account is already linked to a
  different person the upload is refused rather than silently reassigned.
- Guild membership is replaced in full as well (`itemshare_account_guilds`), so
  leaving a guild in game removes that guild's visibility after the next upload.

## Automatic uploads from GuildSync (file watch)

GuildSync runs on the same machine as the game, so it can notice
`SavedVariables/ItemShareSavedVars.lua` being written and send it here without anyone
opening the upload page. ESO writes that file on every save and the addon fills it
during play, so the site ends up as current as the last save.

The watching belongs in GuildSync, not here: it owns the stored on/off setting, the
debounce and the line in its log saying what it sent. This site only has to accept
the file, which it does on `POST /ingest`.

### Turning it on here

1. Make a token: `openssl rand -hex 32`
2. Put it in `Database/.env` as `INGEST_TOKEN=<that string>` and restart the site.
   With it blank the endpoint answers `503` and nothing else about the site changes.
3. Put the same string in GuildSync, next to the on/off switch.

The endpoint takes the file's **contents** in the request body, not a multipart form:

```bash
curl -X POST https://your-site.example/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: text/plain" \
  -H "X-ItemShare-File: ItemShareSavedVars.lua" \
  --data-binary @ItemShareSavedVars.lua
```

The body is read as a stream, so the sender does not have to know the file's size
before it starts: chunked transfer, a body with no `Content-Length`, gzip or deflate
in `Content-Encoding` (up to 12 MB of it), and any `Content-Type` or none at all all
land here the same way. Piping the file off disk is enough:

```bash
gzip -c ItemShareSavedVars.lua | curl -X POST https://your-site.example/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Encoding: gzip" \
  --data-binary @-
```

| Reply | Meaning |
| --- | --- |
| `200` | Accepted and applied. The body is the same summary the upload page gets: accounts, item count, quantity, icon and link results |
| `400` | The body was empty, or no ESO account was found in it - the wrong file, most likely |
| `401` | Missing or wrong token |
| `503` | `INGEST_TOKEN` is blank, so automatic uploads are off |

It does exactly what an upload does - parse, resolve icons, fill-then-prune every
account in one transaction, fetch new icons, and tell open pages to refresh - because
both routes call the same code. The difference is identity: a watcher has no browser
session, so it runs anonymously. It never links an ESO account to a person and never
changes an existing link, so a stolen token can overwrite item lists but cannot
claim someone's account.

The token is compared in constant time and never appears in a reply or the log. Keep
the site behind HTTPS: the token travels in a header, and the file contents are
plain text over the wire.

### The GuildSync side

GuildSync needs three small things of its own: a saved on/off setting, a file watch
that is attached only while it is on, and a debounced POST. ESO rewrites the whole
file and `fs.watch` fires more than once per save, so the send waits for the writes
to settle:

```js
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

let watcher = null;
let pending = null;

export function setItemShareWatch(on, { file, siteUrl, token, log = console }) {
  watcher?.close();
  watcher = null;
  clearTimeout(pending);

  if (!on) {
    log.log('ItemShare file watch: off');
    return;
  }

  watcher = watch(file, () => {
    clearTimeout(pending);
    pending = setTimeout(() => send(file, siteUrl, token, log), 3000);
  });

  log.log(`ItemShare file watch: on, watching ${file}`);
}

async function send(file, siteUrl, token, log) {
  try {
    const response = await fetch(new URL('/ingest', siteUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
        'X-ItemShare-File': path.basename(file),
      },
      body: await readFile(file, 'utf8'),
    });
    const summary = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(summary.error || `HTTP ${response.status}`);
    }

    log.log(
      `ItemShare: sent ${summary.accountCount} account(s), ${summary.itemCount} item(s)`
    );
  } catch (error) {
    // The next save tries again; a failed send must never stop the watch.
    log.warn(`ItemShare: sending the file failed - ${error.message}`);
  }
}
```

Points worth keeping when it is wired in:

- The path is `Documents/Elder Scrolls Online/<live|liveeu|pts>/SavedVariables/ItemShareSavedVars.lua`.
  `node ingest.js` with no argument already finds that folder the same way
  (see *Finding the saved variables file*), so GuildSync can reuse that lookup.
- Nothing is sent until the addon has written at least one account, and the site is
  the authority on whether a file is usable: a partial write answers `400` and the
  next save fixes it.
- The switch is GuildSync's, so turning it off closes the watcher and sends nothing
  more - no queued file is flushed afterwards. Turning it back on does not send the
  file immediately; the next save does.
- Log the reply's `itemCount`, not just success, or a send with nothing in it looks
  identical to one with thirty items.
- The example above reads the file first, which is fine for a few hundred KB. The
  endpoint takes a stream just as happily, so `createReadStream(file).pipe(request)`
  works unchanged if you would rather not hold the file in memory.

## Seeing shared items

Any Discord or Google account can sign in; it only establishes identity. Once one or more
ESO accounts are linked to it, the page lists every shared item offered to any
guild any of those accounts belongs to, with the owning account, character,
quantity, item type and trait.

The list is split into tabs - *Request* (other people's items), *Offering* (your own)
and *Your requests* - so no row needs a `You` tag: the tab already says whose it is.

Rows are grouped by type (Weapon, Apparel, Furnishing, …) and alphabetical inside
each group by default. The **Item** and **Added** headings sort the list, and clicking
one again reverses it; sorting by either drops the type headings, so the order you
asked for is the order you get.

`Added` is the day that item first entered its owner's shared list - the day they
offered it. It is deliberately not the day of their latest upload, so re-uploading a
long-held item does not make it look new.

`Location` is where the owner's copy was the last time they saved - `Bank`,
`Inventory (Character Name)`, `Furnishing Vault (...)`. It is a column rather than a
sentence in the detail line because it is something people scan for, and it follows
the item: an upload rewrites it, so moving something in game and saving again updates
it here without anyone touching the site.

A filter bar above the table narrows the list by item type, owner account, how
recently it was added (the last day, 7 days, 30 days) and item name. Type and owner
accept several values at once: each is a menu of tick boxes, and everything ticked
appears as a chip on one long row under the controls, where clicking a chip takes
just that value off again. "Clear filters" empties the whole row. Filters are
ordinary query parameters, repeated once per value
(`/?type=Weapon&type=Armor&owner=@Name&added=7&q=sword&sort=added&dir=desc`), so a
filtered, sorted view can be bookmarked and still works with scripts off.

The list refreshes automatically after an upload, and a request being cancelled
reaches the person who asked the same way.

An owner can keep some of a stack back in game with a *share reserve*. What the site
lists is what they are actually offering: the addon subtracts the reserve before it
uploads, so `Free` and every request calculation only ever see the shareable number.
The reserve itself is shown as a small amber note under the item name - `keeping 12
back of 20` - so a stack that offers 8 does not look like an owner who only has 8. A
standing offer with nothing above its reserve says it is keeping some back and offers
nothing until the owner holds more.

Visibility joins three tables: the item's own guilds
(`itemshare_shared_item_guilds`), the viewer's guilds
(`itemshare_account_guilds`), and the guild names (`itemshare_guilds`). Nothing
is readable without a guild overlap, so an account in no guilds sees nothing.

## Asking for something

Every row in *Request* has a **Request** button. It opens a small dialog offering one,
everything you can hold, or any number in between. The largest number offered is what
you may end up holding, which is the copies nobody has claimed plus whatever you have
already put in your own basket, and never more than the raw `item_count` - so two
people can never be promised the same five, and asking again for a stack you already
took part of still works. A number picked there is the total you want to hold, so the
same item stays one row in the basket. A standing offer has no count behind it, so it always means one copy, and it can
only be asked for while the owner has one in a bag right now. When they do not, the
row says *Not in a bag right now* instead of offering a button that cannot be
honoured, and the server refuses the same request either way.

When only one copy can be given - a stack of one, or the last copy of a bigger stack
- there is nothing to choose, so the button sends the request for that one straight
away rather than opening a dialog whose only answer is "one". Leaving the page with
it unsent still raises the usual warning, and it can be cancelled from *Your
requests*.

A request is a **reservation, not a delivery**, and it reserves from the moment it is
picked rather than from the moment it is sent:

- The list has two quantity columns. **Free** is what nobody is holding, **Held** is
  what a request is standing on, and they always add up to what the owner reported.
  Once nothing is free the button becomes *All held*.
- Asking puts the item in a **basket** with a five minute clock (`REQUEST_HOLD_MINUTES`).
  Everything picked shares one timer, and adding or removing anything starts it again.
  *Your requests* shows the countdown next to a **Send requests** button; until it is
  pressed nobody has been asked, but the copies are held, so two people cannot be
  offered the same one.
- When the clock runs out the basket is cancelled with the reason shown, and the
  items are free again. That happens **server-side on a timer**
  (`REQUEST_SWEEP_INTERVAL_MS`, default 10 s), so it also happens to someone who
  requested an item and closed the tab: nothing is held because a browser forgot to
  tell anyone. Every query also treats a lapsed reservation as free, so the
  arithmetic is right even between two sweeps.
- Each item in the basket can be removed before sending, which also restarts the
  clock for the rest. A removed row stays where it was, marked **Cancelled**, for
  about five seconds, then fades out and the rows below it close up. It is not added
  to the history, because it was never sent. The five seconds belong to the request,
  not to the row on screen, so a live update that rebuilds the table cannot restart
  them or lose them.
- **Asking again for the same item tops the row up.** Taking 2 of a stack of 5 and
  then asking for the whole stack leaves one basket row holding 5, not two rows
  holding 7: the number in the dialog is the total you want to hold, and the request
  button offers that total (your own basket included) rather than only what is
  unclaimed.
- A row that runs out - every copy asked for and sent - also stays for about five
  seconds before fading away, then the request list stops showing it. A row that is
  only being picked stays visible with *being picked* beside it, because a basket can
  lapse and the copy come back.
- After every upload the owner's requests are settled oldest first, because they were
  promised first. One whose item has gone, or whose turn the stack no longer reaches,
  is cancelled with a sentence the requester can read: "Ghost Bane now has 2 of
  Briarheart Dagger, which does not cover the 3 you asked for." A row that merely
  moved (the item changed character, or was re-shared) is re-pointed by
  `item_key_hash` instead of being cancelled.
- *Your requests* holds the basket and, below it, **Already sent**: only the requests
  that actually stand, newest first and oldest last - waiting on the owner, handed
  over, or turned down. Each row carries the item's picture and trait and the time it
  was sent. A request that timed out or was cancelled is not kept there: it was never
  something the person successfully asked for, so it is dropped instead of sitting in
  the list looking live. When a live update brings back a cancellation the page still
  says so in a toast, once: opening the page does not replay old ones.
- A requester can cancel their own waiting request. The owner sees "2 asked for" on
  the row.
- Leaving the page with a basket still holding items raises a styled warning
  ("You have unsubmitted item requests") before following a link, with the browser's
  own unload prompt as the fallback for closing the tab or posting a form.

## Request emails

Sending the basket emails the owner of each item: one message per person, headed
**ESO Item Request**, listing every item with its quantity and naming the ESO account
(`@Name`) the items should be mailed to. It goes out after the requests are committed,
and a failed send is logged rather than turned into an error - the request already
exists either way.

Each line also carries what tells two copies of a name apart: the item's type, its
trait and its enchantment, with the name in its quality colour. That is copied onto
the request when it is made (migration 015 adds `enchant_name`), because the next
upload rewrites the item rows the request came from. An owner with three Briarheart
swords and two Twice-Born rings can therefore see exactly which one was asked for
without opening the site.

On Linux the site sends mail itself, through the mail server the machine already
runs (`sendmail -t`, which postfix, exim, msmtp and opensmtpd all provide). No
account, key or third-party service is involved, and nothing is installed by the
site:

```
EMAIL_FROM=ItemShare <requests@your-domain.example>
# BASE_URL=https://your-site.example
```

Anything that gives the machine a working `sendmail` is enough - installing postfix
or msmtp is the usual step on a fresh box, and `echo test | sendmail -t you@example.com`
is the check. If the binary is somewhere unusual, set `SENDMAIL_PATH`; `EMAIL_TRANSPORT`
forces `sendmail`, `resend` or `none` when both happen to be available.

`npm run email:test -- you@example.com` sends one of these messages through exactly
the configuration the site uses - `EMAIL_FROM`, `EMAIL_TRANSPORT`, `SENDMAIL_PATH` or
`RESEND_API_KEY` - printing the transport, sender and subject first, then the result.
It opens no database connection and changes nothing, so it separates "the mail server
works" from "the site is configured": if it says the message was handed over and
nothing arrives, the problem is the MTA's queue or DNS, not ItemShare.

Windows has no local mail server, so during development there sending is simply
skipped: the site works, requests are still recorded, and the log says
`Email: N request emails not sent - ...` with the reason. Set `RESEND_API_KEY` (and an
`EMAIL_FROM` on a domain verified in Resend) there - or on a Linux host without an
MTA - to send over Resend's HTTP API instead; `EMAIL_TRANSPORT=resend` pins that
choice.

Only an owner whose ESO account is linked to a signed-in person has an address at
all, so a request to an unclaimed account sends nothing, and a local mail server still
has to be allowed to send as the `EMAIL_FROM` address (for postfix, that is
`myorigin`/`myhostname` plus a matching sender domain in your DNS).

## Making it look busy: simulated people

`npm run simulate` (in `Database/`) drives three made-up people through the same store
code the site uses, so a list with one real owner has traffic on it. Every scenario the
site can put a request through happens for real in the database, one at a time:

- **asking** - something of yours goes into their basket, on the same five-minute clock
- **sending** - the basket is committed, which is the moment a real person's send would
  email you; the log says who *would* have been emailed instead of sending anything
- **cancelling** - either a request that was already waiting, or one taken back out of
  the basket before it was ever sent
- **timing out** - the basket's clock is pushed past its deadline and the site's own
  sweeper runs, so those reservations are released exactly as if they had lapsed
- **re-saving** - items move between bags, the bank and the furnishing vault, stacks
  change and pending requests are re-settled against the new file

One action, a pause, another action: it keeps going until you stop it with Ctrl+C, and
every action ends by asking the running site to announce what happened. The pause is
10 seconds unless `--every` says otherwise.

```
npm run simulate                        until Ctrl+C, one action every 10s
npm run simulate -- --every 4000        one action every four seconds
npm run simulate -- --rounds 12         stop after twelve actions
npm run simulate -- --once              exactly one action, then exit
npm run simulate -- --only requests     asking, sending, cancelling and timing out
npm run simulate -- --only items        just re-saving files
npm run simulate -- --reset             remove the simulated people and their data
```

Set `SIMULATE_TOKEN` in `Database/.env` and restart the site to have open pages refresh
as it runs; without it the data still changes and you see it on the next refresh, and
no `live:` line is printed after an action, because there is no delivery to report. The
three people are identified by a `simulator` identity, so they are the same people on
every run, and `--reset` takes all of them out again.

Their activity appears in the log as a sentence rather than a revision number:

```
Live: @DemoTrader asked @YourAccount for 2 x Soul Gem; @QuietSmith saved again: 2 items, now in Bank / Craft Bag - 1 open page told to refresh
Live: @NightMarket sent 2 requests for Briarheart Greatsword, Dwemer Frame to @YourAccount - the owner would be emailed
Live: @QuietSmith let the basket clock run out, so Alinor Bookshelf, Grand went back to being available
Requests: 3 unsent requests timed out, so the items are free again
```

"1 open page told to refresh" is the delivery detail: how many browsers were connected
over the socket at that moment, each of which refetches its own list. It says nothing
about how many people use the site - closing the page drops it to zero.

Everything here is recorded server-side; the browser never decides how many are
left. The simulator never sends mail - the email module is only reached from the
site's own send route - so a simulated send changes the data and says in the log who
would have been emailed. Handing an item over in game is not recorded yet, so nothing
moves from *Waiting* to *Handed over* - see *Not done yet*.

## Item icons

ItemShare 1.4.0 records the game's icon path for every shared item
(`/esoui/art/icons/…dds`). Browsers cannot draw DDS textures, so after an upload
the site fetches each *new* icon once from UESP's PNG mirror (`esoicons.uesp.net`)
and stores the bytes in `itemshare_item_icons`. Pages then serve them from
`/icons/<key>.png`, so browsing never contacts UESP and a later upload of the same
item fetches nothing at all. Fetching is best effort: a failure is logged, that
row simply shows no thumbnail, and it is retried later.

When the client records no icon path at all - a share written before 1.5.0, a client
without `GetItemIcon`, or a set item whose slot getter came back empty - the addon
asks a link-based getter next (`GetItemLinkIconTextureName` and its older spellings),
and the site falls back to the item id: `esoitem.uesp.net/itemLink.php?itemid=...`
first, then `exportJson.php?table=minedItemSummary&id=...`, which often answers for
set items whose item page carries no icon. Whichever one answers travels the ordinary
cache route, so nothing downstream knows the difference. A path the client returns
without its leading slash is repaired rather than dropped.

Two capture mistakes used to keep whole categories of item blank: `GetItemInfo`
returns the icon as its *third* value (the second is the item link, which is not a
texture), and nothing ever retried a recorded path that the mirror had no image for,
so a set item stayed a placeholder for ever while its id was perfectly well known.

Both steps run at upload and again on a timer, because a blank icon never repairs
itself otherwise. `ICON_BACKFILL_INTERVAL_MS` (default 30 minutes) sets how often
the retry pass runs and `ICON_BACKFILL_BATCH` (default 20) how many item ids one
pass may look up; `ICON_BACKFILL_INTERVAL_MS=0` turns the pass off. A pass looks at
ids with no path anywhere *and* at ids whose stored path never produced an image. The
second kind is only rewritten when UESP answers with a different path, so an item
UESP is still refusing simply stays queued for the next pass instead of looping on
the same answer. `node backfillIcons.js --dry-run` lists both groups.

## Hovering an item

An item's name opens a card instead of sending the reader to another tab. The card
starts with what the row already knows - name in its quality colour, type, trait,
enchant, level and champion points - and then adds the game's own description and what
the item's **set** does. That second half comes from UESP's public item database
(`esoitem.uesp.net/exportJson.php`), fetched server-side by `/item-tip` and cached in
`itemshare_item_tips` (migration 014) for a month, so a name is looked up once however
often it is hovered and the browser never talks to UESP.

The cache is an optimisation: with an empty table, no network, or UESP refusing the
request, the card still shows everything the row carries and simply stops there. The
set name is no longer printed under the item name - it lives in the card, with the
bonus lines, instead. Names are no longer links at all: they keep their quality colour
and carry no underline, and the card is the only thing that opens from them.

The card is placed beside the pointer rather than under it, flips to the other side
near a window edge, opens on keyboard focus as well as hover, and ignores the pointer
entirely so it can never steal the hover that opened it.

ESO writes its own colour codes into item text (`|cffffff10|r` for a number in white,
`|r` to go back to the card's colour). They are read rather than printed, so the game's
numbers keep the colour the game gave them, link codes lose their link and keep their
label, and a code too dark to read on the dark panel is lifted towards white. Text with
no codes is unaffected.

Item type, quality, trait and icon all come from the addon, not from UESP; only the
description and set bonuses are looked up.

## Staying signed in

Signing in is meant to be a one-off. Sessions are stored in MariaDB
(`itemshare_sessions`) rather than in process memory, so a restart, a crash or a
redeploy no longer signs everyone out while their cookie still says otherwise, and
the cookie lasts `SESSION_TTL_DAYS` (default 30) with `rolling` renewal, so a person
who visits now and then never sees a login screen.

The avatar shows the picture from the sign-in provider when there is one: Google's
`picture` claim, or Discord's avatar hash turned into a CDN URL (animated avatars
keep their GIF form). Only https URLs are stored, and if a picture stops loading the
initials underneath show instead, so the header never depends on a third party.

The only way out is the avatar menu in the header: it opens a panel with the name and
provider and holds **Log out**. That posts to
`/logout`, which deletes the session row and clears the cookie. Without JavaScript
the form still submits.

Expired rows are pruned at startup and twice a day. If MariaDB is unreachable the
session layer reports "no session" instead of failing the request, so the page still
renders its database-error card rather than a blank screen.

## Commands

Everything runs from `Database/`, through the `package.json` scripts:

| Command | What it does |
| --- | --- |
| `npm start` | The site: migrations on boot, the request sweeper, the icon repair timer, sockets |
| `npm run check` | Parses `SampleData/Sample1/ItemShareSavedVars.lua` without touching the database |
| `npm run ingest` | Imports the saved variables file found under your home directory |
| `npm run ingest -- <file-or-folder>` | Imports a file, or the `SavedVariables` folder holding it, from any location |
| `npm run backfill` | Retries item icons now instead of waiting for the timer |
| `npm run seed:demo` | Adds `@DemoTrader` to your guilds so *Request* has rows; `-- --remove` takes it out |
| `npm run simulate` | Drives three fake people through real asks, sends, timeouts and re-saves |
| `npm run email:test -- <address>` | Sends one request email through the configured transport, without needing a request |

`npm run seed:demo` prints what it put where: the guilds it could use, every shared
item with its set, quality, trait, quantity and location, and every standing offer.
Nothing needs it to be inferred from the site afterwards.

## Command line equivalent

```bash
node ingest.js                                                        # found under your home directory
node ingest.js "D:/Users/skper/Documents/Elder Scrolls Online/live/SavedVariables"  # a folder is enough
node ingest.js ../SampleData/Sample1/ItemShareSavedVars.lua           # import
node ingest.js ../SampleData/Sample1/ItemShareSavedVars.lua --dry-run  # parse only
node backfillIcons.js --dry-run                                       # what lacks an icon
node backfillIcons.js --limit 20 --passes 5                            # retry missing icons
node backfillIcons.js --id 223698                                      # does UESP know this item?
node testEmail.js you@example.com                                       # one request email, through .env
```

`backfillIcons.js` reads `Database/.env` by absolute path, exactly like the site,
so it works from any directory. It runs the same pass the timer runs, with the
same per-pass ceiling, and `--id` asks UESP about one item without opening a
database at all - the quickest way to tell a refused lookup from a page that no
longer embeds the image.

The command line importer handles multi-account files exactly like the website:
every account is replaced inside one transaction, each with its own guilds.

### Finding the saved variables file

With no path, the importer works the location out from the home directory instead of
from a hard-coded drive, so the same command is right on Windows, macOS and Linux.
`os.homedir()` is the base: `%USERPROFILE%` on Windows - which is why a Users folder
that has been moved to another drive (`D:\Users\skper`) resolves correctly - and
`$HOME` on macOS and Linux. From there it tries, in order:

1. `Documents` under `%OneDrive%`, `%OneDriveConsumer%` and `%OneDriveCommercial%`,
   because Windows moves Documents into OneDrive and the game writes there afterwards;
2. `~/Documents` and `~/OneDrive/Documents`;
3. the Steam Proton prefix on Linux, where ESO's `Documents` folder lives inside the
   prefix (`~/.steam/steam/steamapps/compatdata/306130/pfx/drive_c/users/steamuser/Documents`).

Within each of those it checks `Elder Scrolls Online/live`, then `liveeu`, then `pts`,
for `SavedVariables/ItemShareSavedVars.lua`. The first file that exists is used, and if
none does the error lists every path it tried. A pasted path may be the file or just
the `SavedVariables` folder; the file name is appended when a folder is given.

Upload through the site instead and none of this applies: there the
browser hands the file over, which is the only way a web page can read it at all.

## Tables

| Table | Purpose |
| --- | --- |
| `itemshare_uploads` | One row per import: account, file, item count, total quantity, person |
| `itemshare_accounts` | ESO account → person link; several accounts may belong to one person |
| `itemshare_users` | One row per person: display name, email, verified flag |
| `itemshare_user_identities` | `(provider, provider_user_id)` → person, for Discord and Google |
| `itemshare_discord_users` | Legacy Discord profile table, superseded by `itemshare_users` |
| `itemshare_item_icons` | Cached PNG bytes per icon path, fetched once from UESP |
| `itemshare_guilds` | Guild ID → name, the stable identity for a guild |
| `itemshare_shared_items` | One row per shared item per character |
| `itemshare_shared_item_guilds` | Which guilds each shared item is offered to |
| `itemshare_always_share` | Standing offers: items the owner will hand out whenever they have one |
| `itemshare_always_share_guilds` | Which guilds each standing offer is shown in |
| `itemshare_requests` | Who asked for what, how many, and how it ended |

`itemshare_shared_items` and `itemshare_always_share` also carry `held_quantity`
and `reserve_quantity`: what was in the bag and what the owner keeps back. The
`item_count` column stays what is actually on offer, so every Free/Held calculation
is unaffected by a reserve.

Guild IDs come from the addon (1.3.0+; `/ishare guilds` shows what was captured).
Names are display only, because names are neither unique nor stable.

## Email addresses

Discord sign-in requests the `identify` and `email` scopes; Google sign-in
requests `openid email profile`. Either way the address lands in
`itemshare_users.email` together with the provider's own verified flag, and is
refreshed at every sign-in, so it stays correct if someone changes it.

The address is personal data and is only ever read server-side. It is shown back
to its own owner on the page and is never included in item lists or any other
member's view. `getOwnerNotificationEmail(connection, accountName)` is the single
server-side helper for finding an owner's address when a request needs to notify
them.

That helper is what the request email uses: see *Request emails* above for the
credentials it needs in `.env` and what the message contains.

## Not done yet (next step)

**Handing a request over.** Requests are recorded, reserved, emailed and cancelled
correctly, but nothing yet marks one as delivered, and an owner gets no in-page notice
of their own (only the email). `itemshare_requests.status`
(`pending` / `cancelled` / `fulfilled` / `declined`) and `closed_at` are in place for
that step.

Item icons are not shown. ESO icon art is keyed by icon name rather than the item
ID in the link, so quality colour, type and trait are displayed instead of
guessing at a texture.

## What is captured from the game

Addon 1.5.0 records everything the running client will answer for a shared item:
name, item id, icon path, type, quality, trait, apparel slot, equip type, armour
and weapon type, handedness, furniture data id, location, **set name,
enchantment, crafting style, required level and champion points, and flavour
text**.

Every getter is probed through `pcall` and its results are type-checked, so a
field the current API does not expose is simply absent instead of raising an
error while an item is being added to the list. That also means the same build
keeps working when ZeniMax renames or reshapes one of these functions.

Each probe's raw scalar results are stored with the item and end up in the
`eso_data` JSON column, keyed by getter name:

```json
{"GetItemLinkSetInfo": [true, "Briarheart", 5, 3, 5], "GetItemLinkRequiredLevel": [50]}
```

So detail the site does not render yet is already in the database and can be
surfaced later without asking anyone to upload again. UESP enrichment is then
only used for what the client left empty — the icon PNG mirror is the existing
example.

## Troubleshooting startup

The server prints the `.env` file it actually read, so a setting that "is in there" but has no effect is usually a file in the wrong place — a `.env` in the repo root instead of `Database/`, or Windows Notepad saving it as `.env.txt`.

**`SESSION_SECRET is not set ... using an ephemeral secret`** — no `Database/.env`, or the key is missing from it. Every restart invalidates existing sessions, so sign-in is lost. Make a secret and paste the printed line into `Database/.env`:

```bash
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
```

**`Server requests authentication using unknown plugin auth_gssapi_client`** — the MariaDB account is configured for Kerberos/GSSAPI, which `mysql2` cannot use. On the MariaDB host, as an administrator, give it an ordinary password login:

```sql
SELECT user, host, plugin FROM mysql.user WHERE user = 'itemshare';
ALTER USER 'itemshare'@'%' IDENTIFIED VIA mysql_native_password USING PASSWORD('the-password-from-.env');
FLUSH PRIVILEGES;
```

Leave the password inside `PASSWORD(...)` as the plain text one from `Database/.env`; MariaDB hashes it. If `Access denied for user ...` comes back instead, the plugin is fine and the password or the host grant is wrong — check that the account may connect from this machine's address, not just `localhost`.

**`Sign-in providers: none`** — `DISCORD_CLIENT_ID`/`DISCORD_CLIENT_SECRET` (or the `GOOGLE_*` pair) are empty. Discord also needs `DISCORD_REDIRECT_URI` registered under OAuth2 -> Redirects in the Discord application, and the same URL must be the one the browser is sent to.

## Live updates

The item list updates itself when somebody else uploads. Socket.IO runs on the same
HTTP server as the site, under `/socket.io`, so there is no second port and no extra
proxy rule.

The socket deliberately carries **no item data**: it only says "something you can see
has changed". Each open page then re-fetches `/items` — the same query the page was
built from, with the viewer's own session cookie — and swaps just that region into
the page. Visibility therefore stays in exactly one place (`lib/store.js`), and a
mistake in the push path cannot show another guild's items.

Uploads broadcast after the rows are committed, and again if new icons were fetched.
The icon backfill announces its own repairs, so a picture that was missing earlier
appears without a reload.

### Staying where you were

A redraw that jumps to the top of the table is worse than a stale row, so every row
is marked with its stable `item_key_hash` (`data-item-key="inv:…"` / `"offer:…"`).
Before the swap the page notes which row crosses a line about a third of the way
down the viewport and how far it sits from that line. After the swap it finds the
same row and scrolls by the difference, so the reader keeps their exact place.

If that item was removed, the row that moved up into its slot is used instead: the
reader lands one item down the list rather than at the top. If the change adds or
removes an item type or an owner, the filter controls would be out of date, so the
page reloads and restores the same row from session storage.

### One process

The broadcast is in-process. Running several Node processes against the same
database needs a shared Socket.IO adapter (`@socket.io/mysql`), because an upload
handled by one process would otherwise never reach the sockets held by another.

## Using the site

- **Filters apply as you change them, and can hold more than one value.** Type and
  "Offered by" are tick lists; each ticked value becomes a chip on the row underneath,
  and clicking a chip removes that value and leaves the rest alone. "Clear filters"
  is a button, coloured like the destructive action it is, and empties every control
  at once. There is no Apply button. The address bar keeps up, so a reload or a live
  update uses the same filters. With scripts off, the form's own submit button
  appears and everything still works.
- **Uploads start on their own.** Dropping `ItemShareSavedVars.lua` on the upload
  card, or picking it with the file chooser, uploads it straight away. A toast says
  the file has been received and is being processed, then summarises what landed.
- **The line above the tabs** says how much there is to look at: *9 different items
  shared by other members of your guilds*. It counts different items, not copies, so
  a stack of thirty Soul Gems is still one item.
- **Three tabs,** centred. *Request* is what other people in your guilds are sharing,
  *Offering* is your own items and your own standing offers, and *Your requests* is
  what you asked others for and what became of it. That split is why no row carries a
  "You" tag - which tab it is in already says whose it is.
- **Sort by clicking a heading.** *Item* and *Added* sort the table, and clicking the
  same heading again reverses it. *Added* also has its own filter (day / 7 days /
  30 days) for finding what is new.
- **Ask for what you need.** Requestable rows have a Request button: one, the whole
  stack, or any number up to what is still unclaimed. What you ask for is held for
  you, shown under *Your requests*, and cancelled with a reason if the owner's file
  stops containing the item.
- **Nothing is listed before your first upload.** Items are shared through guilds,
  so until your account and its guilds are known there is nothing anyone could
  legitimately show you.
- Guild names are not repeated on every row: a row is there *because* of a shared
  guild. The guild list at the top shows names only, no ids.

## Previewing it with a fake guildmate

A saved variables file cannot act as a second person - every account in an uploaded
file is linked to whoever uploaded it. To see the Request tab before someone else
really uploads, seed a demo account instead:

```bash
npm run seed:demo                      # into every guild you are in
npm run seed:demo -- --account @Name   # only that account's guilds
npm run seed:demo -- --guild 761817    # only that guild
npm run seed:demo -- --remove          # take it all out again
```

It writes `@DemoTrader` with nine items and three standing offers into guilds that
already exist, and never links that account to your login, so its items appear under
Request exactly like a real guildmate's would. The output lists each item with its
set, quality, trait, quantity and location, then each standing offer, so it is clear
which sets and slots the demo now covers. The items are deliberately spread
across Weapon, Apparel, Jewelry, Consumable, Material, Furnishing and Style, with
two of them in a furnishing vault, so the location line and the type grouping have
something to show.
