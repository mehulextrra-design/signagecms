// In-memory PDF store — holds generated PDF buffers long enough for Aisensy to download them
const store = new Map();

function storePDF(id, buffer) {
  store.set(id, buffer);
  // Auto-cleanup after 30 minutes
  setTimeout(() => store.delete(id), 30 * 60 * 1000);
}

function getPDF(id) {
  return store.get(id) || null;
}

module.exports = { storePDF, getPDF };
