'use strict';
const CP = {
  async api(url,opts={}) {
    const options={credentials:'same-origin',...opts};
    if(options.body&&typeof options.body!=='string'){
      options.body=JSON.stringify(options.body);
      options.headers={'Content-Type':'application/json',...(options.headers||{})};
    }
    let response;
    try {response=await fetch(url,options);} catch {throw new Error('Không thể kết nối máy chủ. Kiểm tra mạng và thử lại.');}
    let data;
    try{data=await response.json();}catch{data={};}
    if(!response.ok)throw new Error(data.error||`Máy chủ báo lỗi ${response.status}.`);
    return data;
  },
  $:id=>document.getElementById(id),
  text(id,value){const el=this.$(id);if(el)el.textContent=value;},
  show(id,visible=true){this.$(id)?.classList.toggle('hidden',!visible);},
  cleanCode(input){return String(input||'').trim().toUpperCase().replace(/[^A-Z2-9]/g,'');},
  roomFromPath(prefix){const parts=location.pathname.split('/').filter(Boolean);return parts[0]===prefix?this.cleanCode(parts[1]):'';},
  toast(message,isError=false){
    const el=this.$('toast');
    if(!el){alert(message);return;}
    el.textContent=message;el.className='toast'+(isError?' toast-error':'');
    clearTimeout(this._toastTimer);this._toastTimer=setTimeout(()=>el.classList.add('hidden'),4000);
  },
  clockLeft(state,offset){
    if(state?.phase==='asking')return Math.max(0,state.deadlineAt-(Date.now()+offset));
    return state?.phase==='paused'?state.remainingMs:0;
  },
  async copy(value){
    try{await navigator.clipboard.writeText(value);this.toast('Đã sao chép vào bộ nhớ!');}
    catch {window.prompt('Sao chép nội dung sau:',value);}
  },
  element(tag,className,content){const e=document.createElement(tag);if(className)e.className=className;if(content!==undefined)e.textContent=content;return e;}
};
