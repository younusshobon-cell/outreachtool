// Only authenticated server context or a database-enumerated cron workspace may set this ID.
export function tenant(env) {
  if (!/^[a-f0-9]{32}$/.test(env.TENANT_ID || '')) throw Error('Workspace context required');
  return env.TENANT_ID;
}
