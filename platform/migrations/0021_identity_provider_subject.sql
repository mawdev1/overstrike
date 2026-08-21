-- 0021 — store an identity-provider subject separately from the credential fallback.
-- auth.md §2; db-schema.md §2.

alter table accounts
  add column if not exists identity_provider text,
  add column if not exists identity_subject text;

alter table accounts
  add constraint accounts_identity_provider_pair
  check ((identity_provider is null) = (identity_subject is null));

create unique index if not exists accounts_identity_provider_subject_uq
  on accounts(identity_provider, identity_subject)
  where identity_provider is not null;

comment on column accounts.identity_provider is
  'Credential provider discriminator. Null only for the non-production local-test fallback.';
comment on column accounts.identity_subject is
  'Opaque provider user id. Never an access token and never projected to clients.';
