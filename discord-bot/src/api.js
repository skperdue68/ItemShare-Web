export function createApi({url,token,fetchImpl=fetch}) {
 const base=new URL(url);if(base.protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw new Error('ITEMSHARE_API_URL must use HTTPS outside localhost.');
 return async(operation,body)=>{
  let response;try {response=await fetchImpl(`${url.replace(/\/$/,'')}/api/discord/v1/${operation}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000),redirect:'error'});}catch{throw new Error('ItemShare connection failed');}
  const data=await response.json();if(!response.ok||data.ok!==true){const error=new Error('ItemShare rejected request');error.publicMessage=`ItemShare: ${String(data.error||'Request failed').replace(/@/g,'＠').slice(0,300)} (${String(data.code||response.status).slice(0,50)})`;throw error;}return data;
 };
}
