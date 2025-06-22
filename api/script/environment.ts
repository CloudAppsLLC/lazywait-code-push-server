import * as os from 'os';
import * as path from 'path';

export function getTempDirectory(): string {
  return process.env.TEMP || process.env.TMPDIR || path.join(os.tmpdir(), 'codepush-temp');
}
