import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTopicsConf } from '../src/topics.js';

const target = fileURLToPath(new URL('../../../infra/kafka/topics.conf', import.meta.url));
// `target` is a fixed path inside the repository.
// eslint-disable-next-line security/detect-non-literal-fs-filename
writeFileSync(target, renderTopicsConf());
console.log(`wrote ${target}`);
