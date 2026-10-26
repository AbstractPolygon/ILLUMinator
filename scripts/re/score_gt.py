import sys,json,numpy as np
from scipy.ndimage import affine_transform, gaussian_filter
from scipy.optimize import minimize
from PIL import Image
def load_ours(n,t):
    m=json.load(open(f'out/{n}/edof{t}.json'))
    return np.fromfile(f'out/{n}/edof{t}.rgba',np.uint8).reshape(m['H'],m['W'],4)[...,:3].astype(float)
def score(gt_png,A):
    G=np.asarray(Image.open(gt_png).convert('RGB'),float); H,W=G.shape[:2]; ha,wa=A.shape[:2]
    sx,sy=wa/W,ha/H
    def warp(p):  # p: dy,dx,scale
        s=p[2]; M=np.eye(2)*np.array([sy,sx])*s
        off=np.array([ha/2,wa/2])-M@np.array([H/2,W/2])+np.array([p[0],p[1]])
        return np.stack([affine_transform(A[...,c],M,offset=off,output_shape=(H,W),order=1,mode='nearest') for c in range(3)],-1)
    Gs=gaussian_filter(G.mean(-1),1.5)
    def cost(p):
        return np.abs(gaussian_filter(warp(p).mean(-1),1.5)-Gs)[80:-80,80:-80].mean()
    r=minimize(cost,[0,0,1.0],method='Powell',options={'xtol':1e-3,'ftol':1e-4})
    w=warp(r.x); w2=w.copy()
    for c in range(3):
        a,b=np.polyfit(w[80:-80:3,80:-80:3,c].ravel(),G[80:-80:3,80:-80:3,c].ravel(),1); w2[...,c]=a*w[...,c]+b
    d=np.abs(w-G)[80:-80,80:-80].mean(); d2=np.abs(w2-G)[80:-80,80:-80].mean()
    # sharpness: mean gradient magnitude ratio
    gm=lambda X:np.hypot(*np.gradient(gaussian_filter(X.mean(-1),0.7)))[80:-80,80:-80].mean()
    return d,d2,r.x,gm(w2)/gm(G),w2
if __name__=='__main__':
    n,t,gt=sys.argv[1:4]
    d,d2,p,sr,w2=score(gt,load_ours(n,t))
    print('%s %s: MAE %.2f fitted %.2f grad-ratio %.3f shift %+.1f,%+.1f scale %.4f'%(n,t,d,d2,sr,*p))
    Image.fromarray(np.clip(w2,0,255).astype(np.uint8)).save(f'gtcmp_{n}_{t}.png')
