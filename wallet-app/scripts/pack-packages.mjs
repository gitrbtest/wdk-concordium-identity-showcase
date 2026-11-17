/**
 * Pack the identity package from a clone of the fork into ./packages, so the app installs it as npm would install
 * the published package (npm install then picks it up from package.json). Only needed to update the snapshot that is
 * already in ./packages.
 *
 *   npm run pack-packages && npm install
 *
 * IDENTITY_PACKAGE: the identity package folder (default: ../../tether-wdk-concordium/identity, a clone of the fork
 * next to this repository).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const here = fileURLToPath(new URL('../', import.meta.url));
const identity = resolve(process.env.IDENTITY_PACKAGE ?? resolve(here, '../../tether-wdk-concordium/identity'));
const packages = fileURLToPath(new URL('../packages/', import.meta.url));
mkdirSync(packages, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const out = execFileSync(npm, ['pack', '--pack-destination', packages], { cwd: identity, encoding: 'utf8', shell: process.platform === 'win32' });
console.log(`Packed into ${packages}: ${out.trim().split('\n').pop()} (from ${identity}; app in ${here})`);
