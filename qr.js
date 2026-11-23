'use strict';
// Bộ mã hóa QR độc lập, Byte mode, mức sửa lỗi L, phiên bản 1–10.
// Tương thích ISO/IEC 18004. Không gọi dịch vụ tạo QR của bên thứ ba.
const BLOCKS = [
  null, [[19,7]], [[34,10]], [[55,15]], [[80,20]], [[108,26]],
  [[68,18],[68,18]], [[78,20],[78,20]], [[97,24],[97,24]],
  [[116,30],[116,30]], [[68,18],[68,18],[69,18],[69,18]]
];
const ALIGN = [null, [], [6,18], [6,22], [6,26], [6,30], [6,34],
  [6,22,38], [6,24,42], [6,26,46], [6,28,50]];
function gfMultiply(a,b) {
  let z=0;
  for (let i=7;i>=0;i--) {
    z=(z<<1)^((z>>>7)*0x11d);
    z ^= ((b>>>i)&1)*a;
  }
  return z;
}
function rsRemainder(data, degree) {
  // Đa thức sinh Reed–Solomon trên trường GF(256).
  let poly=[1];
  let root=1;
  for(let i=0;i<degree;i++) {
    const next=Array(poly.length+1).fill(0);
    for(let j=0;j<poly.length;j++) {
      next[j] ^= poly[j];
      next[j+1] ^= gfMultiply(poly[j],root);
    }
    poly=next;
    root=gfMultiply(root,2);
  }
  const result=Array(degree).fill(0);
  for(const byte of data) {
    const factor=byte^result[0];
    result.shift(); result.push(0);
    for(let j=0;j<degree;j++) result[j]^=gfMultiply(poly[j+1],factor);
  }
  return result;
}
function formatBits(mask) {
  const data=(1<<3)|mask; // ECL L = 01
  let rem=data;
  for(let i=0;i<10;i++) rem=(rem<<1)^((rem>>>9)*0x537);
  return ((data<<10)|rem)^0x5412;
}
function versionBits(version) {
  let rem=version;
  for(let i=0;i<12;i++) rem=(rem<<1)^((rem>>>11)*0x1f25);
  return (version<<12)|rem;
}
function penalty(matrix) {
  const n=matrix.length;
  let score=0, dark=0;
  for(let y=0;y<n;y++) for(let x=0;x<n;x++) {
    if(matrix[y][x]) dark++;
    if(x<n-1 && y<n-1 && matrix[y][x]===matrix[y][x+1] && matrix[y][x]===matrix[y+1][x] && matrix[y][x]===matrix[y+1][x+1]) score+=3;
  }
  for(let dir=0;dir<2;dir++) for(let outer=0;outer<n;outer++) {
    const seq=Array.from({length:n},(_,i)=>dir===0?matrix[outer][i]:matrix[i][outer]);
    let run=1;
    for(let i=1;i<n;i++) {
      if(seq[i]===seq[i-1]) run++;
      else { if(run>=5) score+=3+(run-5); run=1; }
    }
    if(run>=5) score+=3+(run-5);
    for(let i=0;i<n-10;i++) {
      const s=seq.slice(i,i+11).map(v=>v?'1':'0').join('');
      if(s==='10111010000'||s==='00001011101') score+=40;
    }
  }
  score+=Math.floor(Math.abs(dark*20-n*n*10)/(n*n))*10;
  return score;
}
function qrMatrix(text) {
  const bytes=Array.from(Buffer.from(text,'utf8'));
  let version=0;
  for(let v=1;v<=10;v++) {
    const capacity=BLOCKS[v].reduce((s,[count])=>s+count,0)*8;
    const overhead=4+(v<10?8:16);
    if(bytes.length<= (v<10?255:65535) && overhead+bytes.length*8<=capacity) {version=v;break;}
  }
  if(!version) throw new RangeError('Đường link quá dài để tạo mã QR nội bộ (tối đa khoảng 270 byte).');
  const blocks=BLOCKS[version];
  const capacity=blocks.reduce((s,[d])=>s+d,0);
  const bits=[];
  const append=(val,len)=>{for(let i=len-1;i>=0;i--) bits.push((val>>>i)&1);};
  append(4,4); append(bytes.length,version<10?8:16);
  for(const b of bytes) append(b,8);
  const totalBits=capacity*8;
  append(0,Math.min(4,totalBits-bits.length));
  while(bits.length%8) bits.push(0);
  const data=[];
  for(let i=0;i<bits.length;i+=8) data.push(parseInt(bits.slice(i,i+8).join(''),2));
  let paddingIndex=0;
  while(data.length<capacity) data.push(paddingIndex++%2===0?0xec:0x11);
  let cursor=0;
  const chunks=blocks.map(([len,ec])=>{const content=data.slice(cursor,cursor+len);cursor+=len;return {content, ec:rsRemainder(content,ec)};});
  const codewords=[];
  for(let i=0;i<Math.max(...chunks.map(b=>b.content.length));i++) for(const b of chunks) if(i<b.content.length) codewords.push(b.content[i]);
  for(let i=0;i<chunks[0].ec.length;i++) for(const b of chunks) codewords.push(b.ec[i]);
  const n=17+4*version;
  const matrix=Array.from({length:n},()=>Array(n).fill(false));
  const used=Array.from({length:n},()=>Array(n).fill(false));
  const set=(x,y,v)=>{if(x>=0&&x<n&&y>=0&&y<n){matrix[y][x]=!!v;used[y][x]=true;}};
  for(const [cx,cy] of [[3,3],[n-4,3],[3,n-4]]) {
    for(let y=-4;y<=4;y++) for(let x=-4;x<=4;x++) {
      const r=Math.max(Math.abs(x),Math.abs(y));
      set(cx+x,cy+y,r!==2&&r!==4);
    }
  }
  for(const x of ALIGN[version]) for(const y of ALIGN[version]) {
    if(used[y][x]) continue;
    for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++)
      set(x+dx,y+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1);
  }
  // Mốc đồng bộ vẽ sau mẫu căn chỉnh để không ghi đè chúng.
  for(let i=0;i<n;i++){
    if(!used[i][6])set(6,i,i%2===0);
    if(!used[6][i])set(i,6,i%2===0);
  }
  // Chừa vị trí các bit định dạng và thông tin phiên bản.
  for(let i=0;i<8;i++){set(8,i,false);set(i,8,false);set(n-1-i,8,false);set(8,n-1-i,false);}
  set(8,8,false);set(8,n-8,true);set(8,6,true);set(6,8,true);
  if(version>=7) {
    const v=versionBits(version);
    for(let i=0;i<18;i++) {
      const a=n-11+i%3,b=Math.floor(i/3);
      set(a,b,((v>>>i)&1)!==0); set(b,a,((v>>>i)&1)!==0);
    }
  }
  const stream=[];
  for(const b of codewords) for(let i=7;i>=0;i--) stream.push(((b>>>i)&1)!==0);
  let bitPos=0;
  for(let right=n-1;right>=1;right-=2) {
    if(right===6) right=5;
    for(let vertical=0;vertical<n;vertical++) {
      const upward=(((right+1)&2)===0);
      const y=upward?n-1-vertical:vertical;
      for(let j=0;j<2;j++) {
        const x=right-j;
        if(!used[y][x]) matrix[y][x]=bitPos<stream.length?stream[bitPos++]:false;
      }
    }
  }
  const original=matrix.map(r=>r.slice());
  const maskTest=[
    (x,y)=>(x+y)%2===0, (x,y)=>y%2===0, (x,y)=>x%3===0,
    (x,y)=>(x+y)%3===0,(x,y)=>(Math.floor(y/2)+Math.floor(x/3))%2===0,
    (x,y)=>(x*y)%2+(x*y)%3===0,
    (x,y)=>((x*y)%2+(x*y)%3)%2===0,
    (x,y)=>((x+y)%2+(x*y)%3)%2===0
  ];
  let best=null, bestScore=Infinity;
  for(let mask=0;mask<8;mask++) {
    const candidate=original.map(r=>r.slice());
    for(let y=0;y<n;y++) for(let x=0;x<n;x++) if(!used[y][x]&&maskTest[mask](x,y)) candidate[y][x]=!candidate[y][x];
    const fmt=formatBits(mask);
    const sf=(x,y,v)=>{candidate[y][x]=!!v;};
    for(let i=0;i<=5;i++) sf(8,i,(fmt>>>i)&1);
    sf(8,7,(fmt>>>6)&1);sf(8,8,(fmt>>>7)&1);sf(7,8,(fmt>>>8)&1);
    for(let i=9;i<15;i++) sf(14-i,8,(fmt>>>i)&1);
    for(let i=0;i<8;i++) sf(n-1-i,8,(fmt>>>i)&1);
    for(let i=8;i<15;i++) sf(8,n-15+i,(fmt>>>i)&1);
    sf(8,n-8,1);
    const p=penalty(candidate);
    if(p<bestScore){bestScore=p;best=candidate;}
  }
  return best;
}
function svgQr(text) {
  const m=qrMatrix(text), n=m.length, quiet=4, path=[];
  for(let y=0;y<n;y++) {
    let x=0;
    while(x<n) {
      if(!m[y][x]) {x++;continue;}
      let end=x+1;
      while(end<n&&m[y][end]) end++;
      path.push(`M${x+quiet} ${y+quiet}h${end-x}v1h-${end-x}z`);
      x=end;
    }
  }
  const size=n+quiet*2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Mã QR vào phòng trắc nghiệm"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path.join('')}" fill="#101827"/></svg>`;
}
module.exports={svgQr,qrMatrix};
