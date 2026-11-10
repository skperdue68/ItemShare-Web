-- How long an owner keeps an item shared, taken from `expireDays` in their file.
--
-- 0 means the file carried no setting, and then nothing is ever flagged LAST CHANCE: the
-- site does not invent a window. The number is per account, because two accounts in one
-- file can be set up differently, and it is read beside the owner's row in the list.
ALTER TABLE itemshare_accounts
  ADD COLUMN IF NOT EXISTS expire_days SMALLINT UNSIGNED NOT NULL DEFAULT 0;
