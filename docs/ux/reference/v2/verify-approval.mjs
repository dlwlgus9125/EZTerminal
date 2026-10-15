import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {designApproval} from './design-approval.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'ezterminal-v2-approval-'));
try {
  for(const name of ['build.mjs','build-delivery.mjs','build-policies.mjs','content.mjs','ai-planning.mjs','delivery-planning.mjs','policy-planning.mjs','design-approval.mjs']) {
    await fs.copyFile(path.join(root,name),path.join(temporary,name));
  }
  const preserved={schemaVersion:1,packageVersion:'0.1-review',revision:6,
    implementationApproved:false,screens:{D18:'reviewed',M04:'changes'},
    comments:[{screenId:'M04',text:'Retain actual user review; do not mark every screen reviewed.',at:'2026-10-13'}]};
  const logPath=path.join(temporary,'review-log.json');
  await fs.writeFile(logPath,JSON.stringify(preserved));
  const build=()=>execFileSync(process.execPath,['build.mjs'],{cwd:temporary,encoding:'utf8',stdio:'pipe'});
  build();
  const first=await fs.readFile(logPath,'utf8');
  const result=JSON.parse(first);
  assert.equal(result.implementationApproved,true);
  assert.deepEqual(result.designApproval,designApproval);
  assert.equal(result.screens.D18,'reviewed');
  assert.equal(result.screens.M04,'changes');
  assert.equal(result.screens.D01,'pending');
  assert.deepEqual(result.comments,preserved.comments);
  build();
  assert.equal(await fs.readFile(logPath,'utf8'),first,'Repeated generation must preserve approval and review bytes.');
  await fs.writeFile(logPath,'{broken-review-json');
  assert.throws(build,undefined,'Unreadable review history must stop generation rather than erase it.');
  assert.equal(await fs.readFile(logPath,'utf8'),'{broken-review-json');
  console.log('approval:check OK: authorization, screen marks, comments, repeat generation and corrupt-history preservation.');
} finally {
  const parent=path.resolve(os.tmpdir())+path.sep;
  assert.ok(path.resolve(temporary).startsWith(parent)&&path.basename(temporary).startsWith('ezterminal-v2-approval-'));
  await fs.rm(temporary,{recursive:true,force:true});
}
