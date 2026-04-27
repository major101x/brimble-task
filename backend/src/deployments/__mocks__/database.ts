const rows = new Map<string, Record<string, unknown>>();

function prepare(sql: string) {
  return {
    run(...args: unknown[]) {
      if (/INSERT/.test(sql)) {
        const p = args[0] as Record<string, unknown>;
        rows.set(p.id as string, { ...p });
      } else if (/UPDATE deployments SET (\w+)/.test(sql)) {
        const col = sql.match(/SET (\w+)/)![1];
        const [val, id] = args as [unknown, string];
        const row = rows.get(id);
        if (row) rows.set(id, { ...row, [col]: val });
      }
    },
    get(...args: unknown[]) {
      return rows.get(args[0] as string) ?? null;
    },
    all() {
      return [...rows.values()].sort((a, b) =>
        (b.created_at as string).localeCompare(a.created_at as string),
      );
    },
  };
}

export function __resetRows() {
  rows.clear();
}

export default { prepare };
