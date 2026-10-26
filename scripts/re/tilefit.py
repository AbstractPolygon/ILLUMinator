import numpy as np, sys
np.set_printoptions(linewidth=250,precision=3,suppress=True)
c5=np.memmap('syn_const.u16',dtype='<u2',mode='r',shape=(5264,7574,4))
c3=np.memmap('syn_const300.ga.u16',dtype='<u2',mode='r',shape=(5264,7574,2))
xg=np.memmap('syn_xramp.ga.u16',dtype='<u2',mode='r',shape=(5264,7574,2))
yg=np.memmap('syn_yramp.ga.u16',dtype='<u2',mode='r',shape=(5264,7574,2))
a,bb=np.meshgrid(np.arange(14)-6.5,np.arange(14)-6.5)
disc=(a**2+bb**2)<=5.0**2
def decode(R,ys,xs,slope=0.4,v0=100):
    e5=c5[ys,xs,1].astype(np.float64); e3=c3[ys,xs,0].astype(np.float64); er=R[ys,xs,0].astype(np.float64)
    v=300+200*(er-e3)/np.maximum(e5-e3,1)
    return (v-v0)/slope
def fit(I,J,wmax=5.0):
    ys=slice(14*J,14*J+14); xs=slice(14*I,14*I+14)
    al=c5[ys,xs,3]!=0
    m=((a**2+bb**2)<=wmax**2)&al&(c5[ys,xs,1]<60000)
    px=decode(xg,ys,xs); py=decode(yg,ys,xs)
    A=np.stack([np.ones(m.sum()),a[m],bb[m]],1)
    kx=np.linalg.lstsq(A,px[m],rcond=None)[0]; ky=np.linalg.lstsq(A,py[m],rcond=None)[0]
    return kx,ky
if __name__=='__main__':
    print('row J=185')
    for I in range(260,273):
        kx,ky=fit(I,185); print(I,'x: a0=%.2f dx/da=%.3f dx/db=%.3f | y: b0=%.2f dy/da=%.3f dy/db=%.3f'%(kx[0],kx[1],kx[2],ky[0],ky[1],ky[2]))
    print('col I=265')
    for J in range(180,191):
        kx,ky=fit(265,J); print(J,'x: a0=%.2f dx/da=%.3f dx/db=%.3f | y: b0=%.2f dy/da=%.3f dy/db=%.3f'%(kx[0],kx[1],kx[2],ky[0],ky[1],ky[2]))
