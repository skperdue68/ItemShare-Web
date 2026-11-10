import { createHash } from 'node:crypto';
import { createRequest, signInWithProvider, getOwnerContacts } from './store.js';

function fail(message, code = 'INVALID_INPUT', statusCode = 400) {
  throw Object.assign(new Error(message), { code, statusCode });
}

function reference(value) {
  const match = /^(inventory|offer):([1-9]\d*)$/.exec(String(value));
  if (!match || !Number.isSafeInteger(Number(match[2]))) fail('Invalid item reference');
  return { kind: match[1], id: Number(match[2]) };
}

function accountName(value) {
  const name = String(value || '').trim();
  if (!/^@[^\s@]{1,95}$/.test(name)) fail('Enter an ESO account beginning with @');
  return name.toLowerCase();
}

function pageOf(rows, input) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / 5));
  const page = Math.min(totalPages, Math.max(1, Math.trunc(Number(input.page)) || 1));
  return { page, totalPages, total, items: rows.slice((page - 1) * 5, page * 5) };
}

function actorId(actor) {
  const id = String(actor?.discordId || '');
  if (!/^\d{1,32}$/.test(id)) fail('Invalid Discord actor');
  return id;
}

function present(row) {
  return {
    reference: `${row.kind}:${row.id}`,
    name: row.item_name,
    kind: row.kind,
    quantity: Math.max(0, Number(row.free_quantity) || 0),
    owner: row.account_name,
    category: row.item_type_name,
    quality: row.quality,
    level: row.required_level,
    cp: row.required_cp,
    trait: row.trait,
    style: row.style_name,
    enchant: row.enchant_name,
  };
}

export function createDiscordBotStore({
  withDatabase,
  scope,
  resolveConfirmedAccounts = async () => [],
  recipientClaimAllowed = async () => true,
  holdMinutes = 5,
}) {
  if (!scope?.installationId || !scope?.esoGuildId || !scope?.platform || !scope?.worldName) {
    fail('Discord installation scope is incomplete');
  }
  const scopeParams = [scope.esoGuildId, scope.platform, scope.worldName];
  const publicScope = {
    guildName: scope.guildName,
    platform: scope.platform,
    worldName: scope.worldName,
  };

  function transaction(handler) {
    return withDatabase(async (connection) => {
      // Identity reads happen before the target lock. READ COMMITTED ensures the
      // availability reads after that lock see the preceding request's commit.
      await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await connection.beginTransaction();
      try {
        const result = await handler(connection);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
  }

  function user(connection, actor) {
    return signInWithProvider(connection, {
      provider: 'discord',
      providerUserId: actorId(actor),
      username: String(actor.username || ''),
      email: '',
      emailVerified: false,
    });
  }

  async function associations(connection, discordId) {
    const [rows] = await connection.execute(
      `SELECT discord_id, eso_account, status, selected
         FROM itemshare_discord_associations
        WHERE installation_id = ? AND discord_id = ? FOR UPDATE`,
      [scope.installationId, discordId]
    );
    return rows;
  }

  async function identityData(connection, actor) {
    const discordId = actorId(actor);
    const rows = await associations(connection, discordId);
    // Confirmation is refreshed on every operation; it is never persisted as an
    // authoritative ItemShare association. Adapter errors abort the operation.
    const confirmed = await resolveConfirmedAccounts(discordId);
    const accounts = rows.map((row) => ({
      esoAccount: accountName(row.eso_account),
      status: row.status,
      source: 'itemshare',
    }));
    for (const confirmedAccount of confirmed || []) {
      const name = accountName(confirmedAccount.esoAccount);
      const existing = accounts.find((account) => account.esoAccount === name);
      if (existing?.status === 'rejected') continue;
      if (existing) {
        existing.status = 'confirmed';
        existing.source = 'guildsync';
      } else {
        accounts.push({ esoAccount: name, status: 'confirmed', source: 'guildsync' });
      }
    }
    const selected = rows.find((row) => Number(row.selected) === 1);
    return {
      accounts,
      selectedAccount: selected
        ? accountName(selected.eso_account)
        : accounts.find((account) => account.status === 'confirmed')?.esoAccount || null,
      allowProvisional: scope.allowProvisional === true,
    };
  }

  async function assertClaimAllowed(discordId, esoAccount) {
    if (!(await recipientClaimAllowed(discordId, esoAccount))) {
      fail('This recipient cannot be claimed', 'RECIPIENT_BLOCKED', 403);
    }
  }

  async function load(connection, kind, input = {}, id = null, lock = false) {
    const offer = kind === 'offer';
    const table = offer ? 'itemshare_always_share' : 'itemshare_shared_items';
    const links = offer ? 'itemshare_always_share_guilds' : 'itemshare_shared_item_guilds';
    const linkColumn = offer ? 'always_share_id' : 'item_id';
    const requestColumn = offer ? 'always_share_id' : 'shared_item_id';
    const args = [...scopeParams];
    let filter = '';
    if (id !== null) {
      filter += ' AND i.id = ?';
      args.push(id);
    }
    if (input.search) {
      filter += ' AND i.item_name LIKE ?';
      args.push(`%${String(input.search).slice(0, 120)}%`);
    }
    if (input.category) {
      filter += ' AND i.item_type_name = ?';
      args.push(String(input.category).slice(0, 120));
    }
    const stock = offer ? '1' : 'i.item_count';
    const delivered = offer ? '0' : `COALESCE((
      SELECT SUM(d.quantity) FROM itemshare_requests d
      LEFT JOIN itemshare_uploads up ON up.id = i.upload_id
      WHERE d.shared_item_id = i.id AND d.item_kind = 'inventory'
        AND d.status = 'fulfilled'
        AND (up.uploaded_at IS NULL OR d.fulfilled_at > up.uploaded_at)
    ), 0)`;
    const [rows] = await connection.execute(
      `SELECT i.*, (${stock} - COALESCE((
          SELECT SUM(r.quantity) FROM itemshare_requests r
          WHERE r.${requestColumn} = i.id AND r.item_kind = '${kind}'
            AND (r.status = 'pending' OR (r.status = 'draft' AND r.expires_at > NOW()))
        ), 0) - ${delivered}) AS free_quantity
       FROM ${table} i
       WHERE EXISTS (
         SELECT 1 FROM ${links} g WHERE g.${linkColumn} = i.id
           AND g.guild_id = ? AND g.platform = ? AND g.world_name = ?
       )${filter}
       ORDER BY i.item_name, i.id${lock ? ' FOR UPDATE' : ''}`,
      args
    );
    return rows.map((row) => ({ ...row, kind }));
  }

  async function target(connection, itemReference, lock = false) {
    const { kind, id } = reference(itemReference);
    const rows = await load(connection, kind, {}, id, lock);
    if (!rows[0]) fail('Item is outside this guild scope', 'NOT_FOUND', 404);
    return rows[0];
  }

  async function browse(actor, input = {}) {
    actorId(actor);
    return withDatabase(async (connection) => {
      const rows = [
        ...await load(connection, 'inventory', input),
        ...await load(connection, 'offer', input),
      ].map(present).filter((row) => row.quantity > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      return { ...pageOf(rows, input), scope: publicScope };
    });
  }

  async function categories(actor) {
    actorId(actor);
    return withDatabase(async (connection) => {
      const counts = new Map();
      const rows = [
        ...await load(connection, 'inventory'),
        ...await load(connection, 'offer'),
      ];
      for (const row of rows) {
        if (Number(row.free_quantity) > 0) {
          counts.set(row.item_type_name, (counts.get(row.item_type_name) || 0) + 1);
        }
      }
      return {
        categories: [...counts].map(([name, count]) => ({ name, count }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    });
  }

  async function item(actor, input = {}) {
    actorId(actor);
    reference(input.reference);
    return withDatabase(async (connection) => ({
      item: present(await target(connection, input.reference)),
    }));
  }

  function identity(actor) {
    return transaction((connection) => identityData(connection, actor));
  }

  async function account(actor, input = {}) {
    const name = accountName(input.esoAccount);
    const discordId = actorId(actor);
    return transaction(async (connection) => {
      await assertClaimAllowed(discordId, name);
      const current = await identityData(connection, actor);
      const known = current.accounts.find((entry) => entry.esoAccount === name);
      if (known?.status === 'rejected') {
        fail('This recipient was rejected', 'RECIPIENT_REJECTED', 403);
      }
      if (!known && !scope.allowProvisional) {
        fail('A confirmed recipient is required', 'CONFIRMATION_REQUIRED', 403);
      }
      const [owners] = await connection.execute(
        `SELECT a.user_id, i.provider_user_id FROM itemshare_accounts a
         LEFT JOIN itemshare_user_identities i ON i.user_id = a.user_id AND i.provider = ?
         WHERE a.eso_account_name = ?`,
        ['discord', name]
      );
      if (owners.some((owner) => Number(owner.user_id) > 0 &&
          String(owner.provider_user_id || '') !== discordId)) {
        fail('This account is linked to another identity', 'ACCOUNT_CONFLICT', 409);
      }
      await connection.execute(
        `UPDATE itemshare_discord_associations SET selected = 0
         WHERE installation_id = ? AND discord_id = ?`,
        [scope.installationId, discordId]
      );
      await connection.execute(
        `INSERT INTO itemshare_discord_associations
           (installation_id, discord_id, eso_account, selected) VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE selected = 1`,
        [scope.installationId, discordId, name]
      );
      return identityData(connection, actor);
    });
  }

  async function request(actor, input = {}) {
    const discordId = actorId(actor);
    const ref = reference(input.reference);
    const quantity = Number(input.quantity ?? 1);
    const interactionId = String(input.interactionId || '');
    const expectedRecipient = accountName(input.expectedRecipient);
    if (!Number.isInteger(quantity) || quantity < 1 ||
        quantity > Math.min(20, scope.maxQuantity || 20)) {
      fail('Quantity must be between 1 and 20');
    }
    if (!/^[\w-]{1,96}$/.test(interactionId)) fail('Invalid interaction ID');
    const hash = createHash('sha256').update(JSON.stringify({
      reference: input.reference, quantity, expectedRecipient,
    })).digest('hex');

    return transaction(async (connection) => {
      // Insert-or-lock serializes duplicate deliveries of one Discord interaction.
      // A failed request rolls back this row along with its stock reservation.
      await connection.execute(
        `INSERT INTO itemshare_discord_interactions
           (installation_id, interaction_id, discord_id, body_hash) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE interaction_id = VALUES(interaction_id)`,
        [scope.installationId, interactionId, discordId, hash]
      );
      const [[prior]] = await connection.execute(
        `SELECT discord_id, body_hash, response_json FROM itemshare_discord_interactions
         WHERE installation_id = ? AND interaction_id = ? FOR UPDATE`,
        [scope.installationId, interactionId]
      );
      if (prior.discord_id !== discordId || prior.body_hash !== hash) {
        fail('Interaction replay does not match', 'REPLAY_CONFLICT', 409);
      }
      if (prior.response_json) return { ...JSON.parse(prior.response_json), duplicate: true };

      const recipientIdentity = await identityData(connection, actor);
      if (expectedRecipient !== recipientIdentity.selectedAccount) {
        fail('The selected recipient changed; confirm again', 'RECIPIENT_CHANGED', 409);
      }
      const recipient = recipientIdentity.accounts.find((entry) =>
        entry.esoAccount === recipientIdentity.selectedAccount);
      if (!recipient || recipient.status === 'rejected' ||
          (recipient.status === 'provisional' && !scope.allowProvisional)) {
        fail('Select an allowed ESO recipient first', 'RECIPIENT_REQUIRED', 403);
      }
      await assertClaimAllowed(discordId, recipient.esoAccount);
      const signedIn = await user(connection, actor);
      const [owned] = await connection.execute(
        'SELECT eso_account_name FROM itemshare_accounts WHERE user_id = ?',
        [signedIn.userId]
      );
      const [recipientOwners] = await connection.execute(
        'SELECT user_id FROM itemshare_accounts WHERE eso_account_name = ?',
        [recipient.esoAccount]
      );
      if (recipientOwners.some((owner) => Number(owner.user_id) > 0 &&
          Number(owner.user_id) !== signedIn.userId)) {
        fail('This account is linked to another identity', 'ACCOUNT_CONFLICT', 409);
      }
      const row = await target(connection, input.reference, true);
      if (quantity > Number(row.free_quantity)) {
        fail('Not enough stock remains', 'OUT_OF_STOCK', 409);
      }
      if (owned.some((entry) => accountName(entry.eso_account_name) === accountName(row.account_name)) ||
          recipient.esoAccount === accountName(row.account_name)) {
        fail('That item belongs to you');
      }
      const created = await createRequest(connection, {
        userId: signedIn.userId,
        requesterAccounts: [recipient.esoAccount],
        ownAccounts: owned.map((entry) => entry.eso_account_name),
        itemKind: ref.kind,
        itemId: ref.id,
        quantity,
        holdMinutes,
        restrictToGuilds: false,
        combineDrafts: false,
        resetClock: false,
      });
      // Recheck the installation's scope immediately before submitting only the
      // new row. Provisional recipients never enter account ownership tables.
      await target(connection, input.reference, true);
      await connection.execute(
        `UPDATE itemshare_requests SET requester_account_name = ?, status = 'pending',
           submitted_at = UTC_TIMESTAMP(), expires_at = NULL
         WHERE id = ? AND requester_user_id = ? AND status = 'draft'`,
        [recipient.esoAccount, created.id, signedIn.userId]
      );
      const [[submitted]] = await connection.execute(
        'SELECT * FROM itemshare_requests WHERE id = ? AND requester_user_id = ?',
        [created.id, signedIn.userId]
      );
      const response = {
        request: {
          id: created.id,
          itemName: created.itemName,
          quantity: created.quantity,
          status: 'pending',
          recipient: recipient.esoAccount,
          verification: recipient.status,
        },
        duplicate: false,
      };
      await connection.execute(
        `UPDATE itemshare_discord_interactions SET request_id = ?, response_json = ?
         WHERE installation_id = ? AND interaction_id = ?`,
        [created.id, JSON.stringify(response), scope.installationId, interactionId]
      );
      const contacts = await getOwnerContacts(connection, [created.ownerAccountName]);
      return {
        ...response,
        internal: {
          user: { id: signedIn.userId, username: signedIn.displayName, email: signedIn.email },
          submitted: [submitted],
          contacts: [...contacts.entries()],
        },
      };
    });
  }

  function requests(actor, input = {}) {
    return transaction(async (connection) => {
      const signedIn = await user(connection, actor);
      const [rows] = await connection.execute(
        `SELECT r.* FROM itemshare_requests r
         WHERE r.requester_user_id = ? AND r.submitted_at IS NOT NULL
           AND r.status IN ('pending','fulfilled','declined','cancelled')
           AND (EXISTS (SELECT 1 FROM itemshare_discord_interactions d
                  WHERE d.installation_id = ? AND d.request_id = r.id)
             OR (r.item_kind = 'inventory' AND EXISTS
                 (SELECT 1 FROM itemshare_shared_item_guilds g WHERE g.item_id = r.shared_item_id
                   AND g.guild_id = ? AND g.platform = ? AND g.world_name = ?))
             OR (r.item_kind = 'offer' AND EXISTS
                 (SELECT 1 FROM itemshare_always_share_guilds g WHERE g.always_share_id = r.always_share_id
                   AND g.guild_id = ? AND g.platform = ? AND g.world_name = ?)))
         ORDER BY COALESCE(r.closed_at,r.submitted_at,r.created_at) DESC, r.id DESC`,
        [signedIn.userId, scope.installationId, ...scopeParams, ...scopeParams]
      );
      const page = pageOf(rows, input);
      return {
        page: page.page,
        totalPages: page.totalPages,
        total: page.total,
        requests: page.items.map((row) => ({
          id: Number(row.id), itemName: row.item_name, quantity: Number(row.quantity),
          status: row.status, recipient: row.requester_account_name,
        })),
      };
    });
  }

  function review(actor, input = {}) {
    return transaction(async (connection) => {
      const reviewer = actorId(actor);
      const action = input.action || 'list';
      if (!['list', 'approve', 'reject'].includes(action)) fail('Invalid review action');
      // The HTTP layer must authorize officer roles before exposing this method.
      if (action !== 'list') {
        const discordId = actorId({ discordId: input.discordId });
        const name = accountName(input.esoAccount);
        await connection.execute(
          `UPDATE itemshare_discord_associations
           SET status = ?, reviewed_by = ?, reviewed_at = UTC_TIMESTAMP()
           WHERE installation_id = ? AND discord_id = ? AND eso_account = ?`,
          [action === 'approve' ? 'approved' : 'rejected', reviewer,
            scope.installationId, discordId, name]
        );
      }
      const [rows] = await connection.execute(
        `SELECT discord_id, eso_account, status FROM itemshare_discord_associations
         WHERE installation_id = ? ORDER BY created_at DESC`,
        [scope.installationId]
      );
      return {
        associations: rows.map((row) => ({
          discordId: row.discord_id, esoAccount: accountName(row.eso_account), status: row.status,
        })),
      };
    });
  }

  return { browse, categories, identity, account, item, request, requests, review };
}
