'use strict';
const code=CP.roomFromPath('screen');let state=null,offset=0;
const root=CP.$('screen-content');CP.text('screen-code',code);
function phaseContent(){
 if(!state)return;
 const phase=state.phase;root.replaceChildren();
 if(phase==='lobby'){
  const intro=CP.element('div','screen-wait');
  intro.append(CP.element('div','eyebrow','CÙNG THAM GIA NÀO'));
  intro.append(CP.element('h1','','Quét mã QR để vào trò chơi'));
  const qr=CP.element('img','projector-qr');qr.src='/api/rooms/'+code+'/qr.svg';qr.alt='Mã QR tham gia';intro.append(qr);
  intro.append(CP.element('div','projection-code',code));
  intro.append(CP.element('p','',`${state.participantCount} học sinh đã vào phòng. Chờ giáo viên bắt đầu.`));root.append(intro);return;
 }
 if(phase==='ready'){
  const intro=CP.element('div','screen-wait');intro.append(CP.element('div','eyebrow',`CÂU ${state.questionNumber} / 03`));
  intro.append(CP.element('div','screen-symbol','✦'));
  intro.append(CP.element('h1','','Sẵn sàng cho câu hỏi tiếp theo!'));
  intro.append(CP.element('p','','Giáo viên đang chuẩn bị hiển thị câu hỏi.'));root.append(intro);return;
 }
 if(phase==='revealed'&&state.revealMode==='end'){
  const intro=CP.element('div','screen-review');
  intro.append(CP.element('div','eyebrow','CÔNG BỐ ĐÁP ÁN SAU 3 CÂU'));
  intro.append(CP.element('h1','','Cùng kiểm tra đáp án!'));
  const grid=CP.element('div','screen-review-grid');
  for(const q of state.review||[]){
   const block=CP.element('section','screen-review-item');
   block.append(CP.element('b','',`Câu ${q.number}`));
   block.append(CP.element('p','screen-review-q',q.text));
   block.append(CP.element('div','screen-review-a',`✓ ${'ABCD'[q.correctIndex]}. ${q.options[q.correctIndex]}`));
   grid.append(block);
  }
  intro.append(grid);root.append(intro);return;
 }
 if(phase==='finished'){
  const intro=CP.element('div','screen-wait');intro.append(CP.element('div','eyebrow','KẾT THÚC TRÒ CHƠI'));
  intro.append(CP.element('h1','','🏆 Bảng xếp hạng lớp học'));
  const list=CP.element('div','screen-ranklist');
  for(const p of state.leaderboard.slice(0,10)){
   const line=CP.element('div','screen-rank');line.append(CP.element('span','',`${p.rank}. ${p.name}`));line.append(CP.element('strong','',`${p.score} điểm`));list.append(line);
  }
  intro.append(list);root.append(intro);return;
 }
 const head=CP.element('div','screen-question-head');
 const side=CP.element('div','');side.append(CP.element('div','eyebrow',`CÂU HỎI ${state.questionNumber} / 03`));
 side.append(CP.element('div','screen-phase',phase==='asking'?'CẢ LỚP ĐANG TRẢ LỜI':phase==='paused'?'ĐANG TẠM DỪNG':phase==='locked'?'ĐÃ KHÓA ĐÁP ÁN':'CÔNG BỐ ĐÁP ÁN'));
 head.append(side);
 const clock=CP.element('div','screen-timer');clock.id='projector-timer';
 const num=CP.element('span','','30');num.id='projector-timer-num';clock.append(num,CP.element('small','','GIÂY'));head.append(clock);root.append(head);
 root.append(CP.element('h1','screen-question',state.question.text));
 const grid=CP.element('div','screen-choices');
 for(let i=0;i<4;i++){
  const item=CP.element('div','screen-choice'+(phase==='revealed'&&i===state.question.correctIndex?' correct-choice':''));
  item.append(CP.element('span','screen-letter','ABCD'[i]));
  item.append(CP.element('span','',state.question.options[i]));
  if(phase==='revealed'&&i===state.question.correctIndex)item.append(CP.element('span','screen-check','✓'));
  grid.append(item);
 }
 root.append(grid);
 const foot=CP.element('div','screen-question-footer',phase==='locked'?'⏳ Chờ giáo viên mở câu tiếp theo':phase==='revealed'?'✓ Đáp án đúng đã được công bố':phase==='paused'?'◷ Thời gian tạm dừng':'Giáo viên sẽ quyết định thời điểm chuyển câu');root.append(foot);
 updateClock();
}
function updateClock(){
 if(!state)return;
 const rem=CP.clockLeft(state,offset),sec=Math.ceil(rem/1000);
 const el=CP.$('projector-timer'),num=CP.$('projector-timer-num');
 if(el){el.style.setProperty('--timer-percent',(Math.max(0,Math.min(100,rem/30000*100)))+'%');el.classList.toggle('urgent',state.phase==='asking'&&sec<=10);}
 if(num)num.textContent=state.phase==='asking'||state.phase==='paused'?sec:0;
}
(async()=>{
 if(!code||code.length!==7){root.textContent='Link màn hình trình chiếu không hợp lệ.';return;}
 try{
  state=await CP.api(`/api/rooms/${code}/public-state`);offset=state.serverNow-Date.now();phaseContent();
  const stream=new EventSource(`/api/rooms/${code}/public-events`);
  stream.addEventListener('snapshot',e=>{state=JSON.parse(e.data);offset=state.serverNow-Date.now();phaseContent();});
  stream.addEventListener('clock',e=>offset=JSON.parse(e.data).serverNow-Date.now());
 }catch(err){root.textContent=err.message;}
 setInterval(updateClock,100);
})();
