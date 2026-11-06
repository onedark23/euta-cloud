// Runner entry: config from env → loop. SIGTERM/SIGINT = graceful (stop claiming, let running runs
// finish); a second signal kills the engines without reporting (the server aborts them on lease expiry).
import { loadRunnerConfig } from './config.js';
import { startRunner } from './runner.js';

const runner = startRunner(loadRunnerConfig());
let signals = 0;
const onSignal = () => {
  signals++;
  void runner.stop({ graceful: signals === 1 }).then(() => process.exit(0));
};
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);
