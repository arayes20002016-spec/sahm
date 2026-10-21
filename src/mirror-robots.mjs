export function wildcardMatch(pattern, value) {
  let character = 0, token = 0, star = -1, checkpoint = 0;
  while (character < value.length) {
    if (pattern[token] === '*') { star = token++; checkpoint = character; }
    else if (pattern[token] === value[character]) { token++; character++; }
    else if (star >= 0) { token = star + 1; character = ++checkpoint; }
    else return false;
  }
  while (pattern[token] === '*') token++;
  return token === pattern.length;
}

export function parseRobots(source, userAgent = 'sahm') {
  const groups = [];
  let current = { agents: [], rules: [] }, hasRules = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(), colon = line.indexOf(':');
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim();
    if (name === 'user-agent') {
      if (hasRules) { groups.push(current); current = { agents: [], rules: [] }; hasRules = false; }
      current.agents.push(value.toLowerCase());
    } else if ((name === 'allow' || name === 'disallow') && current.agents.length) {
      hasRules = true;
      if (value && value.length <= 8192 && current.rules.length < 5000) current.rules.push({ allow: name === 'allow', pattern: value.endsWith('$') ? value.slice(0, -1) : value + '*', length: value.replaceAll('*', '').replace(/\$$/, '').length });
    }
  }
  groups.push(current);
  const specific = groups.filter(group => group.agents.some(agent => agent !== '*' && userAgent.toLowerCase().includes(agent)));
  const selected = specific.length ? specific : groups.filter(group => group.agents.includes('*'));
  const rules = selected.flatMap(group => group.rules);
  return url => {
    const target = new URL(url), address = target.pathname + target.search;
    const matching = rules.filter(rule => wildcardMatch(rule.pattern, address)).sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow));
    return matching[0]?.allow ?? true;
  };
}
