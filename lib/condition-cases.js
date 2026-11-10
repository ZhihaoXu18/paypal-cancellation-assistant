const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function createConditionCases(directory) {
  const memory = new Map();
  function ownerDirectory(owner) {
    if (!uuid.test(owner)) throw new Error('Invalid case owner.');
    return path.join(directory, owner);
  }
  function list(owner) {
    if (!directory) return [...(memory.get(owner)?.values() || [])];
    const folder = ownerDirectory(owner);
    let entries;
    try { entries = fs.readdirSync(folder); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return entries.filter(name => uuid.test(name.slice(0, -5)) && name.endsWith('.json'))
      .map(name => JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')));
  }
  function get(owner, id) {
    if (!uuid.test(id)) return null;
    if (!directory) return memory.get(owner)?.get(id) || null;
    try { return JSON.parse(fs.readFileSync(path.join(ownerDirectory(owner), id + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function save(owner, record) {
    if (!directory) {
      if (!memory.has(owner)) memory.set(owner, new Map());
      memory.get(owner).set(record.id, record);
      return;
    }
    const folder = ownerDirectory(owner);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const destination = path.join(folder, record.id + '.json');
    const temp = path.join(folder, randomUUID() + '.tmp');
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    try { fs.renameSync(temp, destination); }
    finally { fs.rmSync(temp, { force: true }); }
  }
  return { get, list, save };
}

module.exports = { createConditionCases };
