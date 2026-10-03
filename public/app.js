const $=id=>document.getElementById(id);
const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];
const today=new Date(); today.setHours(0,0,0,0);
const key=(y,m,d)=>y+"-"+String(m+1).padStart(2,"0")+"-"+String(d).padStart(2,"0");
const TODAY=key(today.getFullYear(),today.getMonth(),today.getDate());
const parse=k=>{const [y,m,d]=k.split("-").map(Number);return new Date(y,m-1,d);};
const longDate=k=>parse(k).toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"});
const shortDate=k=>parse(k).toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"});
const monthDay=k=>parse(k).toLocaleDateString(undefined,{month:"short",day:"numeric"});
const nextKey=k=>{const d=parse(k);d.setDate(d.getDate()+1);return key(d.getFullYear(),d.getMonth(),d.getDate());};
function rangeLabel(a,b){
  if(a===b)return shortDate(a);
  const da=parse(a),db=parse(b);
  return shortDate(a)+" – "+(da.getMonth()===db.getMonth()&&da.getFullYear()===db.getFullYear()?db.getDate():monthDay(b));
}
const initials=n=>n.trim().split(/\s+/).slice(0,2).map(w=>w[0]).join("").toUpperCase()||"?";
const lsGet=(k,d)=>{try{const v=localStorage.getItem(k);return v?JSON.parse(v):d;}catch(e){return d;}};
const lsSet=(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}};

/* ── server connection ────────────────────────────────────── */
/* The Overlap server (server/index.js). Identity is an HttpOnly session cookie the
   server sets, so the page never sees a secret. Each open event is one
   server-sent-events stream that delivers the event and every answer after any change. */
async function connectServer(){
  async function api(method,path,body){
    const r=await fetch("/api"+path,{method,credentials:"same-origin",
      headers:body?{"Content-Type":"application/json"}:{},body:body?JSON.stringify(body):undefined});
    const j=await r.json().catch(()=>({}));
    if(!r.ok){const e=new Error(j.error||"Request failed ("+r.status+")");e.status=r.status;if(r.status<500&&j.error)e.userMessage=j.error;throw e;}
    return j;
  }
  const {id:me}=await api("POST","/session");
  const streams=new Map();
  function subscribe(id,kind,fn){
    let s=streams.get(id);
    if(!s){
      s={event:new Set(),responses:new Set(),error:new Set(),es:new EventSource("/api/events/"+encodeURIComponent(id)+"/stream")};
      s.es.onmessage=m=>{
        const d=JSON.parse(m.data);
        s.event.forEach(f=>f(d.event));
        if(d.event)s.responses.forEach(f=>f(d.responses));
      };
      // EventSource reconnects by itself; CLOSED means the server refused the stream.
      s.es.onerror=()=>{if(s.es.readyState===EventSource.CLOSED)s.error.forEach(f=>f());};
      streams.set(id,s);
    }
    s[kind].add(fn);
    return()=>{
      s[kind].delete(fn);
      if(!s.event.size&&!s.responses.size){s.es.close();streams.delete(id);}
    };
  }
  return {
    myId:me,
    async createEvent(title){return (await api("POST","/events",{title})).id;},
    watchEvent:(id,cb)=>subscribe(id,"event",cb),
    watchResponses(id,cb,err){
      const offR=subscribe(id,"responses",cb), offE=err?subscribe(id,"error",err):()=>{};
      return()=>{offE();offR();};
    },
    saveResponse:(id,d)=>api("PUT","/events/"+id+"/responses/me",{name:d.name,dates:d.dates}),
    renameEvent:(id,title)=>api("PATCH","/events/"+id,{title}),
    deleteEvent:id=>api("DELETE","/events/"+id)
  };
}

/* ── state ────────────────────────────────────────────────── */
let store=null, myId="local";
let route={page:"home",id:null};
let ev=null, evLoaded=false, others=new Map(), picks=new Set(), dirty=false, saving=false, loaded=false;
let tab="mine", focusDay=null, view={y:today.getFullYear(),m:today.getMonth()}, bestAll=false, openPerson=null, only=new Set(), whoAll=false;
const WHO_MAX=8;
const BEST_MAX=5;
let subs=[], bootErr="";

function toast(msg,action){
  const t=$("toast"); t.textContent=msg; t.classList.toggle("has",!!action);
  if(action){const b=document.createElement("button");b.textContent=action.label;b.onclick=()=>{t.classList.remove("show");action.fn();};t.appendChild(b);}
  t.classList.add("show"); clearTimeout(toast.t);
  toast.t=setTimeout(()=>t.classList.remove("show"),action?5000:2200);
}
const buzz=ms=>{try{navigator.vibrate&&navigator.vibrate(ms);}catch(e){}};
function unsubAll(){subs.forEach(u=>{try{u();}catch(e){}});subs=[];}
function eventUrl(id){return location.origin+location.pathname+"?e="+id;}
function remember(id,e){if(!store)return;const r=lsGet("overlap-recent",[]).filter(x=>x.id!==id);r.unshift({id,title:e.title,t:Date.now(),mine:e.by===myId,byName:e.byName||""});lsSet("overlap-recent",r.slice(0,20));}
function forget(id){lsSet("overlap-recent",lsGet("overlap-recent",[]).filter(x=>x.id!==id));}

/* ── routing ──────────────────────────────────────────────── */
function goHome(push=true){
  if(dirty&&!confirm("You haven't saved your days. Leave anyway?"))return;
  unsubAll(); route={page:"home",id:null}; ev=null; dirty=false;
  if(push&&store) history.pushState(null,"",location.pathname);
  document.title="Overlap"; renderAll(); window.scrollTo(0,0);
}
function openEvent(id,push=true){
  unsubAll();
  route={page:"event",id}; ev=null; evLoaded=false; others=new Map(); picks=new Set(); dirty=false; loaded=false;
  tab="mine"; focusDay=null; view={y:today.getFullYear(),m:today.getMonth()}; bestAll=false; only=new Set(); whoAll=false;
  pickOpen=false; pickYear=today.getFullYear(); anchor=null; undoPicks=null; openPerson=null;
  if(push&&store) history.pushState(null,"","?e="+id);
  $("name").value=""; $("tedit").hidden=true;
  subs.push(store.watchEvent(id,data=>{
    ev=data; evLoaded=true; if(ev){document.title=ev.title+" — Overlap";remember(id,ev);} renderAll();
  }));
  subs.push(store.watchResponses(id,list=>{
    others=new Map(list.map(r=>[r.id,r]));
    const mine=others.get(myId);
    if(!loaded&&mine){ // jump to the first month you picked
      const first=[...(mine.dates||[])].filter(k=>k>=TODAY).sort()[0];
      if(first){const d=parse(first);view={y:d.getFullYear(),m:d.getMonth()};}
    }
    if(mine&&!dirty&&!drag){picks=new Set(mine.dates||[]);anchor=null;undoPicks=null;if(document.activeElement!==$("name"))$("name").value=mine.name||"";}
    loaded=true; renderAll();
  },()=>toast("Lost the connection. Reload the page to get it back.")));
  renderAll(); window.scrollTo(0,0);
}
window.addEventListener("popstate",()=>{
  if(!store)return;
  const id=new URLSearchParams(location.search).get("e");
  id?openEvent(id,false):goHome(false);
});

/* ── render ───────────────────────────────────────────────── */
function renderAll(){
  const onEvent=route.page==="event";
  $("home").hidden=onEvent;
  $("backBtn").hidden=!onEvent;
  $("event").hidden=!onEvent||!ev;
  $("missing").hidden=!(onEvent&&ev===null&&evLoaded);
  const showBar=!!(onEvent&&ev&&tab==="mine"); $("bar").classList.toggle("away",!showBar); $("bar").inert=!showBar;
  onEvent?renderEvent():renderHome();
}

function renderHome(){
  $("offlineHome").hidden=!bootErr;
  $("createBtn").disabled=!store||!$("newTitle").value.trim();
  const list=lsGet("overlap-recent",[]).map(r=>({id:r.id,title:r.title,created:r.t,mine:r.mine===true,known:r.mine!==undefined,byName:r.byName||""}));
  const box=$("events"); box.innerHTML="";
  if(!list.length){box.innerHTML='<p class="empty">Nothing here yet. Events you make or open will show up in this list.</p>';return;}
  list.forEach(e=>{
    const name=e.title||"Untitled event";
    const row=document.createElement("div"); row.className="row";
    const b=document.createElement("button"); b.className="open";
    b.innerHTML='<div class="t"><b></b><small></small></div><span></span>';
    const tl=b.firstChild;
    tl.firstChild.textContent=name; tl.firstChild.style.fontWeight="500";
    if(e.known&&!e.mine)tl.lastChild.textContent=e.byName?"Created by "+e.byName:"Someone else's event";
    else tl.lastChild.remove();
    b.lastChild.textContent=e.created?new Date(e.created).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}):"";
    b.onclick=()=>openEvent(e.id);
    const d=document.createElement("button"); d.className="del"+(e.mine?" danger":"");
    d.title=e.mine?"Delete this event for everyone":"Take this off your list. The event itself stays.";
    d.setAttribute("aria-label",(e.mine?"Delete for everyone: ":"Remove from your list: ")+name);
    d.innerHTML=e.mine
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    d.onclick=()=>removeEvent(e);
    row.append(b,d); box.appendChild(row);
  });
}

/* Rows you own are deleted for everyone; rows you merely opened are just dropped
   from this browser's list, since the event isn't yours to remove. */
async function removeEvent(e){
  const name=e.title||"Untitled event";
  if(!e.mine){
    const before=lsGet("overlap-recent",[]);
    forget(e.id); renderHome();
    toast("Taken off your list. The event itself is still there.",{label:"Undo",fn:()=>{lsSet("overlap-recent",before);renderHome();}});
    return;
  }
  if(!confirm('Delete "'+name+'" for everyone?\n\nEverybody\'s answers go too, and the link stops working. There is no undo.'))return;
  try{await store.deleteEvent(e.id);forget(e.id);renderHome();toast("Event deleted.");}
  catch(err){console.error(err);toast("Couldn't delete it. Try again.");}
}

function everyone(){
  const list=[];
  others.forEach((r,id)=>{if(id!==myId&&r&&r.name)list.push({id,name:r.name,dates:new Set(r.dates||[]),me:false});});
  const nm=$("name").value.trim();
  if(nm||picks.size)list.push({id:myId,name:nm||"You",dates:picks,me:true});
  return list;
}

function renderEvent(){
  if(!ev)return;
  // With a few people picked, the calendar and Best days only count them. Picks for
  // someone who has since gone are ignored rather than dropped, in case they come back.
  const people=everyone(), comparing=people.length>=3&&people.some(p=>only.has(p.id));
  const group=comparing?people.filter(p=>only.has(p.id)):people;
  const total=group.length, counts=new Map();
  group.forEach(p=>p.dates.forEach(k=>{if(k>=TODAY)counts.set(k,(counts.get(k)||0)+1);}));

  // header
  // An unsaved rename stays in the field until it is saved or cancelled.
  const t=$("etitle"); if(document.activeElement!==t&&$("tedit").hidden)t.value=ev.title||"Untitled event";
  const canEdit=ev.by===myId; t.readOnly=!canEdit; t.tabIndex=canEdit?0:-1; t.title=canEdit?"Tap to rename":"";
  syncTitleEdit();
  const answered=people.length;
  $("emeta").textContent=answered===0?"Nobody has answered yet":answered===1?"1 person has answered":answered+" people have answered";
  $("shareUrl").textContent=route.id; $("shareUrl").title=eventUrl(route.id);

  // tabs
  $("tabs").querySelectorAll("button").forEach(b=>{b.setAttribute("aria-selected",b.dataset.tab===tab);b.tabIndex=b.dataset.tab===tab?0:-1;});
  placeTabBar();
  $("name").hidden=tab!=="mine";
  renderWho(people,comparing);

  // calendar
  $("month").textContent=MONTHS[view.m]+" "+view.y;
  const marks=new Set();
  (tab==="mine"?[...picks]:[...counts.keys()]).forEach(k=>{
    if(k>=TODAY){const d=parse(k);marks.add(d.getFullYear()+"-"+d.getMonth());}
  });
  const atStart=view.y===today.getFullYear()&&view.m===today.getMonth();
  $("prev").disabled=atStart; $("todayBtn").hidden=atStart;
  renderPicker(marks);
  const g=$("grid"); g.className="grid"+(tab==="mine"?" paint":""); g.innerHTML="";
  ["S","M","T","W","T","F","S"].forEach(d=>{const e=document.createElement("div");e.className="dow";e.textContent=d;e.setAttribute("aria-hidden","true");g.appendChild(e);});
  const first=new Date(view.y,view.m,1).getDay(), days=new Date(view.y,view.m+1,0).getDate();
  for(let i=0;i<first;i++){const e=document.createElement("div");e.className="pad before";g.appendChild(e);}
  for(let d=1;d<=days;d++){
    const k=key(view.y,view.m,d), c=counts.get(k)||0;
    const b=document.createElement("button"); b.type="button"; b.className="day"; b.dataset.k=k; b.dataset.w=(first+d-1)%7;
    b.innerHTML='<span class="c"></span><span class="n"></span>'; b.firstChild.textContent=d;
    if(k===TODAY)b.classList.add("today");
    if(k<TODAY)b.disabled=true;
    else if(tab==="mine"){
      if(picks.has(k))b.classList.add("sel");
      if(k===anchor)b.classList.add("anchor");
      b.setAttribute("aria-pressed",picks.has(k)); b.setAttribute("aria-label",longDate(k));
    } else {
      if(total>=2&&c===total)b.classList.add("all");
      else if(c>0){b.classList.add("heat");b.style.setProperty("--h",(0.25+0.75*c/Math.max(total,1)).toFixed(3));}
      if(c>0&&total>1)b.lastChild.textContent=c+"/"+total;
      if(k===focusDay)b.classList.add("focus");
      b.setAttribute("aria-label",longDate(k)+", "+c+" of "+total+" free");
    }
    g.appendChild(b);
  }
  // Blanks closing out the last row. Dragging onto them steps to the next month, which
  // is right beside the last day wherever in the week it happens to fall.
  for(let i=(7-((first+days)%7))%7;i>0;i--){const e=document.createElement("div");e.className="pad after";g.appendChild(e);}
  joinBands();

  // hint + detail
  const h=$("hint"), acts=$("acts");
  acts.innerHTML=""; acts.hidden=tab!=="mine";
  if(tab==="mine"){
    h.textContent=
      anchor?"Tap another day and everything between the two fills in."
      :others.has(myId)&&!dirty?"All saved. Tap any day if you want to change it, then save again."
      :"Tap the days you're free, or drag across a few. Tap one day then another to fill the gap between them.";
    const act=(label,fn,cls,icon)=>{
      const c=document.createElement("button"); c.className="act"+(cls?" "+cls:"");
      if(icon)c.innerHTML=icon;
      c.appendChild(document.createTextNode(label)); c.onclick=fn; acts.appendChild(c);
    };
    const days=new Date(view.y,view.m+1,0).getDate();
    let roomLeft=false;
    for(let d=1;d<=days&&!roomLeft;d++){const k=key(view.y,view.m,d);if(k>=TODAY&&!picks.has(k))roomLeft=true;}
    if(roomLeft)act("Fill all of "+MONTHS[view.m],fillMonth,"go",
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>');
    if(undoPicks)act("Undo",undo,"",
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h11a5 5 0 010 10h-4M3 10l5-5M3 10l5 5"/></svg>');
    if(picks.size)act("Clear all",()=>{snapshot();picks.clear();anchor=null;markDirty();});
  } else if(comparing)h.textContent=total<2?"Pick one more person to see the days you share."
    :"Showing only the days "+nameList(group)+" are free. Tap Everyone to see the whole group.";
  else h.textContent=total<2?"Days fill in with pink once two or more people say they're free.":"The deeper the pink, the more people can make it. Tap a day to see who.";
  const det=$("detail");
  if(tab==="group"&&focusDay&&total){
    det.hidden=false; $("detailHead").textContent=longDate(focusDay);
    const chips=$("chips"); chips.innerHTML="";
    group.forEach(p=>{const s=document.createElement("span");const ok=p.dates.has(focusDay);s.className="chip "+(ok?"ok":"no");s.textContent=p.me?"You":p.name;chips.appendChild(s);});
  } else det.hidden=true;

  // best days
  const best=$("best"); best.innerHTML="";
  const sorted=[...counts.entries()].sort((a,b)=>a[0]<b[0]?-1:1);
  if(total<2){
    $("bestHead").textContent="Best days";
    best.innerHTML=comparing?'<p class="empty">Pick at least two people to see the days they share.</p>'
      :'<p class="empty">Send the link to a few people. Once they pick their days, matches turn up here.</p>';
  }
  else{
    const all=sorted.filter(([,c])=>c===total), top=Math.max(0,...sorted.map(([,c])=>c));
    const rows=all.length?all:sorted.filter(([,c])=>c===top&&c>0);
    $("bestHead").textContent=all.length?(comparing?"All "+total+" free":"Everyone's free"):"Best so far";
    if(!rows.length)best.innerHTML='<p class="empty">Nobody has picked an upcoming day yet.</p>';
    else{
      const runs=groupRuns(rows,group), shown=bestAll?runs:runs.slice(0,BEST_MAX);
      shown.forEach(run=>best.appendChild(bestRow(run,total,group)));
      if(runs.length>BEST_MAX){
        const t=document.createElement("button"); t.className="more";
        t.textContent=bestAll?"Show fewer":"Show all "+runs.length;
        t.onclick=()=>{bestAll=!bestAll;renderAll();};
        best.appendChild(t);
      }
    }
  }

  // people
  const pl=$("people"); pl.innerHTML="";
  $("peopleHead").textContent=answered?"People ("+answered+")":"People";
  if(!answered)pl.innerHTML='<p class="empty">Nobody yet. Put your name in to get started.</p>';
  people.sort(byName).forEach(p=>{
    const open=openPerson===p.id;
    const r=document.createElement("div"); r.className="prow";
    const o=document.createElement("button"); o.className="popen";
    o.innerHTML='<span class="av"></span><div class="t"></div><span class="r"></span>'
      +'<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    o.children[0].textContent=initials(p.name);
    o.children[1].textContent=p.me?p.name+" (you)":p.name;
    o.children[2].textContent=p.dates.size+(p.dates.size===1?" day":" days");
    o.setAttribute("aria-expanded",open);
    o.title=open?"Hide the days "+(p.me?"you picked":p.name+" picked"):"See the days "+(p.me?"you picked":p.name+" picked");
    o.onclick=()=>{openPerson=open?null:p.id;renderAll();};
    r.appendChild(o);
    pl.appendChild(r);
    if(open){
      const box=document.createElement("div"); box.className="pdates";
      const keys=[...p.dates].sort(), runs=dayRuns(keys);
      if(!keys.length)box.innerHTML='<p class="pcap last">No days picked yet.</p>';
      else{
        if(!p.me){
          const cap=document.createElement("p"); cap.className="pcap";
          cap.textContent="Add any of these to your own days:";
          box.appendChild(cap);
        }
        runs.forEach(run=>{
          const line=document.createElement("div"); line.className="pline";
          const j=document.createElement("button"); j.className="pjump";
          j.textContent=rangeLabel(run.from,run.to);
          j.title="Show "+longDate(run.from)+" on the calendar";
          j.onclick=()=>{tab="group";focusDay=run.from;const d=parse(run.from);view={y:d.getFullYear(),m:d.getMonth()};renderAll();};
          line.appendChild(j);
          if(run.n>1){const c=document.createElement("span");c.className="pn";c.textContent=run.n+" days";line.appendChild(c);}
          const upcoming=daysIn(run).filter(k=>k>=TODAY);
          if(!p.me&&upcoming.length){
            if(upcoming.every(k=>picks.has(k))){
              const g=document.createElement("span"); g.className="pgot";
              g.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l6 6L20 6"/></svg>';
              g.appendChild(document.createTextNode("Added")); line.appendChild(g);
            } else {
              const a=document.createElement("button"); a.className="padd";
              a.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
              a.appendChild(document.createTextNode("Add"));
              a.title="Add "+rangeLabel(run.from,run.to)+" to your own days";
              a.onclick=()=>addRange(run,p.name); line.appendChild(a);
            }
          }
          box.appendChild(line);
        });
      }
      pl.appendChild(box);
    }
  });

  updateSave();
}

/* The chips above the Together calendar. "Everyone" clears the selection; each name
   toggles that person in or out. Only worth showing once there are three or more
   people, since with two, picking both is the same as everyone. A big group shows
   the first few names and a "+n more" chip, but anyone picked always stays in view. */
const byName=(a,b)=>a.me?-1:b.me?1:a.name.localeCompare(b.name);
function renderWho(people,comparing){
  const box=$("who"); box.hidden=tab!=="group"||people.length<3;
  if(box.hidden)return;
  box.innerHTML='<span class="cap">Who:</span>';
  const chip=(label,on,fn)=>{
    const b=document.createElement("button"); b.type="button"; b.textContent=label;
    if(on===null)b.className="more"; else b.setAttribute("aria-pressed",on);
    b.onclick=fn; box.appendChild(b); return b;
  };
  chip("Everyone",!comparing,()=>{only.clear();bestAll=false;renderAll();});
  const sorted=[...people].sort(byName), long=sorted.length>WHO_MAX;
  const shown=!long||whoAll?sorted:sorted.filter((p,i)=>i<WHO_MAX||only.has(p.id));
  shown.forEach(p=>chip(p.me?"You":p.name,comparing&&only.has(p.id),()=>{
    only.has(p.id)?only.delete(p.id):only.add(p.id);
    if(people.every(q=>only.has(q.id)))only.clear();   // everybody picked is just Everyone
    bestAll=false; renderAll();
  }));
  if(long&&(whoAll||shown.length<sorted.length)){
    const more=chip(whoAll?"Show fewer":"+"+(sorted.length-shown.length)+" more",null,()=>{whoAll=!whoAll;renderAll();});
    more.setAttribute("aria-expanded",whoAll);
  }
}
function nameList(list){
  const n=[...list].sort(byName).map(p=>p.me?"you":p.name);
  return n.length<2?n.join(""):n.slice(0,-1).join(", ")+" and "+n[n.length-1];
}

/* Consecutive days with the same set of free people collapse into one row, so a
   long stretch reads as "Sat, Mar 7 – 11" instead of five separate lines. */
function groupRuns(rows,people){
  const sig=k=>people.filter(p=>p.dates.has(k)).map(p=>p.id).sort().join("|");
  const out=[];
  rows.forEach(([k,c])=>{
    const s=sig(k), last=out[out.length-1];
    if(last&&last.sig===s&&nextKey(last.to)===k){last.to=k;last.n++;}
    else out.push({from:k,to:k,n:1,c,sig:s});
  });
  return out;
}
function dayRuns(keys){
  const out=[];
  keys.forEach(k=>{
    const last=out[out.length-1];
    if(last&&nextKey(last.to)===k){last.to=k;last.n++;}
    else out.push({from:k,to:k,n:1});
  });
  return out;
}
function bestRow(run,total,people){
  const r=document.createElement("button");
  r.innerHTML='<div class="t"><span></span><small></small></div><span class="r"></span>';
  r.querySelector("span").textContent=rangeLabel(run.from,run.to);
  const sm=r.querySelector("small"), rr=r.querySelector(".r"), notes=[];
  if(run.n>1)notes.push(run.n+" days in a row");
  if(run.c===total){rr.className="r ok pill";rr.textContent="All "+total;}
  else{rr.textContent=run.c+" of "+total;notes.push("Missing "+people.filter(p=>!p.dates.has(run.from)).map(p=>p.me?"you":p.name).join(", "));}
  if(notes.length)sm.textContent=notes.join(" · ");else sm.remove();
  r.onclick=()=>{tab="group";focusDay=run.from;const d=parse(run.from);view={y:d.getFullYear(),m:d.getMonth()};renderAll();};
  return r;
}

/* Month and year picker. The year stepper has no upper bound, so anything from this
   month onward is reachable, and no horizontal scrolling is involved. Months that
   already have days on them get a dot so you can see where to look. */
let pickOpen=false, pickYear=today.getFullYear();
function renderPicker(marks){
  $("mpop").classList.toggle("open",pickOpen); $("mpop").inert=!pickOpen;
  $("mpick").setAttribute("aria-expanded",pickOpen);
  if(!pickOpen)return;
  $("yearLbl").textContent=pickYear;
  $("yprev").disabled=pickYear<=today.getFullYear();
  const box=$("mgrid"); box.innerHTML="";
  for(let m=0;m<12;m++){
    const b=document.createElement("button"); b.type="button"; b.className="mbtn";
    b.textContent=MONTHS[m].slice(0,3);
    b.disabled=pickYear===today.getFullYear()&&m<today.getMonth();
    b.setAttribute("aria-pressed",pickYear===view.y&&m===view.m);
    b.setAttribute("aria-label",MONTHS[m]+" "+pickYear);
    if(marks.has(pickYear+"-"+m))b.appendChild(document.createElement("i"));
    b.onclick=()=>{pickOpen=false;goMonth(pickYear,m);$("mpick").focus({preventScroll:true});};
    box.appendChild(b);
  }
}

function joinBands(){
  $("grid").querySelectorAll(".day").forEach(b=>{
    const sel=b.classList.contains("sel"), w=+b.dataset.w;
    const prev=b.previousElementSibling, next=b.nextElementSibling;
    b.classList.toggle("jl",sel&&w>0&&prev&&prev.classList.contains("sel"));
    b.classList.toggle("jr",sel&&w<6&&next&&next.classList.contains("sel"));
  });
}

function updateSave(){
  const s=$("save"), st=$("status"), nm=$("name").value.trim(), n=picks.size;
  const days=n+(n===1?" day":" days"), sent=others.has(myId);
  s.classList.remove("ghost"); st.classList.remove("ok");
  if(saving){s.textContent="Saving…";s.disabled=true;st.textContent="";}
  else if(!nm){s.textContent="Add your name first";s.disabled=true;st.textContent=n?days+" picked":"";}
  else if(dirty){s.textContent=sent?"Update my days":"Save my days";s.disabled=false;st.textContent=days+" picked, not saved yet";}
  else if(sent){s.textContent="Change my days";s.disabled=false;s.classList.add("ghost");st.textContent="✓ Saved, "+days;st.classList.add("ok");}
  else{s.textContent="Save my days";s.disabled=!n;st.textContent=n?days+" picked":"Pick the days you're free";}
}
/* The calendar is always editable; this only points people back at it. */
function nudgeGrid(){
  const panel=$("grid").parentElement;
  panel.scrollIntoView({behavior:"smooth",block:"center"});
  panel.classList.remove("nudge"); void panel.offsetWidth; panel.classList.add("nudge");
  setTimeout(()=>panel.classList.remove("nudge"),1800);
  toast("Tap any day to add or drop it, then save.");
}
function markDirty(){dirty=true;renderAll();}

/* ── drag / tap selection ─────────────────────────────────── */
const grid=$("grid"); let drag=null, anchor=null, undoPicks=null;
const MAXDAYS=400;
const dayAt=(x,y)=>{const el=document.elementFromPoint(x,y);const b=el&&el.closest(".day");return b&&!b.disabled&&grid.contains(b)?b:null;};
function snapshot(){undoPicks=new Set(picks);}
function undo(){if(!undoPicks)return;picks=new Set(undoPicks);undoPicks=null;anchor=null;markDirty();}
/* Tapping a second day fills everything between it and the last day you tapped, so
   "the 1st through the 9th" is two taps instead of nine. */
function fillRange(a,b){
  const lo=a<b?a:b, hi=a<b?b:a, add=[];
  for(let k=lo,i=0;k<=hi&&i<=MAXDAYS;k=nextKey(k),i++)if(k>=TODAY&&!picks.has(k))add.push(k);
  if(!add.length)return false;
  if(picks.size+add.length>MAXDAYS){toast("You can save up to "+MAXDAYS+" days.");return false;}
  add.forEach(k=>picks.add(k));
  return true;
}
/* "I'm free most of this month" is quicker to say by filling it and knocking out
   the few days that don't work. */
function fillMonth(){
  const days=new Date(view.y,view.m+1,0).getDate(), add=[];
  for(let d=1;d<=days;d++){const k=key(view.y,view.m,d);if(k>=TODAY&&!picks.has(k))add.push(k);}
  if(!add.length)return;
  if(picks.size+add.length>MAXDAYS){toast("You can save up to "+MAXDAYS+" days.");return;}
  snapshot(); add.forEach(k=>picks.add(k)); anchor=null; markDirty();
  toast("Filled "+MONTHS[view.m]+". Tap the days that do not work to drop them.");
}
/* Take one stretch of somebody's answer rather than the lot, and add to your own
   days instead of replacing them. */
function daysIn(run){const out=[];for(let k=run.from,i=0;k<=run.to&&i<=MAXDAYS;k=nextKey(k),i++)out.push(k);return out;}
function addRange(run,who){
  const add=daysIn(run).filter(k=>k>=TODAY&&!picks.has(k));
  if(!add.length)return;
  if(picks.size+add.length>MAXDAYS){toast("You can save up to "+MAXDAYS+" days.");return;}
  snapshot(); add.forEach(k=>picks.add(k)); anchor=null; tab="mine";
  const d=parse(add[0]); view={y:d.getFullYear(),m:d.getMonth()};
  markDirty();
  toast("Added "+rangeLabel(run.from,run.to)+" from "+who+" to your days.");
}
const setsDiffer=(a,b)=>{if(a.size!==b.size)return true;for(const k of a)if(!b.has(k))return true;return false;};
/* A drag covers every date between where it started and wherever it is now, so the
   path your finger took across the grid does not matter. */
function applyDrag(){
  const d=drag; if(!d)return;
  const lo=d.from<d.to?d.from:d.to, hi=d.from<d.to?d.to:d.from, next=new Set(d.base);
  for(let k=lo,i=0;k<=hi&&i<=MAXDAYS;k=nextKey(k),i++){
    if(k<TODAY)continue;
    if(d.op==="add")next.add(k); else next.delete(k);
  }
  if(d.op==="add"&&next.size>MAXDAYS){
    if(!d.warned){d.warned=true;toast("You can save up to "+MAXDAYS+" days.");}
    return;
  }
  picks=next; repaintDays();
}
function repaintDays(){
  grid.querySelectorAll(".day").forEach(b=>{
    const on=picks.has(b.dataset.k);
    b.classList.toggle("sel",on); b.setAttribute("aria-pressed",on);
    b.classList.toggle("anchor",b.dataset.k===anchor);
  });
  joinBands();
}
grid.addEventListener("pointerdown",e=>{
  if(tab!=="mine"||e.button>0)return;
  if(gAnim){gAnim.stop();gAnim=null;} setGX(0);
  const b=dayAt(e.clientX,e.clientY); if(!b)return;
  e.preventDefault(); snapshot();
  const k=b.dataset.k;
  drag={op:picks.has(k)?"remove":"add",from:k,to:k,base:new Set(picks),x:e.clientX,y:e.clientY,moved:false};
  try{grid.setPointerCapture(e.pointerId);}catch(_){}
  applyDrag();
});
grid.addEventListener("pointermove",e=>{
  if(!drag)return;
  drag.x=e.clientX; drag.y=e.clientY;
  const b=dayAt(e.clientX,e.clientY);
  if(b&&b.dataset.k!==drag.to){drag.to=b.dataset.k;drag.moved=true;applyDrag();}
  edgeCheck(e.clientX,e.clientY);
});
/* Dragging clear of the calendar and holding there walks through the months, so a
   range covering several of them can be picked without letting go.

   The zone starts outside the grid. The rightmost column is Saturday, so a zone
   inside it would start flipping months on any ordinary drag to the end of a week.
   Nothing is selected while the months turn. Once you move back onto the grid, the
   range runs from where you started to the day you land on. */
let edgeTimer=null, edgeDir=0;
const atFirstMonth=()=>view.y===today.getFullYear()&&view.m===today.getMonth();
function stopEdge(){
  if(edgeTimer){clearTimeout(edgeTimer);edgeTimer=null;}
  edgeDir=0; grid.classList.remove("edge","edgeL","edgeR");
}
function stepMonth(dir){
  if(dir<0){
    if(atFirstMonth())return false;
    view.m--; if(view.m<0){view.m=11;view.y--;}
  } else {view.m++; if(view.m>11){view.m=0;view.y++;}}
  const cls=[...grid.classList].filter(c=>c.startsWith("edge"));
  renderAll();
  grid.classList.add(...cls);
  const b=dayAt(drag.x,drag.y);
  if(b&&b.dataset.k!==drag.to){drag.to=b.dataset.k;drag.moved=true;applyDrag();}
  return true;
}
/* Which way, if any, the pointer is asking the calendar to move. The blank cells that
   pad the first and last rows are the primary target, since they sit immediately beside
   the first and last day of the month whatever weekday those land on. Running off the
   side of the grid still counts, which covers a month that ends flush on a Saturday and
   so has no trailing blanks. */
function dirAt(x,y){
  const el=document.elementFromPoint(x,y), pad=el&&el.closest(".pad");
  if(pad&&grid.contains(pad))return pad.classList.contains("after")?1:-1;
  const r=grid.getBoundingClientRect();
  if(y>=r.top-30&&y<=r.bottom+30){
    if(x<r.left-6)return -1;
    if(x>r.right+6)return 1;
  }
  return 0;
}
function edgeCheck(x,y){
  if(!drag){stopEdge();return;}
  let dir=dirAt(x,y);
  if(dir===-1&&atFirstMonth())dir=0;
  if(dir===edgeDir)return;
  stopEdge();
  if(!dir)return;
  edgeDir=dir;
  grid.classList.add("edge",dir<0?"edgeL":"edgeR");
  // Wait before the first turn so brushing the zone does not flip a month by itself.
  edgeTimer=setTimeout(function tick(){
    // Re-check every turn: after a flip the same spot may hold a real day, and the
    // months must stop turning then rather than running on.
    if(!drag||dirAt(drag.x,drag.y)!==dir||!stepMonth(dir)){stopEdge();return;}
    edgeTimer=setTimeout(tick,620);
  },520);
}
const endDrag=()=>{
  if(!drag)return;
  stopEdge();
  const d=drag; drag=null; let changed=setsDiffer(d.base,picks);
  if(!d.moved){                                         // a tap, not a drag
    if(d.op==="add"){if(anchor&&anchor!==d.from&&fillRange(anchor,d.from))changed=true;anchor=d.from;}
    else anchor=null;                                   // tapping a chosen day drops just it
  } else anchor=d.op==="add"?d.to:null;
  if(changed)markDirty(); else{undoPicks=null;renderAll();}
};
grid.addEventListener("pointerup",endDrag);
grid.addEventListener("pointercancel",endDrag);
grid.addEventListener("click",e=>{
  if(swiped){swiped=false;return;}
  const b=e.target.closest(".day"); if(!b||b.disabled)return;
  if(tab==="group"){focusDay=focusDay===b.dataset.k?null:b.dataset.k;renderAll();return;}
  if(e.detail===0){                                     // keyboard activation
    const k=b.dataset.k; snapshot();
    if(picks.has(k)){picks.delete(k);anchor=null;}
    else{picks.add(k);if(anchor&&anchor!==k)fillRange(anchor,k);anchor=k;}
    markDirty();grid.querySelector(`[data-k="${k}"]`)?.focus();
  }
});

/* ── motion ───────────────────────────────────────────────────
   Springs described the way Apple does: a damping ratio (1 = no overshoot) and a
   response in seconds. They start from wherever the thing is on screen and carry
   whatever velocity it already has, so any movement can be grabbed or redirected. */
const RM=matchMedia("(prefers-reduced-motion: reduce)");
function spring({from,to,velocity=0,damping=1,response=.4,onUpdate,onDone}){
  let x=from,v=velocity,last=performance.now(),raf=0,live=true;
  const k=(2*Math.PI/response)**2, c=4*Math.PI*damping/response;
  const step=now=>{
    const dt=Math.min(.064,(now-last)/1000); last=now;
    const n=Math.max(1,Math.ceil(dt/.004)), h=dt/n;
    for(let i=0;i<n;i++){v+=(-k*(x-to)-c*v)*h; x+=v*h;}
    if(Math.abs(v)<1&&Math.abs(x-to)<.4){x=to;v=0;live=false;onUpdate(x);onDone&&onDone();return;}
    onUpdate(x); raf=requestAnimationFrame(step);
  };
  raf=requestAnimationFrame(step);
  return {stop(){cancelAnimationFrame(raf);live=false;},get v(){return v;},get live(){return live;}};
}
// Where a flick would come to rest, from Apple's Designing Fluid Interfaces sample code.
const project=(v,rate=.998)=>(v/1000)*rate/(1-rate);
// Past an edge the calendar keeps following, but less and less.
const rubberband=(x,dim,c=.55)=>(x*dim*c)/(dim+c*Math.abs(x));

/* The calendar slides between months. gx is its on-screen offset: every new slide
   starts from it, and from the running spring's velocity. */
let gx=0, gAnim=null;
function setGX(x){
  gx=x; const w=grid.clientWidth||1;
  grid.style.transform=x?`translate3d(${x}px,0,0)`:"";
  grid.style.opacity=x?String(1-Math.min(.7,Math.abs(x)/w*.8)):"";
}
function settleGrid(opts={}){
  const v=opts.velocity!=null?opts.velocity:(gAnim&&gAnim.live?gAnim.v:0);
  if(gAnim)gAnim.stop();
  if(RM.matches){gAnim=null;setGX(0);grid.animate([{opacity:.35},{opacity:1}],{duration:180,easing:"ease-out"});return;}
  gAnim=spring({from:gx,to:0,velocity:v,damping:opts.damping||1,response:opts.response||.38,onUpdate:setGX});
}
/* Moving to another month. The new month enters from the side you are heading
   toward (later months from the right), picking up from the current offset. */
function goMonth(y,m){
  const dir=Math.sign((y*12+m)-(view.y*12+view.m));
  view={y,m}; renderAll();
  if(!dir||drag)return;
  if(RM.matches){grid.animate([{opacity:.35},{opacity:1}],{duration:180,easing:"ease-out"});return;}
  const w=grid.clientWidth;
  setGX(Math.max(-w,Math.min(w,gx+dir*Math.min(64,w*.18))));
  settleGrid();
}

/* In the Together view the calendar can be swiped between months. It follows the
   finger 1:1 after a small threshold, projects the flick forward to decide whether
   to turn the page, and hands the finger's velocity to the spring. */
let sw=null, swiped=false;
grid.addEventListener("pointerdown",e=>{
  if(tab!=="group"||e.button>0)return;
  const held=gAnim&&gAnim.live; if(gAnim)gAnim.stop();   // catch it mid-flight
  sw={x0:e.clientX,y0:e.clientY,base:gx,on:held,dead:false,id:e.pointerId,hist:[{x:e.clientX,t:e.timeStamp}]};
  if(held){try{grid.setPointerCapture(e.pointerId);}catch(_){}}
});
grid.addEventListener("pointermove",e=>{
  if(!sw||sw.dead)return;
  const dx=e.clientX-sw.x0, dy=e.clientY-sw.y0;
  if(!sw.on){
    if(Math.abs(dx)<10&&Math.abs(dy)<10)return;
    if(Math.abs(dy)>Math.abs(dx)){sw.dead=true;return;}   // it's a scroll, let it go
    sw.on=true; sw.x0=e.clientX; try{grid.setPointerCapture(e.pointerId);}catch(_){}
  }
  sw.hist.push({x:e.clientX,t:e.timeStamp}); if(sw.hist.length>6)sw.hist.shift();
  let x=sw.base+(e.clientX-sw.x0);
  if(x>0&&atFirstMonth())x=rubberband(x,grid.clientWidth);   // nothing before this month
  setGX(x);
});
function endSwipe(e){
  const s=sw; sw=null; if(!s||!s.on){return;}
  swiped=e.type==="pointerup"; setTimeout(()=>{swiped=false;},0);
  const h=s.hist.filter(p=>e.timeStamp-p.t<100), a=h[0]||s.hist[0], b=h[h.length-1]||a;
  const v=b.t>a.t?(b.x-a.x)/((b.t-a.t)/1000):0, w=grid.clientWidth;
  const land=gx+project(v);
  const dir=land<-w/2?1:land>w/2&&!atFirstMonth()?-1:0;
  if(!dir){settleGrid({velocity:v});return;}
  const m=view.m+dir; view={y:view.y+(m<0?-1:m>11?1:0),m:(m+12)%12};
  focusDay=null; renderAll(); buzz(8);
  setGX(gx+dir*w);                         // the new month sits right beside the old one
  settleGrid({velocity:v,damping:.86,response:.42});   // a flick gets a little overshoot
}
grid.addEventListener("pointerup",endSwipe);
grid.addEventListener("pointercancel",endSwipe);

/* The tab underline travels to the chosen tab and changes ink on the way. */
function placeTabBar(){
  const t=$("tabs"), b=t.querySelector('[aria-selected="true"]');
  if(!b||!b.offsetWidth)return;
  t.style.setProperty("--tx",b.offsetLeft+"px"); t.style.setProperty("--tw",b.offsetWidth+"px");
  t.style.setProperty("--tc",b.dataset.tab==="group"?"var(--pink)":"var(--blue)");
  if(!t.classList.contains("ready"))requestAnimationFrame(()=>t.classList.add("ready"));
}
window.addEventListener("resize",placeTabBar);
document.fonts&&document.fonts.ready.then(placeTabBar);

/* ── controls ─────────────────────────────────────────────── */
$("brand").onclick=()=>goHome();
$("backBtn").onclick=()=>goHome();
$("missingHome").onclick=()=>goHome();
$("newTitle").addEventListener("input",renderHome);
$("createForm").addEventListener("submit",async e=>{
  e.preventDefault();
  const title=$("newTitle").value.trim(); if(!title||!store)return;
  $("createBtn").disabled=true; $("createBtn").textContent="Creating…";
  try{const id=await store.createEvent(title);$("newTitle").value="";openEvent(id);toast("Event created. Copy the link and send it to people.");}
  catch(err){toast("Couldn't make the event. Try again.");}
  $("createBtn").textContent="Create event"; renderHome();
});
$("tabs").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;tab=b.dataset.tab;renderAll();});
$("tabs").addEventListener("keydown",e=>{
  if(e.key!=="ArrowLeft"&&e.key!=="ArrowRight")return;
  e.preventDefault(); tab=tab==="mine"?"group":"mine"; renderAll();
  $("tabs").querySelector(`[data-tab="${tab}"]`).focus();
});
$("mpick").onclick=()=>{
  pickOpen=!pickOpen; if(pickOpen)pickYear=view.y; renderAll();
  if(pickOpen)$("mgrid").querySelector('[aria-pressed="true"]')?.focus({preventScroll:true});
};
$("yprev").onclick=()=>{if(pickYear>today.getFullYear()){pickYear--;renderAll();}};
$("ynext").onclick=()=>{pickYear++;renderAll();};
$("prev").onclick=()=>{const m=view.m-1;goMonth(view.y+(m<0?-1:0),(m+12)%12);};
$("next").onclick=()=>{const m=view.m+1;goMonth(view.y+(m>11?1:0),m%12);};
$("todayBtn").onclick=()=>goMonth(today.getFullYear(),today.getMonth());
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&pickOpen){pickOpen=false;renderAll();$("mpick").focus();}});
document.addEventListener("pointerdown",e=>{
  if(!pickOpen||e.target.closest("#mpop")||e.target.closest("#mpick"))return;
  pickOpen=false; renderAll();
});
$("name").addEventListener("input",()=>{dirty=true;renderAll();});
$("name").addEventListener("keydown",e=>{if(e.key==="Enter")e.target.blur();});

$("save").onclick=async()=>{
  const name=$("name").value.trim(); if(!name||!route.id)return;
  if(!dirty&&!saving&&others.has(myId))return nudgeGrid();
  saving=true; updateSave();
  const doc={name,dates:[...picks].sort(),updated:Date.now()};
  try{
    await store.saveResponse(route.id,doc); buzz(12);
    others.set(myId,{id:myId,...doc}); dirty=false; anchor=null; undoPicks=null;
    toast("Saved. You can change them whenever.");
  }
  catch(err){toast(err&&err.userMessage?err.userMessage:"Couldn't save. Try again.");}
  saving=false; renderAll();
};

const titleEl=$("etitle");
// A rename only happens through Update name (or Enter). Leaving the field keeps the edit
// waiting; Cancel or Escape puts the old name back.
let titleSaving=false;
function syncTitleEdit(){
  const pending=!!ev&&!titleEl.readOnly&&titleEl.value!==ev.title, t=titleEl.value.trim();
  $("tedit").hidden=!pending;
  $("titleSave").disabled=titleSaving||!t||t===ev?.title;
  $("titleSave").textContent=titleSaving?"Updating…":"Update name";
}
async function saveTitle(){
  const id=route.id, before=ev?.title, t=titleEl.value.trim();
  if(titleSaving||!ev||!t||t===before)return;
  titleSaving=true; syncTitleEdit();
  try{
    await store.renameEvent(id,t);
    if(ev&&route.id===id){ev.title=t;titleEl.value=t;document.title=t+" — Overlap";}
    titleEl.blur();
    toast("Event renamed",{label:"Undo",fn:async()=>{
      try{
        await store.renameEvent(id,before);
        if(ev&&route.id===id&&$("tedit").hidden){ev.title=before;titleEl.value=before;document.title=before+" — Overlap";}
        toast("Name changed back");
      }catch(e){toast(e&&e.userMessage?e.userMessage:"Couldn't change it back");}
    }});
  }catch(e){toast(e&&e.userMessage?e.userMessage:"Couldn't rename it. Try again.");}
  titleSaving=false; syncTitleEdit();
}
function cancelTitle(){if(ev)titleEl.value=ev.title;syncTitleEdit();titleEl.blur();}
titleEl.addEventListener("input",syncTitleEdit);
titleEl.addEventListener("keydown",e=>{
  if(e.key==="Enter"){e.preventDefault();saveTitle();}
  else if(e.key==="Escape")cancelTitle();
});
$("titleSave").onclick=saveTitle;
$("titleCancel").onclick=cancelTitle;

// The box shows only the event code, but copying any of it copies the full link.
$("shareUrl").addEventListener("copy",e=>{e.preventDefault();e.clipboardData.setData("text/plain",eventUrl(route.id));});
$("copyBtn").onclick=async()=>{
  const url=eventUrl(route.id);
  try{await navigator.clipboard.writeText(url);toast("Event link copied");}
  catch(e){if(navigator.share){try{await navigator.share({title:ev?.title,url});}catch(_){}}else prompt("Copy this event link:",url);}
};
window.addEventListener("beforeunload",e=>{if(dirty||!$("tedit").hidden){e.preventDefault();e.returnValue="";}});

/* ── boot ─────────────────────────────────────────────────── */
// Opened from an event link: start on the (empty) event page rather than flashing home
// while the server connects.
const linked=new URLSearchParams(location.search).get("e");
const linkedId=linked&&/^[a-z0-9]{4,32}$/.test(linked)?linked:null;
if(linkedId)route={page:"event",id:linkedId};
renderAll();
(async()=>{
  try{store=await connectServer();}
  catch(e){console.error(e);store=null;bootErr=(e&&e.message)||"unreachable";}
  if(!store){route={page:"home",id:null};renderAll();return;}
  myId=store.myId;
  if(linkedId)openEvent(linkedId,false);else renderAll();
})();
