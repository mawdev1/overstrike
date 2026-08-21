/** Network clients predict player feel; only practice and dedicated servers run Match rules. */
export function advancesLocalReferee(networkSession) {
  return !networkSession;
}
