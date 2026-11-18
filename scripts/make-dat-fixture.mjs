import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
const w=10,h=5;
const argb=Buffer.alloc(w*h*4);
for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const i=(y*w+x)*4;
  argb[i]=255; // A
  argb[i+1]=(x*25)&255; // R
  argb[i+2]=(y*50)&255; // G
  argb[i+3]=((x+y)*20)&255; // B
}
// Premultiplied edge cases used by the decoder test:
// (0,0) fully transparent black; (1,0) premultiplied gray A=128,R=G=B=64.
argb.fill(0, 0, 4);
argb[4]=128; argb[5]=64; argb[6]=64; argb[7]=64;
const z=deflateSync(argb);
const header=Buffer.alloc(26);
header[0]=3; header[1]=5;
header.writeUInt16LE(w*4,2); header.writeUInt16LE(w,4); header.writeUInt16LE(h,6);
header.writeInt32LE(0,8); header.writeInt32LE(w*20,12); header.writeInt32LE(0,16); header.writeInt32LE(h*20,20);
header[24]=1; header[25]=1;
const chunks=[]; let pos=0;
while(pos<z.length){const n=Math.min(7,z.length-pos); const b=Buffer.alloc(2+n); b.writeUInt16LE(n,0); z.copy(b,2,pos,pos+n); chunks.push(b); pos+=n;}
chunks.push(Buffer.from([0,0]));
writeFileSync("fixtures/semantics/bitmap-data.xfl/bin/M 1.fixture.dat", Buffer.concat([header,...chunks]));
console.log("wrote dat", 26+z.length+chunks.length*2, "z",z.length);
