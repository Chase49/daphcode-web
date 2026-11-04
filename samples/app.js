const API = "https://example.com/api";

export async function fetchUsers(limit = 10) {
  const res = await fetch(`${API}/users?limit=${limit}`);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const users = await res.json();
  return users.map(({ id, name, email }) => ({ id, name, email: email.toLowerCase() }));
}

class Counter {
  #count = 0;
  increment(step = 1) {
    this.#count += step;
    return this;
  }
  get value() {
    return this.#count;
  }
}

const c = new Counter().increment().increment(5);
console.log(`Counter is ${c.value}`, /^\d+$/.test(String(c.value)));
