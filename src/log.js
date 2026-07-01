// Tiny leveled logger. Keeps output readable in a terminal and as container
// logs. No dependency on the config module so it can be imported anywhere.
const stamp = () => new Date().toISOString();

export const log = {
  info: (...args) => console.log(stamp(), 'INFO ', ...args),
  warn: (...args) => console.warn(stamp(), 'WARN ', ...args),
  error: (...args) => console.error(stamp(), 'ERROR', ...args),
  debug: (...args) => {
    if (process.env.VERBOSE) console.log(stamp(), 'DEBUG', ...args);
  },
};
