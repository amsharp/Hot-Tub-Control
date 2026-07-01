// Minimal JSON-file persistence. Used for OAuth tokens and schedules. Writes
// are synchronous and atomic-ish (write temp, rename) — fine for a single
// low-traffic personal service.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.js';

export class JsonStore {
  constructor(filename, initial = {}) {
    this.path = join(config.dataDir, filename);
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      try {
        this.data = JSON.parse(readFileSync(this.path, 'utf8'));
      } catch {
        this.data = structuredClone(initial);
      }
    } else {
      this.data = structuredClone(initial);
      this.save();
    }
  }

  save() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
