-- A single sign-on account has no auth_key_hash, which is what signs in. What its
-- unlock passphrase derives proves a current credential and nothing more, so it has
-- a column that the sign-in route does not read.

ALTER TABLE users ADD COLUMN unlock_auth_key_hash BLOB;
