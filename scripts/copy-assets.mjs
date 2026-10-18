import { cpSync } from 'node:fs';
import { URL } from 'node:url';
cpSync(new URL('../src/assets/', import.meta.url), new URL('../dist/assets/', import.meta.url), { recursive: true });
