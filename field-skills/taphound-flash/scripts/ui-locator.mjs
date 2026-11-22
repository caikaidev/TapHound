/** Shared deterministic UI locator for Flash (ADB), Mobile MCP and Appium.
 * One semantic selector + explicit match mode; never choose between ambiguous matches.
 * XML UIAutomator page source only; no browser DOM or visual guesswork.
 */
const MODES = new Set(['exact', 'prefix', 'contains', 'regex']);
const KEYS = ['id', 'text', 'desc'];
const invalid = (message) => Object.assign(new Error(message), {code: 'PLAN_INVALID'});
export function validateTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw invalid('Target must be an object');
  const keys = Object.keys(target).filter(key => KEYS.includes(key));
  const mode = target.match ?? 'exact';
  if (keys.length !== 1 || Object.keys(target).some(key => ![...KEYS, 'match'].includes(key))
      || typeof target[keys[0]] !== 'string' || !target[keys[0]]
      || !MODES.has(mode)) throw invalid('Target needs exactly one id/text/desc and optional match exact|prefix|contains|regex');
  if (mode === 'regex') {
    if (target[keys[0]].length > 512) throw invalid('Target regex is too long');
    try { new RegExp(target[keys[0]]); } catch { throw invalid('Invalid target regex'); }
  }
  return target;
}
const decode = value => String(value).replace(/&(#x[0-9a-f]+|#\d+|quot|apos|lt|gt|amp);/gi, (matched, name) => {
  const named = {quot:'"', apos:"'", lt:'<', gt:'>', amp:'&'};
  if (!name.startsWith('#')) return named[name.toLowerCase()] ?? matched;
  const n = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : matched;
});
function attributes(token) {
  const result = {};
  for (const match of token.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) result[match[1]] = decode(match[2] ?? match[3] ?? '');
  return result;
}
export function parseUiXml(xml, packageName, {appium=false}={}) {
  if (typeof xml !== 'string' || !(appium ? /<[^!?/][^>]*>/.test(xml) : /<(?:hierarchy|node)\b/.test(xml))) throw Object.assign(new Error('Invalid UI hierarchy XML'), {code:'UI_DUMP_FAILED'});
  const roots = [], stack = [];
  const tokens=appium ? xml.matchAll(/<\/?[A-Za-z_][\w.:-]*\b[^>]*>/g) : xml.matchAll(/<\/?node\b[^>]*>/g);
  for (const found of tokens) {
    const token = found[0];
    const tag=/<\/?([A-Za-z_][\w.:-]*)/.exec(token)?.[1];
    if (appium && tag==='hierarchy') continue;
    if (token.startsWith('</')) { if (!stack.length) throw Object.assign(new Error('Unbalanced UI nodes'), {code:'UI_DUMP_FAILED'}); stack.pop(); continue; }
    const attr = attributes(token);
    const nums = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(attr.bounds ?? '');
    const bounds = nums ? nums.slice(1).map(Number) : undefined;
    const element = {
      id: attr['resource-id'] ?? '', text: attr.text ?? '', desc: attr['content-desc'] ?? '',
      pkg: attr.package ?? '', enabled: attr.enabled !== 'false', clickable: attr.clickable === 'true',
      bounds, parent: stack.at(-1), children: []
    };
    if (element.parent) element.parent.children.push(element); else roots.push(element);
    if (!token.endsWith('/>')) stack.push(element);
  }
  if (stack.length || roots.length === 0) throw Object.assign(new Error('Invalid or empty UI hierarchy'), {code:'UI_DUMP_FAILED'});
  const nodes = [];
  const walk = element => { if (!packageName || !element.pkg || element.pkg === packageName) nodes.push(element); element.children.forEach(walk); };
  roots.forEach(walk);
  return nodes;
}
export function targetMatches(element, target, packageName) {
  validateTarget(target);
  if (packageName && element.pkg && element.pkg !== packageName) return false;
  const key = KEYS.find(name => target[name] !== undefined);
  const desired = target[key];
  const actual = String(element[key] ?? '');
  const match = target.match ?? 'exact';
  // Android resource-id may include an application namespace, but class name or arbitrary suffix must not match.
  const candidates = key === 'id' ? [actual, actual.includes(':id/') ? actual.slice(actual.indexOf(':id/')+4) : actual] : [actual];
  return candidates.some(value => match === 'exact' ? value === desired
    : match === 'prefix' ? value.startsWith(desired)
    : match === 'contains' ? value.includes(desired)
    : new RegExp(desired).test(value));
}
export function selectMatches(elements, target, packageName) {
  return elements.filter(element => targetMatches(element, target, packageName));
}
export function centerOf(element, {requireClickable=true, viewport} = {}) {
  if (element.enabled === false) throw Object.assign(new Error('Element is disabled'), {code:'TARGET_DISABLED'});
  const chain = []; for (let n=element; n; n=n.parent) chain.push(n);
  const clickable = chain.find(n => n.clickable);
  if (requireClickable && !clickable) throw Object.assign(new Error('Target has no clickable ancestor'), {code:'NOT_CLICKABLE'});
  if (clickable?.enabled === false) throw Object.assign(new Error('Clickable ancestor is disabled'), {code:'TARGET_DISABLED'});
  const rect = element.bounds ?? clickable?.bounds;
  if (!rect || rect.length !== 4 || rect[0] >= rect[2] || rect[1] >= rect[3] || !rect.every(Number.isFinite)) throw Object.assign(new Error('Invalid target bounds'), {code:'TARGET_UNAVAILABLE'});
  let [left,top,right,bottom] = rect;
  for (const n of chain) if (n.bounds?.length===4) {
    left=Math.max(left,n.bounds[0]);top=Math.max(top,n.bounds[1]);right=Math.min(right,n.bounds[2]);bottom=Math.min(bottom,n.bounds[3]);
  }
  if (viewport) { left=Math.max(0,left);top=Math.max(0,top);right=Math.min(viewport.width,right);bottom=Math.min(viewport.height,bottom); }
  if (left >= right || top >= bottom) throw Object.assign(new Error('Element has no visible bounds'), {code:'TARGET_UNAVAILABLE'});
  return {x:Math.floor((left+right)/2),y:Math.floor((top+bottom)/2)};
}
export function targetXpath(target, packageName) {
  validateTarget(target);
  const key = KEYS.find(name => target[name] !== undefined), mode=target.match ?? 'exact';
  if (mode === 'regex') return null; // XPath 1.0 has no regex; use hierarchy + coordinate actions.
  const attr = key === 'id' ? 'resource-id' : key === 'desc' ? 'content-desc' : 'text';
  const literal = value => !value.includes("'") ? `'${value}'` : !value.includes('"') ? `"${value}"` : `concat(${value.split("'").map(x=>`'${x}'`).join(',"\'",')})`;
  const predicate = value => mode === 'exact' ? `@${attr}=${literal(value)}` : mode === 'prefix' ? `starts-with(@${attr},${literal(value)})` : `contains(@${attr},${literal(value)})`;
  const raw = target[key];
  if (key !== 'id') return `//*[${predicate(raw)}]`;
  return `//*[${predicate(raw)} or ${predicate(`${packageName}:id/${raw}`)}]`;
}
