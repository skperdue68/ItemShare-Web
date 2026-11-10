# Experimental Discord bot: setup and testing guide

This is an opt-in development integration for ItemShare. Use a dedicated Discord test application, test server, and ItemShare test database. Test the development branch separately before considering any deployment. The API is disabled by default; installing dependencies or starting the normal website does not authorize a production rollout. No automatic deployment is part of this feature.

The bot lets eligible Discord members browse guild stock, select an ESO delivery account, and submit an immediate request for one item. Responses are private Discord interaction replies. A request records a delivery request; it does not transfer an ESO item or prove delivery.

## Scope and identity boundaries

Each installation is bound by server configuration to one Discord server and one ESO guild, platform, and world. Users cannot choose a different guild or world through command arguments. The API checks configured member/officer roles and rechecks item scope and recipient eligibility on each operation.

GuildSync is unchanged: no edits to its code, schema, configuration, or data are needed. An optional adapter can read confirmed identity links using existing SELECT-only database credentials configured in ItemShare. Never give this adapter write privileges. If the source is unavailable, do not treat a typed ESO account as confirmed.

A provisional recipient is only an ItemShare delivery association between a Discord user and an ESO account. It creates no account ownership, verified identity link, Discord role, or general guild access. Officer approval affects this delivery association only. It must not overwrite an existing verified identity or link somebody else's account to a website login.

## Prepare a test installation

Fetch and check out the development branch in your separate test checkout:

```powershell
git fetch origin
git switch --track origin/feature/experimental-discord-bot
```

If the local branch already exists, use `git switch feature/experimental-discord-bot`.

1. Use the experimental development checkout and a separate ItemShare database, for example `itemshare_discord_test`. Set `ITEMSHARE_DATABASE` explicitly; ItemShare does not use `MARIADB_DATABASE` as its schema selector. Use the normal `MARIADB_HOST`, `MARIADB_PORT`, `MARIADB_USER`, and `MARIADB_PASSWORD` settings for this test database. Startup migrations must target ItemShare only.
2. Put test inventory and offers into the configured ESO guild/platform/world. Include out-of-scope fixtures so isolation can be tested. Use fake recipients and controlled test mail addresses.
3. Create a dedicated server with a member test role and an officer test role. Enable Discord Developer Mode and copy the server and role IDs. Use separate users to test member, officer, and unauthorized behavior.
4. Store secrets in local environment variables or untracked `.env` files. Never commit `.env`, bot tokens, API bearer tokens, database passwords, or production database copies. Check `git status` before sharing changes.

### Discord application and permissions

Create a separate application in the [Discord Developer Portal](https://discord.com/developers/applications). Under **Bot**, create/reset its bot token and save it securely as `DISCORD_TOKEN`. The application ID is `DISCORD_CLIENT_ID`; it is not the token or OAuth client secret. If a token is exposed, reset it.

Use the new application's ID and token, not GuildSync's. Command registration replaces
the guild-command list for the configured application; using a separate application
keeps GuildSync's commands untouched.

Install the application into the dedicated test server using the `bot` and `applications.commands` OAuth scopes. Start with no privileged permissions and no Administrator permission. Allow the bot to view the test command channel; grant Send Messages/Embed Links only if channel policy requires them for the bot's interaction output. Do not grant Manage Roles, Manage Guild, or read message history for this feature. Keep Message Content, Server Members, and Presence privileged intents off: commands use the invoking interaction's guild, user, and role IDs, not ordinary chat messages.

Restrict the test channel to testers. Discord command visibility/channel permissions supplement the backend role checks; they do not replace them. Guild-specific registration is intentional for this experiment, so commands are registered only in `DISCORD_GUILD_ID` rather than globally.

## Configure and start

There are two processes: the normal ItemShare server (with an explicitly enabled experimental API) and the standalone client in `discord-bot/`.

The client requires:

| Variable | Value |
| --- | --- |
| `DISCORD_TOKEN` | Dedicated test application's bot token. |
| `DISCORD_CLIENT_ID` | That application's ID. |
| `DISCORD_GUILD_ID` | Dedicated test Discord server ID. |
| `ITEMSHARE_API_URL` | Origin of the test ItemShare server, for example `http://127.0.0.1:3101`; omit `/api` and operation paths. |
| `ITEMSHARE_BOT_TOKEN` | Dedicated API bearer secret shared with the test backend. |

The bot token and ItemShare API token are different secrets. Website Discord OAuth login settings are also a separate concern; the bot does not need a Discord OAuth client secret. Ensure process working directories load the intended local environment file. Use HTTPS whenever the API crosses a trusted local development boundary.

Set these **backend** variables in the separate ItemShare instance's local environment:

```dotenv
PORT=3101
ITEMSHARE_DATABASE=itemshare_discord_test
ITEMSHARE_DISCORD_ENABLED=true
ITEMSHARE_BOT_TOKEN=replace_with_a_unique_random_secret_of_at_least_32_characters
ITEMSHARE_DISCORD_GUILD_ID=your_test_discord_server_id
ITEMSHARE_ESO_GUILD_ID=your_test_eso_guild_id
ITEMSHARE_ESO_GUILD_NAME=Your Test Guild
ITEMSHARE_ESO_PLATFORM=2
ITEMSHARE_ESO_WORLD=NA Megaserver
ITEMSHARE_DISCORD_MEMBER_ROLE_IDS=member_role_id
ITEMSHARE_DISCORD_OFFICER_ROLE_IDS=officer_role_id
ITEMSHARE_DISCORD_ALLOW_PROVISIONAL=true
ITEMSHARE_DISCORD_MAX_QUANTITY=20
```

`ITEMSHARE_DISCORD_ENABLED` defaults to `false`; enable it only in this test instance. Role lists accept comma-separated IDs. Member roles are required; an empty officer-role list disables review access. Use the same `ITEMSHARE_BOT_TOKEN` in the client. The backend's `ITEMSHARE_DISCORD_GUILD_ID` must match the client's `DISCORD_GUILD_ID`. Configure the actual test ESO scope explicitly; platform `2` and `NA Megaserver` above are example values, not a way to select another member's scope.

Optional confirmed-identity lookup is off unless `ITEMSHARE_GUILDSYNC_READ_ENABLED=true`. If an existing read-only account is available, configure `ITEMSHARE_GUILDSYNC_READ_HOST`, `ITEMSHARE_GUILDSYNC_READ_PORT`, `ITEMSHARE_GUILDSYNC_READ_DATABASE`, `ITEMSHARE_GUILDSYNC_READ_USER`, and `ITEMSHARE_GUILDSYNC_READ_PASSWORD` in ItemShare only. For TLS, set `ITEMSHARE_GUILDSYNC_READ_TLS=true`; certificate validation remains enabled. The source database must be bound to the same ESO guild via its `eso_guild_id` setting. Also explicitly set `ITEMSHARE_GUILDSYNC_READ_PLATFORM` and `ITEMSHARE_GUILDSYNC_READ_WORLD` to the known platform and megaserver of that GuildSync deployment; they must match the ItemShare scope. This is an administrator-declared trusted mapping, because the existing source setting does not attest platform/server. Verify the source deployment before enabling it; an unknown or mismatched mapping is refused. This change does not provision credentials or alter GuildSync. Leave lookup disabled if no suitable existing SELECT-only account is available.

Start ItemShare from its own test folder so its environment file belongs to that instance. Keep the port distinct from other instances and point `ITEMSHARE_API_URL` to that port (for example `http://127.0.0.1:3101`). Populate fake/test inventory before issuing any real request command.

Use Node.js 20 or newer. From the ItemShare test checkout root, install and start the website:

```powershell
npm ci
npm start
```

In a second terminal, install and configure the standalone client (run these commands from `discord-bot/`):

```powershell
Set-Location discord-bot
npm ci
Copy-Item .env.example .env
# Fill in this local .env with the client variables above.
npm run deploy-commands
npm start
```

The client loads `.env` from its current working directory, so keep the bot terminal in `discord-bot/`. `deploy-commands` registers this application's commands in the configured test guild. Never copy a production `.env` to obtain working test settings.

Register commands again after command definitions change. Registration replaces this application's guild command definitions in the test guild. Restart the bot after configuration changes. Check startup errors before testing interactions; a connected bot cannot compensate for a disabled API, wrong bearer token, wrong guild scope, or missing role configuration.

## Commands and interaction flow

All commands start with `/items`. Select the subcommand in Discord's slash-command picker. There is no text prefix, message scraping, or DM workflow.

| Command | Purpose and arguments |
| --- | --- |
| `/items browse` | Show the first page of stock available in this installation's ESO scope. |
| `/items search name:<text>` | Search item names. Example: `/items search name:rubedite`. |
| `/items categories` | List stock categories and counts, then choose a category to browse. |
| `/items account` | Show known delivery accounts and the selected recipient. |
| `/items account eso:<account>` | Select a confirmed account or submit/select a provisional recipient when allowed. |
| `/items request item:<reference> quantity:<number>` | Open a request confirmation for an item reference such as `inventory:123` or `offer:456`. Quantity is optional. |
| `/items requests` | Show the invoking member's request history and recorded statuses. |
| `/items review` | Officer-only list of delivery associations and review statuses. |
| `/items review action:approve user:<member> eso:<account>` | Approve that member's ItemShare delivery association. |
| `/items review action:reject user:<member> eso:<account>` | Reject that association. |
| `/items help` | Show available commands and short usage guidance. |

### Browsing, categories, and details

Controls on an older page expire after paging, so they cannot select a different item
from newer results. Continue using the controls on the newest response.

Use the private Previous/Next controls to page through browse/search results. Choose a category from the category controls to view that category's results. Page counts and quantities represent current API results; later stock changes can affect availability. Search/category controls stay within the configured guild, platform, and world. Categories show up to 20 buttons per page with Previous/Next controls. Long private account/review replies can be truncated; officers can target an association explicitly with the member and ESO account. The prototype has no website UI for these provisional associations.

Browse rows show name, quantity, reference, owner, and category. Select a result to open its request details and confirmation: reference, available quantity, owner, category, quality, level/CP, trait, style, enchantment, and recipient. The reference distinguishes inventory rows from offers; do not infer it from an item name. Different owners or stacks may have the same name. Check the displayed stock and recipient before confirming.

Item details offer Confirm request, Change quantity, and Cancel. Change quantity opens a modal. Enter a positive whole number within the current stock and configured request limit, check the recipient, and press Confirm request to submit. Cancel leaves no new request. Controls expire after ten minutes; reopen the command when they expire. Controls belong to the invoking user; another member must use their own command.

### Choosing a recipient

Requests require a selected ESO `@Account` recipient. Before confirming a request, run `/items account` to inspect the selected ESO account. Where several confirmed accounts exist, explicitly select the intended one. A Discord display name is not an ESO recipient address. Confirmation records the displayed recipient; if the selected account changes before submission, the backend rejects the stale confirmation. Reopen the item and confirm the intended recipient again.

If no confirmed account is available, the bot directs you to `/items account eso:@Account` when provisional recipients are enabled; then retry the request. Supply the exact delivery account and read the provisional notice. This records an unverified delivery association; it does not verify ownership. If provisional recipients are disabled, arrange account confirmation through the existing account-linking process before requesting. Never ask users for their ESO password.

When provisional recipients are enabled, a provisional association may be used to submit a request before officer approval; the response retains its provisional verification state. Officers can review it afterward. A rejected recipient cannot be used. Inspect the displayed verification/review state; a prompt or officer action is not a completed item request.

### Confirming and tracking a request

Confirm submits a single item immediately. It does not add to, submit, clear, or reset an existing website draft basket. For several items, submit separate requests. Stock and eligibility are checked again at submission, so a previously displayed result can become unavailable. Refresh and choose a smaller quantity or another item when necessary.

Discord can retry an interaction. The same submission interaction is idempotent: a retry should return the recorded request instead of reserving twice. A fresh command/confirmation is a new submission, so check `/items requests` after an ambiguous result before intentionally requesting again.

Keep these three states separate:

- **Request recorded:** ItemShare returns a request ID and status. This confirms the database operation only.
- **Notification:** The existing ItemShare email/website notification hooks run after the request commits. Missing or failed email is not proof that the request was lost; check request history before retrying. Test mail delivery separately.
- **ESO handover:** An owner/officer performs the actual in-game delivery and updates the normal ItemShare workflow. The Discord bot does not log into ESO, mail items, or confirm receipt automatically.

`/items requests` shows the invoking user's requests, recipient, quantity, and recorded fulfillment status with pagination. Use the status as ItemShare workflow information, not proof of in-game receipt. Fulfillment is handled through the existing website workflow; the bot has no delivery/complete/cancel command.

## Officer review

An officer uses `/items review` to inspect Discord-to-ESO delivery associations and their statuses, verifies the proposed address through the guild's normal process, and uses approve or reject with both the Discord member and ESO account. Matching both values avoids approving another association for the same member accidentally.

Ask the member to check `/items account` after review and inspect `/items requests` before submitting another request. Review does not itself fulfill or cancel an already recorded request. Approval is not a request submission and does not grant a role, website account ownership, or guild membership. Rejection prevents future use of that ItemShare association; it does not alter a GuildSync link or GuildSync data. Ordinary members must receive an authorization error for review operations even if they know the command syntax.

## Test acceptance checklist

Automated development checks passed on November 10, 2026: all 199 existing checks,
15 standalone client tests, eight API/identity-reader tests, and the new store regression
script. HTTP tests use a local test server; store/identity tests use controlled database
stubs. They do not establish real MariaDB migration behavior, live Discord delivery,
or email delivery. Run the checklist below against the separate test installation.

This checklist describes required validation; it is not a claim that a live Discord server, email provider, or production database has been tested.

- [ ] API disabled by default; disabled requests fail without changing stock.
- [ ] Missing/wrong API bearer token, wrong Discord guild, and missing allowed roles are denied.
- [ ] Dedicated test bot registers only guild commands, connects, and answers `/items help` privately.
- [ ] Browse/search/category counts and previous/next navigation work with empty, single-page, and multi-page results; another member cannot operate private controls.
- [ ] Inventory and offers display accurate details; references outside the configured ESO guild/platform/world are rejected, including manually supplied references.
- [ ] Changing the selected recipient after opening a confirmation rejects that stale confirmation; reopening shows the new recipient.
- [ ] Confirmed account selection works; unavailable identity data never invents a confirmed account.
- [ ] Unlinked members receive the provisional prompt when enabled and a useful block when disabled. Provisional requests retain their unverified state; rejected associations cannot submit new requests.
- [ ] Only officers can list/approve/reject provisional associations. Approval/rejection changes only ItemShare delivery association state.
- [ ] Quantity rejects zero, negative, fractional, excessive, and stale-stock submissions. Concurrent requests cannot reserve more stock than available.
- [ ] Cancel creates no request; Confirm creates exactly one; retrying the same interaction returns the same request without a second reservation.
- [ ] Discord submission leaves an existing website draft basket unchanged.
- [ ] `/items requests` shows only the member's scoped requests, correct recipients/status, and working pagination.
- [ ] A committed request remains visible if notification fails; controlled test email and website updates are checked independently.
- [ ] Fulfillment updates on the website are reflected in later status checks; no automatic in-game handover is implied.
- [ ] GuildSync code, schema, configuration, and data remain unchanged; optional adapter credentials are SELECT-only.
- [ ] `.env` and secrets are absent from tracked changes; no production deployment was triggered.

## Troubleshooting and removal

If commands are missing, verify application/server IDs, installation scopes, guild command registration, and Discord channel access. If replies fail, inspect bot and ItemShare logs for the disabled API, bearer-token mismatch, scope mismatch, or role error. Redact secrets before sharing logs. If a recipient is blocked, check account selection and review status rather than granting extra bot permissions.

To end the experiment, disable the experimental API feature and stop the bot process. Optionally remove this test application's guild commands or remove the application from the test server. Revoke test tokens when no longer needed. No destructive database cleanup is required: keep request/audit history according to normal retention, and do not delete or modify GuildSync data. Removing commands or stopping the bot does not cancel already recorded ItemShare requests; handle those through the normal website workflow.
