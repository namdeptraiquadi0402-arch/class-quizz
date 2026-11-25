'use strict';
/**
 * Tiết học tương tác – máy chủ Node.js không yêu cầu thư viện bên ngoài.
 * Đồng bộ SSE, lưu dữ liệu trên máy chủ, bảo vệ quyền giáo viên bằng khóa bí mật.
 * Chạy một tiến trình (1 instance) và dùng ổ đĩa bền vững cho DATA_DIR.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { svgQr } = require('./qr');

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'rooms.json');
const DURATION = process.env.NODE_ENV === 'test' && process.env.TEST_DURATION_MS
  ? Number(process.env.TEST_DURATION_MS) : 30_000;
const MAX_PLAYERS = 300;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomSubscribers = new Map();
const expiryTimers = new Map();
const createAttempts = new Map();
fs.mkdirSync(DATA_DIR, { recursive: true });
let rooms = Object.create(null);
try { rooms = JSON.parse(fs.readFileSync(FILE,'utf8')); }
catch (err) { if(err.code !== 'ENOENT') throw err; }

function save() {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rooms), {mode:0o600});
  fs.renameSync(tmp, FILE);
}
function sha(x) {return crypto.createHash('sha256').update(x).digest('hex');}
function equalHash(candidate, stored) {
  if(typeof candidate!=='string'||typeof stored!=='string'||candidate.length>256||stored.length!==64) return false;
  return crypto.timingSafeEqual(Buffer.from(sha(candidate),'hex'),Buffer.from(stored,'hex'));
}
function newSecret() {return crypto.randomBytes(32).toString('base64url');}
function newCode() {
  let code;
  do { code=Array.from({length:7},()=>ALPHABET[crypto.randomInt(ALPHABET.length)]).join(''); }
  while(rooms[code]);
  return code;
}
function sendJson(res,status,data,extra={}) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...extra});
  res.end(JSON.stringify(data));
}
function sendError(res,status,message) {sendJson(res,status,{error:message});}
function readBody(req) {
  return new Promise((resolve,reject)=>{
    if(!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type']||'')) return reject(Object.assign(new Error('Yêu cầu dữ liệu JSON.'),{status:415}));
    let body='', count=0;
    req.on('data',chunk=>{
      count+=chunk.length;
      if(count>100_000){reject(Object.assign(new Error('Dữ liệu quá lớn.'),{status:413}));req.destroy();return;}
      body+=chunk;
    });
    req.on('end',()=>{try{resolve(body?JSON.parse(body):{});}catch{reject(Object.assign(new Error('Dữ liệu JSON không hợp lệ.'),{status:400}));}});
    req.on('error',reject);
  });
}
function cookies(req) {
  const result=Object.create(null);
  for(const part of (req.headers.cookie||'').split(';')) {
    const pos=part.indexOf('=');
    if(pos<0)continue;
    const name=part.slice(0,pos).trim();
    try{result[name]=decodeURIComponent(part.slice(pos+1).trim());}catch{}
  }
  return result;
}
function secure(req) {return req.socket.encrypted || req.headers['x-forwarded-proto']==='https';}
function setCookie(res,req,name,value,code) {
  res.setHeader('Set-Cookie',`${name}=${encodeURIComponent(value)}; Path=/api/rooms/${code}; HttpOnly; SameSite=Strict${secure(req)?'; Secure':''}`);
}
function isTeacher(req,room) {return equalHash(cookies(req)[`quiz_teacher_${room.code}`],room.teacherHash);}
function currentPlayer(req,room) {
  const token=cookies(req)[`quiz_student_${room.code}`];
  if(!token)return null;
  return room.players.find(p=>equalHash(token,p.tokenHash))||null;
}
function publicBase(req) {
  if(process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/,'');
  const host=req.headers.host||`localhost:${PORT}`;
  const proto=secure(req)?'https':'http';
  return `${proto}://${host}`;
}
function roomOf(res,code){
  const room=rooms[code];
  if(!room){sendError(res,404,'Không tìm thấy phòng này.');return null;}
  return room;
}
function teacherOnly(req,res,room) {
  if(!isTeacher(req,room)) {sendError(res,403,'Bạn cần mã quản trị giáo viên để thực hiện thao tác này.');return false;}
  return true;
}
function ensureOrigin(req,res) {
  const origin=req.headers.origin;
  if(!origin)return true; // Cho phép ứng dụng CLI/kiểm thử trực tiếp; browser cookie được bảo vệ SameSite.
  try {
    if(new URL(origin).host===req.headers.host)return true;
  }catch{}
  sendError(res,403,'Nguồn yêu cầu không hợp lệ.');
  return false;
}
function rateLimit(req) {
  const ip=(req.socket.remoteAddress||'unknown');
  const now=Date.now(), history=(createAttempts.get(ip)||[]).filter(t=>now-t<15*60_000);
  if(history.length>=12) return false;
  history.push(now);createAttempts.set(ip,history);return true;
}
function validQuestion(raw) {
  if(!raw||typeof raw!=='object')return false;
  if(typeof raw.text!=='string'||raw.text.length>1200)return false;
  if(!Array.isArray(raw.options)||raw.options.length!==4||raw.options.some(o=>typeof o!=='string'||o.length>500))return false;
  if(!Number.isInteger(raw.correctIndex)||raw.correctIndex < -1 || raw.correctIndex > 3)return false;
  return true;
}
function normalizeQuestions(qs){
  if(!Array.isArray(qs)||qs.length!==3||!qs.every(validQuestion))return null;
  return qs.map(q=>({text:q.text.trim(),options:q.options.map(v=>v.trim()),correctIndex:q.correctIndex}));
}
function complete(q){return q.text.length>0 && q.options.every(v=>v.length>0) && q.correctIndex>=0;}
function timeRemaining(room,now=Date.now()) {
  if(room.phase==='paused')return room.remainingMs;
  if(room.phase==='asking')return Math.max(0,room.deadlineAt-now);
  return 0;
}
function answerList(room,idx) {
  return room.players.flatMap(p=>p.answers?.[idx]!=null?[{p,answer:p.answers[idx]}]:[]);
}
function statsFor(room,idx) {
  const answers=answerList(room,idx), q=room.questions[idx], choices=[0,0,0,0];
  for(const {answer} of answers)choices[answer.choice]++;
  return {question:idx+1, choices, total:answers.length, notAnswered:room.players.length-answers.length,
    correct:answers.filter(v=>v.answer.choice===q.correctIndex).length};
}
function scorePlayer(room,p) {
  let correct=0, totalResponseMs=0;
  for(let i=0;i<3;i++) {
    const a=p.answers?.[i];
    if(a && a.choice===room.questions[i].correctIndex) {correct++;totalResponseMs+=a.responseMs;}
  }
  return {id:p.id,name:p.name,score:correct*100,correct,totalResponseMs};
}
function rankings(room){
  return room.players.map(p=>scorePlayer(room,p)).sort((a,b)=>b.score-a.score || a.totalResponseMs-b.totalResponseMs || a.name.localeCompare(b.name,'vi'))
    .map((p,i)=>({...p,rank:i+1}));
}
function revealMode(room){ return room.revealMode==='end'?'end':'each'; }
function revealOnLock(room){ return revealMode(room)==='each'||room.questionIndex===room.questions.length-1; }
function studentSnapshot(room,p) {
  const idx=room.questionIndex, phase=room.phase, delayed=revealMode(room)==='end';
  const visible=['asking','paused','locked','revealed'].includes(phase);
  const q=visible?room.questions[idx]:null;
  const reviewVisible=idx===room.questions.length-1 && ['revealed','finished'].includes(phase);
  const review=reviewVisible?room.questions.map((question,i)=>({
    number:i+1,text:question.text,options:question.options,correctIndex:question.correctIndex,
    myChoice:p?.answers?.[i]?.choice??null
  })):null;
  return {serverNow:Date.now(),code:room.code,roomName:room.name||'Phòng trắc nghiệm',phase,questionIndex:idx,questionNumber:idx+1,
    revealMode:revealMode(room),joined:!!p,myName:p?.name||null,participantCount:room.players.length,
    question:q?{text:q.text,options:q.options,...(!delayed&&phase==='revealed'||reviewVisible?{correctIndex:q.correctIndex}:{})}:null,
    review,remainingMs:timeRemaining(room),deadlineAt:phase==='asking'?room.deadlineAt:null,
    myAnswer:p?(p.answers?.[idx]??null):null,
    myScore:p&&(!delayed||reviewVisible)?scorePlayer(room,p).score:null,
    leaderboard:phase==='finished'?rankings(room):null};
}
function teacherSnapshot(room){
  return {...studentSnapshot(room,null),createdAt:room.createdAt,updatedAt:room.updatedAt||room.createdAt,questions:room.questions,teacher:true,
    stats:[0,1,2].map(i=>statsFor(room,i)),
    players:room.players.map(p=>({...scorePlayer(room,p),answers:Array.from({length:3},(_,i)=>p.answers?.[i]??null)})),
    leaderboard:rankings(room)};
}
function sseWrite(res,event,data) {
  try {res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);} catch{}
}
function broadcast(room) {
  const listeners=roomSubscribers.get(room.code);
  if(!listeners)return;
  for(const s of listeners)sseWrite(s.res,'snapshot',s.teacher?teacherSnapshot(room):studentSnapshot(room,room.players.find(p=>p.id===s.playerId)||null));
}
function cancelExpiry(room) {if(expiryTimers.has(room.code)){clearTimeout(expiryTimers.get(room.code));expiryTimers.delete(room.code);}}
function lockRoom(room) {
  if(room.phase!=='asking' && room.phase!=='paused')return;
  cancelExpiry(room);
  room.phase=revealOnLock(room)?'revealed':'locked';
  room.updatedAt=Date.now();room.remainingMs=0;room.deadlineAt=null;room.segmentStartAt=null;
  save();broadcast(room);
}
function lockIfExpired(room,now=Date.now()) {
  if(room.phase==='asking'&&now>=room.deadlineAt)lockRoom(room);
}
function scheduleExpiry(room) {
  cancelExpiry(room);
  if(room.phase==='asking') {
    const wait=Math.max(0,room.deadlineAt-Date.now());
    expiryTimers.set(room.code,setTimeout(()=>{
      expiryTimers.delete(room.code);
      if(room.phase==='asking'){
        if(Date.now()>=room.deadlineAt)lockRoom(room);
        else scheduleExpiry(room);
      }
    },wait+1));
  }
}
for(const room of Object.values(rooms)) {
  if(room.phase==='asking')lockIfExpired(room);
  if(room.phase==='locked'&&revealOnLock(room)){room.phase='revealed';save();}
  scheduleExpiry(room);
}
function act(room,type){
  const phase=room.phase, now=Date.now();
  switch(type){
    case 'start':
      if(phase!=='lobby')return 'Chỉ được bắt đầu khi phòng đang chờ.';
      if(room.questions.length!==3||!room.questions.every(complete))return 'Giáo viên phải nhập đầy đủ chính xác 3 câu hỏi, 4 phương án và đáp án đúng.';
      room.phase='ready';room.questionIndex=0;break;
    case 'showQuestion':
      if(phase!=='ready')return 'Chưa đến lúc hiển thị câu hỏi.';
      room.phase='asking';room.remainingMs=DURATION;room.elapsedBeforeMs=0;
      room.segmentStartAt=now;room.deadlineAt=now+DURATION;break;
    case 'pause':
      lockIfExpired(room,now);
      if(room.phase!=='asking')return 'Chỉ có thể tạm dừng câu hỏi đang mở.';
      room.elapsedBeforeMs+=now-room.segmentStartAt;
      room.remainingMs=Math.max(0,DURATION-room.elapsedBeforeMs);
      room.deadlineAt=null;room.segmentStartAt=null;
      room.phase='paused';break;
    case 'resume':
      if(phase!=='paused')return 'Câu hỏi hiện không tạm dừng.';
      room.phase='asking';room.segmentStartAt=now;room.deadlineAt=now+room.remainingMs;break;
    case 'endQuestion':
      if(!['asking','paused'].includes(phase))return 'Chỉ kết thúc sớm câu hỏi đang mở hoặc tạm dừng.';
      lockRoom(room);return null;
    case 'reveal':
      lockIfExpired(room,now);
      if(room.phase==='revealed')return null;
      return 'Đáp án sẽ tự công bố khi đến bước công bố của phòng.';
    case 'next':
      if(room.questionIndex>=2)return 'Đã hoàn thành cả 3 câu hỏi.';
      if(revealMode(room)==='end' ? phase!=='locked' : phase!=='revealed')
        return revealMode(room)==='end'?'Hãy đợi khóa câu hỏi rồi mới chuyển câu.':'Hãy công bố đáp án trước khi chuyển câu.';
      room.questionIndex++;room.phase='ready';room.deadlineAt=null;break;
    case 'finish':
      if(phase!=='revealed'||room.questionIndex!==2)return 'Cần hoàn thành 3 câu và công bố đáp án trước khi kết thúc.';
      room.phase='finished';room.finishedAt=now;break;
    default:return 'Thao tác không hợp lệ.';
  }
  room.updatedAt=now;cancelExpiry(room);save();scheduleExpiry(room);broadcast(room);return null;
}
function csvField(value){const t=String(value??'');return /[\r\n,;"]/.test(t)?`"${t.replaceAll('"','""')}"`:t;}
function csvSafe(value){const s=String(value??'');return /^[=+@\-\t\r]/.test(s)?`'${s}`:s;}
function exportCsv(room){
  const heading=['Thứ hạng','Họ và tên','Tổng điểm','Số câu đúng','Tổng thời gian câu đúng (giây)','Câu 1','Thời gian 1 (giây)','Câu 2','Thời gian 2 (giây)','Câu 3','Thời gian 3 (giây)'];
  const rankingsMap=new Map(rankings(room).map(s=>[s.id,s]));
  const lines=[heading];
  for(const p of room.players){
    const rank=rankingsMap.get(p.id);
    const row=[rank.rank,csvSafe(p.name),rank.score,rank.correct,(rank.totalResponseMs/1000).toFixed(2)];
    for(let i=0;i<3;i++) {
      const a=p.answers?.[i];
      row.push(a?['A','B','C','D'][a.choice]:'Không trả lời',a?(a.responseMs/1000).toFixed(2):'');
    }
    lines.push(row);
  }
  lines.push([]);
  lines.push(['Thống kê theo câu','A','B','C','D','Đúng','Đã trả lời','Chưa trả lời']);
  for(let i=0;i<3;i++){const s=statsFor(room,i);lines.push([`Câu ${i+1}`,...s.choices,s.correct,s.total,s.notAnswered]);}
  return '\ufeff'+lines.map(row=>row.map(csvField).join(',')).join('\r\n')+'\r\n';
}
const STATIC={
  '/':'index.html','/teacher':'teacher.html','/teacher/':'teacher.html',
  '/join':'student.html','/join/':'student.html',
  '/screen':'screen.html','/screen/':'screen.html',
  '/styles.css':'styles.css','/theme.css':'theme.css','/home.js':'home.js','/teacher.js':'teacher.js',
  '/student.js':'student.js','/screen.js':'screen.js','/common.js':'common.js','/favicon.svg':'favicon.svg',
  '/correct-answer.png':'correct-answer.png'
};
const TYPES={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'};
function serveStatic(res,uri) {
  const pathname=uri.startsWith('/join/')&&uri!=='/join/'?'student.html':uri.startsWith('/screen/')&&uri!=='/screen/'?'screen.html':STATIC[uri];
  if(!pathname){sendError(res,404,'Không tìm thấy trang.');return;}
  const full=path.join(__dirname,'public',pathname);
  try{
    const data=fs.readFileSync(full);
    res.writeHead(200,{'Content-Type':TYPES[path.extname(pathname)]||'application/octet-stream',
      'Cache-Control':pathname.endsWith('.html')?'no-cache':'no-cache'});
    res.end(data);
  }catch {sendError(res,404,'Không tìm thấy tệp.');}
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  let url;
  try {url=new URL(req.url,`http://${req.headers.host||'localhost'}`);}
  catch {return sendError(res,400,'URL không hợp lệ.');}
  const pathname=url.pathname;
  if(req.method==='GET'&&pathname==='/health')return sendJson(res,200,{ok:true,rooms:Object.keys(rooms).length});
  if(req.method==='POST'&&!ensureOrigin(req,res))return;
  if(req.method==='PUT'&&!ensureOrigin(req,res))return;
  try{
    if(req.method==='POST'&&pathname==='/api/rooms') {
      if(!rateLimit(req))return sendError(res,429,'Bạn đã tạo quá nhiều phòng. Vui lòng thử lại sau.');
      await readBody(req);
      const code=newCode(), secret=newSecret();
      const room={code,teacherHash:sha(secret),createdAt:Date.now(),updatedAt:Date.now(),name:'Phòng trắc nghiệm',phase:'lobby',questionIndex:0,
        revealMode:'end',questions:Array.from({length:3},()=>({text:'',options:['','','',''],correctIndex:-1})),
        players:[],deadlineAt:null,remainingMs:0,elapsedBeforeMs:0,segmentStartAt:null};
      rooms[code]=room;save();
      setCookie(res,req,`quiz_teacher_${code}`,secret,code);
      return sendJson(res,201,{code,adminKey:secret,
        teacherUrl:`${publicBase(req)}/teacher/#room=${code}&key=${secret}`,
        joinUrl:`${publicBase(req)}/join/${code}`});
    }
    const route=pathname.match(/^\/api\/rooms\/([A-Z2-9]{7})\/(.+)$/);
    if(route) {
      const [,code,endpoint]=route, room=roomOf(res,code);
      if(!room)return;
      if(endpoint==='info'&&req.method==='GET')
        return sendJson(res,200,{code,phase:room.phase,canJoin:room.phase==='lobby',participantCount:room.players.length});
      if(endpoint==='teacher-session'&&req.method==='POST') {
        const body=await readBody(req);
        if(!equalHash(body.key,room.teacherHash))return sendError(res,403,'Mã quản trị không chính xác.');
        setCookie(res,req,`quiz_teacher_${code}`,body.key,code);
        return sendJson(res,200,{ok:true,code});
      }
      if(endpoint==='teacher-summary'&&req.method==='GET') {
        if(!teacherOnly(req,res,room))return;
        return sendJson(res,200,{
          code,roomName:room.name||'Phòng trắc nghiệm',phase:room.phase,
          createdAt:room.createdAt,updatedAt:room.updatedAt||room.createdAt,
          participantCount:room.players.length,questionIndex:room.questionIndex,
          filledQuestions:room.questions.filter(complete).length
        });
      }
      if(endpoint==='name'&&req.method==='PUT') {
        if(!teacherOnly(req,res,room))return;
        const body=await readBody(req);
        const name=typeof body.name==='string'?body.name.replace(/[\x00-\x1f\x7f]/g,'').trim():'';
        if(!name||name.length>80)return sendError(res,400,'Tên phòng phải dài từ 1 đến 80 ký tự.');
        room.name=name;room.updatedAt=Date.now();save();broadcast(room);
        return sendJson(res,200,{ok:true,roomName:name});
      }
      if(endpoint==='settings'&&req.method==='PUT') {
        if(!teacherOnly(req,res,room))return;
        if(room.phase!=='lobby')return sendError(res,409,'Chỉ được chọn cách công bố đáp án trước khi bắt đầu.');
        const body=await readBody(req);
        if(!['each','end'].includes(body.revealMode))return sendError(res,400,'Chế độ công bố không hợp lệ.');
        room.revealMode=body.revealMode;room.updatedAt=Date.now();save();broadcast(room);
        return sendJson(res,200,{ok:true,revealMode:room.revealMode});
      }
      if(endpoint==='questions'&&req.method==='PUT') {
        if(!teacherOnly(req,res,room))return;
        if(room.phase!=='lobby')return sendError(res,409,'Không thể sửa câu hỏi sau khi bắt đầu.');
        const body=await readBody(req),qs=normalizeQuestions(body.questions);
        if(!qs)return sendError(res,400,'Bắt buộc đúng 3 câu, mỗi câu có 4 lựa chọn, nội dung hợp lệ.');
        room.questions=qs;room.updatedAt=Date.now();save();broadcast(room);
        return sendJson(res,200,{ok:true,complete:qs.every(complete)});
      }
      if(endpoint==='join'&&req.method==='POST') {
        const existing=currentPlayer(req,room);
        if(existing)return sendJson(res,200,{ok:true,name:existing.name,rejoined:true});
        if(room.phase!=='lobby')return sendError(res,409,'Phòng đã bắt đầu. Chỉ học sinh đã tham gia trước đó mới có thể quay lại.');
        if(room.players.length>=MAX_PLAYERS)return sendError(res,409,'Phòng đã đạt số lượng học sinh tối đa.');
        const body=await readBody(req);
        const name=typeof body.name==='string'?body.name.replace(/[\x00-\x1f\x7f]/g,'').trim():'';
        if(name.length<1||name.length>40)return sendError(res,400,'Hãy nhập tên từ 1 đến 40 ký tự.');
        if(room.players.some(p=>p.name.toLocaleLowerCase('vi')===name.toLocaleLowerCase('vi')))
          return sendError(res,409,'Tên này đã được sử dụng trong phòng. Vui lòng nhập tên khác để phân biệt.');
        const token=newSecret(), p={id:crypto.randomUUID(),name,tokenHash:sha(token),joinedAt:Date.now(),answers:{}};
        room.players.push(p);save();
        setCookie(res,req,`quiz_student_${code}`,token,code);
        broadcast(room);
        return sendJson(res,201,{ok:true,name,joined:true});
      }
      if(endpoint==='public-state'&&req.method==='GET')return sendJson(res,200,studentSnapshot(room,null));
      if(endpoint==='teacher-state'&&req.method==='GET') {
        if(!teacherOnly(req,res,room))return;
        return sendJson(res,200,teacherSnapshot(room));
      }
      if(endpoint==='state'&&req.method==='GET') {
        const p=currentPlayer(req,room);
        if(!p)return sendError(res,401,'Vui lòng nhập tên để tham gia phòng.');
        return sendJson(res,200,studentSnapshot(room,p));
      }
      if((endpoint==='events'||endpoint==='public-events'||endpoint==='teacher-events')&&req.method==='GET') {
        const viewer=endpoint==='public-events';
        const teacher=endpoint==='teacher-events'&&isTeacher(req,room);
        const p=endpoint==='events'?currentPlayer(req,room):null;
        if(!teacher&&!p&&!viewer)return sendError(res,401,'Bạn chưa tham gia phòng hoặc chưa xác thực.');
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8',
          'Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
        const client={res,teacher,playerId:p?.id};
        if(!roomSubscribers.has(code))roomSubscribers.set(code,new Set());
        roomSubscribers.get(code).add(client);
        sseWrite(res,'snapshot',teacher?teacherSnapshot(room):studentSnapshot(room,p));
        const ping=setInterval(()=>sseWrite(res,'clock',{serverNow:Date.now()}),5000);
        req.on('close',()=>{
          clearInterval(ping);roomSubscribers.get(code)?.delete(client);
        });
        return;
      }
      if(endpoint==='answer'&&req.method==='POST') {
        const p=currentPlayer(req,room);
        if(!p)return sendError(res,401,'Học sinh chưa xác thực.');
        const now=Date.now(); lockIfExpired(room,now);
        if(room.phase!=='asking')return sendError(res,409,'Hiện không thể gửi đáp án (chưa mở, đã tạm dừng hoặc hết giờ).');
        const body=await readBody(req);
        if(!Number.isInteger(body.choice)||body.choice<0||body.choice>3)return sendError(res,400,'Lựa chọn không hợp lệ.');
        if(p.answers[room.questionIndex]!=null)return sendError(res,409,'Bạn đã xác nhận đáp án và không thể đổi.');
        const receivedAt=Date.now();lockIfExpired(room,receivedAt);
        if(room.phase!=='asking')return sendError(res,409,'Đã hết 30 giây. Hệ thống đã khóa đáp án.');
        p.answers[room.questionIndex]={choice:body.choice,responseMs:Math.max(0,Math.min(DURATION,room.elapsedBeforeMs+receivedAt-room.segmentStartAt))};
        save();broadcast(room);
        return sendJson(res,200,{ok:true,choice:body.choice});
      }
      if(endpoint==='action'&&req.method==='POST') {
        if(!teacherOnly(req,res,room))return;
        const body=await readBody(req),error=act(room,body.type);
        if(error)return sendError(res,409,error);
        return sendJson(res,200,{ok:true,phase:room.phase});
      }
      if(endpoint==='export.csv'&&req.method==='GET') {
        if(!teacherOnly(req,res,room))return;
        const csv=exportCsv(room);
        res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="ket-qua-${code}.csv"`,'Cache-Control':'no-store'});
        return res.end(csv);
      }
      if(endpoint==='qr.svg'&&req.method==='GET') {
        try {
          const svg=svgQr(`${publicBase(req)}/join/${code}`);
          res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'no-store'});
          return res.end(svg);
        } catch{return sendError(res,422,'Địa chỉ trang quá dài để tạo QR. Hãy dùng tên miền ngắn hơn.');}
      }
    }
    if(req.method==='GET')return serveStatic(res,pathname);
    sendError(res,404,'Đường dẫn không tồn tại.');
  }catch(err){
    console.error('Request error:',err.message);
    if(!res.headersSent)sendError(res,err.status||500,err.status?err.message:'Máy chủ gặp sự cố.');
    else res.end();
  }
});
server.listen(PORT,'0.0.0.0',()=>console.log(`QUIZ_SERVER_READY port=${server.address().port} duration=${DURATION}ms`));
module.exports={server};
