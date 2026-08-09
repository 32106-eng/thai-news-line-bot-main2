// จำลอง Firestore แบบง่ายพอสำหรับ unit test service layer โดยไม่ต้องต่อ Firestore จริง
// รองรับ: doc().get/set/create, collection().add, where().orderBy().limit().get, runTransaction (best-effort, ไม่ true-atomic แต่พอสำหรับ logic test)

function matchesWhere(data, clauses) {
  return clauses.every(([field, op, value]) => {
    const actual = data[field];
    if (op === "==") return actual === value;
    throw new Error(`Unsupported operator in fake: ${op}`);
  });
}

export function createFakeFirestore() {
  const store = new Map(); // collectionName -> Map(docId -> data)

  function collectionMap(name) {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name);
  }

  function makeDocRef(collectionName, id) {
    return {
      id,
      async get() {
        const map = collectionMap(collectionName);
        const data = map.get(id);
        return { exists: data !== undefined, id, data: () => (data ? { ...data } : undefined) };
      },
      async set(data, opts) {
        const map = collectionMap(collectionName);
        const prev = map.get(id) ?? {};
        map.set(id, opts?.merge ? { ...prev, ...data } : { ...data });
      },
      async create(data) {
        const map = collectionMap(collectionName);
        if (map.has(id)) { const e = new Error("ALREADY_EXISTS"); e.code = 6; throw e; }
        map.set(id, { ...data });
      }
    };
  }

  function makeQuery(collectionName, clauses = [], sort = null, limitN = null) {
    return {
      where(field, op, value) { return makeQuery(collectionName, [...clauses, [field, op, value]], sort, limitN); },
      orderBy(field, dir = "asc") { return makeQuery(collectionName, clauses, { field, dir }, limitN); },
      limit(n) { return makeQuery(collectionName, clauses, sort, n); },
      async get() {
        const map = collectionMap(collectionName);
        let docs = [...map.entries()].filter(([, data]) => matchesWhere(data, clauses)).map(([id, data]) => ({ id, data: () => ({ ...data }), ref: makeDocRef(collectionName, id) }));
        if (sort) docs.sort((a, b) => { const av = a.data()[sort.field], bv = b.data()[sort.field]; const cmp = av < bv ? -1 : av > bv ? 1 : 0; return sort.dir === "desc" ? -cmp : cmp; });
        if (limitN) docs = docs.slice(0, limitN);
        return { empty: docs.length === 0, docs };
      }
    };
  }

  let autoIdCounter = 0;

  function makeCollection(name) {
    return {
      doc(id) { return makeDocRef(name, id ?? `auto_${++autoIdCounter}`); },
      async add(data) {
        const ref = makeDocRef(name, `auto_${++autoIdCounter}`);
        await ref.set(data);
        return ref;
      },
      where(field, op, value) { return makeQuery(name, [[field, op, value]]); },
      orderBy(field, dir) { return makeQuery(name, [], { field, dir }); },
      async get() {
        const map = collectionMap(name);
        return { docs: [...map.entries()].map(([id, data]) => ({ id, data: () => ({ ...data }) })) };
      }
    };
  }

  const db = {
    collection: makeCollection,
    async runTransaction(fn) {
      // best-effort: การทดสอบ logic นี้รันแบบ single-threaded อยู่แล้วจึงไม่มี race จริง
      const tx = {
        async get(ref) { return ref.get(); },
        set(ref, data, opts) { ref.set(data, opts); },
        create(ref, data) { ref.create(data); }
      };
      return fn(tx);
    }
  };

  const FieldValue = { serverTimestamp: () => new Date() };

  return { db, FieldValue, collection: makeCollection };
}
