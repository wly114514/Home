/* SSE supports split UTF-8 chunks, CRLF frames, JSON fallback and visible timeouts. */
(function(global){
  'use strict';
  async function dispatch(block,handlers){
    let eventName='message';const data=[];
    for(const line of block.split(/\r\n|\r|\n/)){
      if(line.startsWith(':'))continue;
      const colon=line.indexOf(':');const field=colon<0?line:line.slice(0,colon);
      let value=colon<0?'':line.slice(colon+1);if(value.startsWith(' '))value=value.slice(1);
      if(field==='event')eventName=value;if(field==='data')data.push(value);
    }
    if(!data.length)return;
    const raw=data.join('\n');if(raw==='[DONE]')return;
    let payload;try{payload=JSON.parse(raw)}catch(_){payload={text:raw,message:raw}}
    if(eventName==='message'&&payload&&payload.type)eventName=payload.type;
    if(payload&&payload.error){const error=typeof payload.error==='string'?payload.error:payload.error.message;throw new Error(error||'模型服务返回错误');}
    const handler=handlers[eventName];if(handler)await handler(payload);
  }
  function parser(handlers){let buffer='';return async function(chunk,final){buffer+=chunk;let match;while((match=/\r\n\r\n|\n\n|\r\r/.exec(buffer))){const block=buffer.slice(0,match.index);buffer=buffer.slice(match.index+match[0].length);await dispatch(block,handlers)}if(final&&buffer.trim()){await dispatch(buffer,handlers);buffer=''}}}
  async function read(response,handlers,{idleTimeout=120000}={}){
    if(!response.body||!response.body.getReader)throw new Error('浏览器无法读取流式回复，请更新浏览器后重试。');
    const reader=response.body.getReader(),decoder=new TextDecoder('utf-8'),feed=parser(handlers);
    try{while(true){let timer;const idle=new Promise((_,reject)=>{timer=setTimeout(()=>{reader.cancel().catch(()=>{});reject(new Error('长时间未收到回复，请稍后重试。'))},idleTimeout)});let part;try{part=await Promise.race([reader.read(),idle])}finally{clearTimeout(timer)}if(part.done)break;await feed(decoder.decode(part.value,{stream:true}),false)}await feed(decoder.decode(),true)}catch(error){await reader.cancel().catch(()=>{});throw error}finally{reader.releaseLock()}
  }
  async function jsonReply(response,handlers){const raw=await response.text();let data;try{data=JSON.parse(raw)}catch(_){throw new Error(response.ok?'服务器没有返回有效回复。':'服务连接失败（HTTP '+response.status+'），请稍后重试。')}if(!response.ok||data.success===false)throw new Error(data.message||(data.error&&data.error.message)||'请求失败');if(data.reply){if(handlers.done)await handlers.done(data);return}throw new Error(data.message||'服务器没有返回文字内容。')}
  function postXhr(url,payload,handlers,controller,headers){return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest(),feed=parser(handlers);let consumed=0,queue=Promise.resolve(),timer,settled=false;
    const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);controller.signal.removeEventListener('abort',abort);error?reject(error):resolve()};
    const abort=()=>{xhr.abort();finish(new Error(controller.signal.reason==='timeout'?'连接超时，请稍后重试。':'请求已取消。'))};
    const arm=(ms)=>{clearTimeout(timer);timer=setTimeout(()=>{finish(new Error('长时间未收到回复，请稍后重试。'));xhr.abort()},ms)};
    const consume=()=>{const chunk=xhr.responseText.slice(consumed);consumed=xhr.responseText.length;if(chunk)queue=queue.then(()=>feed(chunk,false));queue.catch(error=>{finish(error);xhr.abort()})};
    xhr.open('POST',url,true);for(const [key,value] of Object.entries({...headers,Accept:'text/event-stream'}))xhr.setRequestHeader(key,value);
    xhr.onprogress=()=>{arm(120000);if(String(xhr.getResponseHeader('content-type')||'').includes('text/event-stream'))consume()};
    xhr.onerror=()=>finish(new Error('网络连接中断，请稍后重试。'));xhr.onabort=()=>finish(new Error('请求已取消。'));
    xhr.onload=async()=>{try{if(xhr.status<200||xhr.status>=300){let data={};try{data=JSON.parse(xhr.responseText)}catch(_){}throw new Error(data.message||'请求失败（HTTP '+xhr.status+'）')}if(String(xhr.getResponseHeader('content-type')||'').includes('text/event-stream')){consume();await queue;await feed('',true)}else{let data;try{data=JSON.parse(xhr.responseText)}catch(_){throw new Error('服务器没有返回有效回复。')}if(data.success===false||!data.reply)throw new Error(data.message||'服务器没有返回文字内容。');if(handlers.done)await handlers.done(data)}finish()}catch(error){finish(error)}};
    controller.signal.addEventListener('abort',abort,{once:true});if(controller.signal.aborted){abort();return}arm(60000);xhr.send(JSON.stringify(payload));
  })}
  async function post(url,payload,handlers,controller,headers){
    const ua=global.navigator&&global.navigator.userAgent||'';
    if(typeof XMLHttpRequest!=='undefined'&&(!global.ReadableStream||(/Android/i.test(ua)&&(/\bwv\b/i.test(ua)||/Version\/[\d.]+/i.test(ua)))))return postXhr(url,payload,handlers,controller,headers);
    let timer;try{timer=setTimeout(()=>controller.abort('timeout'),60000);const response=await fetch(url,{method:'POST',headers:{...headers,Accept:'text/event-stream'},body:JSON.stringify(payload),signal:controller.signal});clearTimeout(timer);timer=null;if(!response.ok||!String(response.headers.get('content-type')||'').includes('text/event-stream'))return await jsonReply(response,handlers);return await read(response,handlers)}catch(error){if(error.name==='AbortError'||controller.signal.aborted)throw new Error(controller.signal.reason==='timeout'?'连接超时，请稍后重试。':'请求已取消。');throw error}finally{clearTimeout(timer)}
  }
  global.AnimeStream={dispatch,parser,read,post};
})(window);
