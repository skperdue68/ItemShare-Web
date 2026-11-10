# A Discord bot for ItemShare

**Status: idea only. Nothing here is built, scheduled or agreed.** This is a note so the
thinking is not lost, not a specification to implement. Several questions at the bottom are
still open, and at least two of them change the design.

## Why this app suits a bot better than most

- **Discord is already a sign-in provider.** `itemshare_user_identities` maps
  `(provider, provider_user_id)` to a person, and the Discord identity is captured at
  sign-in. GuildSync keeps a Discord <-> ESO link too, so in most cases the bot can go from
  a Discord user to their ESO account without asking anybody anything.
- **Every permission rule already lives in one place.** `lib/store.js` answers "which guilds
  may this person see" and "what is in them" for the web pages; a bot that calls the same
  functions cannot invent a different answer. A bot that re-implemented those rules could.
- **The things people want are conversational**: "who has a Spriggan's Bow", "I'll take
  two", "did anybody hand over my staff yet". That is chat, not a web page.

## The two shapes discussed

### A. Browse a few items at a time, request from the list

The bot shows a short page of items - say five or ten - with a select menu or numbered
buttons, and a **Request** button beside each. Pagination buttons move through the rest.
This suits "what is in my guild this week" and needs no typing beyond a click.

### B. Search by partial name, then pick from the matches

`/itemshare find spriggan` returns the matching items, paginated, and the person picks one
or more from the list before asking for them. This suits somebody who knows the name of the
thing they want.

Both end in the same place - a selected item and a quantity - so the difference is only the
front half. They could coexist: a browse command and a search command over the same result
renderer.

## Whose ESO account the bot acts for

1. **The link table first.** Discord snowflake -> person -> their ESO accounts. This is the
   normal path and asks nothing.
2. **Several accounts is a real case.** One person may have more than one (`@handle` on PC
   and a console account, say), and the guild they can see depends on which they browse as.
   The site already has a notion of the account being browsed as, so the bot needs either
   that same default or a picker.
3. **No account at all: ask, but do not trust it.** If nothing is linked, ask for the
   `@name`, use it for this interaction, and record that it came from a person typing rather
   than from a file. **Do not write it into the account tables as though it were verified** -
   an unverified name typed into a bot should not be able to claim an account, and it
   certainly should not be able to take one away from somebody else.
4. **Offer linking later, explicitly.** The natural follow-up is "this is the account I use,
   remember it", which is a deliberate, visible action - a one-time code generated on the
   website, or a confirmation the person clicks. Worth considering; out of scope here.

## Requesting an item

- Reserve exactly as the web basket does (the arithmetic in `lib/store.js` is the part to
  reuse, not to re-derive).
- Notify the **owner** by DM with buttons: *Hand it over* / *Not now*. The email with a
  signed link already exists and works; a DM is where an ESO player actually is, so the two
  should probably coexist rather than one replacing the other.
- Buttons need idempotent handlers. A double click must not hand over twice.

## Discord's limits, which shape the UI

- 25 embed fields and 2,000 characters per message: any list needs pagination or buttons.
- Roughly 5 message edits per 5 seconds per channel: no live-updating lists.
- DMs are silently impossible for anyone who shares no server with the bot, so every DM
  needs a fallback - the email is already there.
- Anything personal should be **ephemeral** (only the asker sees it). Inventories and
  wishlists in a public channel are a privacy leak, and a guild code posted in a channel is
  a bearer token given away.

## Safety notes worth keeping

- Identify people by snowflake, never by display name.
- Treat a typed `@name` as unverified input (see above), not as a claim on an account.
- Reuse the store's visibility rules rather than filtering in the bot, so a bug in the bot
  cannot widen what is visible.
- The bot token is a secret of the same weight as the mail API key.

## Open questions

1. **One server or many?** Is this for one guild's Discord, or any server that invites it?
   Per-guild configuration only exists in the second case.
2. **Do DMs replace the request emails** or sit alongside them?
3. **Which ESO account** when a person has several - default browsing account, or ask each
   time?
4. **Does an account typed into the bot count as "seen" for the guild slot rules**, which
   currently care about what the upload file reports?
5. **Where does the bot live?** A second always-on Node process next to the site, or
   something separate that talks to an API the site does not have yet?

## Deliberately not covered here

- Uploading a saved variables file by attachment (possible, but a separate decision).
- Guild codes from chat (a code in a DM is fine; a code in a channel is not).
- Channel digests or any public listing.
