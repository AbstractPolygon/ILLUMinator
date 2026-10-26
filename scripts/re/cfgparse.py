import re,struct,sys,json
t=open(sys.argv[1]).read()
parts=re.split(r'(?m)^// ===== ',t)
fn=[p for p in parts if p.startswith(sys.argv[2])][0]
lines=fn.split('\n')
vals={}
out={}
for i,l in enumerate(lines):
    m=re.match(r'\s*(u?Stack_[0-9a-f]+|[a-zA-Z_0-9]+)\s*=\s*(0x[0-9a-fA-F]+|-?\d+|[A-Za-z_0-9]+);',l)
    if m: vals[m.group(1)]=m.group(2)
    m=re.search(r'__ZN3LFE20SingleValueParameter(I[bfi]|IN[A-Za-z0-9_]+E)EaSERK[a-zA-Z0-9_]+\((param_1)(?: \+ (0x[0-9a-f]+|\d+))?,&(\w+)\)',l)
    if m:
        ty=m.group(1); off=m.group(3); off=int(off,0) if off else 0; v=vals.get(m.group(4),'?')
        out[off]=(ty,v)
def conv(ty,v):
    try:
        n=int(v,0)
    except: return v
    if ty=='If': return struct.unpack('<f',struct.pack('<I',n&0xffffffff))[0]
    return n
res={hex(o):(ty,conv(ty,v)) for o,(ty,v) in out.items()}
json.dump(res,open(sys.argv[3],'w'))
print(len(res))
