'use strict';
let roomCode='', adminKey='', snapshot=null, eventSource=null, clockOffset=0, editorInitialized=false, unsaved=false, actionBusy=false;
const ACTIONS={
 start:['BẮT ĐẦU','▶','primary'],showQuestion:['HIỂN THỊ CÂU HỎI','▣','primary'],
 pause:['TẠM DỪNG','Ⅱ','secondary'],resume:['TIẾP TỤC','▶','primary'],
 endQuestion:['KẾT THÚC CÂU HỎI','■','outline'],reveal:['HIỂN THỊ ĐÁP ÁN','✓','primary'],
 next:['CÂU TIẾP THEO','→','primary'],finish:['KẾT THÚC','★','primary']
};
const PHASES={lobby:['Đang chờ','Chờ học sinh tham gia','Nhập và lưu đủ 3 câu hỏi. Sau đó giáo viên nhấn BẮT ĐẦU.'],
 ready:['Sẵn sàng','Sẵn sàng mở câu hỏi','Giáo viên nhấn HIỂN THỊ CÂU HỎI để bắt đầu 30 giây.'],
 asking:['Đang trả lời','Đang nhận câu trả lời','Đồng hồ chạy bằng thời gian của máy chủ.'],
 paused:['Tạm dừng','Đồng hồ đang tạm dừng','Học sinh không thể gửi đáp án trong lúc tạm dừng.'],
 locked:['Đã khóa','Đã khóa đáp án','Giáo viên quyết định chuyển câu tiếp theo hoặc công bố kết quả.'],
 revealed:['Đã công bố','Đã công bố đáp án','Giáo viên có thể kết thúc trò chơi hoặc chuyển câu theo chế độ đã chọn.'],
 finished:['Hoàn thành','Trò chơi đã kết thúc','Bảng xếp hạng cuối cùng đã được công bố.']};
function applyRoom(code,key=''){
 roomCode=CP.cleanCode(code);adminKey=key||localStorage.getItem('cp-teacher-'+roomCode)||'';
 if(key)localStorage.setItem('cp-teacher-'+roomCode,key);
 CP.text('room-code-head',roomCode);
}
function shareLinks(){
 const origin=location.origin, student=origin+'/join/'+roomCode;
 CP.$('student-link').value=student;
 CP.text('code-display',roomCode);
 CP.$('qr-image').src='/api/rooms/'+roomCode+'/qr.svg';
 CP.$('project-link').href='/screen/'+roomCode;
 CP.$('export-link').href='/api/rooms/'+roomCode+'/export.csv';
 CP.$('copy-student-link').onclick=()=>CP.copy(student);
 CP.$('copy-teacher-link').onclick=()=>{
  const key=localStorage.getItem('cp-teacher-'+roomCode)||adminKey;
  if(!key)return CP.toast('Mã quản trị không có trên thiết bị này. Hãy giữ link gốc đã cấp.',true);
  CP.copy(origin+'/teacher/#room='+roomCode+'&key='+key);
 };
}
async function auth(code,key){
 applyRoom(code,key);
 if(!roomCode||roomCode.length!==7)throw new Error('Mã phòng không hợp lệ.');
 if(adminKey)await CP.api(`/api/rooms/${roomCode}/teacher-session`,{method:'POST',body:{key:adminKey}});
 const s=await CP.api(`/api/rooms/${roomCode}/teacher-state`);
 if(!s.teacher)throw new Error('Chưa có quyền quản trị phòng này.');
 // Chi ghi nho sau khi may chu da xac thuc thanh cong quyen giao vien.
 // Ho tro phong cu chi con cookie quan tri, khong con khoa trong localStorage.
 try{localStorage.setItem('cp-room-'+roomCode,'1');}catch{}
 CP.show('teacher-login',false);CP.show('teacher-dashboard',true);
 shareLinks();connect();onSnapshot(s);
}
function initEditor(questions){
 const root=CP.$('question-editor');root.replaceChildren();
 for(let i=0;i<3;i++) {
  const q=questions[i];
  const card=CP.element('section','question-form');card.dataset.index=i;
  const h=CP.element('h3','question-form-title',`Câu ${String(i+1).padStart(2,'0')}`);
  card.append(h);
  const label=CP.element('label','form-label','NỘI DUNG CÂU HỎI');
  const textarea=CP.element('textarea','question-text');textarea.rows=2;textarea.maxLength=1200;
  textarea.placeholder=`Nhập nội dung câu hỏi ${i+1}…`;textarea.value=q.text;
  label.append(textarea);card.append(label);
  const grid=CP.element('div','option-editor-grid');
  for(let j=0;j<4;j++) {
    const row=CP.element('label','option-editor-line');
    row.append(CP.element('span','option-letter','ABCD'[j]));
    const input=CP.element('input','option-input');input.type='text';input.maxLength=500;input.placeholder=`Phương án ${'ABCD'[j]}`;input.value=q.options[j];
    row.append(input);grid.append(row);
  }
  card.append(grid);
  const selector=CP.element('label','form-label correct-field','ĐÁP ÁN ĐÚNG');
  const select=CP.element('select','correct-select');
  for(const [v,t] of [['-1','— Chọn đáp án —'],['0','A'],['1','B'],['2','C'],['3','D']]) {
    const opt=CP.element('option','',t);opt.value=v;select.append(opt);
  }
  select.value=q.correctIndex;selector.append(select);card.append(selector);
  card.querySelectorAll('input,textarea,select').forEach(el=>el.addEventListener('input',()=>{unsaved=true;CP.text('save-status','Có thay đổi chưa lưu');if(snapshot)renderButtons(snapshot);}));
  root.append(card);
 }
 editorInitialized=true;unsaved=false;
}
function collectQuestions(){
 return [...document.querySelectorAll('.question-form')].map(card=>({
  text:card.querySelector('.question-text').value,
  options:[...card.querySelectorAll('.option-input')].map(x=>x.value),
  correctIndex:Number(card.querySelector('.correct-select').value)
 }));
}
CP.$('reveal-mode').addEventListener('change',async e=>{
 const select=e.currentTarget, mode=select.value;
 select.disabled=true;
 try {
  await CP.api(`/api/rooms/${roomCode}/settings`,{method:'PUT',body:{revealMode:mode}});
  CP.toast(mode==='end'?'Sẽ công bố đáp án sau cả 3 câu.':'Sẽ công bố đáp án sau từng câu.');
 }catch(err){select.value=snapshot?.revealMode||'each';CP.toast(err.message,true);}
 finally{select.disabled=snapshot?.phase!=='lobby';}
});
CP.$('save-questions').onclick=async()=>{
 try {
  const data=await CP.api(`/api/rooms/${roomCode}/questions`,{method:'PUT',body:{questions:collectQuestions()}});
  unsaved=false;CP.text('save-status',data.complete?'Đã lưu đủ 3 câu hỏi ✓':'Đã lưu bản nháp. Hãy nhập đủ nội dung trước khi bắt đầu.');
  if(snapshot)renderButtons(snapshot);
  CP.toast('Đã lưu câu hỏi vào máy chủ.');
 } catch(err){CP.toast(err.message,true);}
};
function renderButtons(s){
 const phase=s.phase, actions=phase==='lobby'?['start']:phase==='ready'?['showQuestion']:
  phase==='asking'?['pause','endQuestion']:phase==='paused'?['resume','endQuestion']:
  phase==='locked'?(s.revealMode==='end'&&s.questionIndex<2?['next']:['reveal']):phase==='revealed'?(s.questionIndex===2?['finish']:['next']):[];
 const root=CP.$('control-buttons');root.replaceChildren();
 for(const action of actions){
  const [label,ico,variant]=ACTIONS[action],button=CP.element('button',`btn btn-${variant} btn-wide control-action`,ico+'  '+label);
  button.disabled=actionBusy || (action==='start'&&!s.questions.every(q=>q.text&&q.options.every(Boolean)&&q.correctIndex>=0)) || (action==='start'&&unsaved);
  if(action==='start'&&!button.disabled)button.classList.add('start-glow');
  button.addEventListener('click',async()=>{
   actionBusy=true;renderButtons(snapshot);
   try{await CP.api(`/api/rooms/${roomCode}/action`,{method:'POST',body:{type:action}});CP.toast('Đã thực hiện: '+label.toLowerCase());}
   catch(err){CP.toast(err.message,true);}
   finally{actionBusy=false;renderButtons(snapshot);}
  });
  root.append(button);
 }
 if(phase==='lobby')root.append(CP.element('div','action-help',unsaved?'Hãy lưu nội dung vừa thay đổi.':'Nhập đầy đủ 3 câu và chọn đáp án đúng để bật BẮT ĐẦU.'));
 if(phase==='finished')root.append(CP.element('div','done-mark','✓ Trò chơi đã hoàn thành. Tải kết quả CSV ở bên trái.'));
}
function resultsTable(s){
 const root=CP.$('results-content');root.replaceChildren();
 if(s.phase==='lobby'){root.append(CP.element('p','results-empty','Kết quả sẽ hiển thị sau khi trò chơi bắt đầu.'));return;}
 const statsWrap=CP.element('div','result-bars');
 for(let i=0;i<3;i++) {
  const stat=s.stats[i],q=s.questions[i],block=CP.element('section','stat-question');
  const heading=CP.element('div','stat-question-heading');heading.append(CP.element('b','',`Câu ${i+1}`));heading.append(CP.element('span','',`${stat.total}/${s.participantCount} đã trả lời · ${stat.correct} đúng`));block.append(heading);
  for(let j=0;j<4;j++) {
   const line=CP.element('div','stat-answer');
   const choice=CP.element('b',j===q.correctIndex?'correct-answer-mark':'', 'ABCD'[j]);
   const track=CP.element('div','bar-track');const fill=CP.element('div','bar-fill'+(j===q.correctIndex?' correct-bar':''));
   fill.style.width=(stat.total?stat.choices[j]/stat.total*100:0)+'%';track.append(fill);
   line.append(choice,track,CP.element('span','',String(stat.choices[j])));block.append(line);
  }
  statsWrap.append(block);
 }
 root.append(statsWrap);
 const title=CP.element('h3','table-title','Bảng xếp hạng theo điểm và tốc độ');root.append(title);
 const wrap=CP.element('div','table-scroll'),table=CP.element('table','leaderboard-table');
 const thead=CP.element('thead');const headRow=CP.element('tr');
 ['Hạng','Học sinh','Điểm','Đúng','Tốc độ câu đúng'].forEach(h=>headRow.append(CP.element('th','',h)));
 thead.append(headRow);table.append(thead);
 const tbody=CP.element('tbody');
 for(const item of s.leaderboard){
  const tr=CP.element('tr');[item.rank,item.name,item.score,`${item.correct}/3`,item.correct?(item.totalResponseMs/1000).toFixed(1)+'s':'—'].forEach((x,j)=>tr.append(CP.element('td',j===2?'score-cell':'',String(x))));tbody.append(tr);
 }
 if(!s.leaderboard.length){const tr=CP.element('tr');const cell=CP.element('td','', 'Chưa có học sinh tham gia.');cell.colSpan=5;tr.append(cell);tbody.append(tr);}
 table.append(tbody);wrap.append(table);root.append(wrap);
 const title2=CP.element('h3','table-title','Chi tiết câu trả lời của học sinh');root.append(title2);
 const wrap2=CP.element('div','table-scroll'),t2=CP.element('table','leaderboard-table');
 const h=CP.element('tr');['Học sinh','Câu 1','Câu 2','Câu 3'].forEach(x=>h.append(CP.element('th','',x)));
 const thead2=CP.element('thead');thead2.append(h);t2.append(thead2);
 const body2=CP.element('tbody');
 for(const p of s.players){const tr=CP.element('tr');tr.append(CP.element('td','',p.name));
  for(let i=0;i<3;i++) {const a=p.answers[i];const val=a?'ABCD'[a.choice]+(a.choice===s.questions[i].correctIndex?' ✓':' ✗'):'—';tr.append(CP.element('td','',val));}
  body2.append(tr);
 }
 t2.append(body2);wrap2.append(t2);root.append(wrap2);
}
function updateTimer(){
 if(!snapshot)return;
 const m=CP.clockLeft(snapshot,clockOffset),secs=Math.ceil(m/1000);
 CP.text('timer-label',(snapshot.phase==='asking'||snapshot.phase==='paused')?secs+'s':'30s');
 CP.text('teacher-clock-num',(snapshot.phase==='asking'||snapshot.phase==='paused')?secs:30);
 CP.$('teacher-clock').style.setProperty('--timer-percent',(Math.max(0,Math.min(100,m/30000*100)))+'%');
 CP.$('teacher-clock').classList.toggle('urgent',snapshot.phase==='asking'&&secs<=10);
}
function onSnapshot(s){
 snapshot=s;clockOffset=s.serverNow-Date.now();
 const nameInput=CP.$('room-name');
 if(nameInput&&document.activeElement!==nameInput)nameInput.value=s.roomName||'Phòng trắc nghiệm';
 const [label,title,description]=PHASES[s.phase]||PHASES.lobby;
 const msg=s.phase==='locked'&&s.revealMode==='end'?(s.questionIndex===2?'Cả 3 câu đã hoàn thành. Nhấn HIỂN THỊ ĐÁP ÁN để công bố tất cả cùng lúc.':'Đáp án được giữ kín. Nhấn CÂU TIẾP THEO để tiếp tục, không cần công bố.'):description;
 CP.text('phase-chip',label);CP.text('stage-title',title);CP.text('stage-description',msg);
 const modeSelect=CP.$('reveal-mode');modeSelect.value=s.revealMode||'each';modeSelect.disabled=s.phase!=='lobby';
 CP.text('mode-help',s.revealMode==='end'?'Học sinh trả lời đủ 3 câu trước, sau đó giáo viên công bố toàn bộ đáp án.':'Đáp án được công bố sau khi khóa từng câu.');
 CP.text('student-count',s.participantCount);
 CP.text('question-progress',s.phase==='lobby'?'0/3':`${s.questionNumber}/3`);
 CP.text('answer-count',s.phase==='lobby'?'0':String(s.stats[s.questionIndex].total));
 if(!editorInitialized)initEditor(s.questions);
 CP.$('editor-section').classList.toggle('editor-disabled',s.phase!=='lobby');
 CP.$('save-questions').disabled=s.phase!=='lobby';
 CP.$('question-editor').querySelectorAll('input,textarea,select').forEach(el=>el.disabled=s.phase!=='lobby');
 if(s.phase!=='lobby')CP.text('save-status','Nội dung đã khóa khi trò chơi bắt đầu.');
 renderButtons(s);resultsTable(s);updateTimer();
}
function connect(){
 if(eventSource)eventSource.close();
 eventSource=new EventSource(`/api/rooms/${roomCode}/teacher-events`);
 eventSource.addEventListener('open',()=>CP.text('connection-status','● Đã đồng bộ'));
 eventSource.addEventListener('error',()=>CP.text('connection-status','● Đang kết nối lại…'));
 eventSource.addEventListener('snapshot',e=>{try{onSnapshot(JSON.parse(e.data));}catch(err){console.error(err);}});
 eventSource.addEventListener('clock',e=>{try{clockOffset=JSON.parse(e.data).serverNow-Date.now();}catch{}});
}
CP.$('room-name-form').addEventListener('submit',async e=>{
 e.preventDefault();
 const btn=CP.$('save-room-name'),name=CP.$('room-name').value.trim();
 btn.disabled=true;CP.text('room-name-status','Đang lưu…');
 try{
  const result=await CP.api(`/api/rooms/${roomCode}/name`,{method:'PUT',body:{name}});
  CP.text('room-name-status','✓ Đã lưu tên phòng');
  CP.toast('Đã lưu tên phòng. Bạn sẽ thấy tên này trong Phòng của tôi.');
  if(snapshot)snapshot.roomName=result.roomName;
 }catch(err){CP.text('room-name-status','Không thể lưu tên');CP.toast(err.message,true);}
 finally{btn.disabled=false;}
});
CP.$('login-form').addEventListener('submit',async e=>{
 e.preventDefault();CP.text('login-message','');
 try{await auth(CP.$('login-room').value,CP.$('login-key').value);history.replaceState({},'',`/teacher/#room=${roomCode}`);}
 catch(err){CP.text('login-message',err.message);}
});
(async()=>{
 const hash=new URLSearchParams(location.hash.slice(1));
 const code=CP.cleanCode(hash.get('room')||new URLSearchParams(location.search).get('room'));
 const key=hash.get('key')||'';
 CP.show('teacher-login',true);if(code)CP.$('login-room').value=code;
 if(code&&code.length===7){
  try{await auth(code,key);history.replaceState({},'',`/teacher/#room=${roomCode}`);}
  catch(err){CP.text('login-message',err.message);}
 }
 setInterval(updateTimer,100);
})();
