'use strict';
CP.$('create-room').addEventListener('click',async()=>{
 const btn=CP.$('create-room'), msg=CP.$('create-message');
 btn.disabled=true;btn.textContent='Đang tạo phòng…';msg.textContent='';
 try {
   const r=await CP.api('/api/rooms',{method:'POST',body:{}});
   // Lưu mã quản trị trên trình duyệt này để liệt kê lại phòng sau khi quay về.
   try{localStorage.setItem('cp-teacher-'+r.code,r.adminKey);localStorage.setItem('cp-room-'+r.code,'1');}catch{}
   location.href=r.teacherUrl;
 }catch(err){msg.textContent=err.message;msg.className='message error';btn.disabled=false;btn.textContent='＋ Tạo phòng trắc nghiệm';}
});
CP.$('join-form').addEventListener('submit',e=>{
 e.preventDefault();const code=CP.cleanCode(CP.$('join-code').value);
 if(code.length!==7){CP.$('join-message').textContent='Mã phòng phải gồm 7 ký tự.';return;}
 location.href='/join/'+code;
});
const PHASE_LABELS={lobby:'Đang chuẩn bị',ready:'Chờ mở câu',asking:'Đang trả lời',paused:'Đang tạm dừng',locked:'Đã khóa câu',revealed:'Đã công bố',finished:'Đã hoàn thành'};
function getSavedRooms(){
 // Ho tro ca phong cu: giao vien co the dang duoc xac thuc bang cookie
 // tren may chu, du localStorage khong con giu ma quan tri cu.
 try {
  const codes=new Set();
  for(const key of Object.keys(localStorage)){
   const match=/^cp-(?:teacher|room)-([A-Z2-9]{7})$/.exec(key);
   if(match && localStorage.getItem(key))codes.add(match[1]);
  }
  return [...codes].map(code=>({code,key:localStorage.getItem('cp-teacher-'+code)||''}));
 } catch{return [];}
}
async function roomSummary(item){
 const url=`/api/rooms/${item.code}/teacher-summary`;
 try{return {item,summary:await CP.api(url)};}
 catch(err){
  try {
   await CP.api(`/api/rooms/${item.code}/teacher-session`,{method:'POST',body:{key:item.key}});
   return {item,summary:await CP.api(url)};
  }catch(error){return {item,error:error.message};}
 }
}
function formatDate(epoch){
 if(!Number.isFinite(epoch))return 'Không rõ thời gian';
 return new Date(epoch).toLocaleString('vi-VN',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
}
function showRoomCard(data){
 const {item,summary,error}=data;
 const card=CP.element('article','saved-room-card');
 const top=CP.element('div','saved-room-top');
 top.append(CP.element('span','saved-room-code','MÃ '+item.code));
 top.append(CP.element('span','saved-room-status'+(error?' saved-room-error':''),error?'Không thể mở':(PHASE_LABELS[summary.phase]||summary.phase)));
 card.append(top);
 card.append(CP.element('h3','',summary?.roomName||'Phòng đã tạo'));
 card.append(CP.element('p','saved-room-meta',error?`Chưa lấy được dữ liệu: ${error}`:`${summary.filledQuestions}/3 câu hoàn chỉnh  ·  ${summary.participantCount} học sinh`));
 if(!error)card.append(CP.element('p','saved-room-date','Cập nhật: '+formatDate(summary.updatedAt)));
 const actions=CP.element('div','saved-room-actions');
 if(!error){
  const open=CP.element('a','btn btn-primary','Mở phòng');open.href='/teacher/#room='+item.code;
  actions.append(open);
  if(item.key){
   const copy=CP.element('button','btn btn-outline','Sao lưu link quản trị');copy.type='button';
   copy.addEventListener('click',()=>CP.copy(`${location.origin}/teacher/#room=${item.code}&key=${item.key}`));
   actions.append(copy);
  } else {
   actions.append(CP.element('span','saved-room-help','Phòng cũ: có thể mở khi phiên quản trị còn hiệu lực. Hãy giữ link quản trị gốc.'));
  }
 }else {
  actions.append(CP.element('span','saved-room-help','Nếu đổi máy chủ hoặc chưa giữ dữ liệu cũ, hãy kiểm tra lại thư mục data.'));
 }
 card.append(actions);return card;
}
async function loadSavedRooms(){
 const saved=getSavedRooms(),section=CP.$('saved-rooms'),root=CP.$('saved-rooms-list');
 CP.show('saved-rooms',true);root.replaceChildren();
 CP.text('saved-room-count',`(${saved.length})`);
 if(!saved.length){
  root.append(CP.element('p','saved-room-help','Chưa có phòng được ghi nhớ trên trình duyệt này. Mở trang quản trị phòng cũ một lần, sau đó quay lại trang chủ để hiện phòng.'));
  return;
 }
 root.append(CP.element('p','saved-room-loading','Đang tải các phòng của bạn…'));
 const results=[];
 for(let i=0;i<saved.length;i+=5){
  results.push(...await Promise.all(saved.slice(i,i+5).map(roomSummary)));
 }
 results.sort((a,b)=>(b.summary?.updatedAt||0)-(a.summary?.updatedAt||0));
 root.replaceChildren(...results.map(showRoomCard));
}
CP.$('refresh-rooms').addEventListener('click',loadSavedRooms);
loadSavedRooms();
