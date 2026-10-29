const socket = io();
const $ = id => document.getElementById(id);
let state = null, myDrawn = null, selectedOwnSlot = null, pendingReveal = null, hasConfirmedPeek = false;
const slotLabels = {'near-left':'近左','near-right':'近右','far-left':'遠左','far-right':'遠右'};
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function cardHTML(card, back=false){ if(back||!card) return '<div class="card back"></div>'; const red=card.suit==='♥'||card.suit==='♦'; return `<div class="card playing-card ${red?'red':''}"><span class="corner">${esc(card.rank)}${esc(card.suit)}</span><span class="rank">${esc(card.rank)}</span><span class="suit">${esc(card.suit)}</span></div>`; }
function toast(msg){$('toast').textContent=msg;$('toast').classList.remove('hidden');setTimeout(()=>$('toast').classList.add('hidden'),2800);}
function showGame(){ $('entry').classList.add('hidden'); $('game').classList.remove('hidden'); }
function render(){ if(!state)return; showGame(); $('roomCodeLabel').textContent=state.code; $('deckCount').textContent=state.deckCount; $('notice').textContent=state.message||'遊戲進行中';
  $('topDiscard').outerHTML = `<div id="topDiscard" class="card ${state.topDiscard?'playing-card '+(['♥','♦'].includes(state.topDiscard.suit)?'red':''):'empty-card'}">${state.topDiscard?`<span class="corner">${esc(state.topDiscard.rank)}${esc(state.topDiscard.suit)}</span><span class="rank">${esc(state.topDiscard.rank)}</span><span class="suit">${esc(state.topDiscard.suit)}</span>`:'尚無棄牌'}</div>`;
  $('players').innerHTML = state.players.map(p=>{
    const isCurrent=p.id===state.turnPlayerId; const hand=p.hand.map(item=>{
      const label=slotLabels[item.slot]||item.slot; const own=p.isMe; const known=!!item.card; const clickable=canClickHand(p,item);
      return `<div class="hand-slot"><div class="slot-label">${esc(label)}</div>${clickable?`<button class="card-btn ${selectedOwnSlot===item.slot?'selected':''}" data-slot="${esc(item.slot)}" data-player="${esc(p.id)}">${cardHTML(known?item.card:null,!known)}</button>`:cardHTML(known?item.card:null,!known)}${!known?'<span class="unknown-label">蓋牌</span>':''}</div>`;
    }).join('');
    return `<article class="player-card ${p.isMe?'me':''}"><div class="player-head"><div><div class="player-name">${esc(p.name)}${p.isMe?'（你）':''}</div><div class="player-meta">${p.handCount} 張手牌 · ${p.connected?'在線':'離線'}</div></div><div class="player-tags">${isCurrent?'<span class="tag current">目前回合</span>':''}${p.declared?'<span class="tag declared">CABO</span>':''}</div></div><div class="hand-grid">${hand}</div></article>`;
  }).join('');
  document.querySelectorAll('.card-btn').forEach(b=>b.addEventListener('click',()=>onHandClick(b.dataset.player,b.dataset.slot)));
  $('drawBtn').disabled=!(state.youAreTurn&&state.phase==='turn'&&state.status==='playing');
  renderPanels(); renderHistory();
}
function canClickHand(p,item){
 if(!state||state.status!=='playing')return false;
 if(state.phase==='drawn'&&p.isMe)return true;
 if(state.phase==='ability'&&state.ability?.actorId===socket.id){const a=state.ability;if(a.kind==='peek-own'&&p.isMe)return true;if(a.kind==='peek-other'&&!p.isMe&&!p.declared)return true;if(a.kind==='blind-swap'&&a.step==='own'&&p.isMe)return true;if(a.kind==='blind-swap'&&a.step==='target'&&!p.isMe&&!p.declared)return true;if(a.kind==='peek-swap'&&a.step==='target'&&!p.isMe&&!p.declared)return true;if(a.kind==='peek-swap'&&a.step==='swap-own'&&p.isMe)return true;}
 if(state.phase==='match'&&!state.successfulMatchThisWindow){if(p.isMe)return true;if(state.players.find(x=>x.id===p.id)?.declared)return false;return true;}
 return false;
}
function onHandClick(playerId,slot){
 if(!state)return;
 if(state.phase==='drawn'&&playerId===socket.id){socket.emit('exchange',{slot});return;}
 const a=state.ability;
 if(state.phase==='ability'&&a?.actorId===socket.id){
  if(a.kind==='peek-own'&&playerId===socket.id){socket.emit('abilityPeekOwn',{slot});return;}
  if(a.kind==='peek-other'&&playerId!==socket.id){socket.emit('abilityPeekTarget',{targetId:playerId,slot});return;}
  if(a.kind==='blind-swap'&&a.step==='own'&&playerId===socket.id){selectedOwnSlot=slot;socket.emit('abilityBlindOwn',{slot});return;}
  if(a.kind==='blind-swap'&&a.step==='target'&&playerId!==socket.id){socket.emit('abilityBlindTarget',{targetId:playerId,slot});return;}
  if(a.kind==='peek-swap'&&a.step==='target'&&playerId!==socket.id){socket.emit('abilityPeekTarget',{targetId:playerId,slot});return;}
  if(a.kind==='peek-swap'&&a.step==='swap-own'&&playerId===socket.id){socket.emit('abilitySwapOwn',{slot});return;}
  // While an ability is active, never reinterpret a click as a match attempt.
  return;
 }
 if(state.phase==='ability') return;
 if(state.phase==='match'){
  const target=state.players.find(p=>p.id===playerId); if(!target)return;
  if(target.declared&&playerId!==socket.id){toast('宣告 CABO 的玩家受到保護。');return;}
  socket.emit('match',{targetId:playerId===socket.id?null:playerId,slot});
 }
}
function renderPanels(){
 const waiting=$('waitingPanel'), peek=$('peekPanel'), drawn=$('drawnPanel'), ability=$('abilityPanel'), match=$('matchPanel'), over=$('overPanel');
 [waiting,peek,drawn,ability,match,over].forEach(x=>x.classList.add('hidden'));
 if(state.status==='waiting') {waiting.classList.remove('hidden');$('waitingText').textContent=`目前 ${state.players.length}/4 位玩家。把房間代碼 ${state.code} 分享給朋友。`; $('startBtn').classList.toggle('hidden',!(state.players[0]?.id===socket.id&&state.players.length===4));return;}
 if(state.status==='over'){over.classList.remove('hidden');over.classList.add('panel','over-panel');const scores=state.players.map(p=>({...p,score:p.score??0}));const min=Math.min(...scores.map(p=>p.score));over.innerHTML=`<h3>遊戲結束</h3><p>${esc(state.message)}</p>${scores.sort((a,b)=>a.score-b.score).map(p=>`<div class="score-row ${p.score===min?'winner':''}"><span>${esc(p.name)} ${p.score===min?'🏆':''}</span><strong>${p.score} 分</strong></div>`).join('')}`;return;}
 if(state.phase==='peek'){peek.classList.remove('hidden');hasConfirmedPeek=!!state.youPeekDone;$('finishPeekBtn').disabled=hasConfirmedPeek;$('finishPeekBtn').textContent=hasConfirmedPeek?'已確認，等待其他玩家…':'我已記住，蓋回手牌';return;}
 if(state.phase==='drawn'&&state.youAreTurn){drawn.classList.remove('hidden');drawn.innerHTML=`<div class="drawn-layout"><div><h3>你抽到的牌</h3>${cardHTML(myDrawn)}</div><div><p>選擇與自己的一張手牌交換，或直接棄牌。</p><div class="drawn-actions"><button id="discardDrawBtn" class="primary">直接棄牌</button><button id="cancelExchangeBtn" class="ghost">取消選擇</button></div><p class="muted">交換：點選上方自己的任一張手牌。</p></div></div>`;$('discardDrawBtn').onclick=()=>socket.emit('discardDraw');$('cancelExchangeBtn').onclick=()=>toast('請點選自己的手牌進行交換，或直接棄牌。');}
 if(state.phase==='ability'&&state.ability?.actorId===socket.id){ability.classList.remove('hidden');ability.innerHTML=abilityHTML(state.ability);wireAbility();}
 if(state.phase==='match'){match.classList.remove('hidden');const current=state.players.find(p=>p.id===state.turnPlayerId);match.innerHTML=`<h3>配對時段</h3><p>目標：棄牌堆頂牌 ${state.topDiscard?esc(state.topDiscard.rank+state.topDiscard.suit):'—'}。選擇任何符合規則的手牌嘗試配對。配對失敗後其他玩家仍可繼續；成功一次後本時段結束。</p><div class="action-row">${state.youAreTurn?'<button id="endMatchBtn" class="primary">結束配對時段</button>':''}${state.youAreTurn?'<button id="declareBtn" class="ghost">宣告 CABO</button>':''}</div>`;if($('endMatchBtn'))$('endMatchBtn').onclick=()=>socket.emit('endMatchWindow');if($('declareBtn'))$('declareBtn').onclick=()=>socket.emit('declareCabo');}
 if(state.phase==='turn'&&state.youAreTurn){match.classList.remove('hidden');match.innerHTML=`<h3>你的回合</h3><p>先抽一張牌，然後選擇交換或直接棄牌。</p>`;}
 if(state.phase==='turn'&&!state.youAreTurn){match.classList.remove('hidden');match.innerHTML=`<h3>等待回合</h3><p>等待 ${esc(state.players.find(p=>p.id===state.turnPlayerId)?.name||'其他玩家')} 行動。</p>`;}
}
function abilityHTML(a){const names={'peek-own':'查看自己的牌（7、8）','peek-other':'查看其他玩家的牌（9、10）','blind-swap':'盲換手牌（J、Q）','peek-swap':'查看後決定是否交換（K、A）'};let text='';if(a.kind==='peek-own')text=a.step==='await-reveal-ack'?'已翻開你的手牌；關閉牌面視窗後才會進入配對。':'點選自己的一張手牌查看。';if(a.kind==='peek-other')text=a.step==='await-reveal-ack'?'已查看目標牌；關閉牌面視窗後才會進入配對。':'點選其他玩家的一張手牌查看。';if(a.kind==='blind-swap')text=a.step==='own'?'第 1 步：點選自己要換出去的一張手牌。':`第 2 步：已選好自己的「${slotLabels[a.selectedOwnSlot]||'手牌'}」，再點選另一位玩家的一張手牌。兩張牌會直接互換，不會翻開牌面。`;if(a.kind==='peek-swap')text=a.step==='swap-own'?'第 2 步：你已查看目標牌。若要交換，請點選自己的一張手牌。':a.step==='decide-swap'?'已查看目標牌。請選擇是否交換。':a.step==='await-reveal-ack'?'已翻開目標牌；關閉牌面視窗後才能決定是否交換。':'第 1 步：點選另一位玩家的一張手牌查看。';return `<h3>${names[a.kind]||'特殊能力'}</h3><p>${text}</p><div class="action-row">${a.kind==='peek-swap'&&a.step==='decide-swap'?'<button id="doSwapBtn" class="primary">我要交換</button><button id="skipSwapBtn">不交換</button>':''}${a.kind==='peek-other'||a.kind==='peek-swap'?'<span class="muted">只能選擇未宣告 CABO 的其他玩家。</span>':''}</div>`;}
function wireAbility(){const b=$('skipSwapBtn');if(b)b.onclick=()=>socket.emit('abilityChooseSwap',{swap:false});const s=$('doSwapBtn');if(s)s.onclick=()=>socket.emit('abilityChooseSwap',{swap:true});}
function renderHistory(){ $('history').innerHTML=(state.history||[]).slice().reverse().map(x=>`<li>${esc(x)}</li>`).join('')||'<li>尚無紀錄</li>'; }
socket.on('connect',()=>{$('connection').textContent='已連線';$('connection').style.background='#dff1e3';$('connection').style.color='#21634e';});
socket.on('disconnect',()=>{$('connection').textContent='連線中斷';$('connection').style.background='#fbe5e6';$('connection').style.color='#a42d3a';});
socket.on('state',s=>{if(s.phase==='peek' && state?.phase!=='peek')hasConfirmedPeek=false;state=s;if(s.phase!=='drawn')myDrawn=null;if(s.phase!=='peek')hasConfirmedPeek=false;render();});
socket.on('drawnCard',card=>{myDrawn=card;render();});
socket.on('privateReveal',data=>{pendingReveal=data;$('revealedCard').innerHTML=cardHTML(data.card);$('revealCaption').textContent=data.targetId?'請記住這張牌；只有你能看到。':'請記住這張牌，之後會蓋回原位。';$('revealModal').classList.remove('hidden');});
function closeReveal(){ if(pendingReveal){socket.emit('abilityRevealAck');} $('revealModal').classList.add('hidden'); pendingReveal=null; }
$('closeReveal').onclick=closeReveal;$('ackReveal').onclick=closeReveal;
socket.on('peekComplete',()=>{hasConfirmedPeek=true;toast('已蓋回手牌，等待其他玩家確認。');render();});
socket.on('errorMessage',msg=>toast(msg));
$('createBtn').onclick=()=>socket.emit('createRoom',{name:$('playerName').value});
$('joinBtn').onclick=()=>socket.emit('joinRoom',{code:$('roomCode').value,name:$('playerName').value});
$('roomCode').addEventListener('input',e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4));
$('startBtn').onclick=()=>socket.emit('startGame');
$('drawBtn').onclick=()=>socket.emit('draw');
$('finishPeekBtn').onclick=()=>socket.emit('finishPeek');
$('copyCodeBtn').onclick=async()=>{try{await navigator.clipboard.writeText(state.code);toast('已複製房間代碼。');}catch{toast('房間代碼：'+state.code);}};
