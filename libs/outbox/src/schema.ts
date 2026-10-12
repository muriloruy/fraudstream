/** Schema names are SQL identifiers and cannot be bound as parameters, so they are validated. */
export function assertSchemaName(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new RangeError(`invalid schema name "${schema}"`);
  }
  return schema;
}
