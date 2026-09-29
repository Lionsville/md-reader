// Validates src-tauri/tauri.conf.json (and each platform file merged on top of it) against the
// JSON schema shipped with the installed @tauri-apps/cli. Dependency-free: implements the
// subset of JSON Schema draft-07 that the Tauri schema uses.
//
//   node scripts/validate-config.mjs
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(root, 'node_modules/@tauri-apps/cli/config.schema.json'), 'utf8'));

const typeOf = (v) =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;

function resolve(s) {
  while (s && s.$ref) {
    const path = s.$ref.replace(/^#\//, '').split('/');
    s = path.reduce((o, k) => o[k], schema);
  }
  return s;
}

/** Returns a list of error strings (empty = valid). */
function validate(value, s, at) {
  s = resolve(s);
  if (s === true || s === undefined) return [];
  if (s === false) return [`${at}: not allowed`];
  const errs = [];
  if (s.type) {
    const types = [].concat(s.type);
    const t = typeOf(value);
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) {
      return [`${at}: expected ${types.join('|')}, got ${t}`];
    }
  }
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errs.push(`${at}: must be one of ${JSON.stringify(s.enum)}`);
  }
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(value)) errs.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (s.allOf) for (const sub of s.allOf) errs.push(...validate(value, sub, at));
  if (s.anyOf && !s.anyOf.some((sub) => validate(value, sub, at).length === 0)) {
    errs.push(`${at}: does not match any allowed shape`);
  }
  if (s.oneOf) {
    const ok = s.oneOf.filter((sub) => validate(value, sub, at).length === 0).length;
    if (ok !== 1) errs.push(`${at}: must match exactly one allowed shape (matched ${ok})`);
  }
  if (typeOf(value) === 'object') {
    for (const r of s.required || []) if (!(r in value)) errs.push(`${at}: missing required "${r}"`);
    for (const [k, v] of Object.entries(value)) {
      if (k === '$schema') continue;
      if (s.properties && k in s.properties) errs.push(...validate(v, s.properties[k], `${at}.${k}`));
      else if (s.additionalProperties === false) errs.push(`${at}: unknown property "${k}"`);
      else if (typeof s.additionalProperties === 'object') errs.push(...validate(v, s.additionalProperties, `${at}.${k}`));
    }
  }
  if (typeOf(value) === 'array' && s.items && !Array.isArray(s.items)) {
    value.forEach((v, i) => errs.push(...validate(v, s.items, `${at}[${i}]`)));
  }
  return errs;
}

// RFC 7396 JSON merge patch, which is how Tauri applies tauri.<platform>.conf.json.
function merge(target, patch) {
  if (typeOf(patch) !== 'object') return patch;
  const out = typeOf(target) === 'object' ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = merge(out[k], v);
  }
  return out;
}

const dir = join(root, 'src-tauri');
const base = JSON.parse(readFileSync(join(dir, 'tauri.conf.json'), 'utf8'));
let failed = false;
for (const platform of [null, 'macos', 'windows', 'linux']) {
  const file = platform ? `tauri.${platform}.conf.json` : 'tauri.conf.json';
  if (platform && !existsSync(join(dir, file))) continue;
  const cfg = platform ? merge(base, JSON.parse(readFileSync(join(dir, file), 'utf8'))) : base;
  const errs = validate(cfg, schema, 'config');
  console.log(`${errs.length ? 'FAIL' : 'ok  '} ${file}${platform ? ' (merged)' : ''}`);
  for (const e of errs) console.log(`     ${e}`);
  failed ||= errs.length > 0;
}
process.exit(failed ? 1 : 0);
