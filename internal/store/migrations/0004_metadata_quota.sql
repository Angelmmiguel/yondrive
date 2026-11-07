-- Sealed metadata counts against the owner's quota, like a blob does: a node
-- holds up to 64 KiB of it, and a tree of nodes with no content would otherwise
-- be storage nobody is charged for. The triggers follow it through insert,
-- change and delete, a cascade included.

CREATE TRIGGER nodes_charge AFTER INSERT ON nodes
BEGIN
    UPDATE users SET used_bytes = used_bytes + length(NEW.sealed_metadata) WHERE id = NEW.owner_id;
END;

CREATE TRIGGER nodes_recharge AFTER UPDATE OF sealed_metadata ON nodes
BEGIN
    UPDATE users SET used_bytes = used_bytes + length(NEW.sealed_metadata) - length(OLD.sealed_metadata) WHERE id = NEW.owner_id;
END;

CREATE TRIGGER nodes_discharge AFTER DELETE ON nodes
BEGIN
    UPDATE users SET used_bytes = used_bytes - length(OLD.sealed_metadata) WHERE id = OLD.owner_id;
END;

-- What the nodes that exist already hold.
UPDATE users SET used_bytes = used_bytes
    + coalesce((SELECT sum(length(sealed_metadata)) FROM nodes WHERE owner_id = users.id), 0);
