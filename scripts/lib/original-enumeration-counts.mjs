// Instrument the exact already-rewritten CMain from the bb22 full build.
// This module writes no file and never executes a game/probe/compiler.
export const ENUMERATION_BASE_BRIDGE_SHA256 = '57c3b5da941bca71009c5b30bb265053eb39a309dc1f75850933cd6cc5aad94a';
export const ENUMERATION_BASE_SWF_SHA256 = 'bb22a56d3efd8065b948664264aa5726a5b73e293ce1ddc43b4b7ef2bdccb659';

function replaceOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) !== -1)
    throw new Error('Enumeration diagnostic requires exactly one ' + label);
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

export function enumerationMethodRange(source, name, tokenize) {
  const t = tokenize(source), found = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i].string || t[i].value !== 'function' || t[i + 1]?.value !== name || t[i + 2]?.value !== '(') continue;
    let j = i + 2, depth = 1;
    while (++j < t.length && depth) {
      if (t[j].string) continue;
      if (t[j].value === '(') depth++;
      if (t[j].value === ')') depth--;
    }
    if (t[j]?.value !== '{') throw new Error('Enumeration diagnostic missing body ' + name);
    const start = t[j].end;
    depth = 1;
    while (++j < t.length && depth) {
      if (t[j].string) continue;
      if (t[j].value === '{') depth++;
      if (t[j].value === '}') depth--;
    }
    if (depth) throw new Error('Enumeration diagnostic unterminated body ' + name);
    found.push({ start, end: t[j - 1].start });
  }
  if (found.length !== 1) throw new Error('Enumeration diagnostic expected one method ' + name);
  return found[0];
}

export function instrumentEnumerationCounts(source, tokenize, members) {
  if (typeof source !== 'string' || typeof tokenize !== 'function' || typeof members !== 'string')
    throw new Error('Enumeration diagnostic requires source, tokenizer and members');
  if (/__bhEnum|BH_EnumBegin|BH_EnumRecord|BH_EnumFinish|BH_EnumerationCounts|bhEnumerationCounts/.test(source))
    throw new Error('Enumeration diagnostic was already installed or local names collide');
  const scoped = (name, transform) => {
    const { start, end } = enumerationMethodRange(source, name, tokenize);
    source = source.slice(0, start) + transform(source.slice(start, end)) + source.slice(end);
  };
  scoped('BH_Project', body => {
    body = replaceOnce(body, '      for(var key in value)\n      {',
      '      var __bhEnumTotal = 0;\n      var __bhEnumOwn = 0;\n      for(var key in value)\n      {\n         __bhEnumTotal++;', 'BH_Project own-field loop');
    body = replaceOnce(body, '         if(!value.hasOwnProperty(key)) continue;',
      '         if(!value.hasOwnProperty(key)) continue;\n         __bhEnumOwn++;', 'BH_Project existing hasOwn guard');
    return replaceOnce(body, '      if(keys != undefined && keys.length > 1) keys.sort();',
      '      CMain.BH_EnumRecord(0,className,__bhEnumTotal,__bhEnumOwn);\n      if(keys != undefined && keys.length > 1) keys.sort();', 'BH_Project loop exit');
  });
  scoped('BH_Scalars', body => {
    body = replaceOnce(body, '      for(var key in object)\n      {',
      '      var __bhEnumTotal = 0;\n      var __bhEnumOwn = 0;\n      for(var key in object)\n      {\n         __bhEnumTotal++;', 'BH_Scalars loop');
    body = replaceOnce(body, '         if(!object.hasOwnProperty(key)) continue;',
      '         if(!object.hasOwnProperty(key)) continue;\n         __bhEnumOwn++;', 'BH_Scalars existing hasOwn guard');
    return replaceOnce(body, '      return out;',
      '      CMain.BH_EnumRecord(1,undefined,__bhEnumTotal,__bhEnumOwn);\n      return out;', 'BH_Scalars loop exit');
  });
  scoped('BH_FrameState', body => {
    body = replaceOnce(body, '      var started = getTimer();',
      '      CMain.BH_EnumBegin("frame",b.tick);\n      var started = getTimer();', 'compact projection start');
    body = replaceOnce(body, '         for(var scalarKey in thing)\n         {',
      '         var __bhEnumTotal = 0;\n         var __bhEnumOwn = 0;\n         for(var scalarKey in thing)\n         {\n            __bhEnumTotal++;', 'compact entity loop');
    body = replaceOnce(body, '            if(!thing.hasOwnProperty(scalarKey)) continue;',
      '            if(!thing.hasOwnProperty(scalarKey)) continue;\n            __bhEnumOwn++;', 'compact existing hasOwn guard');
    body = replaceOnce(body, '         scalars.$class = thing._CLASSID_;',
      '         scalars.$class = thing._CLASSID_;\n         CMain.BH_EnumRecord(2,scalars.$class,__bhEnumTotal,__bhEnumOwn);', 'already-read compact class');
    return replaceOnce(body, '      return b.snapshot;',
      '      CMain.BH_EnumFinish(b.snapshot);\n      return b.snapshot;', 'compact final snapshot');
  });
  scoped('BH_State', body => {
    body = replaceOnce(body, '      var context = {objects:new Array(),errorPath:new Array(),fields:0};',
      '      CMain.BH_EnumBegin("full",b.tick);\n      var context = {objects:new Array(),errorPath:new Array(),fields:0};', 'full projection start after cache return');
    return replaceOnce(body, '         if(forceFull != true || b.tick % 25 == 0)',
      '         CMain.BH_EnumFinish(snapshot);\n         if(forceFull != true || b.tick % 25 == 0)', 'full final snapshot');
  });
  const t = tokenize(source);
  if (t.at(-1)?.value !== '}') throw new Error('Enumeration diagnostic requires a complete CMain class');
  const sequence = ['this', '.', 'BH_ReplayRegister', '(', ')', ';'];
  const offsets = t.flatMap((item, index) => sequence.every((value, offset) =>
    t[index + offset]?.value === value && !t[index + offset]?.string) ? [t[index + sequence.length - 1].end] : []);
  if (offsets.length !== 1 || offsets[0] >= t.at(-1).start)
    throw new Error('Enumeration diagnostic requires the existing constructor replay registration');
  return source.slice(0, offsets[0]) + '\n      this.BH_EnumerationRegister();'
    + source.slice(offsets[0], t.at(-1).start) + '\n' + members + '\n' + source.slice(t.at(-1).start);
}
