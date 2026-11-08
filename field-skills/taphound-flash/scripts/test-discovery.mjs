/** Conservative test inventory for a changed Android/source module.
 * This is an evidence-producing heuristic, NOT a complete dependency graph.
 * It never runs tests, cannot prove indirect dependencies absent, and does
 * not substitute for Agent inspection of callers, Gradle modules and DI.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { relative, resolve, join, sep, extname, basename } from 'node:path';
import { createHash } from 'node:crypto';
const ignore=new Set(['.git','.gradle','.idea','.taphound','build','dist','out','node_modules','.next','coverage','Pods','.worktrees']);
const MAX_FILES=12000, MAX_TEST_SIZE=1024*1024;
const isTestPath = rel => /(^|\/)(src\/(?:test|androidTest|commonTest|iosTest)|test|tests)\//.test(rel)
  && /(?:\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$|Test\.(?:kt|java)$|Tests\.(?:kt|java)$|Spec\.kt$|\/test\/.*\.(?:kt|java)$|\/androidTest\/.*\.(?:kt|java)$)/.test(rel);
const normalize = value => value.split(sep).join('/');
const moduleOf = path => {
  const match=/^(.*?)\/src\/(?:main|test|androidTest|commonMain|commonTest)\//.exec(path);
  if(match) return match[1]||'.';
  return path.startsWith('src/')||path.startsWith('test/')||path.startsWith('tests/')?'.':path.split('/').slice(0,-1).join('/')||'.';
};
const sha = data => createHash('sha256').update(data).digest('hex');
async function inspect(root){
  const tests=[];const buildFiles=[];let visited=0;let scanComplete=true;const issues=[];
  const stack=[root];
  while(stack.length){
    const folder=stack.pop();
    let entries;
    try { entries=await readdir(folder,{withFileTypes:true}); }
    catch(error){scanComplete=false;issues.push(`Cannot read ${relative(root,folder)}: ${error.code||error.message}`);continue;}
    for(const entry of entries){
      if(++visited>MAX_FILES){scanComplete=false;issues.push(`Scan limit ${MAX_FILES} entries reached`);break;}
      const path=join(folder,entry.name),rel=normalize(relative(root,path));
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory()){if(!ignore.has(entry.name)) stack.push(path);continue;}
      if(!entry.isFile())continue;
      if(isTestPath(rel))tests.push({path:rel,module:moduleOf(rel)});
      if(/(^|\/)(build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|pom\.xml|package\.json)$/.test(rel))buildFiles.push(rel);
    }
    if(!scanComplete&&visited>MAX_FILES)break;
  }
  return {tests,buildFiles,visited,scanComplete,issues};
}
export async function discoverTests(projectRoot, sources, symbols=[]) {
  const root=resolve(projectRoot);
  if(!Array.isArray(sources)||!sources.length)throw new Error('Discover tests requires affected source paths (not only a task description)');
  const normalizedSources=sources.map(source=>{
    const full=resolve(root,source),rel=normalize(relative(root,full));
    if(!rel||rel==='..'||rel.startsWith('../')||rel.startsWith('/'))throw new Error(`Changed source must be inside project: ${source}`);
    return rel;
  });
  const inventory=await inspect(root);
  for(const source of normalizedSources) {
    const info=await stat(join(root,source)).catch(()=>undefined);
    if(!info?.isFile()) {inventory.scanComplete=false;inventory.issues.push(`Affected source is absent or unreadable: ${source}`);}
  }
  const sourceNames=normalizedSources.map(path=>basename(path,extname(path))).filter(name=>name.length>3);
  const sourceModules=new Set(normalizedSources.map(moduleOf));
  const scanSymbols=[...new Set([...sourceNames,...symbols.filter(x=>typeof x==='string'&&/^[A-Za-z_][\w.]{3,80}$/.test(x))])];
  const candidates=[];
  for(const test of inventory.tests){
    const reasons=[];
    if(sourceModules.has(test.module))reasons.push('same-source-module');
    if(sourceNames.some(name=>test.path.includes(name)))reasons.push('name-related');
    if(!reasons.length&&scanSymbols.length){
      try {
        const testPath=join(root,test.path),size=(await stat(testPath)).size;
        if(size>MAX_TEST_SIZE){inventory.scanComplete=false;inventory.issues.push(`Test too large to inspect: ${test.path}`);}
        else {
          const body=await readFile(testPath,'utf8');
          if(scanSymbols.some(name=>body.includes(name)))reasons.push('symbol-reference');
        }
      }catch(error){inventory.scanComplete=false;inventory.issues.push(`Test read failed: ${test.path}: ${error.message}`);}
    }
    if(reasons.length)candidates.push({...test,reasons});
  }
  return {
    version:1,generatedAt:new Date().toISOString(),projectRoot:root,affectedSources:normalizedSources,
    symbols:scanSymbols,sourceModules:[...sourceModules].sort(),
    inventory:{testFiles:inventory.tests.length,buildFiles:inventory.buildFiles,visitedEntries:inventory.visited},
    candidateTests:candidates,scanComplete:inventory.scanComplete,warnings:inventory.issues,
    // A source-aware scan is just an initial candidate inventory, not proof that
    // there are no indirect/dynamic test consumers.
    limitation:'Heuristic scan: inspect cross-module consumers, Gradle dependency graph and dynamically injected call paths before declaring NOT_APPLICABLE',
    inventoryHash:sha(JSON.stringify({sources:normalizedSources,tests:inventory.tests,buildFiles:inventory.buildFiles}))
  };
}
