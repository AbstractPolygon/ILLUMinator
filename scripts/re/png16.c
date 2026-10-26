// png16 in.png out.u16 : decode a non-interlaced 8/16-bit PNG to raw big->little endian uint16 samples (8-bit scaled x257)
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <zlib.h>
static uint32_t be32(const uint8_t*p){return (uint32_t)p[0]<<24|p[1]<<16|p[2]<<8|p[3];}
int main(int argc,char**argv){
  FILE*f=fopen(argv[1],"rb"); fseek(f,0,SEEK_END); long n=ftell(f); fseek(f,0,SEEK_SET);
  uint8_t*d=malloc(n); fread(d,1,n,f); fclose(f);
  long p=8; uint32_t w=0,h=0; int bd=0,ct=0;
  uint8_t*z=malloc(n); long zn=0;
  while(p<n){ uint32_t len=be32(d+p); const uint8_t*t=d+p+4;
    if(!memcmp(t,"IHDR",4)){w=be32(d+p+8);h=be32(d+p+12);bd=d[p+16];ct=d[p+17];}
    else if(!memcmp(t,"IDAT",4)){memcpy(z+zn,d+p+8,len);zn+=len;}
    p+=12+len; }
  int ch=ct==6?4:ct==2?3:ct==0?1:ct==4?2:0; int bps=bd/8; int bpp=ch*bps; long stride=(long)w*bpp;
  long rawn=(stride+1)*h; uint8_t*r=malloc(rawn); uLongf dl=rawn;
  if(uncompress(r,&dl,z,zn)!=Z_OK){fprintf(stderr,"inflate fail\n");return 1;}
  uint8_t*img=malloc(stride*h);
  for(uint32_t y=0;y<h;y++){ uint8_t ft=r[y*(stride+1)]; uint8_t*s=r+y*(stride+1)+1; uint8_t*o=img+y*stride; uint8_t*u=y?o-stride:NULL;
    for(long i=0;i<stride;i++){ int a=i>=bpp?o[i-bpp]:0, b=u?u[i]:0, c=(u&&i>=bpp)?u[i-bpp]:0, v=s[i];
      switch(ft){case 0:break;case 1:v+=a;break;case 2:v+=b;break;case 3:v+=(a+b)>>1;break;
       case 4:{int pp=a+b-c,pa=abs(pp-a),pb=abs(pp-b),pc=abs(pp-c);v+=(pa<=pb&&pa<=pc)?a:(pb<=pc?b:c);break;}}
      o[i]=(uint8_t)v; } }
  FILE*g=fopen(argv[2],"wb"); int sel[4]={0,1,2,3}; int ns=ch; if(argc>3){ns=0; for(char*q=argv[3];*q;q++) if(*q>='0'&&*q<='3') sel[ns++]=*q-'0';}
  long px=(long)w*h; uint16_t*out=malloc(px*ns*2);
  for(long i=0;i<px;i++) for(int k=0;k<ns;k++){ long j=i*ch+sel[k]; out[i*ns+k]= bps==2 ? (uint16_t)(img[2*j]<<8|img[2*j+1]) : (uint16_t)(img[j]*257); }
  fwrite(out,2,px*ns,g); fclose(g); printf("%u %u %d\n",w,h,ns); return 0; }
