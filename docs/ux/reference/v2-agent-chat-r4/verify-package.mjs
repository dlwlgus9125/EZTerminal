// Validate reference fingerprints and local links without changing any artifact.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(root,'../../../..');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
for(const [file,expected]of Object.entries(manifest.files))assert.equal(hash(await fs.readFile(path.join(root,file))),expected,`Artifact changed: ${file}`);
for(const [file,expected]of Object.entries(manifest.sources))assert.equal(hash(await fs.readFile(path.join(repo,file))),expected,`Source changed: ${file}`);
let preserved=0;
for(const version of ['r1','r2','r3']){
  const earlier=path.resolve(root,`../v2-agent-chat-${version}`),old=JSON.parse(await fs.readFile(path.join(earlier,'manifest.json'),'utf8'));
  for(const [file,expected]of Object.entries(old.files)){assert.equal(hash(await fs.readFile(path.join(earlier,file))),expected,`Earlier artifact changed: ${version}/${file}`);preserved++;}
  // Earlier source fingerprints are historical, not assertions about today's source tree.
}
const docs=(await fs.readdir(root)).filter(f=>f.endsWith('.md')).map(f=>path.join(root,f));docs.push(path.join(repo,'docs/ux/agent-workflow-plan.md'));
let links=0;
for(const file of docs){const body=await fs.readFile(file,'utf8');for(const match of body.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)){const target=match[1];if(/^(?:https?:|#|mailto:)/.test(target))continue;const pathname=decodeURIComponent(target.split(/[?#]/)[0]);await fs.access(path.resolve(path.dirname(file),pathname));links++;}}
let checks=0;for(const name of ['qa-report.json','journey-report.json','plans-report.json','workflows-report.json']){const report=JSON.parse(await fs.readFile(path.join(root,name),'utf8'));assert.equal(report.passed,true,name);assert.ok(report.checks.every(c=>c.passed));checks+=report.checks.length;}
const plan=await fs.readFile(path.join(repo,'docs/ux/agent-workflow-plan.md'),'utf8');
const scenarios=[...plan.matchAll(/^\| (S\d{2}) \|/gm)].map(m=>m[1]);assert.equal(scenarios.length,46);assert.equal(new Set(scenarios).size,46);
console.log(JSON.stringify({artifacts:Object.keys(manifest.files).length,sources:Object.keys(manifest.sources).length,preservedEarlierFiles:preserved,localLinks:links,scenarioIds:scenarios.length,prototypeChecks:checks,approved:manifest.approved,productImplemented:manifest.productImplemented},null,2));
