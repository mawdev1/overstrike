/** One build-owned lobby→match loadout mapping, consumed by both control and game planes. */
export const LIVE_LOADOUT_CATALOG = Object.freeze({
  version: 'alpha-1',
  primary: Object.freeze([
    Object.freeze({ idx: 0, weaponId: 'ar_vector', label: 'VK-7 Vector', eligible: true }),
    Object.freeze({ idx: 1, weaponId: 'dmr_meridian', label: 'M-14 Meridian', eligible: true }),
  ]),
  secondary: Object.freeze([
    Object.freeze({ idx: 0, weaponId: 'pistol_viper', label: 'P-11 Viper', eligible: true }),
  ]),
});

export function liveWeaponId(slot, idx) {
  return LIVE_LOADOUT_CATALOG[slot]?.find((item) => item.idx === idx && item.eligible)?.weaponId ?? null;
}

export function publicLoadoutCatalog() {
  return {
    version: LIVE_LOADOUT_CATALOG.version,
    primary: LIVE_LOADOUT_CATALOG.primary.map(({ weaponId: _weaponId, ...item }) => ({ ...item })),
    secondary: LIVE_LOADOUT_CATALOG.secondary.map(({ weaponId: _weaponId, ...item }) => ({ ...item })),
  };
}
