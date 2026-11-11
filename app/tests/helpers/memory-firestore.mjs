const DELETED = Symbol('deleted');

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function strip(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createMemoryFirestore() {
  const docs = new Map();
  let chain = Promise.resolve();

  function read(path, overlay) {
    if (overlay?.has(path)) {
      const value = overlay.get(path);
      return value === DELETED ? undefined : value;
    }
    return docs.has(path) ? docs.get(path) : undefined;
  }

  function snapshotDoc(path, row, overlay) {
    const id = path.split('/').slice(1).join('/');
    const exists = row !== undefined;
    return {
      id,
      exists,
      ref: makeRef(path, overlay),
      data() {
        return exists ? clone(row) : undefined;
      },
    };
  }

  function matching(name, filters, overlay) {
    const prefix = `${name}/`;
    const paths = new Set();
    for (const path of docs.keys()) {
      if (path.startsWith(prefix)) paths.add(path);
    }
    if (overlay) {
      for (const [path, value] of overlay) {
        if (!path.startsWith(prefix)) continue;
        if (value === DELETED) paths.delete(path);
        else paths.add(path);
      }
    }
    const rows = [];
    for (const path of paths) {
      const row = read(path, overlay);
      if (!row) continue;
      const ok = filters.every((filter) => {
        const actual = row[filter.field];
        if (filter.op === '==') return actual === filter.value;
        if (filter.op === '>=') return actual >= filter.value;
        if (filter.op === '<=') return actual <= filter.value;
        if (filter.op === '>') return actual > filter.value;
        if (filter.op === '<') return actual < filter.value;
        throw new Error(`Unsupported operator ${filter.op}`);
      });
      if (ok) rows.push({ path, row });
    }
    return rows;
  }

  function querySnapshot(name, filters, limit, overlay) {
    const rows = matching(name, filters, overlay).slice(0, limit);
    return {
      size: rows.length,
      empty: rows.length === 0,
      docs: rows.map(({ path, row }) => snapshotDoc(path, row, overlay)),
    };
  }

  function makeQuery(name, filters = [], limitCount = Number.POSITIVE_INFINITY, overlay = null) {
    return {
      name,
      filters,
      limitCount,
      where(field, op, value) {
        return makeQuery(name, [...filters, { field, op, value }], limitCount, overlay);
      },
      limit(count) {
        return makeQuery(name, filters, count, overlay);
      },
      get() {
        return Promise.resolve(querySnapshot(name, filters, limitCount, overlay));
      },
    };
  }

  function makeRef(path, overlay = null) {
    const id = path.split('/').slice(1).join('/');
    return {
      path,
      id,
      get: async () => snapshotDoc(path, read(path, overlay), overlay),
      set: (data, options) => runTransaction(async (tx) => tx.set(makeRef(path), data, options)),
      create: (data) => runTransaction(async (tx) => tx.create(makeRef(path), data)),
      update: (data) => runTransaction(async (tx) => tx.update(makeRef(path), data)),
      delete: () => runTransaction(async (tx) => tx.delete(makeRef(path))),
    };
  }

  function applyWrite(overlay, path, value) {
    overlay.set(path, value);
  }

  function runTransaction(fn) {
    const run = chain.then(async () => {
      const overlay = new Map();
      const tx = {
        get: async (target) => {
          if (target?.path) return snapshotDoc(target.path, read(target.path, overlay), overlay);
          return querySnapshot(target.name, target.filters, target.limitCount, overlay);
        },
        create(target, data) {
          if (read(target.path, overlay)) throw new Error('Record already exists');
          applyWrite(overlay, target.path, strip(data));
        },
        set(target, data, options) {
          const current = read(target.path, overlay);
          const next = options?.merge && current ? { ...current, ...strip(data) } : strip(data);
          applyWrite(overlay, target.path, next);
        },
        update(target, data) {
          const current = read(target.path, overlay);
          if (!current) throw new Error('Record not found');
          applyWrite(overlay, target.path, { ...current, ...strip(data) });
        },
        delete(target) {
          applyWrite(overlay, target.path, DELETED);
        },
      };
      const result = await fn(tx);
      for (const [path, value] of overlay) {
        if (value === DELETED) docs.delete(path);
        else docs.set(path, clone(value));
      }
      return result;
    });
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    collection(name) {
      return {
        doc: (id) => makeRef(`${name}/${id}`),
        where: (field, op, value) => makeQuery(name, [{ field, op, value }]),
        limit: (count) => makeQuery(name, [], count),
        get: () => makeQuery(name).get(),
        name,
      };
    },
    runTransaction,
    async getAll() {
      return [...docs.entries()].map(([path, row]) => ({ path, ...clone(row) }));
    },
  };
}
