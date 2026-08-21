-- Accepted room chat is retained for 30 days for moderation/report reconstruction. New room
-- joins never query this table; it is an internal evidence sink, not lobby history.
create table if not exists chat_messages (
  message_id text primary key,
  room_id text not null references rooms(room_id) on delete restrict,
  sender_account_id text not null references accounts(account_id) on delete restrict,
  text text not null check (char_length(text) between 1 and 200),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  removed_at timestamptz,
  removed_by text,
  removal_reason text,
  constraint chat_removal_complete check (
    (removed_at is null and removed_by is null and removal_reason is null)
    or (removed_at is not null and removed_by is not null and removal_reason is not null)
  )
);
create index if not exists chat_messages_expiry_idx on chat_messages(expires_at)
  where removed_at is null;
create index if not exists chat_messages_room_idx on chat_messages(room_id,created_at);

alter table reports add column if not exists chat_message_id text
  references chat_messages(message_id) on delete restrict;
alter table reports drop constraint if exists reports_no_duplicate;
alter table reports add constraint reports_no_duplicate
  unique nulls not distinct
  (reporter_account_id,subject_account_id,match_id,chat_message_id,category);
