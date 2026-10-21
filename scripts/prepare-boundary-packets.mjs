import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { capsule } from './public-capsule.mjs';
const bound=capsule();
const packets=Object.fromEntries(Object.entries(bound.files).filter(([p])=>/^dist\/ui-preview\/data\/(?:catalog-(?:reading|learning|trading|investment)|books\/[a-z0-9-]+)\.json$/.test(p)).map(([p,h])=>[p.slice('dist/ui-preview/'.length),h]));
assert.equal(Object.keys(packets).length,12);
writeFileSync('public-packet-manifest.json',JSON.stringify({packets_sha256:packets}));
