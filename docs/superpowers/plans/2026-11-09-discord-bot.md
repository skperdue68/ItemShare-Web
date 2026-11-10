# Experimental ItemShare Discord bot implementation plan

**Goal:** Test Discord searching, category browsing, immediate item requests, and provisional recipient review on a dedicated development branch, without changing GuildSync.

**Architecture:** Standalone Node Discord client in `discord-bot/`, authenticated opt-in ItemShare JSON API, scoped store operations and ItemShare-owned association/idempotency tables. Optional GuildSync adapter performs only SELECTs with separately configured read-only credentials. Website stock/status updates reuse existing notification hooks. No deployment or live credentials in this change.

**Constraints:** GuildSync repository, schema, configuration and data remain untouched. Bind one experimental installation to one Discord guild plus ESO guild/platform/world. Default API disabled. Private Discord responses. Provisional recipients do not create account ownership, verified identity links, roles or general guild access. Officer review affects only ItemShare delivery associations. Existing website drafts must never be submitted or reset by a Discord request.

## Tasks

- [x] Define API contract and failing tests for guild scope, roles, identity isolation, duplicate requests and stock.
- [x] Implement `lib/discord-bot-store.js` plus migration 027: browse/categories, recipient associations/review, immediate single-item submission, request history, idempotency.
- [x] Implement opt-in authenticated Express API and optional SELECT-only GuildSync identity adapter. Integrate mail and website notifications after commit.
- [x] Implement standalone `discord-bot/` commands, private pagination/category controls, item detail/confirmation, recipient prompt, account/status/review commands and startup checks.
- [x] Document bot application setup, environment configuration, read-only integration, every command/interaction, officer workflow, test checklist and removal.
- [x] Run existing tests and targeted API/bot tests, review authorization/concurrency behavior, then publish a draft PR on the development branch.

## API contract

POST `/api/discord/v1/:operation`; JSON body contains `actor:{discordId,username,roleIds:[]}`, `discordGuildId`, plus operation fields. Authorization is a dedicated Bearer token. Installation ESO scope and allowed/officer roles are server configuration, never body scope fields. All errors `{ok:false,error,code}`. Successful replies `{ok:true,...data}`.

Operations: `browse {search?,category?,page?}` -> `{items:[{reference,name,kind,quantity,owner,category,quality,level,cp,trait,style,enchant}],page,totalPages,total,scope:{guildName,platform,worldName}}`; `categories` -> `{categories:[{name,count}]}`; `identity` -> `{accounts:[{esoAccount,status,source}],selectedAccount,allowProvisional}`; `account {esoAccount}` -> same identity shape; `item {reference}` -> `{item}`; `request {reference,quantity,interactionId,expectedRecipient}` -> `{request:{id,itemName,quantity,status,recipient,verification},duplicate}`; `requests {page?}` -> `{requests:[{id,itemName,quantity,status,recipient}],page,totalPages,total}`; `review {action?:list|approve|reject,discordId?,esoAccount?}` -> `{associations:[{discordId,esoAccount,status}]}`. A reference is `inventory:ID` or `offer:ID`; every use revalidates scope.

Store factory `createDiscordBotStore({withDatabase,scope,resolveConfirmedAccounts,recipientClaimAllowed,holdMinutes})` returns methods `browse(actor,input)`, `categories(actor,input)`, `identity(actor,input)`, `account(actor,input)`, `item(actor,input)`, `request(actor,input)`, `requests(actor,input)`, `review(actor,input)`. `withDatabase(handler)` opens ItemShare only. `scope={installationId,discordGuildId,esoGuildId,guildName,platform,worldName,allowProvisional,maxQuantity}`. `resolveConfirmedAccounts(discordId)` returns confirmed `{esoAccount}` entries from the optional external adapter; source unavailable must fail closed for confirmed resolution rather than invent verification. API enforces member/officer roles before methods; store rechecks recipient/scope and owns transaction/idempotency.

Bot env: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `ITEMSHARE_API_URL`, `ITEMSHARE_BOT_TOKEN`; backend validates required/officer role IDs. Slash `/items browse`, `search name`, `categories`, `account [eso]`, `request item [quantity]`, `requests`, `review [action] [user] [eso]`, `help`. Bot command handlers trust only the actual interaction guild/user/member role IDs. No raw prefix messages or message-content intent.
