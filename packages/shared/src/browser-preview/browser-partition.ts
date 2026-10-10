const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Returns the persistent Browser partition for a UUID workspace; rejects other ids. */
export function browserPartitionFor(workspaceId: string): string {
  if (!UUID.test(workspaceId)) throw new TypeError("Browser workspace id must be a UUID");
  return `persist:mcode-browser-${workspaceId.toLowerCase()}`;
}
