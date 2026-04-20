/**
 * Maps a {@link Volume} label to the numeric parameters consumed by
 * the security-documents-generator standard sequence.
 *
 * Kept in config/ (not in the runner) so callers that only need to display
 * or validate volume options can import the constant without pulling in the
 * entire runner module.
 */
export const VOLUME_PRESETS = {
  light:  { events: 200,  hosts: 5,  users: 5,  extraAlerts: 1000,  orgSize: 'small' },
  medium: { events: 500,  hosts: 10, users: 10, extraAlerts: 10000, orgSize: 'medium' },
  heavy:  { events: 2000, hosts: 25, users: 25, extraAlerts: 50000, orgSize: 'enterprise' },
} as const;
