/**
 * Callsign pool for AI operators.
 *
 * Kept deliberately varied in shape — single words, compound tags, numbered
 * variants — so a lobby of 12 bots never reads as one naming scheme.
 * BotManager shuffles this with the seeded RNG and assigns without repeats.
 */
export const BOT_NAMES = [
  'REAPER', 'VULTURE', 'HOLLOW', 'DRIFTER', 'ONYX', 'STILETTO',
  'GHOST-9', 'TALLBOY', 'KESTREL', 'MARLOW', 'BRIMSTONE', 'ASHFALL',
  'PIKE', 'SANDMAN', 'HAVOC', 'RONIN', 'COLDIRON', 'VESPER',
  'NOMAD', 'JACKAL', 'SIXGUN', 'TETHER', 'MAVERICK', 'BLACKOUT',
  'CINDER', 'HALYARD', 'GRIMWALD', 'ZERO-K', 'RAMROD', 'SABLE',
  'THRESHER', 'IRONWOOD', 'CAIRN', 'VANDAL', 'PRIEST', 'LONGSHOT',
  'BADGER', 'ECHO-7', 'HANGFIRE', 'SALTLICK', 'MERIDIAN', 'CROWBAR',
  'DUSTOFF', 'WARDEN', 'TOMBSTONE', 'FLINT', 'ODDJOB', 'NIGHTJAR',
];

export default BOT_NAMES;
