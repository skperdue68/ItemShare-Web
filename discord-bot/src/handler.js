import { randomBytes } from 'node:crypto';
const safe = value => String(value ?? '').replace(/@/g,'＠').replace(/[\\`*_~|>\[\]]/g,'\\$&').slice(0,180);
const button = (id,label,style=2) => ({type:2,custom_id:id,label:String(label).slice(0,80),style});
const row = components => ({type:1,components});
const referencePattern = /^(inventory|offer):[1-9]\d*$/;
export function createHandler({guildId,api,now=Date.now,ttlMs=10*60*1000,maxSessions=1000}) {
 const sessions=new Map();
 return async function handle(i) {
  if(i.isChatInputCommand() && i.commandName!=='items') return;
  if(!i.isChatInputCommand() && !i.customId?.startsWith('is:')) return;
  const privateReply = content => i.reply({content,flags:64,allowedMentions:{parse:[]}});
  if(i.guildId!==guildId) return privateReply('Use this command in the configured guild.');
  for(const [key,value] of sessions) if(value.expires<=now()) sessions.delete(key);
  let state,action;
  if(!i.isChatInputCommand()) {
   const [,key,kind]=i.customId.split(':');state=sessions.get(key);action=kind;
   if(!state) return privateReply('This control expired. Run /items again.');
   if(state.user!==i.user.id) return privateReply('This control belongs to another member. Run /items yourself.');
  } else {
   while(sessions.size>=maxSessions) sessions.delete(sessions.keys().next().value);
   const key=randomBytes(8).toString('hex');state={key,user:i.user.id,expires:now()+ttlMs};sessions.set(key,state);
  }
  const id = action => `is:${state.key}:${action}`;
  const rotatePage = () => {
   sessions.delete(state.key);
   state={...state,key:randomBytes(8).toString('hex')};
   sessions.set(state.key,state);
  };
  const roles=Array.isArray(i.member?.roles)?i.member.roles:[...(i.member?.roles?.cache?.keys()??[])];
  const call=(operation,input={})=>api(operation,{...input,actor:{discordId:i.user.id,username:i.user.username,roleIds:roles},discordGuildId:i.guildId});
  const send=(content,components=[])=>i.editReply({content:String(content).slice(0,1950),components,allowedMentions:{parse:[]}});
  async function details(reference,quantity=1) {
   if(!referencePattern.test(reference)) return send('Use a reference such as inventory:123 or offer:123 from /items browse.');
   const {item}=await call('item',{reference}); const identity=await call('identity');
   // Each displayed confirmation owns an immutable snapshot; old buttons expire.
   sessions.delete(state.key);
   state={...state,key:randomBytes(8).toString('hex'),reference,quantity,itemName:item.name,submitting:false};
   sessions.set(state.key,state);
   if(!identity.selectedAccount) return send('Choose your ESO recipient with /items account eso:@Account, then run your request again. Provisional recipients are subject to officer review.');
   state.recipient=identity.selectedAccount;
   return send(`Confirm request: ${quantity} × ${safe(item.name)}\nReference: ${safe(reference)} · Available: ${safe(item.quantity)}\nOwner: ${safe(item.owner)} · Category: ${safe(item.category)} · Quality: ${safe(item.quality)}\nLevel: ${safe(item.level)} · CP: ${safe(item.cp)} · Trait: ${safe(item.trait)}\nStyle: ${safe(item.style)} · Enchant: ${safe(item.enchant)}\nRecipient: ${safe(identity.selectedAccount)}\nSubmitting creates an immediate request. Provisional recipients are subject to officer review.`,[row([button(id('confirm'),'Confirm request',3),button(id('quantity'),'Change quantity'),button(id('cancel'),'Cancel',4)])]);
  }
  try {
   if(action==='quantity') return await i.showModal({custom_id:id('quantitySubmit'),title:'Request quantity',components:[row([{type:4,custom_id:'quantity',label:'Quantity (positive whole number)',style:1,required:true,min_length:1,max_length:6,value:String(state.quantity)}])]});
   await i.deferReply({flags:64});
   if(action==='cancel') {sessions.delete(state.key);return send('Request cancelled.');}
   if(action==='quantitySubmit') {const q=Number(i.fields.getTextInputValue('quantity'));if(!Number.isSafeInteger(q)||q<1||q>999999)return send('Quantity must be a whole number from 1 to 999999.');return await details(state.reference,q);}
   if(action==='confirm') {
    if(state.submitting) return send('This confirmation has already been used. Check /items requests.');
    state.submitting=true;
    const {request,duplicate}=await call('request',{reference:state.reference,quantity:state.quantity,expectedRecipient:state.recipient,interactionId:i.id});
    sessions.delete(state.key);return send(`${duplicate?'Already recorded':'Request recorded'} #${safe(request.id)}: ${safe(request.quantity)} × ${safe(request.itemName)}\nStatus: ${safe(request.status)} · Recipient: ${safe(request.recipient)} · ${safe(request.verification)}`);
   }
   if(action?.startsWith('item')) return await details(state.items[Number(action.slice(4))].reference);
   if(action?.startsWith('cat')) {state.category=state.categories[Number(action.slice(3))].name;state.search=undefined;state.page=1;}
   let sub=i.isChatInputCommand()?i.options.getSubcommand():state.view;
   if(action?.startsWith('cat'))sub='browse';
   if(action==='next')state.page++;if(action==='prev')state.page--;
   if(sub==='help')return send('/items browse — browse stock\n/items search name — search\n/items categories — category buttons\n/items account [eso] — view/select ESO recipient\n/items request item [quantity] — use inventory:ID or offer:ID; confirm before submitting\n/items requests — your request history\n/items review [action] [user] [eso] — officer association review\nAll results are private; controls expire after 10 minutes.');
   if(sub==='request')return await details(i.options.getString('item'),i.options.getInteger('quantity')??1);
   if(sub==='account') {const esoAccount=i.options.getString('eso');const data=await call(esoAccount?'account':'identity',esoAccount?{esoAccount}:{});return send(`Selected: ${safe(data.selectedAccount||'none')}\n${data.accounts.map(a=>`${safe(a.esoAccount)} — ${safe(a.status)} (${safe(a.source)})`).join('\n')||'No linked account.'}\nUse /items account eso:@Account to select a recipient.${data.allowProvisional?' Unlinked recipients are provisional and subject to officer review.':''}`);}
   if(sub==='review') {const data=await call('review',{action:i.options.getString('action')??'list',discordId:i.options.getUser('user')?.id,esoAccount:i.options.getString('eso')??undefined});return send(data.associations.map(a=>`${safe(a.discordId)} · ${safe(a.esoAccount)} · ${safe(a.status)}`).join('\n')||'No associations.');}
   if(sub==='categories') {
    if(i.isChatInputCommand()){state.page=1;state.categories=(await call('categories')).categories;}
    rotatePage();
    state.view='categories';const offset=(state.page-1)*20;const visible=state.categories.slice(offset,offset+20);
    const rows=visible.reduce((rows,c,index)=>{if(index%5===0)rows.push(row([]));rows.at(-1).components.push(button(id(`cat${offset+index}`),`${c.name} (${c.count})`));return rows;},[]);
    const nav=[];if(state.page>1)nav.push(button(id('prev'),'Previous'));if(offset+20<state.categories.length)nav.push(button(id('next'),'Next'));if(nav.length)rows.push(row(nav));
    return send(`${visible.map(c=>`${safe(c.name)} (${safe(c.count)})`).join('\n')||'No categories.'}\nPage ${state.page}/${Math.max(1,Math.ceil(state.categories.length/20))}`,rows);
   }
   if(i.isChatInputCommand()){state.page=1;state.search=sub==='search'?i.options.getString('name'):undefined;state.category=undefined;}
   state.view=sub==='search'?'browse':sub;
   const data=await call(sub==='requests'?'requests':'browse',{page:state.page,search:state.search,category:state.category});
   rotatePage();
   state.page=data.page;
   const controls=[];let content;
   if(sub==='requests')content=data.requests.map(r=>`#${safe(r.id)} ${safe(r.itemName)} ×${safe(r.quantity)} · ${safe(r.status)} · ${safe(r.recipient)}`).join('\n');
   else {state.items=data.items;content=data.items.map((x,n)=>`${n+1}. ${safe(x.name)} ×${safe(x.quantity)} · ${safe(x.reference)} · ${safe(x.owner)} · ${safe(x.category)}`).join('\n');data.items.slice(0,20).forEach((x,n)=>{if(n%5===0)controls.push(row([]));controls.at(-1).components.push(button(id(`item${n}`),`${n+1}. ${x.name}`));});}
   const nav=[];if(data.page>1)nav.push(button(id('prev'),'Previous'));if(data.page<data.totalPages)nav.push(button(id('next'),'Next'));if(nav.length)controls.push(row(nav));
   return send(`${content||'No results.'}\nPage ${data.page}/${data.totalPages} · ${data.total} results${data.scope?` · ${safe(data.scope.guildName)} / ${safe(data.scope.platform)} / ${safe(data.scope.worldName)}`:''}`,controls);
  } catch(error) {
   // Failed/uncertain submissions remain consumed: never retry writes automatically.
   const message=error.publicMessage||'ItemShare could not complete this action. Check /items requests before retrying a request, or contact an officer.';
   if(i.deferred||i.replied)return send(message);return privateReply(message);
  }
 };
}
