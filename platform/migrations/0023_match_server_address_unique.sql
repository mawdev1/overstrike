-- One live authority address has one control-plane identity. Without this, two registrations
-- can reserve the same single-Game process concurrently under different server ids.
create unique index if not exists match_servers_address_unique on match_servers(address);
