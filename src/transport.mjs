let currentFetch = (input, init) => globalThis.fetch(input, init);

// Only the desktop host sets this. Unit consumers retain an ordinary Fetch API.
export function setTransportFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch function is required');
  currentFetch = fetchImpl;
}

export function transportFetch(input, init) { return currentFetch(input, init); }
