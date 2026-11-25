'use strict';
let code=CP.roomFromPath('join')||CP.cleanCode(new URLSearchParams(location.search).get('room'));
let state=null, clockOffset=0, stream=null, selectedChoice=null, selectedIndex=-1, sending=false, playerName='';
CP.text('play-code',code||'KHÔNG CÓ');
const root=CP.$('play-content');
const revealedPictures=new Set();
let completionShown=false;

function picturePiece(questionIndex,earned){
 const piece=CP.element('div','picture-piece'+(earned?' picture-piece-earned':''),
  earned?'':`Mảnh ${questionIndex+1}`);
 piece.dataset.piece=questionIndex+1;
 return piece;
}

function correctAnswerPicture(questionIndex){
 const frame=CP.element('div','answer-picture');
 const card=CP.element('div','answer-picture-card');
 if(state.phase==='revealed'&&!revealedPictures.has(questionIndex)){
  card.classList.add('answer-picture-flip');
  revealedPictures.add(questionIndex);
 }

 const cover=CP.element('div','answer-picture-cover','✓');
 cover.setAttribute('aria-hidden','true');
 const piece=picturePiece(questionIndex,true);
 piece.classList.add('answer-picture-image');
 piece.setAttribute('role','img');
 piece.setAttribute('aria-label',`Mảnh ${questionIndex+1} của tranh minh họa Việt Nam`);
 card.append(cover,piece);
 frame.append(card);
 return frame;
}

function waitScreen(kicker,headline,explanation,withPeople=true){
 root.replaceChildren();
 const section=CP.element('div','waiting-area');
 section.append(CP.element('div','waiting-orbit','✦'));
 section.append(CP.element('div','eyebrow',kicker));
 section.append(CP.element('h1','',headline));
 section.append(CP.element('p','',explanation));
 if(withPeople)section.append(CP.element('div','waiting-count',`${state?.participantCount||0} học sinh đã tham gia`));
 root.append(section);
}
function makeChoice(i,value,locked,correctIndex,myChoice){
 const isReveal=state.phase==='revealed';
 const selected=selectedChoice===i&&!locked;
 const b=CP.element('button','answer-option '+(selected?'selected ':'')+(isReveal&&i===correctIndex?'answer-correct ':'')+(isReveal&&myChoice===i&&i!==correctIndex?'answer-wrong ':''));
 b.type='button';b.disabled=locked||state.phase!=='asking';b.dataset.choice=i;
 b.append(CP.element('span','answer-letter','ABCD'[i]));b.append(CP.element('span','answer-text',value));
 if(isReveal&&i===correctIndex)b.append(CP.element('span','answer-symbol','✓'));
 if(isReveal&&myChoice===i&&i!==correctIndex)b.append(CP.element('span','answer-symbol','✕'));
 b.onclick=()=>{selectedChoice=i;render();};
 return b;
}
function renderQuestion(){
 root.replaceChildren();
 const q=state.question, idx=state.questionIndex;
 const answered=state.myAnswer!=null, phase=state.phase;
 const locked=answered||phase!=='asking';
 if(selectedIndex!==idx){selectedChoice=null;selectedIndex=idx;}
 const head=CP.element('div','question-head');
 const left=CP.element('div','');
 left.append(CP.element('div','eyebrow',`CÂU HỎI ${String(idx+1).padStart(2,'0')} / 03`));
 left.append(CP.element('div','question-phase',phase==='asking'?'CHỌN ĐÁP ÁN ĐÚNG':phase==='paused'?'GIÁO VIÊN ĐÃ TẠM DỪNG':phase==='locked'?'ĐÃ HẾT GIỜ': 'CÔNG BỐ ĐÁP ÁN'));
 head.append(left);
 const timer=CP.element('div','student-timer');timer.id='student-timer';
 const num=CP.element('span','student-timer-num','30');num.id='student-timer-num';
 timer.append(num,CP.element('small','','GIÂY'));head.append(timer);root.append(head);
 root.append(CP.element('h1','quiz-question',q.text));
 const grid=CP.element('div','answer-grid');
 for(let i=0;i<4;i++)grid.append(makeChoice(i,q.options[i],locked,q.correctIndex,state.myAnswer?.choice));
 root.append(grid);
 if(phase==='asking'&&!answered){
  const foot=CP.element('div','answer-footer');
  foot.append(CP.element('span','answer-tip',selectedChoice===null?'Chạm vào một đáp án để chọn.':'Kiểm tra lựa chọn trước khi xác nhận.'));
  const submit=CP.element('button','btn btn-primary',`XÁC NHẬN ĐÁP ÁN ${selectedChoice===null?'':'ABCD'[selectedChoice]} →`);
  submit.id='confirm-answer';submit.disabled=selectedChoice===null||sending;
  submit.onclick=submitAnswer;foot.append(submit);root.append(foot);
 } else {
  const note=CP.element('div','answer-status');
  if(phase==='asking'&&answered)note.textContent=`✓ Em đã gửi đáp án ${'ABCD'[state.myAnswer.choice]}. Hãy chờ giáo viên.`;
  else if(phase==='paused')note.textContent='◷ Thời gian đang tạm dừng. Hãy chờ giáo viên tiếp tục.';
  else if(phase==='locked')note.textContent='Đã khóa câu hỏi. Hãy chờ giáo viên mở câu tiếp theo.';
  else if(phase==='revealed')note.textContent=answered?(state.myAnswer.choice===q.correctIndex?'✓ Chính xác! Em nhận được 100 điểm.':`Đáp án đúng là ${'ABCD'[q.correctIndex]}. Cố gắng ở câu tiếp theo!`):`Đáp án đúng: ${'ABCD'[q.correctIndex]}.`;
  root.append(note);
  if(phase==='revealed'&&answered&&state.myAnswer.choice===q.correctIndex){
   root.append(correctAnswerPicture(idx));
  }
 }
 updateClock();
}
async function submitAnswer(){
 if(selectedChoice===null||sending||state?.phase!=='asking')return;
 sending=true;const button=CP.$('confirm-answer');if(button)button.disabled=true;
 try{
  await CP.api(`/api/rooms/${code}/answer`,{method:'POST',body:{choice:selectedChoice}});
  CP.toast('Đã ghi nhận đáp án. Không thể sửa sau khi xác nhận.');
 }catch(err){CP.toast(err.message,true);await refresh();}
 finally{sending=false;}
}
function answerReview(showPieces){
 const section=CP.element('section','answer-review');
 section.append(CP.element('h2','','Đáp án của cả 3 câu hỏi'));
 const grid=CP.element('div','review-grid');
 for(const q of state.review||[]){
  const item=CP.element('article','review-item');
  item.append(CP.element('div','eyebrow',`CÂU ${String(q.number).padStart(2,'0')}`));
  item.append(CP.element('h3','',q.text));
  item.append(CP.element('p','review-correct',`✓ Đáp án đúng: ${'ABCD'[q.correctIndex]}. ${q.options[q.correctIndex]}`));
  const mine=q.myChoice===null?'Em chưa trả lời.':`Em chọn: ${'ABCD'[q.myChoice]}${q.myChoice===q.correctIndex?' — Đúng':' — Chưa đúng'}`;
  item.append(CP.element('p','review-mine',mine));
  if(showPieces&&q.myChoice===q.correctIndex)item.append(correctAnswerPicture(q.number-1));
  grid.append(item);
 }
 section.append(grid);return section;
}
function pictureResult(){
 const section=CP.element('section','picture-result');
 if(!completionShown){
  section.classList.add('picture-result-animate');
  completionShown=true;
 }
 const matches=state.review.map(q=>q.myChoice===q.correctIndex);
 const count=matches.filter(Boolean).length;
 const mark=CP.element('div','picture-result-mark',count===3?'✦':'✓');
 mark.setAttribute('aria-hidden','true');
 section.append(mark,CP.element('h2','',count===3?'Đã ghép xong bức tranh!':'Bức tranh của em'));
 section.append(CP.element('p','picture-result-count',`Đã mở ${count} / 3 mảnh`));
 const board=CP.element('div','picture-board');
 board.setAttribute('role','img');
 board.setAttribute('aria-label',matches.map((earned,i)=>`Mảnh ${i+1} ${earned?'đã mở':'còn khóa'}`).join(', '));
 matches.forEach((earned,i)=>board.append(picturePiece(i,earned)));
 section.append(board);
 return section;
}
function fullReview(){
 root.replaceChildren();
 const intro=CP.element('div','finished-header');
 intro.append(CP.element('div','winner-emoji','✓'));
 intro.append(CP.element('div','eyebrow','ĐÃ HOÀN THÀNH CẢ 3 CÂU'));
 intro.append(CP.element('h1','','Kết quả trắc nghiệm'));
 intro.append(CP.element('p','',`Điểm của em: ${state.myScore} / 300`));
 intro.append(CP.element('p','','Hãy xem lại câu trả lời, sau đó chờ giáo viên kết thúc để xem bảng xếp hạng.'));
 root.append(intro,answerReview(true),pictureResult());
}
function leaderboard(){
 root.replaceChildren();
 const intro=CP.element('div','finished-header');intro.append(CP.element('div','winner-emoji','🏆'));
 intro.append(CP.element('div','eyebrow','TRÒ CHƠI ĐÃ KẾT THÚC'));
 intro.append(CP.element('h1','','Bảng xếp hạng cuối cùng'));
 intro.append(CP.element('p','',`Điểm của em: ${state.myScore} / 300`));root.append(intro);
 const ranklist=CP.element('div','ranklist');
 for(const p of state.leaderboard||[]){
  const item=CP.element('div','rank-item'+(p.name===playerName?' my-rank':''));
  item.append(CP.element('span','rank-number',p.rank<=3?['🥇','🥈','🥉'][p.rank-1]:String(p.rank)));
  item.append(CP.element('span','rank-name',p.name));
  item.append(CP.element('strong','rank-score',p.score+' điểm'));
  ranklist.append(item);
 }
 root.append(ranklist);
 if(state.review)root.append(answerReview(false),pictureResult());
 root.append(CP.element('p','end-note','Cảm ơn em đã tham gia!'));
}
function render(){
 if(!state)return;
 if(state.phase==='lobby')waitScreen('PHÒNG ĐANG MỞ','Chào mừng đến với trò chơi!','Hãy chờ giáo viên bắt đầu.');
 else if(state.phase==='ready')waitScreen(`CÂU HỎI ${state.questionNumber} / 03`,'Sẵn sàng nào!','Giáo viên sẽ hiển thị câu hỏi khi cả lớp đã sẵn sàng.');
 else if(state.phase==='revealed'&&state.review)fullReview();
 else if(['asking','paused','locked','revealed'].includes(state.phase))renderQuestion();
 else if(state.phase==='finished')leaderboard();
}
function updateClock(){
 if(!state)return;
 const time=CP.clockLeft(state,clockOffset), secs=Math.ceil(time/1000);
 const circle=CP.$('student-timer'), num=CP.$('student-timer-num');
 if(circle){circle.style.setProperty('--timer-percent',(Math.max(0,Math.min(100,time/30000*100)))+'%');circle.classList.toggle('urgent',state.phase==='asking'&&secs<=10);}
 if(num)num.textContent=(state.phase==='asking'||state.phase==='paused')?secs:0;
 const confirm=CP.$('confirm-answer');
 if(confirm&&time<=0)confirm.disabled=true;
 if(state.phase==='asking'&&!state.myAnswer&&time<=0)document.querySelectorAll('.answer-option').forEach(b=>b.disabled=true);
}
function onState(s){
 const sameResult=state?.phase===s.phase&&state.questionIndex===s.questionIndex&&
  ['revealed','finished'].includes(s.phase);
 state=s;clockOffset=s.serverNow-Date.now();
 if(s.myName){playerName=s.myName;CP.text('my-name','✳ '+playerName);}
 if(!sameResult)render();
}
async function refresh(){
 try{onState(await CP.api(`/api/rooms/${code}/state`));}
 catch(err){CP.toast(err.message,true);}
}
function connect(){
 stream?.close();stream=new EventSource(`/api/rooms/${code}/events`);
 stream.addEventListener('open',()=>CP.text('student-connect','● Đã kết nối'));
 stream.addEventListener('error',()=>CP.text('student-connect','● Đang kết nối lại…'));
 stream.addEventListener('snapshot',e=>{try{onState(JSON.parse(e.data));}catch(err){console.error(err);}});
 stream.addEventListener('clock',e=>{try{clockOffset=JSON.parse(e.data).serverNow-Date.now();}catch{}});
}
async function enterGame(){
 CP.show('student-join',false);CP.show('student-game',true);
 await refresh();connect();
}
CP.$('student-join-form').addEventListener('submit',async e=>{
 e.preventDefault();CP.text('join-error','');
 const name=CP.$('student-name').value.trim();
 const btn=e.currentTarget.querySelector('button');btn.disabled=true;
 try{
  const result=await CP.api(`/api/rooms/${code}/join`,{method:'POST',body:{name}});
  playerName=result.name;sessionStorage.setItem('cp-name-'+code,playerName);
  CP.text('my-name','✳ '+playerName);await enterGame();
 }catch(err){CP.text('join-error',err.message);btn.disabled=false;}
});
(async()=>{
 if(!code||code.length!==7){CP.show('student-join',true);CP.text('join-error','Mã phòng không hợp lệ. Hãy mở đường link giáo viên gửi.');CP.$('student-join-form').querySelector('button').disabled=true;return;}
 try{
  const s=await CP.api(`/api/rooms/${code}/state`);
  playerName=sessionStorage.getItem('cp-name-'+code)||'Học sinh';CP.text('my-name','✳ '+playerName);
  CP.show('student-game',true);onState(s);connect();
 }catch{
  CP.show('student-join',true);
  try {const info=await CP.api(`/api/rooms/${code}/info`);if(!info.canJoin)CP.text('join-error','Phòng đã bắt đầu. Nếu đã tham gia trước đó, hãy mở lại bằng cùng trình duyệt.');}
  catch(err){CP.text('join-error',err.message);}
 }
 setInterval(updateClock,100);
})();
