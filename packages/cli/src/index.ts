import { createRequire } from 'node:module';
import { program } from 'commander';
import { registerConnectCommand } from './commands/connect.js';
import { registerLoginCommand } from './commands/login.js';
import { registerStatusCommand } from './commands/status.js';
import { registerListCommand } from './commands/list.js';
import { registerStartCommand } from './commands/start.js';
import { registerStopCommand } from './commands/stop.js';
import { registerRestartCommand } from './commands/restart.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerRemoveCommand } from './commands/remove.js';
import { registerOpenCommand } from './commands/open.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

program
  .name('agent-bridge')
  .description('Connect local AI agents to the Agents.Hot platform')
  .version(version)
  .option('-v', 'output the version number')
  .on('option:v', () => { console.log(version); process.exit(0); });

registerConnectCommand(program);
registerLoginCommand(program);
registerStatusCommand(program);
registerListCommand(program);
registerStartCommand(program);
registerStopCommand(program);
registerRestartCommand(program);
registerLogsCommand(program);
registerRemoveCommand(program);
registerOpenCommand(program);

program.parse();
