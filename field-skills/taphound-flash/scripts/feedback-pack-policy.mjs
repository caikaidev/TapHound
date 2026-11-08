/** v3.6 deterministic, critical-first archive selection. No OS / ZIP dependencies. */
const normalized = path => path.replaceAll('\\', '/');
export function archivePriority(path) {
  const p = normalized(path);
  if (['manifest.json','summary.md','index.json','timeline.jsonl','zip-omissions.txt','zip-manifest.json'].includes(p)) return 0;
  if (/^gates\/[^/]+\.json$/.test(p) || /^impact\/(?:plan|current)\.json$/.test(p)
      || /^oracle\/(?:plan|current)\.json$/.test(p) || /^tests\/(?:discovery|execution-results)\.json$/.test(p)
      || p === 'verification-gaps.json') return 0;
  if (/^attempts\/\d+\/(?:attempt|oracle-manifest|git-before|git-after|apk-identity)\.json$/.test(p)
      || /^attempts\/\d+\/evidence\/(?:field-result|result|scenario-results|capture-manifest|logcat-meta)\.json$/.test(p)) return 1;
  if (/^impact\/versions\//.test(p)||/^oracle\/versions\//.test(p)
      || /^attempts\/\d+\/(?:plan\.snapshot\.json|oracles\/)/.test(p)
      || /^tests\/reports\//.test(p)) return 2;
  if (/^attempts\/\d+\/evidence\//.test(p) || /^attempts\/\d+\/(?:stdout|stderr)\.txt$/.test(p)) return 3;
  return 4;
}
export function selectForArchive(entries, limits={maxTotal:70*1024*1024,maxFile:32*1024*1024}) {
  const ranked=[...entries].sort((a,b)=>archivePriority(a.path)-archivePriority(b.path)||a.path.localeCompare(b.path,'en'));
  const included=[],omitted=[],criticalOmitted=[];
  let bytes=0;
  for (const file of ranked) {
    const critical=archivePriority(file.path)<=1;
    const reason=file.size>limits.maxFile?'per-file-limit':bytes+file.size>limits.maxTotal?'archive-budget':null;
    if (reason) {omitted.push({...file,reason});if(critical)criticalOmitted.push(file.path);}
    else {included.push(file);bytes+=file.size;}
  }
  return {included,omitted,criticalOmitted,bytes};
}
