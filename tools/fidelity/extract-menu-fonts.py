#!/usr/bin/env python3
"""Read-only original SWF text/font and main-menu placement evidence."""
import hashlib,json,struct,sys,zlib
from pathlib import Path
raw=Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(raw).hexdigest()=='34ff145d96891ddea20278700c8b1fb6fd6273ca0e71b73d8bdf0df183fdbece'
body=zlib.decompress(raw[8:]) if raw[:3]==b'CWS' else raw[8:]
class Bits:
 def __init__(self,data,pos=0):self.data=data;self.bit=pos*8
 def get(self,n,signed=False):
  v=0
  for _ in range(n):v=(v<<1)|((self.data[self.bit//8]>>(7-self.bit%8))&1);self.bit+=1
  return v-(1<<n) if signed and n and v&(1<<(n-1)) else v
 def align(self):self.bit=(self.bit+7)//8*8;return self.bit//8
 def rect(self):
  n=self.get(5);a=[self.get(n,True) for _ in range(4)];self.align();return a
 def matrix(self):
  m={'scaleX':1,'scaleY':1,'rotate0':0,'rotate1':0,'translateX':0,'translateY':0}
  if self.get(1):
   n=self.get(5);m['scaleX']=self.get(n,True)/65536;m['scaleY']=self.get(n,True)/65536
  if self.get(1):
   n=self.get(5);m['rotate0']=self.get(n,True)/65536;m['rotate1']=self.get(n,True)/65536
  n=self.get(5);m['translateX']=self.get(n,True)/20;m['translateY']=self.get(n,True)/20;self.align();return m
 def cx(self,alpha=True):
  add=self.get(1);mult=self.get(1);n=self.get(4);count=4 if alpha else 3
  d={}
  if mult:d['mult']=[self.get(n,True) for _ in range(count)]
  if add:d['add']=[self.get(n,True) for _ in range(count)]
  self.align();return d
fonts={};texts={};placements=[];exports={};definitions={}
def u16(p,o):return struct.unpack_from('<H',p,o)[0]
def cstr(p,o):
 e=p.index(0,o);return p[o:e].decode('utf8','replace'),e+1
def walk(data,pos,parent='root'):
 while pos<len(data):
  h=u16(data,pos);pos+=2;code=h>>6;n=h&63
  if n==63:n=struct.unpack_from('<I',data,pos)[0];pos+=4
  p=data[pos:pos+n];pos+=n
  if code==0:break
  if code in (48,75):
   fid=u16(p,0);flags=p[2];name=p[5:5+p[4]].decode('utf8','replace');q=5+p[4];count=u16(p,q);q+=2;base=q;wide=bool(flags&8);size=4 if wide else 2
   codeoff=int.from_bytes(p[q+count*size:q+(count+1)*size],'little');codesat=base+codeoff;codesize=2 if flags&4 else 1
   codes=[int.from_bytes(p[codesat+i*codesize:codesat+(i+1)*codesize],'little') for i in range(count)]
   font={'id':fid,'tag':code,'name':name,'bold':bool(flags&1),'italic':bool(flags&2),'hasLayout':bool(flags&128),'glyphCount':count,'codes':codes}
   if flags&128:
    at=codesat+count*codesize;font['ascent'],font['descent'],font['leading']=struct.unpack_from('<hhh',p,at);at+=6
    font['advances']=list(struct.unpack_from('<'+'h'*count,p,at));at+=2*count
    font['bounds']=[]
    for _ in range(count):r=Bits(p,at);font['bounds'].append(r.rect());at=r.align()
    kern=u16(p,at);at+=2;font['kerning']=[]
    for _ in range(kern):
     a=int.from_bytes(p[at:at+codesize],'little');at+=codesize;b=int.from_bytes(p[at:at+codesize],'little');at+=codesize;v=struct.unpack_from('<h',p,at)[0];at+=2;font['kerning'].append([a,b,v])
   fonts[fid]=font
  elif code in (11,33):
   tid=u16(p,0);r=Bits(p,2);bounds=r.rect();matrix=r.matrix();q=r.align();gb,ab=p[q:q+2];q+=2;records=[];state={}
   while p[q]:
    flags=p[q];q+=1
    if flags&8:state['fontId']=u16(p,q);q+=2
    if flags&4:state['color']=list(p[q:q+(4 if code==33 else 3)]);q+=4 if code==33 else 3
    if flags&1:state['xOffsetTwips']=struct.unpack_from('<h',p,q)[0];q+=2
    if flags&2:state['yOffsetTwips']=struct.unpack_from('<h',p,q)[0];q+=2
    if flags&8:state['textHeightTwips']=u16(p,q);q+=2
    count=p[q];q+=1;r=Bits(p,q);glyphs=[{'index':r.get(gb),'advanceTwips':r.get(ab,True)} for _ in range(count)];q=r.align();records.append({**state,'glyphs':glyphs})
   texts[tid]={'id':tid,'tag':code,'boundsTwips':bounds,'matrix':matrix,'records':records}
  elif code==39:
   sid=u16(p,0);definitions[sid]={'type':'sprite','frames':u16(p,2)};walk(p,4,sid)
  elif code in (56,76):
   q=2
   for _ in range(u16(p,0)):
    sid=u16(p,q);q+=2;name,q=cstr(p,q);exports[sid]=name
  elif code in (4,26,70):
   try:
    if code==4:
     item={'parent':parent,'depth':u16(p,2),'characterId':u16(p,0)};r=Bits(p,4);item['matrix']=r.matrix()
    else:
     flags=p[0];flags2=p[1] if code==70 else 0;q=2 if code==70 else 1;item={'parent':parent,'depth':u16(p,q),'flags':flags};q+=2
     if code==70 and (flags2&8 or flags2&16 and flags&2):item['className'],q=cstr(p,q)
     if flags&2:item['characterId']=u16(p,q);q+=2
     if flags&4:r=Bits(p,q);item['matrix']=r.matrix();q=r.align()
     if flags&8:r=Bits(p,q);item['colorTransform']=r.cx();q=r.align()
     if flags&16:item['ratio']=u16(p,q);q+=2
     if flags&32:item['name'],q=cstr(p,q)
    placements.append(item)
   except (IndexError,ValueError,struct.error) as e:placements.append({'parent':parent,'parseError':str(e),'tag':code})
r=Bits(body);stage=r.rect();walk(body,r.align()+4)
for text in texts.values():
 for record in text['records']:
  codes=fonts.get(record.get('fontId'),{}).get('codes',[])
  record['text']=''.join(chr(codes[g['index']]) if g['index']<len(codes) else '?' for g in record['glyphs'])
 text['text']=''.join(r['text'] for r in text['records'])
chosen={i:t for i,t in texts.items() if any(v in t['text'].upper() for v in ['SINGLE PLAY','COOPERATIVE','DEATH MATCH','INSTRUCTIONS'])}
needed={r.get('fontId') for t in chosen.values() for r in t['records']}
def tree(sid,seen=None):
 seen=set() if seen is None else seen
 if sid in seen:return {'characterId':sid,'recursive':True}
 seen=seen|{sid};result={'characterId':sid,'export':exports.get(sid)}
 if sid in texts:result['text']=texts[sid]
 children=[p for p in placements if p.get('parent')==sid and 'characterId'in p]
 if children:result['children']=[{**p,'definition':tree(p['characterId'],seen)} for p in children]
 return result
main=[p for p in placements if p.get('name') in ['mcSinglePlay','mcCoopPlay','mcDeathPlay','mcInstructions']]
out={'sourceSha256':hashlib.sha256(raw).hexdigest(),'stageTwips':stage,'fonts':[fonts[k] for k in needed if k in fonts],'texts':list(chosen.values()),'mainPlacements':[{**p,'definition':tree(p['characterId'])} for p in main],'parseErrors':[p for p in placements if 'parseError'in p]}
print(json.dumps(out,ensure_ascii=False,indent=2))
