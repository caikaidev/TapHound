import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const cases=[
  ['tap-check', ['验收','Android','change'], ['tap-fix','taphound-flash']],
  ['tap-fix', ['Crash','复现','bug'], ['tap-check','taphound-flash']],
  ['taphound-flash', ['冒烟','ADB','tap-check'], []],
];
describe('copy-ready skill routing',()=>{
  for(const [name,positive] of cases)it(`${name} has matching frontmatter and exact directory`, async()=>{
    const file=await readFile(join(root,name,'SKILL.md'),'utf8');
    assert.match(file,new RegExp(`^---\\nname: ${name}\\n`, 'm'));
    assert.match(file,/description:\s*>-/);
    assert.ok(positive.every(w=>file.includes(w)),`${name}: missing routing context`);
  });
  it('uses sibling Flash relative scripts and requires journal',async()=>{
    for(const name of ['tap-check','tap-fix']){
      const doc=await readFile(join(root,name,'SKILL.md'),'utf8');
      assert.match(doc,/\.\.\/taphound-flash\/scripts\/feedback\.mjs/);
      assert.match(doc,/feedback\.zip/);
    }
    await access(join(root,'taphound-flash','scripts','feedback.mjs'));
    await access(join(root,'taphound-flash','scripts','field-runner.mjs'));
  });
  it('feedback CLI accepts both new and legacy names and creates a feedback bundle',async()=>{
    const script=join(root,'taphound-flash','scripts','feedback.mjs');
    const base=await mkdtemp(join(tmpdir(),'tap-skill-routing-'));
    try {
      for(const [index,name] of ['tap-check','tap-fix','taphound-verify-change','taphound-bug-fix'].entries()){
        const output=join(base,`feedback-${index}`);
        const r=spawnSync(process.execPath,[script,'start','--dir',output,'--skill',name,'--task','Smoke routing'],{encoding:'utf8'});
        assert.equal(r.status,0, `${name}: ${r.stderr} ${r.stdout}`);
        assert.equal(JSON.parse(await readFile(join(output,'manifest.json'),'utf8')).skill,name);
        await access(join(output,'feedback.zip'));
      }
    } finally {await rm(base,{recursive:true,force:true});}
  });
});
