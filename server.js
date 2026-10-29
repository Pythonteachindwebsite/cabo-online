const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
app.use(express.static('public'));
app.get('/health', (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const SUITS = ['♠', '♥', '♦', '♣'];
function makeDeck() {
  const cards = [];
  for (const suit of SUITS) for (const rank of ['A','2','3','4','5','6','7','8','9','10','J','Q','K']) {
    cards.push({ id: crypto.randomUUID(), suit, rank, score: rank === 'A' ? 1 : rank === 'J' ? 11 : rank === 'Q' ? 12 : rank === 'K' ? ((suit === '♥' || suit === '♦') ? -1 : 13) : Number(rank) });
  }
  return cards;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function code() { return Math.random().toString(36).slice(2, 6).toUpperCase(); }
function getRoom(socket) { return socket.data.room ? rooms.get(socket.data.room) : null; }
function playerById(room, id) { return room.players.find(p => p.id === id); }
function rankMatch(a,b) { return !!a && !!b && a.rank === b.rank; }
function isRed(card) { return card.suit === '♥' || card.suit === '♦'; }
function publicState(room, viewerId) {
  const viewer = playerById(room, viewerId);
  const viewerPeekDone = !!(room.peekDone && room.peekDone.has(viewerId));
  return {
    code: room.code, status: room.status, phase: room.phase, message: room.message, youPeekDone: viewerPeekDone,
    players: room.players.map((p,i) => ({ id:p.id, name:p.name, index:i, connected:p.connected, handCount:p.hand.length, isMe:p.id===viewerId, declared:p.declared, score: room.status==='over' ? p.hand.reduce((s,x)=>s+x.card.score,0) : undefined,
      hand: p.hand.map(x=>{ const initialPeekVisible = room.phase==='peek' && p.id===viewerId && !viewerPeekDone && x.slot.startsWith('near-'); const revealAll = room.status==='over'; const known = revealAll || initialPeekVisible; return {slot:x.slot, card:known?x.card:null, known}; })
    })),
    turnPlayerId: room.players[room.turn]?.id || null, youAreTurn: room.players[room.turn]?.id === viewerId,
    deckCount: room.deck.length, discard: room.discard.map(x=>({rank:x.rank,suit:x.suit,score:x.score})), topDiscard: room.discard.length ? room.discard[room.discard.length-1] : null,
    matchOpen: room.phase === 'match', successfulMatchThisWindow: room.matchSuccess,
    ability: room.ability ? { actorId:room.ability.actorId, kind:room.ability.kind, step:room.ability.step, selectedOwnSlot:room.ability.selectedOwnSlot, selectedTargetId:room.ability.selectedTargetId } : null,
    finalTurns: room.finalTurns ? [...room.finalTurns] : null,
    history: room.history.slice(-14),
    knownCards: Object.entries(room.knowledge[viewerId] || {}).filter(([,v])=>v.knownTo.includes(viewerId)).map(([cardId,v])=>({cardId,rank:v.rank,suit:v.suit,slot:v.slot,ownerId:v.ownerId}))
  };
}
function emitRoom(room) { for (const p of room.players) if (p.connected) io.to(p.id).emit('state', publicState(room,p.id)); }
function log(room, text) { room.message = text; room.history.push(text); if(room.history.length>40) room.history.shift(); }
function fail(socket, msg) { socket.emit('errorMessage', msg); }
function clearKnowledgeForCard(room, cardId) { for (const k of Object.values(room.knowledge)) delete k[cardId]; }
function remember(room, viewerId, ownerId, item) {
  room.knowledge[viewerId] ||= {};
  room.knowledge[viewerId][item.card.id] = { rank:item.card.rank, suit:item.card.suit, slot:item.slot, ownerId, knownTo:[viewerId] };
}
function transferKnowledge(room, cardId, ownerId, slot) {
  for (const [viewerId, knowledge] of Object.entries(room.knowledge)) if (knowledge[cardId]) {
    knowledge[cardId].ownerId = ownerId; knowledge[cardId].slot = slot;
  }
}
function addToHand(room, player, card) {
  const occupied = new Set(player.hand.map(x=>x.slot));
  let slot;
  if (player.hand.length < 4) {
    slot = ['near-left','near-right','far-left','far-right'].find(s=>!occupied.has(s));
    if (!slot) slot = 'far-right';
  } else slot = 'far-right';
  // If far-right is occupied for a 4+ hand, preserve the special rule by allowing a stable extra slot at the far-right edge.
  if (occupied.has(slot)) {
    let n=2; while (occupied.has(`far-right-${n}`)) n++;
    slot=`far-right-${n}`;
  }
  player.hand.push({card,slot});
  // The returned discard was face-up, so its identity remains known to every player.
  for (const viewer of room.players) { room.knowledge[viewer.id] ||= {}; room.knowledge[viewer.id][card.id] = {rank:card.rank,suit:card.suit,slot,ownerId:player.id,knownTo:[viewer.id]}; }
  return slot;
}
function finishGame(room, reason) {
  room.status='over'; room.phase='over'; room.ability=null; room.matchSuccess=true; room.finalTurns=null;
  log(room, `${reason} 遊戲立即結束，開始結算分數。`);
}
function startGame(room) {
  room.drawn=null; room.deck = shuffle(makeDeck()); room.discard=[]; room.knowledge={}; room.peekDone=new Set(); room.history=[]; room.turn=0; room.phase='peek'; room.status='playing'; room.ability=null; room.matchSuccess=false; room.finalTurns=null; room.caboCaller=null;
  room.players.forEach(p=>{p.hand=[];p.declared=false; room.knowledge[p.id]={};});
  const slots=['near-left','near-right','far-left','far-right'];
  for(let n=0;n<4;n++) for(const p of room.players) p.hand.push({card:room.deck.pop(),slot:slots[n]});
  log(room,'每位玩家請查看靠近自己的兩張手牌，記住後蓋回原位。');
  emitRoom(room);
}
function openMatch(room) { room.phase='match'; room.matchSuccess=false; log(room,'配對時段開放！可嘗試配對棄牌堆頂牌。'); emitRoom(room); }
function endTurn(room) {
  if (room.status !== 'playing') return;
  if (room.finalTurns) {
    const currentId=room.players[room.turn].id;
    room.finalTurns.delete(currentId);
    if (room.finalTurns.size===0) { finishGame(room,'宣告 CABO 的最後回合已完成。'); emitRoom(room); return; }
  }
  room.turn=(room.turn+1)%room.players.length;
  room.phase='turn'; room.ability=null; room.matchSuccess=false;
  if (room.deck.length===0) { finishGame(room,'抽牌堆已抽完。'); }
  emitRoom(room);
}
function checkTurn(socket, room) {
  if (!room || room.status!=='playing') { fail(socket,'目前沒有進行中的遊戲。'); return false; }
  if (room.players[room.turn]?.id !== socket.id) { fail(socket,'還沒輪到你。'); return false; }
  return true;
}
function startAbility(room, actor, card) {
  const kind = ['7','8'].includes(card.rank) ? 'peek-own' : ['9','10'].includes(card.rank) ? 'peek-other' : ['J','Q'].includes(card.rank) ? 'blind-swap' : ['K','A'].includes(card.rank) ? 'peek-swap' : null;
  if (!kind) { openMatch(room); return; }
  room.ability={actorId:actor.id,kind,step:kind==='blind-swap'?'own':'target',selectedOwnSlot:null,selectedTargetId:null,viewedCardId:null};
  room.phase='ability'; log(room,`${actor.name} 正在處理特殊能力。`); emitRoom(room);
}
function validTarget(room, actorId, targetId) {
  const target=playerById(room,targetId);
  return target && target.id!==actorId && !(room.caboCaller && target.id===room.caboCaller);
}
function swapItems(room, p1, item1, p2, item2) {
  const s1=item1.slot, s2=item2.slot;
  const i1=p1.hand.indexOf(item1), i2=p2.hand.indexOf(item2);
  item1.slot=s2; item2.slot=s1;
  p1.hand[i1] = item2;
  p2.hand[i2] = item1;
  // Keep only card-face knowledge that remains certain, following the physical card.
  for(const k of Object.values(room.knowledge)) {
    if(k[item1.card.id]) { k[item1.card.id].ownerId=p2.id; k[item1.card.id].slot=s2; }
    if(k[item2.card.id]) { k[item2.card.id].ownerId=p1.id; k[item2.card.id].slot=s1; }
  }
}
function findSlot(player, slot) { return player.hand.find(x=>x.slot===slot); }
function discardDrawAndContinue(room, player, drawn, chosenSlot) {
  const old=findSlot(player,chosenSlot);
  if(!old) return false;
  player.hand[player.hand.indexOf(old)]={card:drawn,slot:chosenSlot};
  room.discard.push(old.card); clearKnowledgeForCard(room,drawn.id); clearKnowledgeForCard(room,old.card.id);
  log(room,`${player.name} 交換了一張手牌。`); openMatch(room); return true;
}

io.on('connection', socket => {
  socket.on('createRoom', ({name}) => {
    let roomCode; do { roomCode=code(); } while(rooms.has(roomCode));
    const p={id:socket.id,name:String(name||'玩家').trim().slice(0,18)||'玩家',hand:[],connected:true,declared:false};
    const room={code:roomCode,players:[p],status:'waiting',phase:'waiting',deck:[],discard:[],turn:0,ability:null,matchSuccess:false,history:[],message:'等待其他玩家加入。',knowledge:{},finalTurns:null,caboCaller:null};
    rooms.set(roomCode,room); socket.data.room=roomCode; socket.join(roomCode); emitRoom(room);
  });
  socket.on('joinRoom', ({code:roomCode,name}) => {
    roomCode=String(roomCode||'').trim().toUpperCase(); const room=rooms.get(roomCode);
    if(!room) return fail(socket,'找不到這個房間，請確認房間代碼。');
    if(room.status!=='waiting') return fail(socket,'這個房間的遊戲已經開始。');
    if(room.players.length>=4) return fail(socket,'房間已滿，最多只能有 4 位玩家。');
    const p={id:socket.id,name:String(name||'玩家').trim().slice(0,18)||'玩家',hand:[],connected:true,declared:false};
    room.players.push(p); socket.data.room=roomCode; socket.join(roomCode); log(room,`${p.name} 加入房間。`); emitRoom(room);
  });
  socket.on('startGame',()=>{
    const room=getRoom(socket); if(!room || room.players[0]?.id!==socket.id) return fail(socket,'只有房主可以開始遊戲。');
    if(room.players.length!==4) return fail(socket,'需要 4 位玩家都加入後才能開始。');
    startGame(room);
  });
  socket.on('finishPeek',()=>{
    const room=getRoom(socket); if(!room || room.status!=='playing' || room.phase!=='peek') return;
    // Each player may privately view only the two near cards, then confirm.
    const p=playerById(room,socket.id); if(!p) return;
    if(room.peekDone.has(p.id)) return;
    for(const item of p.hand.filter(x=>x.slot.startsWith('near-'))) remember(room,p.id,p.id,item);
    room.peekDone.add(p.id);
    socket.emit('peekComplete');
    const remaining=room.players.filter(pl=>!room.peekDone.has(pl.id)).length;
    if(remaining===0) {
      room.phase='turn';
      log(room,'所有玩家已完成起始查看，遊戲開始。');
    } else {
      log(room,`${p.name} 已完成起始查看，正在等待其他 ${remaining} 位玩家確認。`);
    }
    emitRoom(room);
  });
  socket.on('draw',()=>{
    const room=getRoom(socket); if(!checkTurn(socket,room)) return;
    if(room.phase!=='turn') return fail(socket,'目前不能抽牌。');
    if(room.deck.length===0) { finishGame(room,'抽牌堆已抽完。'); emitRoom(room); return; }
    const p=playerById(room,socket.id); const card=room.deck.pop();
    if(room.deck.length===0) { finishGame(room,'52 張牌已抽完。'); emitRoom(room); return; }
    room.phase='drawn'; room.drawn={playerId:p.id,card}; log(room,`${p.name} 抽了一張牌，請選擇交換或直接棄牌。`);
    socket.emit('drawnCard',card); emitRoom(room);
  });
  socket.on('exchange',({slot})=>{
    const room=getRoom(socket); if(!checkTurn(socket,room)) return;
    if(room.phase!=='drawn' || room.drawn?.playerId!==socket.id) return fail(socket,'目前沒有可交換的抽牌。');
    const p=playerById(room,socket.id); const ok=discardDrawAndContinue(room,p,room.drawn.card,slot); if(!ok) return fail(socket,'請選擇有效的手牌位置。'); room.drawn=null;
  });
  socket.on('discardDraw',()=>{
    const room=getRoom(socket); if(!checkTurn(socket,room)) return;
    if(room.phase!=='drawn' || room.drawn?.playerId!==socket.id) return fail(socket,'目前沒有可棄置的抽牌。');
    const p=playerById(room,socket.id); const card=room.drawn.card; room.drawn=null; room.discard.push(card); log(room,`${p.name} 直接棄置了 ${card.rank}${card.suit}。`); startAbility(room,p,card);
  });
  socket.on('abilityPeekOwn',({slot})=>{
    const room=getRoom(socket); const a=room?.ability; if(!room||room.phase!=='ability'||a?.actorId!==socket.id) return fail(socket,'目前沒有你的特殊能力。');
    if(a.kind!=='peek-own') return fail(socket,'這張牌的能力不適用。'); const p=playerById(room,socket.id), item=findSlot(p,slot); if(!item) return fail(socket,'無效的手牌位置。');
    remember(room,p.id,p.id,item); socket.emit('privateReveal',{card:item.card,slot}); room.ability=null; openMatch(room);
  });
  socket.on('abilityPeekTarget',({targetId,slot,swap})=>{
    const room=getRoom(socket); const a=room?.ability; if(!room||room.phase!=='ability'||a?.actorId!==socket.id) return fail(socket,'目前沒有你的特殊能力.');
    if(!['peek-other','peek-swap'].includes(a.kind)) return fail(socket,'這張牌的能力不適用。');
    if(!validTarget(room,socket.id,targetId)) return fail(socket,'這位玩家不是合法目標。');
    const target=playerById(room,targetId), item=findSlot(target,slot); if(!item) return fail(socket,'無效的目標手牌位置。');
    remember(room,socket.id,target.id,item); socket.emit('privateReveal',{card:item.card,slot,targetId});
    if(a.kind==='peek-swap') { a.selectedTargetId=targetId; a.selectedTargetSlot=slot; a.step='decide-swap'; emitRoom(room); return; }
    room.ability=null; openMatch(room);
  });
  socket.on('abilityChooseSwap',({swap})=>{
    const room=getRoom(socket); const a=room?.ability; if(!room||room.phase!=='ability'||a?.actorId!==socket.id||a.kind!=='peek-swap'||a.step!=='decide-swap') return fail(socket,'目前不能決定是否交換。');
    if(swap) { a.step='swap-own'; emitRoom(room); }
    else { log(room,`${playerById(room,socket.id).name} 查看後選擇不交換。`); room.ability=null; openMatch(room); }
  });
  socket.on('abilitySwapOwn',({slot})=>{
    const room=getRoom(socket); const a=room?.ability; if(!room||room.phase!=='ability'||a?.actorId!==socket.id||a.kind!=='peek-swap'||a.step!=='swap-own') return fail(socket,'目前不能交換。');
    const me=playerById(room,socket.id), target=playerById(room,a.selectedTargetId), own=findSlot(me,slot), other=findSlot(target,a.selectedTargetSlot);
    if(!own||!other) return fail(socket,'無效的手牌位置。'); swapItems(room,me,own,target,other); log(room,`${me.name} 查看後交換了手牌。`); room.ability=null; openMatch(room);
  });
  socket.on('abilityBlindOwn',({slot})=>{
    const room=getRoom(socket); const a=room?.ability; if(!room||room.phase!=='ability'||a?.actorId!==socket.id||a.kind!=='blind-swap'||a.step!=='own') return fail(socket,'目前不能進行盲換。');
    if(!findSlot(playerById(room,socket.id),slot)) return fail(socket,'無效的手牌位置。'); a.selectedOwnSlot=slot; a.step='target'; emitRoom(room);
  });
  socket.on('abilityBlindTarget',({targetId,slot})=>{
    const room=getRoom(socket); const a=room?.ability; if(!room||room.phase!=='ability'||a?.actorId!==socket.id||a.kind!=='blind-swap'||!a.selectedOwnSlot) return fail(socket,'請先選擇自己的手牌。');
    if(!validTarget(room,socket.id,targetId)) return fail(socket,'這位玩家不是合法目標。'); const me=playerById(room,socket.id), target=playerById(room,targetId), own=findSlot(me,a.selectedOwnSlot), other=findSlot(target,slot); if(!own||!other) return fail(socket,'無效的手牌位置。');
    swapItems(room,me,own,target,other); log(room,`${me.name} 盲換了兩張手牌。`); room.ability=null; openMatch(room);
  });
  socket.on('match',({targetId,slot})=>{
    const room=getRoom(socket); if(!room||room.status!=='playing'||room.phase!=='match'||room.matchSuccess) return fail(socket,'目前沒有開放配對，或本時段已成功配對。');
    const actor=playerById(room,socket.id); if(!actor) return;
    const top=room.discard[room.discard.length-1]; if(!top) return fail(socket,'棄牌堆沒有可配對的牌。');
    const target=targetId ? playerById(room,targetId) : actor;
    if(!target) return fail(socket,'找不到目標玩家。');
    if(target.id!==actor.id && room.caboCaller===target.id) return fail(socket,'宣告 CABO 的玩家受到保護，不能被其他玩家配對。');
    const item=findSlot(target,slot); if(!item) return fail(socket,'無效的手牌位置。');
    if(rankMatch(item.card,top)) {
      target.hand.splice(target.hand.indexOf(item),1); clearKnowledgeForCard(room,item.card.id); room.discard.push(item.card); room.matchSuccess=true;
      if(target.id!==actor.id) {
        const giverItem=actor.hand[0]; if(giverItem) { actor.hand.splice(actor.hand.indexOf(giverItem),1); target.hand.push({card:giverItem.card,slot:item.slot}); transferKnowledge(room,giverItem.card.id,target.id,item.slot); }
        log(room,`${actor.name} 成功配對 ${target.name} 的手牌；目標牌被棄置，${actor.name} 將一張手牌交給 ${target.name}。`);
      } else log(room,`${actor.name} 成功配對自己的手牌，該牌已棄置。`);
      room.phase='resolving';
      // Successful match closes the window; advance after the server has committed the result.
      emitRoom(room); setTimeout(()=>{ const r=rooms.get(room.code); if(r&&r.status==='playing'&&r.phase==='resolving') endTurn(r); },250);
    } else {
      addToHand(room,actor,top); room.discard.pop(); log(room,`${actor.name} 配對失敗，收回棄牌堆頂牌，錯誤翻開的牌回到原位。其他玩家仍可繼續配對。`); emitRoom(room);
    }
  });
  socket.on('declareCabo',()=>{
    const room=getRoom(socket); if(!checkTurn(socket,room)) return;
    if(room.phase!=='match') return fail(socket,'只能在自己完成回合行動、配對時段開放時宣告 CABO。');
    const p=playerById(room,socket.id); if(p.declared) return fail(socket,'你已經宣告 CABO。');
    p.declared=true; room.caboCaller=p.id; room.finalTurns=new Set(room.players.filter(x=>x.id!==p.id).map(x=>x.id)); log(room,`${p.name} 宣告 CABO！其他三位玩家各進行最後一回合；宣告者的手牌受到保護。`); emitRoom(room);
  });
  socket.on('endMatchWindow',()=>{ const room=getRoom(socket); if(!room||room.phase!=='match') return; if(room.players[room.turn]?.id!==socket.id) return fail(socket,'只有當前回合玩家可結束配對時段。'); endTurn(room); });
  socket.on('disconnect',()=>{ const room=getRoom(socket); if(!room) return; const p=playerById(room,socket.id); if(p) p.connected=false; log(room,`${p?.name||'玩家'} 已離線。`); emitRoom(room); });
});

server.listen(PORT,()=>console.log(`CABO server listening on ${PORT}`));
