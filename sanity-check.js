const { editors } = require('./editors/index');
const antigravityCli = editors.find(e => e.name === 'antigravity-cli');

if (!antigravityCli) {
  console.error('FAIL: antigravity-cli adapter not found in editors array');
  process.exit(1);
}

const requiredFunctions = ['getChats', 'getMessages', 'getArtifacts', 'getMCPServers'];
for (const fn of requiredFunctions) {
  if (typeof antigravityCli[fn] !== 'function') {
    console.error(`FAIL: ${fn} is not a function`);
    process.exit(1);
  }
}

console.log('SUCCESS: antigravity-cli adapter is correctly registered and exported.');
